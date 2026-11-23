/** Named deployment smoke: synthetic text only; ephemeral owner browser session.
 * Run from apps/server: node --env-file=.env --import tsx scripts/verify-omni-tts.ts
 * Logs response metadata only. No credentials in argv, no agent/vault calls.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export interface VoiceSmokeDependencies {
  port: number; ownerEmail: string; origin: string;
  createSession(id: string, email: string, ttlMs: number): void;
  destroySession(id: string): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  log(value: { status: number; type: string; bytes: number; elapsedMs: number; providerID: string }): void;
}
const SYNTHETIC_TEXT = "This is Omni's synthetic speech deployment check. No personal information is included.";
const MAX_AUDIO = 10 * 1024 * 1024;
async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); throw new Error("smoke_body_limit"); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error("smoke_body_limit"); }
      chunks.push(value.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
export async function verifyOmniTTS(deps: VoiceSmokeDependencies, providerID: "hermes-edge" | "kokoro-local" = "hermes-edge"): Promise<void> {
  const voiceID = providerID === "kokoro-local" ? "af_heart" : "en-US-AriaNeural";
  const expectedType = providerID === "kokoro-local" ? "audio/wav" : "audio/mpeg";
  if (!Number.isInteger(deps.port) || deps.port < 1 || deps.port > 65535 || !deps.ownerEmail || !/^https?:\/\//.test(deps.origin)) throw new Error("smoke_configuration");
  const base = `http://127.0.0.1:${deps.port}/api/omni/voice`;
  const credential = randomBytes(32).toString("base64url");
  const sessionID = randomUUID(); const requestID = randomUUID(); const cancelledID = randomUUID();
  const headers = { cookie: `prism_session=${credential}`, origin: deps.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const deadline = AbortSignal.timeout(45_000);
  const measure = async (path: string, method: string, body?: unknown, signal = deadline) => {
    const start = performance.now();
    const response = await deps.fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal });
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const bytes = await readBounded(response, method === "POST" ? MAX_AUDIO : 64 * 1024);
    deps.log({ status: response.status, type, bytes: bytes.byteLength, elapsedMs: Math.round(performance.now() - start), providerID });
    return { response, type, bytes };
  };
  let created = false;
  try {
    deps.createSession(credential, deps.ownerEmail, 60_000); created = true;
    const catalog = await measure("/providers", "GET");
    if (catalog.response.status !== 200 || catalog.type !== "application/json") throw new Error("smoke_catalog");
    const metadata = JSON.parse(new TextDecoder().decode(catalog.bytes));
    const provider = Array.isArray(metadata.providers) ? metadata.providers.find((p: { id?: string }) => p.id === providerID) : null;
    if (!provider?.available || provider.defaultVoiceID !== voiceID) throw new Error("smoke_unavailable");
    const payload = { sessionID, requestID, providerID, voiceID, text: SYNTHETIC_TEXT };
    const audio = await measure("/synthesis", "POST", payload);
    const validAudio = providerID === "kokoro-local"
      ? audio.bytes.byteLength >= 46 && new TextDecoder().decode(audio.bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(audio.bytes.subarray(8, 12)) === "WAVE"
      : new TextDecoder().decode(audio.bytes.subarray(0, 3)) === "ID3" || (audio.bytes[0] === 0xff && (audio.bytes[1]! & 0xe0) === 0xe0);
    if (audio.response.status !== 200 || audio.type !== expectedType || !validAudio) throw new Error("smoke_audio");
    const cancelled = await measure(`/synthesis/${cancelledID}`, "DELETE", { sessionID });
    if (cancelled.response.status !== 200) throw new Error("smoke_cancel");
    const suppressed = await measure("/synthesis", "POST", { ...payload, requestID: cancelledID });
    if (suppressed.response.status !== 409) throw new Error("smoke_cancel");
  } finally {
    if (created) {
      try { await measure(`/synthesis/${requestID}`, "DELETE", { sessionID }, AbortSignal.timeout(5000)); } catch { /* cleanup failure cannot prevent credential removal */ }
      deps.destroySession(credential);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "kokoro-local" && process.argv[2] !== "hermes-edge")) { process.exitCode = 2; }
  else {
    const { config } = await import("../src/config");
    const { createSession, destroySession } = await import("../src/db");
    try { await verifyOmniTTS({ port: config.port, ownerEmail: config.ownerEmail, origin: config.appOrigin, createSession, destroySession, fetch, log: value => console.log(JSON.stringify(value)) }, process.argv[2] as "kokoro-local" | "hermes-edge" | undefined); }
    catch { process.exitCode = 1; }
  }
}
