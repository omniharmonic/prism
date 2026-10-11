import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyOmniTTS, type VoiceSmokeDependencies } from "../scripts/verify-omni-tts";
function fixture(mode = "valid") {
  const sessions = new Set<string>(); const calls: string[] = []; const logs: unknown[] = [];
  let credential = ""; let createdTTL = 0; let deleted = "";
  const deps: VoiceSmokeDependencies = {
    port: 12345, ownerEmail: "owner@test.local", origin: "https://omni.test",
    createSession(id, _email, ttl) { credential = id; createdTTL = ttl; sessions.add(id); },
    destroySession(id) { deleted = id; sessions.delete(id); },
    log(value) { logs.push(value); },
    async fetch(url, init) {
      assert.match(url, /^http:\/\/127\.0\.0\.1:12345\/api\/omni\/voice\//);
      assert.equal(init.redirect, "error"); assert.ok(init.signal);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("cookie"), `prism_session=${credential}`);
      assert.equal(headers.get("origin"), "https://omni.test");
      assert.equal(headers.get("sec-fetch-site"), "same-origin");
      calls.push(init.method!);
      if (mode === "network-failure") throw new Error("synthetic-network-error");
      if (init.method === "GET") return Response.json({ providers: [{ id: "hermes-edge", available: true, defaultVoiceID: "en-US-AriaNeural" }] });
      if (init.method === "DELETE") return Response.json({ ok: true });
      const body = JSON.parse(String(init.body));
      assert.match(body.text, /synthetic speech deployment check/);
      assert.ok(!body.text.includes("owner@test.local"));
      if (calls.filter(call => call === "POST").length > 1) return Response.json({ error: "voice_cancelled" }, { status: 409 });
      if (mode === "wrong-mime") return new Response("ID3fixture", { headers: { "content-type": "text/plain" } });
      if (mode === "zero-audio") return new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } });
      if (mode === "oversize") return new Response("fixture", { headers: { "content-type": "audio/mpeg", "content-length": String(10 * 1024 * 1024 + 1) } });
      return new Response("ID3fixture", { headers: { "content-type": "audio/mpeg" } });
    },
  };
  return { deps, sessions, calls, logs, result: () => ({ credential, createdTTL, deleted }) };
}
test("synthetic smoke uses real browser headers and deletes exactly its short-lived credential", async () => {
  const f = fixture(); await verifyOmniTTS(f.deps);
  assert.deepEqual(f.calls, ["GET", "POST", "DELETE", "POST", "DELETE"]);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.result().deleted, f.result().credential);
  assert.equal(f.result().createdTTL, 60_000);
  assert.ok(!JSON.stringify(f.logs).includes(f.result().credential));
  for (const log of f.logs) assert.deepEqual(Object.keys(log as object).sort(), ["bytes", "elapsedMs", "providerID", "status", "type"]);
});
for (const mode of ["wrong-mime", "zero-audio", "oversize", "network-failure"]) test(`smoke ${mode} always destroys exact credential`, async () => {
  const f = fixture(mode); await assert.rejects(verifyOmniTTS(f.deps));
  assert.equal(f.sessions.size, 0); assert.equal(f.result().deleted, f.result().credential);
  assert.ok(!JSON.stringify(f.logs).includes(f.result().credential));
});
test("smoke fixture crosses actual owner auth and synthesis routes with an ephemeral DB session", async () => {
  process.env.OMNI_ENABLED = "true";
  const { Hono } = await import("hono");
  const { config } = await import("../src/config");
  const { createSession, destroySession, getSession, ensureUser } = await import("../src/db");
  // Import the guarded in-memory test harness before any session write.
  await import("./helpers");
  const { omniApi } = await import("../src/routes/omni");
  const { setVoiceProviderForTests } = await import("../src/omni/voice-synthesis");
  const app = new Hono(); app.route("/api/omni", omniApi);
  ensureUser(config.ownerEmail);
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => new Uint8Array([0x49, 0x44, 0x33, 0x04]) });
  let created = "";
  try {
    await verifyOmniTTS({ port: 12345, ownerEmail: config.ownerEmail, origin: config.appOrigin,
      createSession(id, email, ttl) { created = id; createSession(id, email, ttl); }, destroySession,
      fetch: (url, init) => Promise.resolve(app.request(url, init)), log() {},
    });
    assert.ok(created); assert.equal(getSession(created), null);
  } finally { if (created) destroySession(created); setVoiceProviderForTests(null); }
});

test("Kokoro smoke verifies local WAV and scoped cancellation", async () => {
  const f = fixture(); const original = f.deps.fetch;
  f.deps.fetch = async (url, init) => {
    if (init.method === "GET") return Response.json({ providers: [{ id: "kokoro-local", available: true, defaultVoiceID: "af_heart" }] });
    const response = await original(url, init);
    if (init.method === "POST" && response.status === 200) {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.providerID, "kokoro-local"); assert.equal(payload.voiceID, "af_heart");
      const wav = Buffer.alloc(46); wav.write("RIFF"); wav.write("WAVE", 8);
      return new Response(wav, { headers: { "content-type": "audio/wav" } });
    }
    return response;
  };
  await verifyOmniTTS(f.deps, "kokoro-local"); assert.equal(f.sessions.size, 0);
});
