// Playable audio for the Comms apps (owner-testing round 4: "I can't play voice messages anywhere").
//
// AVFoundation (AVAudioPlayer / AVPlayer on macOS and iOS) cannot decode Ogg/Opus — what WhatsApp,
// Telegram and Signal send voice notes as — nor AMR or WebM audio. `GET /api/comms/media/:token
// ?format=m4a` asks for a playable rendition: the server reads the original (bounded), and when its
// BYTES are one of those containers it transcodes them to AAC in an .m4a with ffmpeg; anything
// already playable (AAC/MP4, MP3, CAF, WAV, AIFF, FLAC) is answered unchanged.
//
// SAFETY: ffmpeg is spawned with an argument vector (never a shell), on a file the server wrote
// itself in a private directory, with a wall clock (TRANSCODE_TIMEOUT_MS, then SIGKILL), an input
// cap (AUDIO_MAX_INPUT_BYTES), a duration cap (-t), an output cap, `-nostdin`, no network
// protocols (`-protocol_whitelist file`) and at most MAX_CONCURRENT at once; identical requests
// share one run. Results are cached on disk beside the media cache (`comms-audio-cache/`, 0700/0600,
// SHA-256 names — no media id on disk), LRU-capped at CACHE_MAX_BYTES.
//
// Config: COMMS_FFMPEG_PATH (default: /opt/homebrew/bin/ffmpeg, /usr/local/bin/ffmpeg,
// /usr/bin/ffmpeg, then the first `ffmpeg` on PATH), COMMS_AUDIO_CACHE_DIR, COMMS_AUDIO_CACHE_MAX_BYTES.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { config } from "../config";

export const AUDIO_MAX_INPUT_BYTES = 25 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 50 * 1024 * 1024;
export const TRANSCODE_TIMEOUT_MS = 60_000;
const MAX_DURATION_S = 2 * 60 * 60;
const MAX_CONCURRENT = 2;

/** What the bytes are, for this decision only (null = not an audio container we know). */
export function sniffAudio(b: Uint8Array): string | null {
  const s = (o: number, t: string) => b.length >= o + t.length && [...t].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  if (s(0, "OggS")) return "audio/ogg";
  if (s(0, "#!AMR-WB")) return "audio/amr-wb";
  if (s(0, "#!AMR")) return "audio/amr";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (s(4, "ftyp")) return "audio/mp4";
  if (s(0, "caff")) return "audio/x-caf";
  if (s(0, "RIFF") && s(8, "WAVE")) return "audio/wav";
  if (s(0, "FORM") && (s(8, "AIFF") || s(8, "AIFC"))) return "audio/aiff";
  if (s(0, "fLaC")) return "audio/flac";
  if (s(0, "ID3") || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

const UNPLAYABLE = new Set(["audio/ogg", "audio/opus", "application/ogg", "audio/amr", "audio/amr-wb", "audio/3gpp", "audio/3gpp2", "audio/webm", "video/webm", "audio/x-matroska"]);
/** Does this audio need a playable rendition on Apple platforms? The sniffed type wins over the declared one. */
export function needsTranscode(bytes: Uint8Array, declared: string | null): boolean {
  const sniffed = sniffAudio(bytes);
  if (sniffed) return UNPLAYABLE.has(sniffed);
  const base = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  return UNPLAYABLE.has(base);
}

// ── configuration ──────────────────────────────────────────────────────────────
let ffmpegOverride: string | null | undefined;
/** Tests: force a path (or null = "not installed"); undefined restores discovery. */
export function setFfmpegPathForTests(p: string | null | undefined): void {
  ffmpegOverride = p;
}
const executable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
export function ffmpegPath(): string | null {
  if (ffmpegOverride !== undefined) return ffmpegOverride;
  const env = (process.env.COMMS_FFMPEG_PATH ?? "").trim();
  if (env) return executable(env) ? env : null;
  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) if (executable(p)) return p;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir && executable(join(dir, "ffmpeg"))) return join(dir, "ffmpeg");
  return null;
}

function cacheDir(): string {
  const env = (process.env.COMMS_AUDIO_CACHE_DIR ?? "").trim();
  if (env) return resolve(env);
  if (process.env.MEDIA_CACHE_DIR) return join(dirname(resolve(process.env.MEDIA_CACHE_DIR)), "comms-audio-cache");
  if (config.dbPath === ":memory:") return join(tmpdir(), `prism-comms-audio-${process.pid}`);
  return join(dirname(resolve(config.dbPath)), "comms-audio-cache");
}
const cacheMax = (): number => {
  const v = Number(process.env.COMMS_AUDIO_CACHE_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 256 * 1024 * 1024;
};
function ensureDir(): string {
  const d = cacheDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try { chmodSync(d, 0o700); } catch { /* best effort */ }
  return d;
}
/** The cached rendition's file for a media identity (an mxc / BlueBubbles ref). */
export const cachedPathFor = (identity: string): string =>
  join(cacheDir(), `${createHash("sha256").update(`m4a:v1:${identity}`).digest("hex")}.m4a`);

/** The cached rendition, if any (touched: LRU). */
export async function cachedRendition(identity: string): Promise<Buffer | null> {
  const p = cachedPathFor(identity);
  try {
    const b = await readFile(p);
    const t = new Date();
    try { utimesSync(p, t, t); } catch { /* fine */ }
    return b;
  } catch {
    return null;
  }
}

function prune(dir: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".m4a")).map((f) => {
      const st = statSync(join(dir, f));
      return { f, size: st.size, at: st.mtimeMs };
    }).sort((a, b) => a.at - b.at);
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files) {
      if (total <= cacheMax()) break;
      try { unlinkSync(join(dir, x.f)); total -= x.size; } catch { /* raced */ }
    }
  } catch { /* nothing to prune */ }
}

// ── transcoding ───────────────────────────────────────────────────────────────
export class TranscodeError extends Error {
  constructor(readonly code: "unavailable" | "too_large" | "failed" | "timeout" | "busy") {
    super(`transcode ${code}`);
  }
}

let active = 0;
const waiters: Array<() => void> = [];
const inflight = new Map<string, Promise<Buffer>>();
export const transcodeStats = { runs: 0 };

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiters.length >= 16) throw new TranscodeError("busy");
    await new Promise<void>((r) => waiters.push(r));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], shell: false, env: { PATH: "/usr/bin:/bin" } });
    let done = false;
    const finish = (err: TranscodeError | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolveRun();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new TranscodeError("timeout"));
    }, timeoutMs);
    child.stderr.on("data", () => { /* drained, never logged (could quote metadata) */ });
    child.on("error", () => finish(new TranscodeError("unavailable")));
    child.on("close", (code) => finish(code === 0 ? null : new TranscodeError("failed")));
  });
}

/**
 * The AAC/.m4a rendition of `input` (cached under `identity`). Throws TranscodeError. Identical
 * concurrent requests share one ffmpeg run.
 */
export function transcodeToM4a(identity: string, input: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
  const known = inflight.get(identity);
  if (known) return known;
  const p = (async () => {
    const cached = await cachedRendition(identity);
    if (cached) return cached;
    if (input.byteLength > AUDIO_MAX_INPUT_BYTES) throw new TranscodeError("too_large");
    const bin = ffmpegPath();
    if (!bin) throw new TranscodeError("unavailable");
    return slot(async () => {
      const dir = ensureDir();
      const id = randomUUID();
      const src = join(dir, `in-${id}.bin`);
      const tmp = join(dir, `out-${id}.m4a`);
      try {
        await writeFile(src, input, { mode: 0o600 });
        transcodeStats.runs++;
        await run(bin, [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file",
          "-i", src, "-t", String(MAX_DURATION_S), "-vn", "-sn", "-dn", "-map_metadata", "-1",
          "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart", "-fs", String(OUTPUT_MAX_BYTES),
          "-f", "ipod", "-y", tmp,
        ], opts.timeoutMs ?? TRANSCODE_TIMEOUT_MS);
        const st = await stat(tmp);
        if (!st.isFile() || st.size === 0 || st.size >= OUTPUT_MAX_BYTES) throw new TranscodeError("failed");
        const final = cachedPathFor(identity);
        await rename(tmp, final);
        prune(dir);
        return await readFile(final);
      } finally {
        await rm(src, { force: true });
        await rm(tmp, { force: true });
      }
    });
  })().finally(() => inflight.delete(identity));
  inflight.set(identity, p);
  return p;
}

/** Tests: empty the cache directory. */
export async function _clearAudioCacheForTests(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true });
}
