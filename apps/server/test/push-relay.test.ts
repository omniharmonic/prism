/**
 * Push relay mode (decision D-I): with no direct APNs key, Prism notifications go
 * to the relay as {deviceToken, environment, kind, id}. The relay here is the REAL
 * relay handler (packages/push-relay) over in-memory shards and a FAKE APNs, wired
 * through an injected transport — nothing reaches a network.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushApi } from "../src/routes/push";
import { config } from "../src/config";
import { db } from "../src/db";
import { resetDb } from "./helpers";
import { issueDeviceToken } from "../src/auth/device";
import {
  configureApns,
  _resetApns,
  apnsEnabled,
  apnsMode,
  apnsStatus,
  sendApns,
  sendApnsToOwner,
  saveApnsToken,
  agentTurnNotification,
  notificationAlert,
  testNotification,
  type ApnsTransport,
} from "../src/apns";
import { configurePushRelay, _resetPushRelay, relayCall, relayKey, type RelayRequest, type RelayResponse, type RelayTransport } from "../src/push-relay";
import { createRelay } from "../../../packages/push-relay/src/relay";
import { memoryStorage, runShard, type ShardStorage } from "../../../packages/push-relay/src/shard";
import { _resetApnsCaches } from "../../../packages/push-relay/src/apns";

const TOKEN = "c".repeat(64);
const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const dir = mkdtempSync(join(tmpdir(), "prism-relay-"));
const relayKeyFile = join(dir, "push-relay.key");
writeFileSync(relayKeyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
chmodSync(relayKeyFile, 0o600);
const p8 = join(dir, "AuthKey.p8");
writeFileSync(p8, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
chmodSync(p8, 0o600);

const relayApnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

let relayReqs: RelayRequest[];
let apnsBodies: Array<{ url: string; body: string; topic: string }>;
let apnsStatusNext: number[];
let forced: Array<RelayResponse | "throw">;
let shards: Map<string, ShardStorage>;
let directReqs: number;
let sleeps: number[];
const orig = { log: console.log, warn: console.warn, error: console.error };
let logs: string[];

function realRelay() {
  return createRelay({
    env: { APNS_KEY_P8: relayApnsKey, APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.example.relayed" },
    shard: async (name, op) => {
      let s = shards.get(name);
      if (!s) shards.set(name, (s = memoryStorage()));
      return runShard(s, op);
    },
    fetch: async (url, init) => {
      apnsBodies.push({ url, body: init.body, topic: init.headers["apns-topic"]! });
      const status = apnsStatusNext.shift() ?? 200;
      return { status, text: async () => (status === 410 ? '{"reason":"Unregistered"}' : "") };
    },
    log: () => {},
  });
}
const transport: RelayTransport = {
  async send(r) {
    relayReqs.push(r);
    const f = forced.shift();
    if (f === "throw") throw new Error("connect ECONNREFUSED");
    if (f) return f;
    const res = await realRelay()(new Request(r.url, { method: r.method, headers: r.headers, body: r.body }));
    const ra = Number(res.headers.get("retry-after"));
    return { status: res.status, body: await res.text(), retryAfterS: ra > 0 ? ra : undefined };
  },
};
const directFake: ApnsTransport = {
  send: async () => {
    directReqs++;
    return { status: 200, body: "" };
  },
  close: () => {},
};

function relayMode() {
  configureApns({ transport: directFake, keyPath: "", keyId: "", teamId: "", topic: "", sleep: async (ms) => void sleeps.push(ms) });
  configurePushRelay({ url: "https://relay.example", keyPath: relayKeyFile, transport });
}
async function registered() {
  const k = relayKey();
  assert.ok(k.ok);
  const r = await relayCall("POST", "/v1/servers", JSON.stringify({ publicKey: k.publicKey }));
  assert.equal(r.status, 201);
  relayReqs = [];
}

beforeEach(() => {
  resetDb();
  relayReqs = [];
  apnsBodies = [];
  apnsStatusNext = [];
  forced = [];
  shards = new Map();
  directReqs = 0;
  sleeps = [];
  logs = [];
  _resetApnsCaches();
  const cap = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.log = cap;
  console.warn = cap;
  console.error = cap;
  relayMode();
});
afterEach(() => {
  Object.assign(console, orig);
  _resetApns();
  _resetPushRelay();
});

test("mode: relay only when NO direct value is set; direct wins; a refused relay key is off", () => {
  assert.equal(apnsMode(), "relay");
  assert.deepEqual(apnsStatus(), { enabled: true, configured: true, mode: "relay" });
  assert.equal(apnsEnabled(), true);
  assert.equal(apnsEnabled("prism"), true);
  assert.equal(apnsEnabled("omni"), false, "Omni notifications carry text: never relayed");

  configureApns({ keyPath: p8, keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "com.example.prism" });
  assert.equal(apnsMode(), "direct");
  assert.equal(apnsEnabled("omni"), true);
  // A direct key that is set but broken never falls back to the relay.
  configureApns({ keyId: "bad" });
  assert.equal(apnsMode(), "off");

  configureApns({ keyPath: "", keyId: "", teamId: "" });
  configurePushRelay({ url: "" });
  assert.equal(apnsMode(), "off");
  assert.equal(apnsStatus().configured, false);
  for (const url of ["http://relay.example", "https://u:p@relay.example", "https://relay.example/sub", "https://relay.example?x=1", "nope"]) {
    configurePushRelay({ url });
    assert.equal(apnsMode(), "off", url);
    assert.match(apnsStatus().reason ?? "", /push relay/);
  }
  const loose = join(dir, "loose.key");
  writeFileSync(loose, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o644 });
  chmodSync(loose, 0o644);
  configurePushRelay({ url: "https://relay.example", keyPath: loose });
  assert.equal(apnsMode(), "off");
  assert.match(apnsStatus().reason!, /chmod 600/);
  configurePushRelay({ keyPath: p8 }); // an EC key is not the relay key
  assert.match(apnsStatus().reason!, /Ed25519/);
  configurePushRelay({ keyPath: join(dir, "missing.key") });
  assert.match(apnsStatus().reason!, /push-relay:register/);
});

test("send through the REAL relay: only {deviceToken, environment, kind, id} leaves the server", async () => {
  await registered();
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, agentTurnNotification(SESSION, "turn-1", "done")), "sent");
  assert.equal(await sendApns({ token: TOKEN, environment: "sandbox" }, agentTurnNotification(SESSION, "turn-2", "error")), "sent");
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, notificationAlert("n-42")), "sent");
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, testNotification()), "sent");
  assert.equal(directReqs, 0, "no direct APNs in relay mode");
  assert.deepEqual(relayReqs.map((r) => JSON.parse(r.body!)), [
    { deviceToken: TOKEN, environment: "production", kind: "agent", id: SESSION },
    { deviceToken: TOKEN, environment: "sandbox", kind: "agent-attention", id: SESSION },
    { deviceToken: TOKEN, environment: "production", kind: "notification", id: "n-42" },
    { deviceToken: TOKEN, environment: "production", kind: "test" },
  ]);
  for (const r of relayReqs) {
    assert.equal(r.url, "https://relay.example/v1/send");
    assert.ok(!r.body!.includes("turn-"), "no turn id, no status, no text");
  }
  // What the relay wrote for Apple: the server's own generic payloads, topic from the RELAY.
  assert.equal(apnsBodies.length, 4);
  assert.equal(apnsBodies[0]!.url, `https://api.push.apple.com/3/device/${TOKEN}`);
  assert.equal(apnsBodies[1]!.url, `https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
  assert.equal(apnsBodies[0]!.topic, "com.example.relayed");
  const direct = agentTurnNotification(SESSION, "turn-1", "done").payload as { aps: unknown; sessionId: string; url: string };
  const relayed = JSON.parse(apnsBodies[0]!.body);
  assert.deepEqual(relayed.aps, direct.aps);
  assert.equal(relayed.sessionId, direct.sessionId);
  assert.equal(relayed.url, direct.url);
  assert.deepEqual(JSON.parse(apnsBodies[2]!.body), notificationAlert("n-42").payload);
  assert.deepEqual(JSON.parse(apnsBodies[3]!.body), testNotification().payload);
});

test("a notification with no relay form (Omni, anything with text) is never sent", async () => {
  await registered();
  const omni = { payload: { aps: { alert: { title: "Omni", body: "Your flight moved to 9:40" } } } };
  assert.equal(await sendApns({ token: TOKEN, environment: "production", application: "omni" }, omni), "failed");
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, omni), "failed");
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, { ...notificationAlert("x"), relay: { kind: "agent", id: "not-a-uuid" } }), "failed");
  assert.equal(relayReqs.length, 0);
  const out = await sendApnsToOwner(config.ownerEmail, omni, "omni");
  assert.deepEqual(out, { sent: 0, pruned: 0, failed: 0 });
});

test("pruned: the relay's dead-token answer deletes the row, like a direct 410", async () => {
  await registered();
  const dev = issueDeviceToken(config.ownerEmail, "iPhone", "prism-native");
  saveApnsToken({ deviceId: dev.id, token: TOKEN, environment: "production", email: config.ownerEmail, vaultId: "primary" });
  apnsStatusNext = [410];
  assert.deepEqual(await sendApnsToOwner(config.ownerEmail, notificationAlert("n1")), { sent: 0, pruned: 1, failed: 0 });
  assert.equal((db.prepare("SELECT count(*) n FROM apns_tokens").get() as { n: number }).n, 0);
  assert.ok(!logs.join("\n").includes(TOKEN), "the token is never logged");
});

test("retries: 503 / network are retried (bounded), 401 / 403 / 400 are not", async () => {
  await registered();
  forced = [{ status: 503, body: '{"error":"unavailable"}', retryAfterS: 1 }, "throw"];
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, notificationAlert("a")), "sent");
  assert.equal(relayReqs.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0]! >= 1000, "Retry-After honoured");

  relayReqs = [];
  forced = [{ status: 503, body: "" }, { status: 503, body: "" }, { status: 503, body: "" }, { status: 503, body: "" }];
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, notificationAlert("a")), "failed");
  assert.equal(relayReqs.length, 3, "at most 3 attempts");

  relayReqs = [];
  forced = [{ status: 429, body: "", retryAfterS: 3600 }];
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, notificationAlert("a")), "failed");
  assert.equal(relayReqs.length, 1, "a long Retry-After gives up for this notification");

  for (const status of [401, 403, 400]) {
    relayReqs = [];
    forced = [{ status, body: "{}" }];
    assert.equal(await sendApns({ token: TOKEN, environment: "production" }, notificationAlert("a")), "failed");
    assert.equal(relayReqs.length, 1, String(status));
  }
  assert.ok(logs.some((l) => l.includes("push-relay:register")));
});

test("unregistered server: the relay refuses with 401 and nothing reaches APNs", async () => {
  assert.equal(await sendApns({ token: TOKEN, environment: "production" }, notificationAlert("a")), "failed");
  assert.equal(apnsBodies.length, 0);
});

test("routes: registration reports apnsEnabled via the relay; the test push goes through it", async () => {
  await registered();
  const dev = issueDeviceToken(config.ownerEmail, "iPhone", "prism-native");
  const auth = { authorization: `Bearer ${dev.token}`, "content-type": "application/json" };
  const reg = await pushApi.request("/apns", { method: "POST", headers: auth, body: JSON.stringify({ token: TOKEN, environment: "production" }) });
  assert.equal(reg.status, 200);
  assert.deepEqual(await reg.json(), { ok: true, apnsEnabled: true });
  const t = await pushApi.request("/apns/test", { method: "POST", headers: auth });
  assert.deepEqual(await t.json(), { result: "sent" });
  assert.deepEqual(JSON.parse(relayReqs[0]!.body!), { deviceToken: TOKEN, environment: "production", kind: "test" });
});

test("signing: a replayed request is refused by the real relay", async () => {
  await registered();
  await sendApns({ token: TOKEN, environment: "production" }, notificationAlert("a"));
  const first = relayReqs[0]!;
  const replay = await realRelay()(new Request(first.url, { method: "POST", headers: first.headers, body: first.body }));
  assert.equal(replay.status, 401);
});

test("fetchTransport reads at most 4 KB of a relay's answer and returns without waiting for the rest", async () => {
  const { createServer } = await import("node:http");
  const { fetchTransport } = await import("../src/push-relay");
  // A hostile relay: 64 KB, then the response never ends. Finishing at all is the proof.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("x".repeat(64 * 1024));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await fetchTransport.send({ url: `http://127.0.0.1:${port}/v1/send`, method: "POST", headers: {}, body: "{}", timeoutMs: 60_000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 4096);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
