/** Bounded swappable synthesis providers. No retained text/audio, public cache or agent dispatch. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const VOICE_LIMITS = { characters: 4000, audioBytes: 10 * 1024 * 1024, timeoutMs: 30_000, concurrency: 2 } as const;
export const VOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface VoiceRequest { sessionID: string; requestID: string; providerID: string; voiceID: string; text: string }
export interface VoiceProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly cloud: boolean;
  readonly disclosure: string;
  readonly defaultVoiceID: string;
  readonly voices: readonly { readonly id: string; readonly name: string; readonly language: string }[];
  readonly maxCharacters: number;
  readonly maxAudioBytes: number;
  readonly contentType: "audio/mpeg";
}
export interface VoiceProvider {
  readonly descriptor: VoiceProviderDescriptor;
  available(): Promise<boolean>;
  synthesize(request: VoiceRequest, signal: AbortSignal): Promise<Uint8Array>;
}
export class VoiceError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
const worker = fileURLToPath(new URL("../../scripts/omni-tts.py", import.meta.url));
function runtime(): { root: string; python: string } | null {
  const root = process.env.OMNI_TTS_HERMES_ROOT;
  const python = process.env.OMNI_TTS_PYTHON;
  return root && python && isAbsolute(root) && isAbsolute(python) && existsSync(join(root, "tools/tts_tool.py")) && existsSync(python) ? { root, python } : null;
}
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" };
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "TZ"]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function runWorker(mode: string, input: string, signal: AbortSignal): Promise<string> {
  const r = runtime();
  if (!r) throw new VoiceError("voice_unavailable", 503);
  if (signal.aborted) throw new VoiceError("voice_cancelled", 409);
  return new Promise((resolve, reject) => {
    const child = spawn(r.python, [worker, mode, r.root], { cwd: r.root, env: childEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let overflow = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => { child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref(); };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 4096) { overflow = true; stop(); } else stdout += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => { signal.removeEventListener("abort", stop); if (killTimer) clearTimeout(killTimer); reject(new VoiceError("voice_unavailable", 503)); });
    child.on("close", code => {
      signal.removeEventListener("abort", stop);
      if (killTimer) clearTimeout(killTimer);
      if (signal.aborted) reject(new VoiceError("voice_cancelled", 409));
      else if (code !== 0 || overflow) reject(new VoiceError("voice_failed", 502));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}
let checkInFlight: Promise<boolean> | null = null;
let checkCache: { key: string; expires: number; available: boolean } | null = null;
const edgeDescriptor: VoiceProviderDescriptor = Object.freeze({
  id: "hermes-edge", name: "Hermes · Microsoft Edge", cloud: true,
  disclosure: "Response text is sent to Microsoft for speech synthesis. Apple speech is used when unavailable.",
  defaultVoiceID: "en-US-AriaNeural", voices: Object.freeze([{ id: "en-US-AriaNeural", name: "Aria", language: "en-US" }]),
  maxCharacters: VOICE_LIMITS.characters, maxAudioBytes: VOICE_LIMITS.audioBytes, contentType: "audio/mpeg",
});
const edge: VoiceProvider = {
  descriptor: edgeDescriptor,
  async available() {
    const r = runtime();
    if (!r) return false;
    const key = r.root + "\n" + r.python;
    if (checkCache?.key === key && checkCache.expires > Date.now()) return checkCache.available;
    if (checkInFlight) return checkInFlight;
    checkInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let available = false;
    try { available = JSON.parse(await runWorker("--check", "", controller.signal)).available === true; } catch { /* metadata never promises missing dependencies */ }
    finally { clearTimeout(timer); }
    checkCache = { key, expires: Date.now() + 30_000, available };
    return available;
    })();
    try { return await checkInFlight; } finally { checkInFlight = null; }
  },
  async synthesize(request, signal) {
    const directory = await mkdtemp(join(tmpdir(), "omni-tts-"));
    try {
      await chmod(directory, 0o700);
      const output = join(directory, "speech.mp3");
      const bounded = new AbortController();
      let oversized = false;
      const stop = () => bounded.abort();
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const monitor = setInterval(() => {
        void lstat(output).then(stat => {
          if (stat.size > VOICE_LIMITS.audioBytes) { oversized = true; bounded.abort(); }
        }).catch(() => {});
      }, 50);
      try {
        await runWorker("--synthesize", JSON.stringify({ text: request.text, voiceID: request.voiceID, output }), bounded.signal);
      } catch (error) {
        if (oversized) throw new VoiceError("voice_failed", 502);
        throw error;
      } finally { clearInterval(monitor); signal.removeEventListener("abort", stop); }
      const stat = await lstat(output);
      if (!stat.isFile() || stat.size < 4 || stat.size > VOICE_LIMITS.audioBytes) throw new VoiceError("voice_failed", 502);
      const audio = await readFile(output);
      if (!(audio.subarray(0, 3).toString() === "ID3" || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0))) throw new VoiceError("voice_failed", 502);
      return audio;
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
};
// Fixed code registrations only: a vetted local adapter is added here, not by
// accepting a module/command/path from HTTP or configuration.
const shippedProviders: readonly VoiceProvider[] = [edge];
let providers = providerRegistry(shippedProviders);
/** Preserve the original single-Edge test injection without coupling routes to Edge. */
export function setVoiceProviderForTests(value: (Omit<VoiceProvider, "descriptor"> & { id: string; descriptor?: VoiceProviderDescriptor }) | null): void {
  if (value && value.id !== edgeDescriptor.id && !value.descriptor) throw new Error("test provider descriptor required");
  setVoiceProvidersForTests(value ? [{ ...value, descriptor: value.descriptor ?? edgeDescriptor }] : null);
}
export function setVoiceProvidersForTests(values: readonly VoiceProvider[] | null): void {
  providers = providerRegistry(values ?? shippedProviders);
}
function providerRegistry(registry: readonly VoiceProvider[]): Map<string, VoiceProvider> {
  if (new Set(registry.map(value => value.descriptor.id)).size !== registry.length) throw new Error("duplicate voice provider");
  for (const { descriptor } of registry) {
    if (!descriptor.voices.some(voice => voice.id === descriptor.defaultVoiceID) ||
      !Number.isInteger(descriptor.maxCharacters) || descriptor.maxCharacters <= 0 || descriptor.maxCharacters > VOICE_LIMITS.characters ||
      !Number.isInteger(descriptor.maxAudioBytes) || descriptor.maxAudioBytes <= 0 || descriptor.maxAudioBytes > VOICE_LIMITS.audioBytes) throw new Error("invalid voice provider descriptor");
  }
  return new Map(registry.map(provider => [provider.descriptor.id, provider]));
}
export function voiceProviderDescriptor(id: string): VoiceProviderDescriptor | undefined { return providers.get(id)?.descriptor; }
export function validVoiceRequest(input: Record<string, unknown> | null): input is Record<string, unknown> & VoiceRequest {
  if (!input || Object.keys(input).sort().join(",") !== "providerID,requestID,sessionID,text,voiceID" ||
    typeof input.sessionID !== "string" || !VOICE_UUID.test(input.sessionID) || typeof input.requestID !== "string" || !VOICE_UUID.test(input.requestID) ||
    typeof input.providerID !== "string" || typeof input.voiceID !== "string" || typeof input.text !== "string" || !input.text.trim()) return false;
  const descriptor = voiceProviderDescriptor(input.providerID);
  return !!descriptor && descriptor.voices.some(voice => voice.id === input.voiceID) && input.text.length <= descriptor.maxCharacters;
}
export async function voiceProviders() {
  return { providers: await Promise.all([...providers.values()].map(async provider => ({ ...provider.descriptor, available: await provider.available() }))) };
}
interface Active { sessionID: string; requestID: string; controller: AbortController }
const active = new Map<string, Active>();
// Cancellation arriving before POST is processed must also invalidate that exact request.
const cancelled = new Map<string, number>();
function key(scope: string, sessionID: string, requestID: string) { return `${scope}:${sessionID}:${requestID}`; }
function pruneCancelled() { for (const [k, expiry] of cancelled) if (expiry <= Date.now()) cancelled.delete(k); }
export function cancelVoice(scope: string, sessionID: string, requestID: string): void {
  pruneCancelled();
  if (cancelled.size >= 1024) cancelled.delete(cancelled.keys().next().value!);
  cancelled.set(key(scope, sessionID, requestID), Date.now() + 60_000);
  const current = active.get(scope);
  if (current?.sessionID === sessionID && current.requestID === requestID) current.controller.abort();
}
export interface VoiceOutcomeMetadata {
  kind: "success" | "rejected" | "cancelled" | "timeout" | "unavailable" | "failed";
  stage: "validation" | "admission" | "availability" | "synthesis" | "delivery";
  status: number;
  elapsedMs: number;
  bytes: number;
  provider: string;
}
const defaultOutcomeSink = (value: VoiceOutcomeMetadata) => console.log(JSON.stringify({ event: "omni_voice_synthesis", ...value }));
let outcomeSink = defaultOutcomeSink;
export function setVoiceOutcomeSinkForTests(sink: ((value: VoiceOutcomeMetadata) => void) | null): void { outcomeSink = sink ?? defaultOutcomeSink; }
/** Only registered code-owned IDs enter diagnostics; never arbitrary request input. */
export function recordVoiceOutcome(providerID: unknown, stage: VoiceOutcomeMetadata["stage"], status: number, startedAt: number, bytes = 0): void {
  const provider = typeof providerID === "string" ? providers.get(providerID)?.descriptor.id ?? "unregistered" : "unregistered";
  const kind: VoiceOutcomeMetadata["kind"] = status === 200 ? "success" : status === 409 ? "cancelled" : status === 504 ? "timeout" : status === 503 ? "unavailable" : status < 500 ? "rejected" : "failed";
  // Logging cannot fail the audio response or emit provider exceptions/content.
  try { outcomeSink({ kind, stage, status, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), bytes, provider }); } catch { /* diagnostic sink only */ }
}
export async function synthesizeVoice(scope: string, request: VoiceRequest, disconnect: AbortSignal): Promise<Uint8Array> {
  const startedAt = performance.now();
  let stage: VoiceOutcomeMetadata["stage"] = "validation";
  let status = 502; let bytes = 0;
  try {
    const provider = providers.get(request.providerID);
    if (!validVoiceRequest(request as unknown as Record<string, unknown>) || !provider) throw new VoiceError("bad_request", 400);
    stage = "admission";
    pruneCancelled();
    if (cancelled.has(key(scope, request.sessionID, request.requestID))) throw new VoiceError("voice_cancelled", 409);
    if (active.has(scope) || active.size >= VOICE_LIMITS.concurrency) throw new VoiceError("voice_busy", 429);
    const controller = new AbortController();
    const reservation = { sessionID: request.sessionID, requestID: request.requestID, controller };
    active.set(scope, reservation);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, VOICE_LIMITS.timeoutMs);
    const stop = () => controller.abort();
    disconnect.addEventListener("abort", stop, { once: true });
    if (disconnect.aborted) stop();
    try {
      stage = "availability";
      if (!await provider.available()) throw new VoiceError("voice_unavailable", 503);
      if (controller.signal.aborted) throw new VoiceError("voice_cancelled", 409);
      stage = "synthesis";
      const audio = await provider.synthesize(request, controller.signal);
      if (controller.signal.aborted) throw new VoiceError("voice_cancelled", 409);
      stage = "delivery";
      if (!audio.byteLength || audio.byteLength > provider.descriptor.maxAudioBytes) throw new VoiceError("voice_failed", 502);
      status = 200; bytes = audio.byteLength;
      return audio;
    } catch (error) {
      if (timedOut) throw new VoiceError("voice_timeout", 504);
      if (controller.signal.aborted) throw new VoiceError("voice_cancelled", 409);
      throw error instanceof VoiceError ? error : new VoiceError("voice_failed", 502);
    } finally {
      clearTimeout(timer); disconnect.removeEventListener("abort", stop);
      if (active.get(scope) === reservation) active.delete(scope);
    }
  } catch (error) {
    status = error instanceof VoiceError ? error.status : 502;
    throw error;
  } finally { recordVoiceOutcome(request.providerID, stage, status, startedAt, bytes); }
}
