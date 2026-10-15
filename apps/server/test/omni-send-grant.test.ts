/**
 * The one door (2026-10-15): send scripts may only send with a ONE-TIME grant minted by an
 * executor after a human-claimed, digest-matched approval. Fake spawners — nothing is
 * executed or sent; the "script" in these tests is a callback that calls the verify route
 * the way scripts/send_grant.py does.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
process.env.OMNI_ENABLED = "true";
process.env.OMNI_HERMES_KEY = "hermes-test-key-0123456789";
process.env.OMNI_SERVICE_TOKEN = "omni-service-token-0123456789";

import { config } from "../src/config";
import { createApp } from "../src/app";
import { setOmniPusherForTests } from "../src/omni/bus";
import { resetOmniStoreForTests, auditRows } from "../src/omni/store";
import { setProtonSpawnerForTests, type Spawner } from "../src/omni/proton-send";
import { setTweetSpawnerForTests } from "../src/omni/tweet-send";
import {
  consumeSendGrant,
  emailSendDigest,
  GRANT_ENV,
  GRANT_TTL_MS,
  messageSendDigest,
  mintSendGrant,
  outstandingGrants,
  sendDigest,
  setGrantClockForTests,
  tweetSendDigest,
} from "../src/omni/send-grant";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const J = { "content-type": "application/json" };
const app = createApp();
const D = (c: string) => c.repeat(64);

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  setOmniPusherForTests(async () => {});
  process.env.OMNI_PROTON_SEND = process.execPath;
  process.env.OMNI_TWEET_SEND = process.execPath;
});
afterEach(() => {
  setGrantClockForTests(null);
  setProtonSpawnerForTests(null);
  setTweetSpawnerForTests(null);
  delete process.env.OMNI_PROTON_SEND;
  delete process.env.OMNI_TWEET_SEND;
});
after(() => setOmniPusherForTests(null));

// ── the digest (the Python twin, scripts/send_grant.py, is tested against the SAME vectors) ──

/** Shared with tests/test_send_grant.py in the agent repo: both languages must agree. */
export const GOLDEN = {
  tweet: "aebf2adad1845cf81fd71d0f57214fefaa3a88e5c0ccc26751b9c53f0fcaaa15",
  email: "2b75e74fe15277efa1f3c3cc3f5ad84c5447501fe4e24b24a7967584a54e81a6",
  reply: "d109e6fda69cc1f0c862d2c752f7f1eb760a1ff87edb0c24f8bd1aeeaf81f62f",
  message: "3e57c88bfe703235f34dd866219ea7b29c3d983e7f6d4ec68bdb2e934e0c5664",
};

test("digest: golden vectors shared with scripts/send_grant.py", () => {
  assert.equal(tweetSendDigest("hello"), GOLDEN.tweet);
  assert.equal(tweetSendDigest("hello"), crypto.createHash("sha256").update("prism-send-grant/v1\ntweet\ntext\n1\n5:hello\n", "utf8").digest("hex"));
  assert.equal(emailSendDigest("email", { to: ["kevin@example.org"], subject: "Grüße", body: "Hi\r\nthere ✓\n" }), GOLDEN.email);
  assert.equal(emailSendDigest("email-reply", { noteId: "vault/messages/email/n1", expectTo: ["a@b.co"], cc: ["c@d.co"], body: "ok" }), GOLDEN.reply);
  assert.equal(messageSendDigest("!r:hs", "ab"), GOLDEN.message);
  assert.notEqual(messageSendDigest("!r:hs", "ab"), messageSendDigest("!r:hsa", "b"), "length prefixes make the encoding unambiguous");
  assert.notEqual(
    emailSendDigest("email-reply", { noteId: "n1", expectTo: ["a@b.co"], body: "ok" }),
    emailSendDigest("email", { to: ["a@b.co"], subject: "n1", body: "ok" }),
    "subject and note are different fields",
  );
  assert.equal(sendDigest("tweet", [["text", ["hello"]]]), GOLDEN.tweet);
});

// ── mint / consume ──

test("a grant is single-use: the first verify consumes it; a replay is invalid", () => {
  const t = mintSendGrant("apr_1", D("a"));
  assert.deepEqual(consumeSendGrant("apr_1", t, D("a"), () => "approved"), { ok: true });
  assert.deepEqual(consumeSendGrant("apr_1", t, D("a"), () => "approved"), { ok: false, error: "invalid_grant" });
  assert.equal(outstandingGrants(), 0);
});

test("a grant expires within 60 s, and a longer TTL is clamped", () => {
  let now = 1_000_000;
  setGrantClockForTests(() => now);
  const t = mintSendGrant("apr_1", D("a"), 10 * 60_000);
  now += GRANT_TTL_MS;
  assert.deepEqual(consumeSendGrant("apr_1", t, D("a"), () => "approved"), { ok: false, error: "expired" });
  const t2 = mintSendGrant("apr_1", D("a"));
  now += GRANT_TTL_MS - 1;
  assert.deepEqual(consumeSendGrant("apr_1", t2, D("a"), () => "approved"), { ok: true });
});

test("a grant is bound to its approval and digest, and a wrong presentation burns it", () => {
  const t = mintSendGrant("apr_1", D("a"));
  assert.deepEqual(consumeSendGrant("apr_1", t, D("b"), () => "approved"), { ok: false, error: "digest_mismatch" });
  assert.deepEqual(consumeSendGrant("apr_1", t, D("a"), () => "approved"), { ok: false, error: "invalid_grant" }, "burnt by the mismatch");
  const t2 = mintSendGrant("apr_1", D("a"));
  assert.deepEqual(consumeSendGrant("apr_2", t2, D("a"), () => "approved"), { ok: false, error: "wrong_approval" });
  const t3 = mintSendGrant("apr_1", D("a"));
  for (const st of ["pending", "sent", "failed", "cancelled", null]) {
    const t4 = mintSendGrant("apr_1", D("a"));
    assert.deepEqual(consumeSendGrant("apr_1", t4, D("a"), () => st), { ok: false, error: "approval_not_claimed" }, String(st));
  }
  assert.deepEqual(consumeSendGrant("apr_1", t3, D("a"), () => "approved"), { ok: true });
  for (const bad of [undefined, 42, "", "x".repeat(43) + "!", "short"]) assert.deepEqual(consumeSendGrant("apr_1", bad, D("a"), () => "approved"), { ok: false, error: "invalid_grant" });
});

// ── the route, end to end through the real executor ──

async function proposeEmail(): Promise<{ id: string; digest: string }> {
  const r = await app.request("/api/omni/hooks/propose", {
    method: "POST",
    headers: { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` },
    body: JSON.stringify({ kind: "email", payload: { to: ["kevin@example.org"], subject: "Friday", body: "See you Friday.\n" } }),
  });
  assert.equal(r.status, 201);
  return (await r.json()) as { id: string; digest: string };
}
const verify = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api/omni/approvals/${id}/send-grant/verify`, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });
const approve = (id: string, digest: string, key: string) =>
  app.request(`/api/omni/approvals/${id}/decision`, {
    method: "POST",
    headers: { ...J, cookie: sessionCookie(makeSession(config.ownerEmail)), "idempotency-key": key },
    body: JSON.stringify({ decision: "send", digest }),
  });

test("approved email: the script verifies its grant once, over loopback, for the exact draft", async () => {
  const p = await proposeEmail();
  const seen: Array<{ status: number; body: unknown }> = [];
  let env: Record<string, string> = {};
  const fake: Spawner = async (_cmd, _args, o) => {
    env = o.env;
    // A script that was handed (or tries to send) other recipients cannot verify.
    const tamperedFirst = await verify(p.id, { token: o.env[GRANT_ENV.token], digest: emailSendDigest("email", { to: ["mallory@example.org"], subject: "Friday", body: o.input }) });
    seen.push({ status: tamperedFirst.status, body: await tamperedFirst.json() });
    return { code: 1, signal: null, stdout: "", stderr: "ERROR: Sends must be approved in Omni (digest_mismatch).", timedOut: false };
  };
  setProtonSpawnerForTests(fake);
  const r = await approve(p.id, p.digest, "grant-key-0001");
  assert.equal(r.status, 422, "a refused grant = failed, nothing sent");
  assert.equal(env[GRANT_ENV.approval], p.id);
  assert.match(env[GRANT_ENV.token]!, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(seen, [{ status: 403, body: { ok: false, error: "digest_mismatch" } }]);
  assert.equal(outstandingGrants(), 0, "nothing left behind");

  // A fresh approval: the honest script verifies once (200), and a replay is refused.
  const p2 = await proposeEmail();
  const statuses: number[] = [];
  setProtonSpawnerForTests(async (_c, _a, o) => {
    const digest = emailSendDigest("email", { to: ["kevin@example.org"], subject: "Friday", body: o.input });
    statuses.push((await verify(p2.id, { token: o.env[GRANT_ENV.token], digest })).status);
    statuses.push((await verify(p2.id, { token: o.env[GRANT_ENV.token], digest })).status);
    return { code: 0, signal: null, stdout: '{"messageId":"<m@x>"}', stderr: "", timedOut: false };
  });
  const r2 = await approve(p2.id, p2.digest, "grant-key-0002");
  assert.equal(r2.status, 200);
  assert.deepEqual(statuses, [200, 403]);
  const grantAudit = auditRows().filter((a) => a.action === "approval.grant").map((a) => [a.status, a.error]);
  assert.deepEqual(grantAudit, [["refused", "digest_mismatch"], ["ok", null], ["refused", "invalid_grant"]]);
});

test("approved tweet: the grant covers exactly the approved text", async () => {
  const r0 = await app.request("/api/omni/hooks/propose", {
    method: "POST",
    headers: { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` },
    body: JSON.stringify({ kind: "tweet", payload: { text: "  exact  " } }),
  });
  const p = (await r0.json()) as { id: string; digest: string };
  let status = 0;
  setTweetSpawnerForTests(async (_c, _a, o) => {
    const text = (JSON.parse(o.input) as { text: string }).text;
    status = (await verify(p.id, { token: o.env[GRANT_ENV.token], digest: tweetSendDigest(text) })).status;
    return { code: 0, signal: null, stdout: JSON.stringify({ status: "sent", postId: "1" }), stderr: "", timedOut: false };
  });
  assert.equal((await approve(p.id, p.digest, "grant-key-0003")).status, 200);
  assert.equal(status, 200);
});

test("verify: a request through the tunnel, a GET, or no grant at all is refused; no session is needed or honoured", async () => {
  const p = await proposeEmail();
  const t = mintSendGrant(p.id, D("a"));
  assert.equal((await verify(p.id, { token: t, digest: D("a") }, { "x-forwarded-for": "203.0.113.9" })).status, 403);
  assert.equal((await verify(p.id, { token: t, digest: D("a") }, { "cf-connecting-ip": "203.0.113.9" })).status, 403);
  assert.equal((await app.request(`/api/omni/approvals/${p.id}/send-grant/verify`)).status, 403);
  // Still unused (the tunnel requests never reached the route) — but the approval is only pending.
  assert.deepEqual(await (await verify(p.id, { token: t, digest: D("a") })).json(), { ok: false, error: "approval_not_claimed" });
  // A signed-in session cannot mint or skip anything here: no token, no send.
  const s = await verify(p.id, { digest: D("a") }, { cookie: sessionCookie(makeSession(config.ownerEmail)) });
  assert.equal(s.status, 403);
  assert.deepEqual(await s.json(), { ok: false, error: "invalid_grant" });
});
