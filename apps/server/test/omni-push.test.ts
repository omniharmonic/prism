import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OMNI_ENABLED = "true";
import { omniApi } from "../src/routes/omni";
import { pushApi } from "../src/routes/push";
import { config } from "../src/config";
import { db } from "../src/db";
import { issueDeviceToken, revokeDevice } from "../src/auth/device";
import { apnsTokenForDevice, configureApns, _resetApns, sendApnsToOwner, liveApnsTokens, type ApnsRequest } from "../src/apns";
import { resetDb, makeSession, sessionCookie } from "./helpers";
const dir = mkdtempSync(join(tmpdir(), "omni-apns-test-"));
const path = join(dir, "key.p8");
writeFileSync(path, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
let requests: ApnsRequest[] = [];
beforeEach(() => {
  resetDb(); requests = [];
  configureApns({ keyPath: path, keyId: "TESTKEY123", teamId: "TEAM123456", topic: "com.benjaminlife.prism.client", transport: { send: async r => { requests.push(r); return { status: 200, body: "" }; }, close() {} } });
});
after(() => { _resetApns(); rmSync(dir, { recursive: true }); });
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const register = (api: typeof omniApi, route: string, token: string, value = "a".repeat(64)) => api.request(route, { method: "POST", headers: headers(token), body: JSON.stringify({ token: value, environment: "sandbox", topic: "attacker.topic" }) });
test("native app identity fixes registration topic and prevents cross-app mutation", async () => {
  const omni = issueDeviceToken(config.ownerEmail, "Omni phone", "omni-native");
  const prism = issueDeviceToken(config.ownerEmail, "Prism phone", "prism-native");
  assert.equal((await register(omniApi, "/push", omni.token)).status, 200);
  assert.equal((await register(pushApi, "/apns", prism.token, "b".repeat(64))).status, 200);
  assert.equal(apnsTokenForDevice(omni.id)?.application, "omni");
  assert.equal((await register(pushApi, "/apns", omni.token)).status, 403);
  assert.equal((await register(omniApi, "/push", prism.token)).status, 403);
  assert.equal((await omniApi.request("/push", { method: "DELETE", headers: headers(prism.token) })).status, 403);
  assert.equal((await pushApi.request("/apns", { method: "DELETE", headers: headers(omni.token) })).status, 403);
  await sendApnsToOwner(config.ownerEmail, { payload: { aps: { alert: "Omni has an update" }, id: "thread-1" } }, "omni");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers["apns-topic"], "com.benjaminlife.omni");
  assert.equal(requests[0]!.origin, "https://api.sandbox.push.apple.com");
  assert.equal(liveApnsTokens(config.ownerEmail).length, 1, "Prism fanout remains separate");
});
test("registration rejects browsers, non-owners and invalid data; expired/revoked devices never receive pushes", async () => {
  const device = issueDeviceToken(config.ownerEmail, "Omni", "omni-native");
  assert.equal((await omniApi.request("/push", { method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie(makeSession(config.ownerEmail)) }, body: "{}" })).status, 403);
  assert.equal((await register(omniApi, "/push", device.token, "invalid")).status, 400);
  const other = issueDeviceToken("other@example.com", "Other", "omni-native");
  assert.equal((await register(omniApi, "/push", other.token)).status, 403);
  await register(omniApi, "/push", device.token);
  db.prepare("UPDATE device_tokens SET expires_at = 0 WHERE id = ?").run(device.id);
  assert.equal(liveApnsTokens(config.ownerEmail, "omni").length, 0);
  await revokeDevice(device.id);
  assert.equal(apnsTokenForDevice(device.id), null);
});

test("push registration requires authentication, caps input and limits replacement churn", async () => {
  assert.equal((await omniApi.request("/push", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const device = issueDeviceToken(config.ownerEmail, "Omni", "omni-native");
  assert.equal((await omniApi.request("/push", { method: "POST", headers: headers(device.token), body: JSON.stringify({ padding: "x".repeat(512 * 1024) }) })).status, 400);
  for (let i = 0; i < 19; i++) assert.equal((await register(omniApi, "/push", device.token)).status, 200);
  const limited = await register(omniApi, "/push", device.token);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("Retry-After"));
});

test("invalid-token pruning cannot delete another app or signing environment", async () => {
  const sandbox = issueDeviceToken(config.ownerEmail, "Omni sandbox", "omni-native");
  const production = issueDeviceToken(config.ownerEmail, "Omni production", "omni-native");
  const prism = issueDeviceToken(config.ownerEmail, "Prism", "prism-native");
  const token = "a".repeat(64);
  await register(omniApi, "/push", sandbox.token, token);
  await omniApi.request("/push", { method: "POST", headers: headers(production.token), body: JSON.stringify({ token, environment: "production" }) });
  await register(pushApi, "/apns", prism.token, token);
  assert.equal(liveApnsTokens(config.ownerEmail, "omni").length, 2);
  configureApns({ transport: { send: async r => ({ status: r.origin.includes("sandbox") ? 410 : 200, body: "" }), close() {} } });
  await sendApnsToOwner(config.ownerEmail, { payload: { aps: { alert: "An update" } } }, "omni");
  assert.equal(apnsTokenForDevice(sandbox.id), null);
  assert.equal(apnsTokenForDevice(production.id)?.application, "omni");
  assert.equal(apnsTokenForDevice(prism.id)?.application, "prism");
});


test("preview opt-in is device-scoped, validated and retained on token refresh", async () => {
  const phone = issueDeviceToken(config.ownerEmail, "Phone", "omni-native");
  const mac = issueDeviceToken(config.ownerEmail, "Mac", "omni-native");
  await register(omniApi, "/push", phone.token);
  await register(omniApi, "/push", mac.token, "b".repeat(64));
  assert.equal(apnsTokenForDevice(phone.id)?.preview, "generic");
  const set = (preview: unknown) => omniApi.request("/push", { method: "POST", headers: headers(phone.token), body: JSON.stringify({ token: "a".repeat(64), environment: "sandbox", preview, deviceId: mac.id }) });
  assert.equal((await set("title_preview")).status, 200);
  assert.equal(apnsTokenForDevice(phone.id)?.preview, "title_preview");
  assert.equal(apnsTokenForDevice(mac.id)?.preview, "generic", "caller cannot select another device");
  await register(omniApi, "/push", phone.token);
  assert.equal(apnsTokenForDevice(phone.id)?.preview, "title_preview");
  for (const bad of ["everything", null, {}, 1]) assert.equal((await set(bad)).status, 400);
  assert.equal((await set("generic")).status, 200);
  assert.equal(apnsTokenForDevice(phone.id)?.preview, "generic");
});

test("mixed device preferences produce distinct private alerts, owner/app scoped", async () => {
  const { omniNotification, subscribeNotices, publishNotice } = await import("../src/omni/bus");
  const generic = issueDeviceToken(config.ownerEmail, "Private", "omni-native");
  const rich = issueDeviceToken(config.ownerEmail, "Rich", "omni-native");
  const title = issueDeviceToken(config.ownerEmail, "Title", "omni-native");
  await register(omniApi, "/push", generic.token);
  for (const [device, preview, token] of [[rich, "title_preview", "b"], [title, "title", "c"]] as const) {
    await omniApi.request("/push", { method: "POST", headers: headers(device.token), body: JSON.stringify({ token: token.repeat(64), environment: "sandbox", preview }) });
  }
  const stranger = issueDeviceToken("other@example.com", "Other", "omni-native");
  const { saveApnsToken } = await import("../src/apns");
  saveApnsToken({ deviceId: stranger.id, token: "d".repeat(64), environment: "sandbox", application: "omni", email: "other@example.com", vaultId: "test", preview: "title_preview" });
  const notices: unknown[] = [];
  const stop = subscribeNotices(n => notices.push(n));
  publishNotice({ type: "thread", id: "thread", op: "done" });
  stop();
  await sendApnsToOwner(config.ownerEmail, row => omniNotification("OMNI_THREAD", "thread", row.preview, "Planning", "The answer is ready."), "omni");
  assert.equal(requests.length, 3);
  const alerts = requests.map(r => JSON.parse(r.body).aps.alert);
  assert.deepEqual(alerts, [
    { title: "Omni", body: "Omni has an update" },
    { title: "Planning", body: "The answer is ready." },
    { title: "Planning", body: "Omni has an update" },
  ]);
  assert.deepEqual(notices, [{ type: "thread", id: "thread", op: "done" }]);
});

test("bounded plain-text previews omit code, controls and paths with generic fallback", async () => {
  const { omniNotification, notificationText } = await import("../src/omni/bus");
  const alert = (reply?: string, kind: "OMNI_THREAD" | "OMNI_APPROVAL" = "OMNI_THREAD") => (omniNotification(kind, "thread", "title_preview", "Private title", reply).payload.aps as { alert: { title: string; body: string } }).alert;
  for (const reply of [undefined, "", "```swift\nlet secret = 1\n```", "`command`", "/tmp/reply.wav", "file:///private/reply.mp3", "[Audio](/tmp/reply.wav)", "![Audio](/tmp/reply.wav)"]) {
    assert.deepEqual(alert(reply), { title: "Omni", body: "Omni has an update" });
  }
  assert.deepEqual(alert("Final answer", "OMNI_APPROVAL"), { title: "Omni", body: "A draft is waiting for your review" });
  assert.equal(notificationText("**Ready**\n[Details](https://example.com) /tmp/audio.wav `code`\u202E\u0000", 180), "Ready Details");
  const text = notificationText("😀".repeat(500), 180);
  assert.equal(Array.from(text).length, 180);
  assert.ok(text.endsWith("…"));
  const longTitle = omniNotification("OMNI_THREAD", "thread", "title_preview", "😀".repeat(200), "😀".repeat(500));
  assert.ok(Buffer.byteLength(JSON.stringify(longTitle.payload)) < 4096);
});


test("transport failures cannot log opted-in reply or title content", async () => {
  const { omniNotification } = await import("../src/omni/bus");
  const { sendApns } = await import("../src/apns");
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  configureApns({ sleep: async () => {}, transport: { send: async r => { throw new Error(`request failed ${r.body}`); }, close() {} } });
  try {
    await sendApns({ token: "a".repeat(64), environment: "sandbox", application: "omni" }, omniNotification("OMNI_THREAD", "thread", "title_preview", "PRIVATE_TITLE", "PRIVATE_REPLY"));
    assert.ok(logs.length);
    assert.ok(!logs.join(" ").includes("PRIVATE_TITLE"));
    assert.ok(!logs.join(" ").includes("PRIVATE_REPLY"));
  } finally { console.error = original; }
});
