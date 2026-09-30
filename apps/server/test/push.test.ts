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
  sendPush,
  notifyTurnEnd,
  pushEnabled,
  MAX_FAILURES,
  type PushSender,
} from "../src/push";

const J = { "content-type": "application/json" };
const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const sub = (n: number) => ({ endpoint: `https://push.test/${n}`, keys: { p256dh: "p", auth: "a" } });
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

test("routes are owner-only (anon, capability, non-owner member all 403)", async () => {
  const req = (init: RequestInit) => pushApi.request("/subscribe", { method: "POST", headers: J, body: JSON.stringify(sub(1)), ...init });
  assert.equal((await req({})).status, 403);
  const cap = makeCapability("note", "n1", "edit");
  assert.equal((await req({ headers: { ...J, authorization: `Capability ${cap}` } })).status, 403);
  const member = sessionCookie(makeSession("member@test.local"));
  assert.equal((await req({ headers: { ...J, cookie: member } })).status, 403);
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
  assert.equal((await pushApi.request("/test", { method: "POST", headers: owner() })).status, 503);
});

test("/test pings every subscription with a content-free payload", async () => {
  saveSubscription({ email: config.ownerEmail, endpoint: sub(1).endpoint, p256dh: "p", auth: "a" });
  saveSubscription({ email: config.ownerEmail, endpoint: sub(2).endpoint, p256dh: "p", auth: "a" });
  const r = await pushApi.request("/test", { method: "POST", headers: owner() });
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
