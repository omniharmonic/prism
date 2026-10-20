/**
 * Web Push (WP3.3): owner-only routes, ids-only payloads, 404/410 prune, failure
 * backoff, turn-end filtering. A FAKE sender is injected — nothing reaches a real
 * push service.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pushApi } from "../src/routes/push";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import { db } from "../src/db";
import {
  configurePush,
  _resetPush,
  saveSubscription,
  listSubscriptions,
  removeSubscription,
  sendPush,
  notifyTurnEnd,
  pushEnabled,
  MAX_FAILURES,
  type PushSender,
} from "../src/push";

const J = { "content-type": "application/json" };
const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: "p", auth: "a" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let sends: Array<{ endpoint: string; payload: string }>;
let status: number | "throw";

const fake: PushSender = async (s, payload) => {
  sends.push({ endpoint: s.endpoint, payload });
  if (status === "throw") throw new Error("network");
  return { statusCode: status };
};

beforeEach(() => {
  resetDb();
  sends = [];
  status = 201;
  configurePush({ keys: { publicKey: "PUBKEY", privateKey: "priv", subject: "mailto:o@test.local" }, sender: fake });
});
afterEach(() => _resetPush());

test("routes are signed-in users only (anon, capability 403; a member registers their OWN browser)", async () => {
  const req = (init: RequestInit) => pushApi.request("/subscribe", { method: "POST", headers: J, body: JSON.stringify(sub(1)), ...init });
  assert.equal((await req({})).status, 403);
  const cap = makeCapability("note", "n1", "edit");
  assert.equal((await req({ headers: { ...J, authorization: `Capability ${cap}` } })).status, 403);
  const member = sessionCookie(makeSession("member@test.local"));
  assert.equal((await req({ headers: { ...J, cookie: member } })).status, 200);
  assert.equal(listSubscriptions("member@test.local").length, 1, "bound to the member's own email");
  removeSubscription("member@test.local", sub(1).endpoint);
  assert.equal((await pushApi.request("/vapid-public-key")).status, 403);
  assert.equal((await pushApi.request("/test", { method: "POST" })).status, 403);
  assert.equal((await pushApi.request("/subscribe", { method: "DELETE", headers: J, body: JSON.stringify(sub(1)) })).status, 403);
  assert.equal(listSubscriptions(config.ownerEmail).length, 0);
});

test("owner: vapid key, subscribe (idempotent), validate, unsubscribe", async () => {
  const k = await pushApi.request("/vapid-public-key", { headers: owner() });
  assert.deepEqual(await k.json(), { publicKey: "PUBKEY" });
  const post = (b: unknown) => pushApi.request("/subscribe", { method: "POST", headers: { ...J, ...owner() }, body: JSON.stringify(b) });
  assert.equal((await post(sub(1))).status, 200);
  assert.equal((await post(sub(1))).status, 200);
  assert.equal(listSubscriptions(config.ownerEmail).length, 1);
  assert.equal((await post({ endpoint: "http://insecure/x", keys: { p256dh: "p", auth: "a" } })).status, 400);
  assert.equal((await post({ endpoint: "https://x/y" })).status, 400);
  const del = await pushApi.request("/subscribe", { method: "DELETE", headers: { ...J, ...owner() }, body: JSON.stringify({ endpoint: sub(1).endpoint }) });
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal(listSubscriptions(config.ownerEmail).length, 0);
});

test("disabled without keys: vapid route 503, /test 503", async () => {
  configurePush({ keys: { publicKey: "", privateKey: "", subject: "" }, sender: null });
  assert.equal(pushEnabled(), false);
  assert.equal((await pushApi.request("/vapid-public-key", { headers: owner() })).status, 503);
  assert.equal((await pushApi.request("/test", { method: "POST", headers: { ...J, ...owner() } })).status, 503);
});

test("/test pings every subscription with a content-free payload", async () => {
  saveSubscription({ email: config.ownerEmail, endpoint: sub(1).endpoint, p256dh: "p", auth: "a" });
  saveSubscription({ email: config.ownerEmail, endpoint: sub(2).endpoint, p256dh: "p", auth: "a" });
  const r = await pushApi.request("/test", { method: "POST", headers: { ...J, ...owner() } });
  assert.deepEqual(await r.json(), { sent: 2, pruned: 0, failed: 0 });
  assert.deepEqual(JSON.parse(sends[0]!.payload), { type: "test" });
});

test("410/404 prunes the subscription; 5xx/throw backs off then drops at MAX_FAILURES", async () => {
  saveSubscription({ email: config.ownerEmail, endpoint: sub(1).endpoint, p256dh: "p", auth: "a" });
  status = 410;
  assert.equal((await sendPush(config.ownerEmail, { type: "test" })).pruned, 1);
  assert.equal(listSubscriptions(config.ownerEmail).length, 0);

  saveSubscription({ email: config.ownerEmail, endpoint: sub(2).endpoint, p256dh: "p", auth: "a" });
  status = 503;
  for (let i = 1; i < MAX_FAILURES; i++) {
    await sendPush(config.ownerEmail, { type: "test" });
    assert.equal(listSubscriptions(config.ownerEmail)[0]!.failures, i);
  }
  status = 201; // a success resets the counter
  await sendPush(config.ownerEmail, { type: "test" });
  assert.equal(listSubscriptions(config.ownerEmail)[0]!.failures, 0);
  status = "throw";
  for (let i = 0; i < MAX_FAILURES; i++) await sendPush(config.ownerEmail, { type: "test" });
  assert.equal(listSubscriptions(config.ownerEmail).length, 0);
});

test("notifyTurnEnd: ids only, only for the session owner, skips cancelled/non-terminal, never throws", async () => {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agent_sessions (id, vault_id, owner_email, title, profile, status, cost_usd, created_at, updated_at) VALUES ('s1','v',?, 'PRIVATE TITLE','vault-rw','idle',0,?,?)",
  ).run(config.ownerEmail, now, now);
  saveSubscription({ email: config.ownerEmail, endpoint: sub(1).endpoint, p256dh: "p", auth: "a" });
  saveSubscription({ email: "someone@else", endpoint: sub(2).endpoint, p256dh: "p", auth: "a" });
  notifyTurnEnd("s1", "t1", "cancelled");
  notifyTurnEnd("s1", "t1", "running");
  notifyTurnEnd("missing", "t1", "done");
  await sleep(5);
  assert.equal(sends.length, 0);
  notifyTurnEnd("s1", "t1", "error");
  notifyTurnEnd("s1", "t2", "interrupted");
  await sleep(5);
  assert.equal(sends.length, 2);
  assert.ok(sends.every((s) => s.endpoint === sub(1).endpoint));
  assert.deepEqual(JSON.parse(sends[0]!.payload), { type: "agent-turn", sessionId: "s1", turnId: "t1", status: "error" });
  assert.ok(!sends[0]!.payload.includes("PRIVATE"));
  status = "throw";
  assert.doesNotThrow(() => notifyTurnEnd("s1", "t3", "done"));
  await sleep(5);
});


// ── review H1: the endpoint is a URL the SERVER will POST to ─────────────────
test("subscribe: only real push services; IP literals, private names, ports, other hosts refused", async () => {
  const member = { cookie: sessionCookie(makeSession("member@test.local")) };
  const post = (endpoint: string) => pushApi.request("/subscribe", { method: "POST", headers: { ...J, ...member }, body: JSON.stringify({ endpoint, keys: { p256dh: "p", auth: "a" } }) });
  for (const bad of [
    "https://127.0.0.1:1940/vault/default/api/notes",
    "https://10.0.0.5/x",
    "https://[::1]/x",
    "https://2130706433/x",
    "https://localhost/x",
    "https://vault.internal/x",
    "https://evil.example.com/x",
    "https://fcm.googleapis.com.evil.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x",
  ]) assert.equal((await post(bad)).status, 400, bad);
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QAbc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) assert.equal((await post(ok)).status, 200, ok);
});

test("subscribe: CSRF guarded; another user's endpoint can't be hijacked; ≤10 rows per user", async () => {
  const a = { cookie: sessionCookie(makeSession("a@test.local")) };
  const b = { cookie: sessionCookie(makeSession("b@test.local")) };
  const post = (who: Record<string, string>, n: number, extra: Record<string, string> = {}) =>
    pushApi.request("/subscribe", { method: "POST", headers: { ...J, ...who, ...extra }, body: JSON.stringify(sub(n)) });
  assert.equal((await post(a, 1, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(a, 1, { origin: "https://evil.example" })).status, 403);
  assert.equal((await pushApi.request("/subscribe", { method: "POST", headers: { ...a, "content-type": "text/plain" }, body: JSON.stringify(sub(1)) })).status, 415);
  assert.equal((await post(a, 1)).status, 200);
  assert.equal((await post(b, 1)).status, 409, "an endpoint bound to another account is refused");
  assert.equal(listSubscriptions("a@test.local").length, 1);
  assert.equal(listSubscriptions("b@test.local").length, 0);
  // B can't remove A's row either.
  await pushApi.request("/subscribe", { method: "DELETE", headers: { ...J, ...b }, body: JSON.stringify({ endpoint: sub(1).endpoint }) });
  assert.equal(listSubscriptions("a@test.local").length, 1);
  for (let n = 2; n <= 14; n++) assert.equal((await post(a, n)).status, 200);
  assert.equal(listSubscriptions("a@test.local").length, 10, "oldest pruned at the cap");
});

test("/test: CSRF, rate-limited, and non-owners learn no per-endpoint outcome; stored bad endpoints are never contacted", async () => {
  const m = { cookie: sessionCookie(makeSession("m2@test.local")) };
  saveSubscription({ email: "m2@test.local", endpoint: sub(1).endpoint, p256dh: "p", auth: "a" });
  // A row stored before validation existed must never be POSTed to.
  db.prepare("INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, created_at, failures) VALUES (?, ?, 'p', 'a', ?, 0)").run("https://127.0.0.1:1940/x", "m2@test.local", Date.now());
  assert.equal((await pushApi.request("/test", { method: "POST", headers: { ...m, "sec-fetch-site": "cross-site", ...J } })).status, 403);
  const r = await pushApi.request("/test", { method: "POST", headers: { ...m, ...J } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(sends.map((s) => s.endpoint), [sub(1).endpoint]);
  assert.equal(listSubscriptions("m2@test.local").length, 1, "the invalid row was dropped");
  let limited = false;
  for (let i = 0; i < 10; i++) if ((await pushApi.request("/test", { method: "POST", headers: { ...m, ...J } })).status === 429) limited = true;
  assert.ok(limited);
});
