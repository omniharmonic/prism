import { test, after } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true";
import { omniApi } from "../src/routes/omni";
import { config } from "../src/config";
import { issueDeviceToken } from "../src/auth/device";
import { makeSession, sessionCookie } from "./helpers";
import { cancelVoice, setVoiceProviderForTests, synthesizeVoice, VoiceError, VOICE_LIMITS, type VoiceRequest } from "../src/omni/voice-synthesis";
const sessionID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
let sequence = 0;
const request = (): VoiceRequest => ({ sessionID, requestID: `bbbbbbbb-bbbb-4bbb-bbbb-${String(++sequence).padStart(12, "0")}`, providerID: "hermes-edge", voiceID: "en-US-AriaNeural", text: "Synthetic speech fixture." });
const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
const headers = { "content-type": "application/json", authorization: `Bearer ${issueDeviceToken(config.ownerEmail, "Voice test", "omni-native").token}` };
setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => audio });
after(() => setVoiceProviderForTests(null));
const send = (body: unknown, h: Record<string,string> = headers) => omniApi.request("/voice/synthesis", { method: "POST", headers: h, body: JSON.stringify(body) });
test("voice uses owner gates and browser CSRF", async () => {
  assert.equal((await send(request(), { "content-type": "application/json" })).status, 401);
  const other = issueDeviceToken("other@test.local", "Other", "omni-native").token;
  assert.equal((await send(request(), { ...headers, authorization: `Bearer ${other}` })).status, 403);
  assert.equal((await send(request(), { "content-type": "application/json", cookie: sessionCookie(makeSession(config.ownerEmail)), origin: "https://evil.test" })).status, 403);
});
test("fixed provider metadata and MP3 bytes have no cache/path exposure", async () => {
  const metadata = await omniApi.request("/voice/providers", { headers });
  assert.equal(metadata.status, 200);
  const body = await metadata.json();
  assert.equal(body.providers[0].available, true);
  assert.equal(body.providers[0].cloud, true);
  assert.equal(body.providers[0].defaultVoiceID, "en-US-AriaNeural");
  const response = await send(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
});
test("strict bounds reject paths, arbitrary provider, empty/oversize text", async () => {
  for (const change of [{ output: "/tmp/private.mp3" }, { providerID: "command" }, { voiceID: "unknown" }, { text: " " }, { text: "a".repeat(4001) }, { sessionID: "not-uuid" }]) assert.equal((await send({ ...request(), ...change })).status, 400);
});
test("exact-session cancellation cannot stop another device; late bytes discarded", async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => began = resolve);
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async (_r, signal) => {
    began(); return new Promise(resolve => signal.addEventListener("abort", () => resolve(audio), { once: true }));
  } });
  const input = request();
  const pending = synthesizeVoice("device-a", input, new AbortController().signal);
  await started;
  cancelVoice("device-b", input.sessionID, input.requestID);
  cancelVoice("device-a", "cccccccc-cccc-4ccc-cccc-cccccccccccc", input.requestID);
  await assert.rejects(synthesizeVoice("device-a", request(), new AbortController().signal), (e: unknown) => e instanceof VoiceError && e.code === "voice_busy");
  cancelVoice("device-a", input.sessionID, input.requestID);
  await assert.rejects(pending, (e: unknown) => e instanceof VoiceError && e.code === "voice_cancelled");
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => audio });
  assert.deepEqual(await synthesizeVoice("device-a", request(), new AbortController().signal), audio);
});
test("DELETE before POST invalidates only matching request", async () => {
  const input = request();
  assert.equal((await omniApi.request(`/voice/synthesis/${input.requestID}`, { method: "DELETE", headers, body: JSON.stringify({ sessionID: input.sessionID }) })).status, 200);
  assert.equal((await send(input)).status, 409);
  assert.equal((await send(request())).status, 200);
});
test("disconnect, unavailable and oversize output release reservation", async () => {
  const disconnected = new AbortController(); disconnected.abort();
  await assert.rejects(synthesizeVoice("disconnect", request(), disconnected.signal), (e: unknown) => e instanceof VoiceError && e.code === "voice_cancelled");
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => false, synthesize: async () => audio });
  assert.equal((await send(request())).status, 503);
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => new Uint8Array(VOICE_LIMITS.audioBytes + 1) });
  assert.equal((await send(request())).status, 502);
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => audio });
  assert.equal((await send(request())).status, 200);
});
test("real subprocess adapter cleans private files on completion and cancellation without logging text", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "voice-worker-fixture-"));
  const oldRoot = process.env.OMNI_TTS_HERMES_ROOT;
  const oldPython = process.env.OMNI_TTS_PYTHON;
  try {
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "edge_tts.py"), "# synthetic installed-module fixture\n");
    await mkdir(join(root, "edge_tts-7.2.7.dist-info"));
    await writeFile(join(root, "edge_tts-7.2.7.dist-info", "METADATA"), "Name: edge-tts\nVersion: 7.2.7\n");
    await writeFile(join(root, "tools", "tts_tool.py"), `import asyncio\nfrom pathlib import Path\nasync def _generate_edge_tts(text,output,config):\n p=Path(output)\n p.write_bytes(b'ID3fixture')\n Path(__file__).parents[1].joinpath('created-dir').write_text(str(p.parent))\n if text=='cancel fixture': await asyncio.sleep(30)\n return output\n`);
    process.env.OMNI_TTS_HERMES_ROOT = root;
    process.env.OMNI_TTS_PYTHON = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
    setVoiceProviderForTests(null);
    assert.equal((await send(request())).status, 200);
    const directory = await readFile(join(root, "created-dir"), "utf8");
    await assert.rejects(stat(directory), { code: "ENOENT" });
    await rm(join(root, "created-dir"));
    const input = { ...request(), text: "cancel fixture" };
    const pending = synthesizeVoice("worker-cancel", input, new AbortController().signal);
    let created = "";
    const deadline = Date.now() + 3000;
    while (!created && Date.now() < deadline) {
      created = await readFile(join(root, "created-dir"), "utf8").catch(() => "");
      if (!created) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(created, "fixture child began");
    assert.equal((await stat(created)).mode & 0o777, 0o700);
    cancelVoice("worker-cancel", input.sessionID, input.requestID);
    await assert.rejects(pending, (e: unknown) => e instanceof VoiceError && e.code === "voice_cancelled");
    await assert.rejects(stat(created), { code: "ENOENT" });
  } finally {
    if (oldRoot === undefined) delete process.env.OMNI_TTS_HERMES_ROOT; else process.env.OMNI_TTS_HERMES_ROOT = oldRoot;
    if (oldPython === undefined) delete process.env.OMNI_TTS_PYTHON; else process.env.OMNI_TTS_PYTHON = oldPython;
    setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => audio });
    await rm(root, { recursive: true, force: true });
  }
});
test("hard deadline aborts worker and reports timeout", async context => {
  let began!: () => void;
  const started = new Promise<void>(resolve => began = resolve);
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async (_r, signal) => {
    began(); return new Promise(resolve => signal.addEventListener("abort", () => resolve(audio), { once: true }));
  } });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = synthesizeVoice("timeout-fixture", request(), new AbortController().signal);
  await started;
  context.mock.timers.tick(VOICE_LIMITS.timeoutMs);
  await assert.rejects(pending, (e: unknown) => e instanceof VoiceError && e.code === "voice_timeout");
  context.mock.timers.reset();
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => audio });
});
test("named config helper dry-run preserves all values; apply backs up and updates paths only", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "voice-config-fixture-"));
  try {
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "tools", "tts_tool.py"), "# fixture\n");
    const original = "FIXTURE_TOKEN=@keychain:fixture\nOTHER_FLAG=unchanged\n";
    await writeFile(join(root, ".env.tmpl"), original);
    await writeFile(join(root, ".env"), "FIXTURE_TOKEN=synthetic-secret-never-print\n");
    const python = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
    const args = [resolve("scripts/configure-omni-tts.py"), "--server-dir", root, "--hermes-root", root, "--python", python];
    const dry = execFileSync(python, args, { encoding: "utf8" });
    assert.doesNotMatch(dry, /synthetic-secret|@keychain/);
    assert.equal(await readFile(join(root, ".env.tmpl"), "utf8"), original);
    assert.equal((await readdir(root)).includes("omni-tts-config-backups"), false);
    const result = execFileSync(python, [...args, "--apply"], { encoding: "utf8" });
    assert.doesNotMatch(result, /synthetic-secret|@keychain/);
    const updated = await readFile(join(root, ".env.tmpl"), "utf8");
    assert.ok(updated.startsWith(original));
    assert.ok(updated.includes(`OMNI_TTS_HERMES_ROOT=${root}\n`));
    assert.equal(await readFile(join(root, ".env"), "utf8"), "FIXTURE_TOKEN=synthetic-secret-never-print\n");
    assert.equal((await stat(join(root, ".env.tmpl"))).mode & 0o777, 0o600);
    const [backup] = await readdir(join(root, "omni-tts-config-backups"));
    assert.equal(await readFile(join(root, "omni-tts-config-backups", backup!, ".env.tmpl"), "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
