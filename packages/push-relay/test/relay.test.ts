/**
 * The relay end to end against in-memory shards and a FAKE APNs — nothing here
 * reaches Apple or Cloudflare. Requests are signed with node:crypto (the way the
 * Prism Server signs them), verified by the relay's WebCrypto code.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, randomBytes, type KeyObject } from "node:crypto";
import { createRelay, readBody, type RelayEnv } from "../src/relay";
import { MAX_NONCES, MAX_SERVERS_PER_DEVICE, memoryStorage, runShard, type ShardStorage } from "../src/shard";
import { parseSendRequest } from "../src/schema";
import { _resetApnsCaches, TOKEN_BUCKET_MS, type FetchLike } from "../src/apns";
import { SIGNING_CONTEXT } from "../src/auth";

const T0 = 1_800_000_000_000;
const TOKEN = "a".repeat(32) + "0123456789abcdef".repeat(2);
const TOKEN2 = "b".repeat(64);
const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const APNS_ENV: RelayEnv = {
  APNS_KEY_P8: apnsKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  APNS_KEY_ID: "ABC123DEFG",
  APNS_TEAM_ID: "TEAM123456",
  APNS_TOPIC: "com.example.prism",
  ADMIN_TOKEN: "admin-secret",
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}
let shards: Map<string, ShardStorage & { map: Map<string, unknown> }>;
let apnsCalls: Captured[];
let apnsReply: () => Promise<{ status: number; text(): Promise<string> }>;
let now: number;
let logs: string[];

beforeEach(() => {
  shards = new Map();
  apnsCalls = [];
  apnsReply = async () => ({ status: 200, text: async () => "" });
  now = T0;
  logs = [];
  _resetApnsCaches();
});

function relay(env: RelayEnv = APNS_ENV) {
  const fakeFetch: FetchLike = async (url, init) => {
    apnsCalls.push({ url, headers: init.headers, body: init.body });
    return apnsReply();
  };
  return createRelay({
    env,
    shard: async (name, op) => {
      let s = shards.get(name);
      if (!s) shards.set(name, (s = memoryStorage()));
      return runShard(s, op);
    },
    fetch: fakeFetch,
    now: () => now,
    log: (l) => logs.push(l),
  });
}

interface Server {
  privateKey: KeyObject;
  publicKey: string;
  id: string;
}
function newServer(): Server {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "jwk" }) as { x: string }).x; // base64url raw key
  const id = createHash("sha256").update(Buffer.from(raw, "base64url")).digest("base64url").slice(0, 22);
  return { privateKey, publicKey: raw, id };
}
function signed(s: Server, method: string, path: string, body = "", o: { nonce?: string; ts?: number; id?: string; bodyForSig?: string } = {}): Request {
  const ts = String(o.ts ?? now);
  const nonce = o.nonce ?? randomBytes(16).toString("base64url");
  const msg = [SIGNING_CONTEXT, method, path, ts, nonce, createHash("sha256").update(o.bodyForSig ?? body).digest("hex")].join("\n");
  const sig = cryptoSign(null, Buffer.from(msg), s.privateKey).toString("base64url");
  return new Request(`https://relay.test${path}`, {
    method,
    headers: { "content-type": "application/json", "x-relay-server": o.id ?? s.id, "x-relay-timestamp": ts, "x-relay-nonce": nonce, "x-relay-signature": sig },
    body: method === "GET" || method === "DELETE" ? undefined : body,
  });
}
const register = (h: ReturnType<typeof relay>, s: Server) => h(signed(s, "POST", "/v1/servers", JSON.stringify({ publicKey: s.publicKey })));
const sendBody = (o: Record<string, unknown> = {}) => JSON.stringify({ deviceToken: TOKEN, environment: "production", kind: "notification", id: "n_1-a", ...o });
const send = (h: ReturnType<typeof relay>, s: Server, body = sendBody(), o = {}) => h(signed(s, "POST", "/v1/send", body, o));

// ── schema ───────────────────────────────────────────────────────────────────
test("schema: only ids — every text/payload key is refused", () => {
  for (const extra of ["alert", "title", "body", "url", "payload", "aps", "sound", "text", "category"]) {
    assert.equal(parseSendRequest(sendBody({ [extra]: "hi" })).ok, false, extra);
  }
  assert.equal(parseSendRequest(sendBody({ deviceToken: "zz".repeat(32) })).ok, false);
  assert.equal(parseSendRequest(sendBody({ deviceToken: "a".repeat(63) })).ok, false);
  assert.equal(parseSendRequest(sendBody({ environment: "dev" })).ok, false);
  assert.equal(parseSendRequest(sendBody({ kind: "custom" })).ok, false);
  for (const bad of ["", "a/b", "a b", "../x", "x".repeat(65), 5, null]) assert.equal(parseSendRequest(sendBody({ id: bad })).ok, false, String(bad));
  assert.equal(parseSendRequest(sendBody({ kind: "agent", id: "not-a-uuid" })).ok, false);
  assert.equal(parseSendRequest(JSON.stringify({ deviceToken: TOKEN, environment: "sandbox", kind: "test", id: "x" })).ok, false);
  const ok = parseSendRequest(sendBody({ deviceToken: TOKEN.toUpperCase(), kind: "agent", id: SESSION.toUpperCase() }));
  assert.deepEqual(ok, { ok: true, value: { deviceToken: TOKEN, environment: "production", kind: "agent", id: SESSION } });
  assert.equal(parseSendRequest("[1]").ok, false);
  assert.equal(parseSendRequest("nope").ok, false);
});

// ── registration ─────────────────────────────────────────────────────────────
test("register: a signed public key gets its derived id; re-registering is idempotent", async () => {
  const h = relay();
  const s = newServer();
  const r = await register(h, s);
  assert.equal(r.status, 201);
  assert.equal(((await r.json()) as { serverId: string }).serverId, s.id);
  assert.equal((await register(h, s)).status, 201);
  const st = await h(signed(s, "GET", "/v1/servers/self"));
  assert.equal(st.status, 200);
  assert.deepEqual(await st.json(), { serverId: s.id, createdAt: T0, revoked: false });
});

test("register: proof of possession, matching id, fresh timestamp", async () => {
  const h = relay();
  const s = newServer();
  const other = newServer();
  const body = JSON.stringify({ publicKey: s.publicKey });
  // Signed by another key.
  assert.equal((await h(signed(other, "POST", "/v1/servers", body, { id: s.id }))).status, 401);
  // Header id not derived from the key.
  assert.equal((await h(signed(s, "POST", "/v1/servers", body, { id: other.id }))).status, 401);
  // Stale.
  assert.equal((await h(signed(s, "POST", "/v1/servers", body, { ts: T0 - 6 * 60_000 }))).status, 401);
  // Extra keys.
  assert.equal((await h(signed(s, "POST", "/v1/servers", JSON.stringify({ publicKey: s.publicKey, name: "x" })))).status, 400);
  assert.equal(shards.size > 0 && [...shards.keys()].some((k) => k.startsWith("srv:")), false, "nothing registered");
});

test("register: REGISTRATION_SECRET makes the relay invite-only; per-IP limit", async () => {
  const h = relay({ ...APNS_ENV, REGISTRATION_SECRET: "invite", REGISTRATIONS_PER_IP_PER_DAY: "2" });
  const s = newServer();
  assert.equal((await register(h, s)).status, 401);
  const withSecret = (srv: Server) => {
    const req = signed(srv, "POST", "/v1/servers", JSON.stringify({ publicKey: srv.publicKey }));
    req.headers.set("authorization", "Bearer invite");
    req.headers.set("cf-connecting-ip", "198.51.100.7");
    return h(req);
  };
  assert.equal((await withSecret(s)).status, 201);
  assert.equal((await withSecret(newServer())).status, 201);
  const third = await withSecret(newServer());
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get("retry-after")) > 0);
});

// ── send ─────────────────────────────────────────────────────────────────────
test("send: the relay writes the whole APNs request — fixed copy, ids only", async () => {
  const h = relay();
  const s = newServer();
  await register(h, s);
  const r = await send(h, s);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { result: "sent" });
  assert.equal(apnsCalls.length, 1);
  const c = apnsCalls[0]!;
  assert.equal(c.url, `https://api.push.apple.com/3/device/${TOKEN}`);
  assert.deepEqual(JSON.parse(c.body), {
    aps: { alert: { title: "Prism", body: "You have a new notification" }, sound: "default", "thread-id": "prism-inbox" },
    type: "notification",
    notificationId: "n_1-a",
    url: "/inbox/n_1-a",
  });
  assert.equal(c.headers["apns-topic"], "com.example.prism");
  assert.equal(c.headers["apns-push-type"], "alert");
  assert.equal(c.headers["apns-priority"], "10");
  assert.equal(c.headers["apns-collapse-id"], "notification-n_1-a");
  assert.equal(c.headers["apns-expiration"], String(T0 / 1000 + 86400));
  // The provider JWT: ES256 over the bucketed iat, verifiable with the .p8's public key.
  const jwt = c.headers.authorization!.replace(/^bearer /, "");
  const [hd, cl, sg] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(hd!, "base64url").toString()), { alg: "ES256", kid: "ABC123DEFG" });
  assert.deepEqual(JSON.parse(Buffer.from(cl!, "base64url").toString()), { iss: "TEAM123456", iat: Math.floor(Math.floor(T0 / TOKEN_BUCKET_MS) * TOKEN_BUCKET_MS / 1000) });
  assert.ok(cryptoVerify("sha256", Buffer.from(`${hd}.${cl}`), { key: apnsKey.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sg!, "base64url")));
});

test("send: agent kinds and test map to the server's own payloads; sandbox host", async () => {
  const h = relay();
  const s = newServer();
  await register(h, s);
  await send(h, s, sendBody({ kind: "agent", id: SESSION, environment: "sandbox" }));
  await send(h, s, sendBody({ kind: "agent-attention", id: SESSION }));
  await send(h, s, JSON.stringify({ deviceToken: TOKEN, environment: "production", kind: "test" }));
  assert.equal(apnsCalls[0]!.url, `https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
  assert.deepEqual(JSON.parse(apnsCalls[0]!.body), {
    aps: { alert: { title: "Prism", body: "Your agent finished" }, sound: "default", "thread-id": SESSION },
    type: "agent-turn",
    sessionId: SESSION,
    url: `/agent/${SESSION}`,
  });
  assert.equal(apnsCalls[0]!.headers["apns-collapse-id"], `agent-${SESSION}`);
  assert.equal(JSON.parse(apnsCalls[1]!.body).aps.alert.body, "Agent needs attention");
  assert.deepEqual(JSON.parse(apnsCalls[2]!.body), { aps: { alert: { title: "Prism", body: "Notifications are working" }, sound: "default" }, type: "test" });
  // A 64-char notification id would exceed the 64-byte collapse id: hashed like the server does.
  await send(h, s, sendBody({ id: "x".repeat(64) }));
  assert.match(apnsCalls[3]!.headers["apns-collapse-id"]!, /^h-[0-9a-f]{40}$/);
});

test("send: tampered body, unknown server, replayed nonce, stale timestamp → 401, APNs untouched", async () => {
  const h = relay();
  const s = newServer();
  await register(h, s);
  assert.equal((await send(h, s, sendBody({ id: "other" }), { bodyForSig: sendBody() })).status, 401);
  assert.equal((await send(h, newServer())).status, 401);
  assert.equal((await send(h, s, sendBody(), { ts: T0 + 6 * 60_000 })).status, 401);
  assert.equal(apnsCalls.length, 0);
  const nonce = randomBytes(16).toString("base64url");
  assert.equal((await send(h, s, sendBody(), { nonce })).status, 200);
  assert.equal((await send(h, s, sendBody(), { nonce })).status, 401);
  assert.equal(apnsCalls.length, 1);
  // A query string is never accepted (it would not be signed).
  assert.equal((await h(new Request("https://relay.test/v1/send?x=1", { method: "POST", body: sendBody() }))).status, 400);
});

test("send: body cap, schema before auth", async () => {
  const h = relay();
  const s = newServer();
  await register(h, s);
  assert.equal((await send(h, s, JSON.stringify({ pad: "x".repeat(2000) }))).status, 413);
  const bad = await send(h, s, sendBody({ alert: { body: "secret text" } }));
  assert.equal(bad.status, 400);
  assert.equal(apnsCalls.length, 0);
});

test("APNs outcomes: 410/BadDeviceToken → pruned, 5xx/429/403/network → 503 retryable, other 4xx → failed", async () => {
  // Eight sends to one device from one server inside a minute: give this server the whole device budget.
  const h = relay({ ...APNS_ENV, DEVICE_SERVER_SENDS_PER_MINUTE: "10" });
  const s = newServer();
  await register(h, s);
  const cases: Array<[number, string, number, unknown]> = [
    [410, '{"reason":"Unregistered"}', 200, { result: "pruned", reason: "Unregistered" }],
    [400, '{"reason":"BadDeviceToken"}', 200, { result: "pruned", reason: "BadDeviceToken" }],
    [400, '{"reason":"DeviceTokenNotForTopic"}', 200, { result: "pruned", reason: "DeviceTokenNotForTopic" }],
    [400, '{"reason":"PayloadEmpty"}', 200, { result: "failed", reason: "400 PayloadEmpty" }],
    [500, "", 503, { error: "unavailable", reason: "500" }],
    [429, '{"reason":"TooManyRequests"}', 503, { error: "unavailable", reason: "429 TooManyRequests" }],
    [403, '{"reason":"ExpiredProviderToken"}', 503, { error: "unavailable", reason: "403 ExpiredProviderToken" }],
  ];
  for (const [status, text, want, body] of cases) {
    apnsReply = async () => ({ status, text: async () => text });
    const r = await send(h, s);
    assert.equal(r.status, want, `${status} ${text}`);
    assert.deepEqual(await r.json(), body);
  }
  apnsReply = async () => {
    throw new Error(`connect failed to ${TOKEN}`);
  };
  const r = await send(h, s);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "unavailable", reason: "Network" });
});

test("provider token: one per 30-minute bucket, shared iat across isolates", async () => {
  const h = relay();
  const s = newServer();
  await register(h, s);
  await send(h, s);
  now = T0 + 60_000;
  await send(h, s);
  assert.equal(apnsCalls[0]!.headers.authorization, apnsCalls[1]!.headers.authorization);
  _resetApnsCaches(); // a "new isolate" mints its own copy with the same claims
  await send(h, s);
  const claims = (a: string) => a.split(".")[1];
  assert.equal(claims(apnsCalls[2]!.headers.authorization!), claims(apnsCalls[0]!.headers.authorization!));
  now = T0 + TOKEN_BUCKET_MS;
  await send(h, s);
  assert.notEqual(claims(apnsCalls[3]!.headers.authorization!), claims(apnsCalls[0]!.headers.authorization!));
});

// ── limits ───────────────────────────────────────────────────────────────────
test("rate limits: per server and per device token (across servers), with Retry-After", async () => {
  const h = relay({ ...APNS_ENV, SERVER_SENDS_PER_MINUTE: "3", DEVICE_SENDS_PER_MINUTE: "2" });
  const a = newServer();
  const b = newServer();
  await register(h, a);
  await register(h, b);
  assert.equal((await send(h, a)).status, 200);
  assert.equal((await send(h, b)).status, 200);
  const dev = await send(h, a);
  assert.equal(dev.status, 429);
  assert.equal(((await dev.json()) as { scope: string }).scope, "device");
  assert.equal((await send(h, a, sendBody({ deviceToken: TOKEN2 }))).status, 200);
  const srv = await send(h, a, sendBody({ deviceToken: TOKEN2 }));
  assert.equal(srv.status, 429);
  assert.equal(((await srv.json()) as { scope: string }).scope, "server");
  assert.ok(Number(srv.headers.get("retry-after")) > 0);
  now = T0 + 60_000;
  assert.equal((await send(h, a, sendBody({ deviceToken: TOKEN2 }))).status, 200);
});

// ── revocation ───────────────────────────────────────────────────────────────
test("revoke: a server can revoke itself; admin revoke / restore; admin needs the token", async () => {
  const h = relay();
  const s = newServer();
  await register(h, s);
  const del = await h(signed(s, "DELETE", "/v1/servers/self"));
  assert.deepEqual(await del.json(), { serverId: s.id, revoked: true });
  assert.equal((await send(h, s)).status, 403);
  assert.equal((await register(h, s)).status, 403, "a revoked key cannot re-register");
  const adm = (path: string, method = "POST", token = "admin-secret") =>
    h(new Request(`https://relay.test${path}`, { method, headers: { authorization: `Bearer ${token}` } }));
  assert.equal((await adm(`/v1/admin/servers/${s.id}`, "GET", "wrong")).status, 401);
  const st = (await (await adm(`/v1/admin/servers/${s.id}`, "GET")).json()) as { revokedBy: string };
  assert.equal(st.revokedBy, "self");
  assert.equal((await adm(`/v1/admin/servers/${s.id}/restore`)).status, 200);
  assert.equal((await send(h, s)).status, 200);
  assert.equal((await adm(`/v1/admin/servers/${s.id}/revoke`)).status, 200);
  assert.equal((await send(h, s)).status, 403);
  assert.equal((await adm(`/v1/admin/servers/${"x".repeat(22)}`, "GET")).status, 404);
  const noAdmin = relay({ ...APNS_ENV, ADMIN_TOKEN: undefined });
  assert.equal((await noAdmin(new Request(`https://relay.test/v1/admin/servers/${s.id}`, { headers: { authorization: "Bearer " } }))).status, 404);
});

test("kill switch and missing APNs secrets answer 503 (retryable)", async () => {
  const s = newServer();
  const paused = relay({ ...APNS_ENV, RELAY_PAUSED: "true" });
  await register(paused, s);
  assert.equal((await send(paused, s)).status, 503);
  const unconfigured = relay({ ADMIN_TOKEN: "x" });
  await register(unconfigured, s);
  const r = await send(unconfigured, s);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "apns_unconfigured" });
  assert.deepEqual(await (await unconfigured(new Request("https://relay.test/health"))).json(), { ok: true, apns: false });
  assert.equal(apnsCalls.length, 0);
});

// ── privacy ──────────────────────────────────────────────────────────────────
test("privacy: no device token or id is stored or logged — only hashes name the shards", async () => {
  const h = relay();
  const s = newServer();
  await register(h, s);
  await send(h, s);
  await send(h, s, sendBody({ kind: "agent", id: SESSION }));
  apnsReply = async () => ({ status: 410, text: async () => "" });
  await send(h, s);
  const stored = JSON.stringify([...shards.entries()].map(([k, v]) => [k, [...v.map.entries()]]));
  for (const secret of [TOKEN, SESSION, "n_1-a"]) {
    assert.equal(stored.includes(secret), false, `stored: ${secret}`);
    assert.equal(logs.join("\n").includes(secret), false, `logged: ${secret}`);
  }
  assert.ok([...shards.keys()].some((k) => /^dev:[0-9a-f]{64}$/.test(k)));
  assert.ok(logs.some((l) => l === `[relay] send ${s.id} notification sent`));
});

test("authorize: a server full of LIVE nonces is refused (rate_limited) — no live nonce is ever evicted, so none can be replayed", async () => {
  const s = newServer();
  const store = memoryStorage();
  assert.equal((await runShard(store, { op: "register", publicKey: s.publicKey, now: T0 })).ok, true);
  const op = (nonce: string, at = T0) => {
    const message = `m\n${nonce}`;
    return { op: "authorize" as const, message, signature: cryptoSign(null, Buffer.from(message), s.privateKey).toString("base64url"), nonce, timestamp: at, now: at, limits: [] };
  };
  // Filled to the cap with live nonces (what a burst of signed, rate-limited retries leaves).
  await store.put("nonces", Array.from({ length: MAX_NONCES }, (_, i) => [`n${i}`, T0 + 60_000]));
  const full = await runShard(store, op("fresh"));
  assert.equal(full.ok === false && full.error, "rate_limited");
  const kept = store.map.get("nonces") as Array<[string, number]>;
  assert.equal(kept.length, MAX_NONCES, "nothing recorded, nothing evicted");
  assert.equal(kept[0]![0], "n0", "the oldest live nonce is still there");
  // The oldest nonce, replayed: still refused as a replay.
  const replay = await runShard(store, op("n0"));
  assert.equal(replay.ok === false && replay.error, "unauthorized");
  // Once they have expired, the server is served again.
  assert.equal((await runShard(store, op("fresh", T0 + 60_001))).ok, true);
});

// ── security follow-ups ──────────────────────────────────────────────────────
test("device budget: one server gets only its share — another server can still reach the device", async () => {
  const h = relay({ ...APNS_ENV, DEVICE_SENDS_PER_MINUTE: "4" }); // share = 2
  const noisy = newServer();
  const quiet = newServer();
  await register(h, noisy);
  await register(h, quiet);
  assert.equal((await send(h, noisy)).status, 200);
  assert.equal((await send(h, noisy)).status, 200);
  const capped = await send(h, noisy);
  assert.equal(capped.status, 429);
  assert.equal(((await capped.json()) as { scope: string }).scope, "device_server");
  assert.ok(Number(capped.headers.get("retry-after")) > 0);
  // The device's own budget is not used up: the other server still delivers.
  assert.equal((await send(h, quiet)).status, 200);
  assert.equal((await send(h, quiet)).status, 200);
  const full = await send(h, quiet);
  assert.equal(full.status, 429);
  assert.equal(((await full.json()) as { scope: string }).scope, "device");
  assert.equal(apnsCalls.length, 4);
  // A refused send spent nothing: after the window the noisy server is served again.
  now = T0 + 60_000;
  assert.equal((await send(h, noisy)).status, 200);
  // The share is never above the device's own limit.
  const h2 = relay({ ...APNS_ENV, DEVICE_SENDS_PER_MINUTE: "1", DEVICE_SERVER_SENDS_PER_MINUTE: "50" });
  const s2 = newServer();
  await register(h2, s2);
  assert.equal((await send(h2, s2, sendBody({ deviceToken: TOKEN2 }))).status, 200);
  assert.equal(((await (await send(h2, s2, sendBody({ deviceToken: TOKEN2 }))).json()) as { scope: string }).scope, "device");
});

test("device shard: servers whose windows rolled over are forgotten; the tracked set is bounded", async () => {
  const store = memoryStorage();
  const limits = [{ window: "minute" as const, max: 1000 }];
  const op = (serverId: string, at: number) => ({ op: "consumeDevice" as const, limits, perServer: { serverId, limits: [{ window: "minute" as const, max: 10 }] }, now: at });
  for (let i = 0; i < MAX_SERVERS_PER_DEVICE; i++) assert.equal((await runShard(store, op(`s${i}`, T0))).ok, true);
  const over = await runShard(store, op("one-more", T0));
  assert.equal(over.ok === false && over.scope, "device");
  assert.equal((await runShard(store, op("s0", T0))).ok, true, "a tracked server is still served");
  // A minute later every window rolled over: the map is pruned and a new server fits.
  assert.equal((await runShard(store, op("one-more", T0 + 60_000))).ok, true);
  assert.deepEqual(Object.keys(store.map.get("servers") as object), ["one-more"]);
});

test("register: a bad signature or junk is refused BEFORE the per-IP budget is charged", async () => {
  const h = relay({ ...APNS_ENV, REGISTRATIONS_PER_IP_PER_DAY: "1" });
  const fromIp = (req: Request) => {
    req.headers.set("cf-connecting-ip", "203.0.113.9");
    return h(req);
  };
  const s = newServer();
  const other = newServer();
  const body = JSON.stringify({ publicKey: s.publicKey });
  for (let i = 0; i < 5; i++) {
    assert.equal((await fromIp(signed(other, "POST", "/v1/servers", body, { id: s.id }))).status, 401, "signed by another key");
    assert.equal((await fromIp(signed(s, "POST", "/v1/servers", body, { ts: T0 - 6 * 60_000 }))).status, 401, "stale");
    assert.equal((await fromIp(new Request("https://relay.test/v1/servers", { method: "POST", body }))).status, 401, "no signature");
  }
  assert.equal([...shards.keys()].some((k) => k.startsWith("ip:")), false, "no IP budget was touched");
  assert.equal((await fromIp(signed(s, "POST", "/v1/servers", body))).status, 201, "the real registration still has its budget");
  const second = newServer();
  assert.equal((await fromIp(signed(second, "POST", "/v1/servers", JSON.stringify({ publicKey: second.publicKey })))).status, 429);
});

test("malformed or stale signing headers never reach a Durable Object", async () => {
  const h = relay();
  const s = newServer();
  const junk = [
    new Request("https://relay.test/v1/send", { method: "POST", body: sendBody(), headers: { "x-relay-server": "short", "x-relay-timestamp": String(now), "x-relay-nonce": "n".repeat(20), "x-relay-signature": "s".repeat(86) } }),
    new Request("https://relay.test/v1/servers/self", { method: "GET", headers: { "x-relay-server": "!".repeat(22) } }),
    signed(s, "POST", "/v1/send", sendBody(), { ts: T0 - 10 * 60_000 }),
    signed(s, "GET", "/v1/servers/self", "", { ts: T0 + 10 * 60_000 }),
  ];
  for (const r of junk) assert.equal((await h(r)).status, 401);
  assert.equal(shards.size, 0, "no shard was created or asked");
});

test("bodies are read as a stream with a byte cap: an oversized chunked body is cancelled, not buffered", async () => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(256).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("https://relay.test/v1/send", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert.equal(await readBody(req, 1024), null);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 8, `pulled ${pulled} chunks of 256 bytes for a 1024-byte cap`);
  // A declared length over the cap is refused without reading.
  assert.equal(await readBody(new Request("https://relay.test/x", { method: "POST", body: "x", headers: { "content-length": "999999" } }), 1024), null);
  assert.equal(await readBody(new Request("https://relay.test/x", { method: "POST", body: "hello" }), 1024), "hello");
  // Through the relay: 413, nothing sent.
  const h = relay();
  const s = newServer();
  await register(h, s);
  const big = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(chunk) });
  const r = signed(s, "POST", "/v1/send", sendBody());
  const streamed = new Request(r.url, { method: "POST", headers: r.headers, body: big, duplex: "half" } as RequestInit);
  assert.equal((await h(streamed)).status, 413);
  assert.equal(apnsCalls.length, 0);
});
