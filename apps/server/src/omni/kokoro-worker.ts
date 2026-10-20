import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_OUTPUT = 1_930_000;
export class KokoroWorkerError extends Error {
  readonly status: number;
  constructor(public readonly code: 'unavailable' | 'busy' | 'invalid_text' | 'aborted' | 'failed') {
    super(`Kokoro synthesis ${code}`);
    this.status = code === 'invalid_text' ? 400 : code === 'aborted' ? 499 : 503;
  }
}
export interface KokoroWorkerOptions {
  executable?: string;
  cache?: string;
  startupMs?: number;
  renderMs?: number;
  idleMs?: number;
  restartMs?: number;
}
interface Render {
  id: string;
  resolve: (wav: Buffer) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Validate the worker's canonical mono 24 kHz PCM16 WAV before returning it. */
export function validateKokoroWav(value: unknown, frames: unknown, sampleRate: unknown): Buffer {
  if (typeof value !== 'string' || value.length > MAX_OUTPUT || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      || !Number.isInteger(frames) || (frames as number) < 1 || (frames as number) > 720_000 || sampleRate !== 24_000) throw new KokoroWorkerError('failed');
  const wav = Buffer.from(value, 'base64');
  if (wav.toString('base64') !== value || wav.length !== 44 + (frames as number) * 2
      || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8
      || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(16) !== 16
      || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1
      || wav.readUInt32LE(24) !== 24_000 || wav.readUInt32LE(28) !== 48_000
      || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16
      || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== (frames as number) * 2) throw new KokoroWorkerError('failed');
  return wav;
}

/** One isolated process, one render at a time. Never logs speech or worker output. */
export class KokoroWorker {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private stopping?: Promise<void>;
  private active?: Render;
  private buffer = Buffer.alloc(0);
  private startup?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private nextStart = 0;
  private failures = 0;
  private disposed = false;
  private readonly options: Required<Omit<KokoroWorkerOptions, 'executable' | 'cache'>> & Pick<KokoroWorkerOptions, 'executable' | 'cache'>;

  constructor(optionsOrConfig: KokoroWorkerOptions | (() => { executable: string; cache: string } | null) = {}) {
    const options: KokoroWorkerOptions = typeof optionsOrConfig === 'function' ? (optionsOrConfig() ?? { executable: '', cache: '' }) : optionsOrConfig;
    this.options = { executable: options.executable ?? process.env.OMNI_TTS_KOKORO_EXECUTABLE,
      cache: options.cache ?? process.env.OMNI_TTS_KOKORO_CACHE,
      startupMs: options.startupMs ?? 45_000, renderMs: options.renderMs ?? 45_000,
      idleMs: options.idleMs ?? 300_000, restartMs: options.restartMs ?? 1_000 };
  }

  /** Starts warmup opportunistically; metadata requests never wait for model loading. */
  async available(): Promise<boolean> { return this.warmup(); }

  private warmup(): boolean {
    if (!this.child && !this.stopping && !this.disposed && Date.now() >= this.nextStart) this.start();
    return this.ready && !this.stopping;
  }

  private start(): void {
    const { executable, cache } = this.options;
    if (!executable || !cache || !isAbsolute(executable) || !isAbsolute(cache)) return;
    // No inherited credentials, provider keys, transcript variables or shell execution.
    const env: NodeJS.ProcessEnv = { OMNI_TTS_EVALUATION_CACHE: cache };
    for (const key of ['HOME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(executable, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.output(child, chunk));
    child.stdin.on('error', () => { void this.stop('failed', true); });
    child.on('error', () => { void this.stop('failed', true); });
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = undefined; this.ready = false;
      this.clearTimers();
      if (!this.stopping) this.rejectActive('failed');
      this.buffer = Buffer.alloc(0);
      if (!this.stopping) this.backoff();
    });
    this.startup = setTimeout(() => { void this.stop('failed', true); }, this.options.startupMs);
    this.startup.unref();
  }

  private output(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child || this.stopping) return;
    if (this.buffer.length + chunk.length > MAX_OUTPUT) { void this.stop('failed', true); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const message = JSON.parse(line);
        if (!this.ready) {
          if (message.id !== '' || message.status !== 'ready' || message.ready !== true) throw new Error();
          this.ready = true;
          clearTimeout(this.startup); this.startup = undefined;
          this.armIdle();
        } else {
          const active = this.active;
          if (!active || message.id !== active.id || message.status !== 'ok') throw new Error();
          const wav = validateKokoroWav(message.wavBase64, message.frames, message.sampleRate);
          this.active = undefined; this.failures = 0; active.cleanup(); active.resolve(wav); this.armIdle();
        }
      } catch { void this.stop('failed', true); return; }
    }
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    if (typeof text !== 'string' || !text.trim() || text.length > 160) throw new KokoroWorkerError('invalid_text');
    if (signal?.aborted) throw new KokoroWorkerError('aborted');
    if (this.active || this.stopping) throw new KokoroWorkerError('busy');
    if (!this.warmup() || !this.child) throw new KokoroWorkerError('unavailable');
    clearTimeout(this.idle);
    return new Promise<Buffer>((resolve, reject) => {
      const id = randomUUID();
      const onAbort = () => { void this.stop('aborted', false); };
      const timer = setTimeout(() => { void this.stop('failed', true); }, this.options.renderMs);
      timer.unref();
      this.active = { id, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, text }) + '\n');
    });
  }

  private rejectActive(code: 'aborted' | 'failed'): void {
    const active = this.active;
    this.active = undefined;
    active?.cleanup(); active?.reject(new KokoroWorkerError(code));
  }
  private clearTimers(): void { clearTimeout(this.startup); clearTimeout(this.idle); }
  private backoff(): void {
    this.failures = Math.min(this.failures + 1, 6);
    this.nextStart = Date.now() + Math.min(30_000, this.options.restartMs * 2 ** (this.failures - 1));
  }
  private armIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { void this.stop('failed', false); }, this.options.idleMs);
    this.idle.unref();
  }
  private stop(code: 'aborted' | 'failed', failed: boolean): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ready = false; this.clearTimers();
    const child = this.child;
    if (!child) { this.rejectActive(code); if (failed) this.backoff(); return Promise.resolve(); }
    // Set stopping before sending a signal. Hold the render promise until close.
    this.stopping = new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 1_000);
      kill.unref();
      child.once('close', () => {
        clearTimeout(kill);
        this.rejectActive(code);
        resolve();
      });
    }).finally(() => { this.stopping = undefined; if (failed) this.backoff(); });
    child.kill('SIGTERM');
    return this.stopping;
  }
  async close(): Promise<void> { this.disposed = true; await this.stop('failed', false); }
}
