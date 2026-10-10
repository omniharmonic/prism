/** Mounted after Omni's enabled, owner session/device and mutation CSRF gates. */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import { resolveActor } from "../auth/actor";
import { consumeRateLimit } from "../middleware/ratelimit";
import { readCapped } from "./actions";
import { VOICE_LIMITS, VOICE_UUID, VoiceError, cancelVoice, synthesizeVoice, voiceProviders, type VoiceRequest } from "../omni/voice-synthesis";
export const omniVoiceApi = new Hono();
function scope(c: Context): string {
  const actor = resolveActor(c);
  if (actor.kind !== "user") throw new VoiceError("forbidden", 403);
  const credential = actor.deviceId ?? createHash("sha256").update(getCookie(c, "prism_session") ?? "").digest("hex");
  return `${actor.email.toLowerCase()}:${actor.vaultId}:${credential}`;
}
async function body(c: Context): Promise<Record<string, unknown> | null> {
  const text = await readCapped(c.req.raw, 32 * 1024);
  try { const value = text === null ? null : JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}
omniVoiceApi.get("/providers", async c => { c.header("Cache-Control", "no-store"); return c.json(await voiceProviders()); });
omniVoiceApi.post("/synthesis", async c => {
  const input = await body(c);
  if (!input || Object.keys(input).sort().join(",") !== "providerID,requestID,sessionID,text,voiceID" ||
    typeof input.sessionID !== "string" || !VOICE_UUID.test(input.sessionID) || typeof input.requestID !== "string" || !VOICE_UUID.test(input.requestID) ||
    input.providerID !== "hermes-edge" || input.voiceID !== "en-US-AriaNeural" || typeof input.text !== "string" || !input.text.trim() || input.text.length > VOICE_LIMITS.characters)
    return c.json({ error: "bad_request" }, 400);
  const identity = scope(c);
  const retry = consumeRateLimit(`omni-voice:${identity}`, 30, 60_000);
  if (retry !== null) { c.header("Retry-After", String(retry)); return c.json({ error: "rate_limited" }, 429); }
  try {
    const audio = await synthesizeVoice(identity, input as unknown as VoiceRequest, c.req.raw.signal);
    return new Response(audio as BodyInit, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store, private", "Content-Length": String(audio.byteLength), "X-Content-Type-Options": "nosniff" } });
  } catch (error) { const e = error instanceof VoiceError ? error : new VoiceError("voice_failed", 502); return c.json({ error: e.code }, e.status as 400); }
});
omniVoiceApi.delete("/synthesis/:requestID", async c => {
  const input = await body(c);
  if (!input || Object.keys(input).join(",") !== "sessionID" || typeof input.sessionID !== "string" || !VOICE_UUID.test(input.sessionID) || !VOICE_UUID.test(c.req.param("requestID"))) return c.json({ error: "bad_request" }, 400);
  cancelVoice(scope(c), input.sessionID, c.req.param("requestID"));
  return c.json({ ok: true });
});
