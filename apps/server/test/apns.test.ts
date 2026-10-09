/**
 * APNs (iOS push, WP5 server side): provider JWT, request shape, response
 * handling, device-bound registration, revoke, privacy. A FAKE transport is
 * injected everywhere except the HTTP/2 transport test, which talks to a local
 * cleartext HTTP/2 server on 127.0.0.1 — nothing ever reaches Apple.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { pushApi } from "../src/routes/push";
import { config } from "../src/config";
import { db } from "../src/db";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import { issueDeviceToken, revokeDevice } from "../src/auth/device";
import { configurePush, _resetPush, notifyTurnEnd } from "../src/push";
import { validateEnvEdit } from "../src/env-edit";
import {
  configureApns,
  _resetApns,
  apnsEnabled,
  apnsStatus,
  reportApns,
  providerToken,
  sendApns,
  saveApnsToken,
  liveApnsTokens,
  apnsTokenForDevice,
  removeApnsTokenForDevice,
  agentTurnNotification,
  http2Transport,
  tokenRef,
  JWT_REFRESH_MS,
  JWT_MIN_REMINT_MS,
  MAX_RETRIES,
  BACKOFF_MAX_MS,
  EXPIRATION_S,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from "../src/apns";

const J = { "content-type": "application/json" };
const KID = "ABC123DEFG";
const TEAM = "TEAM123456";
const TOKEN = "a".repeat(32) + "0123456789abcdef".repeat(2);
const TOKEN2 = "b".repeat(64);
const T0 = 1_800_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "prism-apns-"));
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const keyFile = join(dir, "AuthKey.p8");
writeFileSync(keyFile, pem, { mode: 0o600 });
chmodSync(keyFile, 0o600);

let reqs: ApnsRequest[];
let responses: Array<ApnsResponse | "hang" | "throw">;
let clock: number;
let sleeps: number[];
let logs: string[];
const orig = { log: console.log, warn: console.warn, error: console.error };

const fake: ApnsTransport = {
  send: (r) => {
    reqs.push(r);
    const next = responses.shift() ?? { status: 200, body: "" };
    if (next === "hang") return new Promise(() => {});
    if (next === "throw") return Promise.reject(new Error(`socket hang up for /3/device/${r.path.slice(10)}`));
    return Promise.resolve(next);
  },
  close: () => {},
};

function enable(extra: Parameters<typeof configureApns>[0] = {}) {
  configureApns({ transport: fake, keyPath: keyFile, keyId: KID, teamId: TEAM, topic: "com.benjaminlife.prism.client", now: () => clock, sleep: async (ms) => void sleeps.push(ms), ...extra });
}

beforeEach(() => {
  resetDb();
  reqs = [];
  responses = [];
  clock = T0;
  sleeps = [];
  logs = [];
  const cap = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.log = cap;
  console.warn = cap;
  console.error = cap;
  enable();
});
afterEach(() => {
  Object.assign(console, orig);
  _resetApns();
  _resetPush();
});

const parseJwt = (jwt: string) => {
  const [h, c, s] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), claims: JSON.parse(Buffer.from(c!, "base64url").toString()), signed: `${h}.${c}`, sig: Buffer.from(s!, "base64url") };
};
const verifies = (jwt: string, key: KeyObject = publicKey) => {
  const p = parseJwt(jwt);
  return cryptoVerify("sha256", Buffer.from(p.signed), { key, dsaEncoding: "ieee-p1363" }, p.sig);
};
const device = (email = config.ownerEmail, label = "iPhone") => issueDeviceToken(email, label, "prism-native");
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const apnsCount = () => (db.prepare("SELECT count(*) n FROM apns_tokens").get() as { n: number }).n;
const row = (environment: "sandbox" | "production" = "production", token = TOKEN) => ({ token, environment });

// ── provider token ───────────────────────────────────────────────────────────
test("JWT: ES256 header (kid), claims (iss, iat), signature verifies with the key's public half", () => {
  const jwt = providerToken()!;
  const p = parseJwt(jwt);
  assert.deepEqual(p.header, { alg: "ES256", kid: KID });
  assert.deepEqual(p.claims, { iss: TEAM, iat: Math.floor(T0 / 1000) });
  assert.equal(p.sig.length, 64, "raw r||s (IEEE P1363), not DER");
  assert.ok(verifies(jwt));
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
  assert.equal(verifies(jwt, other), false);
});

test("JWT: cached until 50 min, then re-minted (never per request)", () => {
  const a = providerToken();
  clock = T0 + JWT_REFRESH_MS - 1;
  assert.equal(providerToken(), a);
  clock = T0 + JWT_REFRESH_MS;
  const b = providerToken()!;
  assert.notEqual(b, a);
  assert.equal(parseJwt(b).claims.iat, Math.floor((T0 + JWT_REFRESH_MS) / 1000));
  assert.ok(JWT_REFRESH_MS < 60 * 60_000 && JWT_REFRESH_MS >= JWT_MIN_REMINT_MS);
});

// ── configuration ────────────────────────────────────────────────────────────
test("disabled when unconfigured (silently), and notifyTurnEnd sends nothing", async () => {
  _resetApns();
  configureApns({ transport: fake, keyPath: "", keyId: "", teamId: "" });
  assert.equal(apnsEnabled(), false);
  assert.deepEqual(apnsStatus(), { enabled: false, configured: false, reason: "not configured" });
  assert.equal(providerToken(), null);
  reportApns();
  assert.ok(logs.some((l) => l.includes("apns:   off")));
  assert.ok(!logs.some((l) => l.includes("WARNING")));
  const d = device();
  saveApnsToken({ deviceId: d.id, token: TOKEN, environment: "production", email: config.ownerEmail, vaultId: "primary" });
  seedSession();
  notifyTurnEnd("s1", "t1", "done");
  await sleep(5);
  assert.equal(reqs.length, 0);
  assert.equal(await sendApns(row(), agentTurnNotification("s1", "t1", "done")), "failed");
  assert.equal(reqs.length, 0);
});

test("partial config / malformed ids are refused with a reason", () => {
  for (const [o, re] of [
    [{ keyId: "" }, /missing APNS_KEY_ID/],
    [{ teamId: "short" }, /APNS_TEAM_ID/],
    [{ keyId: "abc123defg" }, /APNS_KEY_ID/],
    [{ topic: "bad topic!" }, /APNS_TOPIC/],
    [{ keyPath: join(dir, "missing.p8") }, /unreadable \(ENOENT\)/],
  ] as const) {
    _resetApns();
    enable(o);
    const s = apnsStatus();
    assert.equal(s.enabled, false);
    assert.equal(s.configured, true);
    assert.match(s.reason!, re);
  }
});

test("key file must be 0600 or stricter: 0644/0640 refused with a startup warning that never shows the key", () => {
  const loose = join(dir, "loose.p8");
  writeFileSync(loose, pem);
  for (const mode of [0o644, 0o640, 0o604]) {
    chmodSync(loose, mode);
    _resetApns();
    enable({ keyPath: loose });
    assert.equal(apnsEnabled(), false);
    assert.match(apnsStatus().reason!, /too open — run chmod 600/);
  }
  logs = [];
  reportApns();
  assert.ok(logs.some((l) => l.includes("WARNING: APNs is DISABLED") && l.includes("chmod 600")));
  const keyBody = pem.split("\n")[1]!;
  assert.ok(!logs.join("\n").includes(keyBody));
  chmodSync(loose, 0o400);
  _resetApns();
  enable({ keyPath: loose });
  assert.equal(apnsEnabled(), true, "0400 is stricter than 0600 and accepted");
});

test("a non-EC or non-P-256 key is refused; a garbage file never echoes its content", () => {
  const rsa = join(dir, "rsa.p8");
  writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  _resetApns();
  enable({ keyPath: rsa });
  assert.match(apnsStatus().reason!, /not an EC P-256/);
  const junk = join(dir, "junk.p8");
  writeFileSync(junk, "SECRET-JUNK-CONTENT", { mode: 0o600 });
  _resetApns();
  enable({ keyPath: junk });
  assert.equal(apnsEnabled(), false);
  assert.ok(!apnsStatus().reason!.includes("SECRET-JUNK"));
});

test("APNS_* are host bootstrap config: none is editable via PUT /acl/server/config", () => {
  for (const k of ["APNS_KEY_PATH", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC"]) {
    assert.deepEqual(validateEnvEdit(k, "x"), { ok: false, error: "not_editable" }, k);
  }
  assert.equal(config.apnsTopic, "com.benjaminlife.prism.client", "default topic (APNS_TOPIC unset in .env.test)");
});

// ── request shape ────────────────────────────────────────────────────────────
test("request: origin per environment, path, headers and ids-only payload are exact", async () => {
  assert.equal(await sendApns(row("production"), agentTurnNotification("sess-1", "turn-9", "done")), "sent");
  assert.equal(await sendApns(row("sandbox"), agentTurnNotification("sess-1", "turn-10", "error")), "sent");
  const [p, s] = reqs;
  assert.equal(p!.origin, "https://api.push.apple.com");
  assert.equal(s!.origin, "https://api.sandbox.push.apple.com");
  assert.equal(p!.path, `/3/device/${TOKEN}`);
  const { authorization, ...rest } = p!.headers;
  assert.match(authorization!, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(verifies(authorization!.slice(7)));
  assert.deepEqual(rest, {
    "apns-topic": "com.benjaminlife.prism.client",
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(T0 / 1000) + EXPIRATION_S),
    "apns-collapse-id": "agent-sess-1",
  });
  assert.deepEqual(JSON.parse(p!.body), {
    aps: { alert: { title: "Prism", body: "Your agent finished" }, sound: "default", "thread-id": "sess-1" },
    type: "agent-turn",
    sessionId: "sess-1",
    turnId: "turn-9",
    status: "done",
    url: "/agent/sess-1",
  });
  assert.equal(JSON.parse(s!.body).aps.alert.body, "Agent needs attention");
  assert.ok(p!.timeoutMs > 0);
});

test("collapse id stays within APNs' 64-byte limit", () => {
  const n = agentTurnNotification("x".repeat(100), "t", "done");
  assert.ok(Buffer.byteLength(n.collapseId!) <= 64);
});

// ── responses ────────────────────────────────────────────────────────────────
function registered(token = TOKEN, environment: "sandbox" | "production" = "production") {
  const d = device();
  saveApnsToken({ deviceId: d.id, token, environment, email: config.ownerEmail, vaultId: "primary" });
  return d;
}

test("410 Unregistered / 400 BadDeviceToken / 400 DeviceTokenNotForTopic delete the token; other 400s keep it", async () => {
  for (const r of [
    { status: 410, body: JSON.stringify({ reason: "Unregistered", timestamp: 1 }) },
    { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) },
    { status: 400, body: JSON.stringify({ reason: "DeviceTokenNotForTopic" }) },
  ]) {
    resetDb();
    const d = registered();
    responses = [r];
    assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "pruned");
    assert.equal(apnsTokenForDevice(d.id), null);
  }
  resetDb();
  const d = registered();
  reqs = [];
  responses = [{ status: 400, body: JSON.stringify({ reason: "PayloadTooLarge" }) }];
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "failed");
  assert.ok(apnsTokenForDevice(d.id));
  assert.equal(reqs.length, 1, "a non-retryable 400 is not retried");
});

test("403 ExpiredProviderToken re-mints the JWT ONCE and retries with it", async () => {
  providerToken(); // minted at T0
  clock = T0 + JWT_MIN_REMINT_MS + 1; // still cached (< 50 min) but old enough to update
  responses = [{ status: 403, body: '{"reason":"ExpiredProviderToken"}' }, { status: 200, body: "" }];
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "sent");
  assert.equal(reqs.length, 2);
  assert.notEqual(reqs[0]!.headers.authorization, reqs[1]!.headers.authorization);
  assert.equal(parseJwt(reqs[1]!.headers.authorization!.slice(7)).claims.iat, Math.floor(clock / 1000));

  // Still rejected after the refresh → give up (no second mint, no loop).
  reqs = [];
  clock += JWT_MIN_REMINT_MS + 1;
  responses = [{ status: 403, body: '{"reason":"ExpiredProviderToken"}' }, { status: 403, body: '{"reason":"ExpiredProviderToken"}' }];
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "failed");
  assert.equal(reqs.length, 2);
  assert.equal(sleeps.length, 0);
});

test("403 ExpiredProviderToken right after a mint does NOT re-mint (Apple's 20-min update limit)", async () => {
  providerToken();
  clock = T0 + 60_000;
  responses = [{ status: 403, body: '{"reason":"ExpiredProviderToken"}' }];
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "failed");
  assert.equal(reqs.length, 1);
});

test("429 / 5xx / network errors: bounded retry with capped exponential backoff", async () => {
  responses = Array(10).fill({ status: 429, body: '{"reason":"TooManyRequests"}' });
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "failed");
  assert.equal(reqs.length, MAX_RETRIES + 1);
  assert.equal(sleeps.length, MAX_RETRIES);
  for (const ms of sleeps) assert.ok(ms > 0 && ms <= BACKOFF_MAX_MS);
  assert.ok(sleeps[1]! >= sleeps[0]! / 2, "backoff grows (jittered)");

  reqs = [];
  sleeps = [];
  responses = [{ status: 503, body: '{"reason":"ServiceUnavailable"}' }, "throw", { status: 200, body: "" }];
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "sent");
  assert.equal(reqs.length, 3);
  assert.equal(sleeps.length, 2);
});

test("a hung request times out (bounded) instead of hanging the fan-out", async () => {
  _resetApns();
  enable({ timeoutMs: 1 });
  responses = ["hang", "hang", "hang"];
  const t = Date.now();
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "failed");
  assert.equal(reqs.length, MAX_RETRIES + 1);
  // (No duration is asserted: the dependency here NEVER answers, so finishing at all is the proof that the deadline ended it — and a wall-clock bound fails on a busy machine without anything being wrong.)
  assert.ok(logs.some((l) => l.includes("timed out")));
});

// ── registration routes ──────────────────────────────────────────────────────
const post = (headers: Record<string, string>, body: unknown = { token: TOKEN, environment: "production" }) =>
  pushApi.request("/apns", { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });

test("register: a signed-in user's DEVICE token only; session cookie, link, anon refused", async () => {
  // Owner browser session: an APNs token belongs to a device, not a browser.
  const cookie = await post({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
  assert.equal(cookie.status, 403);
  assert.equal(((await cookie.json()) as { error: string }).error, "device_token_required");
  // Wave 2A: a member's own device may register (mentions/replies notify members);
  // the row is bound to THEIR email + device.
  const md = device("member@test.local");
  assert.equal((await post(bearer(md.token))).status, 200);
  assert.equal(apnsTokenForDevice(md.id)!.owner_email, "member@test.local");
  removeApnsTokenForDevice(md.id);
  assert.equal((await post({ authorization: `Capability ${makeCapability("note", "n1", "edit")}` })).status, 403);
  assert.equal((await post({})).status, 403);
  assert.equal((await post(bearer("pd_not-a-real-token"))).status, 403);
  assert.equal(apnsCount(), 0);

  const d = device();
  const ok = await post(bearer(d.token), { token: TOKEN.toUpperCase(), environment: "sandbox" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, apnsEnabled: true });
  const r = apnsTokenForDevice(d.id)!;
  assert.equal(r.token, TOKEN, "stored lowercase");
  assert.equal(r.environment, "sandbox");
  assert.equal(r.owner_email, config.ownerEmail);
  assert.equal(r.vault_id, "primary");
});

test("register: validation; one row per device (re-register replaces); a token moving devices is not duplicated", async () => {
  const d = device();
  for (const body of [
    { token: "xyz", environment: "production" },
    { token: "a".repeat(63), environment: "production" },
    { token: "a".repeat(202), environment: "production" },
    { token: "g".repeat(64), environment: "production" },
    { token: TOKEN, environment: "development" },
    { token: TOKEN },
    {},
  ]) {
    assert.equal((await post(bearer(d.token), body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post(bearer(d.token))).status, 200);
  assert.equal((await post(bearer(d.token), { token: TOKEN2, environment: "production" })).status, 200);
  assert.equal(apnsCount(), 1);
  assert.equal(apnsTokenForDevice(d.id)!.token, TOKEN2);
  // The app signs in again (new device credential) and re-registers the same token.
  const d2 = device();
  assert.equal((await post(bearer(d2.token), { token: TOKEN2, environment: "production" })).status, 200);
  assert.equal(apnsCount(), 1);
  assert.equal(apnsTokenForDevice(d.id), null);
});

test("register is accepted while APNs is off (reports apnsEnabled:false); /apns/test is 503", async () => {
  _resetApns();
  configureApns({ transport: fake, keyPath: "", keyId: "", teamId: "" });
  const d = device();
  const r = await post(bearer(d.token));
  assert.deepEqual(await r.json(), { ok: true, apnsEnabled: false });
  assert.equal((await pushApi.request("/apns/test", { method: "POST", headers: bearer(d.token) })).status, 503);
});

test("DELETE /apns removes only the calling device's row; /apns/test pings only this device", async () => {
  const a = device();
  const b = device(config.ownerEmail, "iPad");
  await post(bearer(a.token));
  await post(bearer(b.token), { token: TOKEN2, environment: "sandbox" });
  assert.equal((await pushApi.request("/apns/test", { method: "POST", headers: bearer(b.token) })).status, 200);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.path, `/3/device/${TOKEN2}`);
  assert.equal(reqs[0]!.origin, "https://api.sandbox.push.apple.com");
  assert.deepEqual(JSON.parse(reqs[0]!.body), { aps: { alert: { title: "Prism", body: "Notifications are working" }, sound: "default" }, type: "test" });
  const del = await pushApi.request("/apns", { method: "DELETE", headers: bearer(a.token) });
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal(apnsTokenForDevice(a.id), null);
  assert.ok(apnsTokenForDevice(b.id));
  assert.equal((await pushApi.request("/apns/test", { method: "POST", headers: bearer(a.token) })).status, 404);
  const cookie = { cookie: sessionCookie(makeSession(config.ownerEmail)) };
  assert.equal((await pushApi.request("/apns", { method: "DELETE", headers: cookie })).status, 403);
});

test("revoking the device (or its own sign-out) deletes its APNs token; expired devices are never pushed", async () => {
  const a = device();
  const b = device(config.ownerEmail, "iPad");
  await post(bearer(a.token));
  await post(bearer(b.token), { token: TOKEN2, environment: "production" });
  assert.equal(liveApnsTokens(config.ownerEmail).length, 2);
  await revokeDevice(a.id);
  assert.equal(apnsTokenForDevice(a.id), null);
  assert.ok(apnsTokenForDevice(b.id));
  // A row whose device lapsed (missed delete) is filtered at send time.
  db.prepare("UPDATE device_tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1, b.id);
  assert.equal(liveApnsTokens(config.ownerEmail).length, 0);
});

test("the device's own sign-out route (/auth/device/revoke) deletes its APNs token", async () => {
  const { deviceAuth } = await import("../src/routes/device");
  const d = device();
  await post(bearer(d.token));
  const r = await deviceAuth.request("/device/revoke", { method: "POST", headers: bearer(d.token) });
  assert.ok(r.status < 300, `revoke → ${r.status}`);
  assert.equal(apnsTokenForDevice(d.id), null);
});

// ── delivery ─────────────────────────────────────────────────────────────────
function seedSession() {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agent_sessions (id, vault_id, owner_email, title, profile, status, cost_usd, created_at, updated_at) VALUES ('s1','primary',?, 'PRIVATE TITLE about the merger','vault-rw','idle',0,?,?)",
  ).run(config.ownerEmail, now, now);
}

test("notifyTurnEnd fans out to APNs (web push off): ids only, owner's devices only, no note content, no token in logs", async () => {
  configurePush({ keys: { publicKey: "", privateKey: "", subject: "" }, sender: null });
  seedSession();
  const d = device();
  await post(bearer(d.token));
  const other = device("someone@else.test");
  saveApnsToken({ deviceId: other.id, token: TOKEN2, environment: "production", email: "someone@else.test", vaultId: "primary" });
  notifyTurnEnd("s1", "t1", "cancelled");
  notifyTurnEnd("s1", "t1", "running");
  await sleep(5);
  assert.equal(reqs.length, 0);
  responses = [{ status: 410, body: '{"reason":"Unregistered"}' }];
  notifyTurnEnd("s1", "t2", "done");
  await sleep(20);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.path, `/3/device/${TOKEN}`);
  const body = reqs[0]!.body;
  assert.ok(!body.includes("PRIVATE") && !body.includes("merger"));
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["aps", "sessionId", "status", "turnId", "type", "url"]);
  // The prune was logged by hash prefix, never the token itself.
  const all = logs.join("\n");
  assert.ok(all.includes(tokenRef(TOKEN)));
  assert.ok(!all.includes(TOKEN));
});

test("network error messages are scrubbed of the device token before logging", async () => {
  responses = ["throw", "throw", "throw"];
  assert.equal(await sendApns(row(), agentTurnNotification("s", "t", "done")), "failed");
  assert.ok(!logs.join("\n").includes(TOKEN));
  assert.ok(logs.join("\n").includes(tokenRef(TOKEN)));
});

// ── the real HTTP/2 transport (local cleartext h2 server, never Apple) ───────
test("http2Transport: one reused session, headers + body on the wire, reconnect after the server drops it", async () => {
  const seen: Array<{ headers: http2.IncomingHttpHeaders; body: string; session: unknown }> = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (c: string) => (body += c));
    stream.on("end", () => {
      seen.push({ headers, body, session: stream.session! });
      stream.respond({ ":status": headers[":path"] === "/3/device/gone" ? 410 : 200 });
      stream.end(headers[":path"] === "/3/device/gone" ? '{"reason":"Unregistered"}' : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tx = http2Transport();
  try {
    const req = (path: string) => tx.send({ origin, path, headers: { "apns-topic": "t.x", authorization: "bearer j" }, body: '{"aps":{}}', timeoutMs: 2_000 });
    assert.deepEqual(await req("/3/device/abc"), { status: 200, body: "" });
    assert.deepEqual(await req("/3/device/gone"), { status: 410, body: '{"reason":"Unregistered"}' });
    assert.equal(seen[0]!.session, seen[1]!.session, "the HTTP/2 session is reused");
    assert.equal(seen[0]!.headers[":method"], "POST");
    assert.equal(seen[0]!.headers["apns-topic"], "t.x");
    assert.equal(seen[0]!.headers["content-type"], "application/json");
    assert.equal(seen[0]!.body, '{"aps":{}}');
    (seen[1]!.session as http2.Http2Session).destroy();
    await sleep(50);
    assert.deepEqual(await req("/3/device/abc"), { status: 200, body: "" });
    assert.notEqual(seen[2]!.session, seen[0]!.session, "reconnected on a fresh session");
  } finally {
    tx.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
