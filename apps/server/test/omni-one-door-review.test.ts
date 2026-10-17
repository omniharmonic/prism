/**
 * One-door review round 1 (B3, S6, S7, N1, N2): an agent on the host cannot approve its
 * own draft with a session cookie lifted from the database, a reply's subject/threading
 * are fixed at propose time, the verify endpoint is bounded, and the argv Prism hands
 * proton_send.py is pinned by vectors the agent repo's Python tests replay.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
process.env.OMNI_ENABLED = "true";
process.env.OMNI_HERMES_KEY = "hermes-test-key-0123456789";
process.env.OMNI_SERVICE_TOKEN = "omni-service-token-0123456789";

import { config } from "../src/config";
import { createApp } from "../src/app";
import { db, getSession, createSession } from "../src/db";
import { setOmniPusherForTests } from "../src/omni/bus";
import { resetOmniStoreForTests, auditRows } from "../src/omni/store";
import { setProtonSpawnerForTests } from "../src/omni/proton-send";
import { protonSendArgs } from "../src/omni/proton-send";
import { emailSendDigest, messageSendDigest, mintSendGrant, tweetSendDigest } from "../src/omni/send-grant";
import { resetDb, makeSession, sessionCookie, deviceAuth, installFakeVault, type FakeVault } from "./helpers";

const J = { "content-type": "application/json" };
const SVC = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
const app = createApp();
let fv: FakeVault;

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  fv = installFakeVault();
  setOmniPusherForTests(async () => {});
  process.env.OMNI_PROTON_SEND = process.execPath;
});
after(() => {
  fv?.restore();
  setOmniPusherForTests(null);
  setProtonSpawnerForTests(null);
  delete process.env.OMNI_PROTON_SEND;
});

const propose = async (kind: string, payload: unknown) => {
  const r = await app.request("/api/omni/hooks/propose", { method: "POST", headers: SVC, body: JSON.stringify({ kind, payload }) });
  return { status: r.status, j: (await r.json()) as { id: string; digest: string; detail?: string } };
};
const decide = (id: string, digest: string, headers: Record<string, string>, k: string) =>
  app.request(`/api/omni/approvals/${id}/decision`, { method: "POST", headers: { ...J, ...headers, "idempotency-key": k }, body: JSON.stringify({ decision: "send", digest }) });

// ── B3: no self-approval with a session cookie ───────────────────────────────

test("B3: a session cookie cannot approve a send or edit a draft; the owner's device can", async () => {
  let spawned = 0;
  setProtonSpawnerForTests(async () => (spawned++, { code: 0, signal: null, stdout: "{}", stderr: "", timedOut: false }));
  const p = (await propose("email", { to: ["kevin@example.org"], subject: "S", body: "b" })).j;
  const cookie = sessionCookie(makeSession(config.ownerEmail));
  const r = await decide(p.id, p.digest, { cookie }, "b3-key-0001");
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, "device_required");
  const edit = await app.request(`/api/omni/approvals/${p.id}`, { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ digest: p.digest, payload: { to: ["kevin@example.org"], subject: "S", body: "edited" } }) });
  assert.equal(edit.status, 403);
  assert.equal(spawned, 0, "nothing was launched");
  // Cancel sends nothing and stays open to a session.
  const ok = await decide(p.id, p.digest, deviceAuth(), "b3-key-0002");
  assert.equal(ok.status, 200);
  assert.equal(spawned, 1);
  assert.ok(auditRows().some((a) => a.action === "approval.decide" && a.error === "device_required"));
});

test("B3: session ids are stored hashed; the stored value is not a usable cookie; legacy rows migrate on use", () => {
  const raw = makeSession(config.ownerEmail);
  const stored = (db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>).map((r) => r.id);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0], raw);
  assert.match(stored[0]!, /^h:[a-f0-9]{64}$/);
  assert.ok(getSession(raw), "the cookie value still signs in");
  assert.equal(getSession(stored[0]!), null, "the database value replays nothing");
  // A row written before hashing (raw id) still works once, and is rewritten.
  db.prepare("INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)").run("legacy-raw-session-id", config.ownerEmail, Date.now(), Date.now() + 60_000);
  assert.equal(getSession("legacy-raw-session-id")?.email, config.ownerEmail);
  const ids = (db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>).map((r) => r.id);
  assert.ok(!ids.includes("legacy-raw-session-id"), "the plaintext row is gone");
  assert.ok(getSession("legacy-raw-session-id"), "and the cookie keeps working");
  createSession("another", config.ownerEmail, 1000);
  assert.ok(getSession("another"));
});

test("B3: outward live actions need the device; a session gets device_required and nothing is sent", async () => {
  Object.assign(config, { actionsEmailEnabled: true });
  try {
    const r = await app.request("/api/actions/email/send", {
      method: "POST",
      headers: { ...J, cookie: sessionCookie(makeSession(config.ownerEmail)), origin: config.appOrigin, "sec-fetch-site": "same-origin", "idempotency-key": "b3-live-0001" },
      body: JSON.stringify({ to: ["kevin@example.org"], subject: "S", body: "b" }),
    });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json().then((j: { error: string; sent?: boolean }) => [j.error, j.sent]), ["device_required", false]);
  } finally {
    Object.assign(config, { actionsEmailEnabled: false });
  }
});

// ── S6: a reply's subject + threading are fixed at propose time ──────────────

test("S6: a proposed reply carries the note's subject and threading; the digest and argv bind them", async () => {
  fv.notes.set("vault/messages/email/n1", {
    id: "vault/messages/email/n1",
    path: "vault/messages/email/n1",
    tags: ["email"],
    content: "",
    metadata: { type: "email", from: "Dana <dana@example.org>", subject: "Plans", messageId: "<m1@mail.example>", threadId: "<root@mail.example>" },
  } as never);
  const p = await propose("email-reply", { noteId: "vault/messages/email/n1", expectTo: ["dana@example.org"], subject: "Wire money", inReplyTo: "<evil@x>", body: "Sounds good." });
  assert.equal(p.status, 201, JSON.stringify(p.j));
  const a = (await (await app.request(`/api/omni/approvals/${p.j.id}`, { headers: deviceAuth() })).json()) as { approval: { payload: Record<string, unknown> } };
  assert.deepEqual(a.approval.payload, {
    noteId: "vault/messages/email/n1", expectTo: ["dana@example.org"], body: "Sounds good.",
    subject: "Re: Plans", inReplyTo: "<m1@mail.example>", references: "<root@mail.example> <m1@mail.example>",
  }, "the proposer's subject/threading are ignored; the note's are shown on the card");
  const argv = protonSendArgs("email-reply", a.approval.payload, "synergy@benjaminlife.one")!;
  assert.deepEqual(argv.slice(argv.indexOf("--subject"), argv.indexOf("--subject") + 2), ["--subject", "Re: Plans"]);
  // A note edited after approval cannot change the digest: it is a function of the payload only.
  const d = emailSendDigest("email-reply", a.approval.payload);
  assert.notEqual(d, emailSendDigest("email-reply", { ...a.approval.payload, subject: "Re: Changed" }));
  assert.notEqual(d, emailSendDigest("email-reply", { ...a.approval.payload, inReplyTo: "<other@x>" }));
  // Not an email note → the proposal is refused.
  fv.notes.set("n2", { id: "n2", path: "n2", tags: ["note"], content: "", metadata: {} } as never);
  assert.equal((await propose("email-reply", { noteId: "n2", expectTo: ["a@b.co"], body: "x" })).status, 400);
  assert.equal((await propose("email-reply", { noteId: "missing", expectTo: ["a@b.co"], body: "x" })).status, 400);
});

// ── N2: the unauthenticated verify endpoint is bounded ───────────────────────

test("N2: unknown tokens are not audited; a flood is rate-limited", async () => {
  const p = (await propose("email", { to: ["kevin@example.org"], subject: "S", body: "b" })).j;
  const verify = (token: string) => app.request(`/api/omni/approvals/${p.id}/send-grant/verify`, { method: "POST", headers: J, body: JSON.stringify({ token, digest: "a".repeat(64) }) });
  const before = auditRows().length;
  for (let i = 0; i < 10; i++) assert.equal((await verify("Z".repeat(43))).status, 403);
  assert.equal(auditRows().length, before, "unknown grants leave no audit rows");
  const real = mintSendGrant(p.id, "a".repeat(64));
  assert.equal((await verify(real)).status, 403, "pending approval");
  assert.equal(auditRows().length, before + 1, "a real grant's presentation is audited");
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await verify("Z".repeat(43))).status === 429) limited++;
  assert.ok(limited > 0, "a flood is refused");
});

// ── S7: argv + digest vectors replayed by the agent repo's Python tests ──────

test("S7: send-grant-vectors.json matches protonSendArgs and the digests exactly", () => {
  const v = JSON.parse(readFileSync(new URL("./fixtures/send-grant-vectors.json", import.meta.url), "utf8")) as {
    email: Array<{ kind: "email" | "email-reply"; argv: string[]; body: string; digest: string }>;
    tweet: Array<{ text: string; digest: string }>;
    message: Array<{ room: string; body: string; digest: string }>;
  };
  assert.ok(v.email.length >= 5);
  for (const e of v.email) {
    // Rebuild the payload from the argv the way proton_send.py sees it, then compare both ways.
    const val = (flag: string) => (e.argv.includes(flag) ? e.argv[e.argv.indexOf(flag) + 1] : undefined);
    const all = (flag: string) => e.argv.flatMap((x, i) => (x === flag ? [e.argv[i + 1]!] : []));
    const payload: Record<string, unknown> = e.kind === "email"
      ? { to: all("--to"), cc: all("--cc"), subject: val("--subject"), body: e.body }
      : { noteId: val("--reply-to-note"), expectTo: all("--to"), cc: all("--cc"), subject: val("--subject"), inReplyTo: val("--in-reply-to"), references: val("--references"), body: e.body };
    assert.deepEqual(protonSendArgs(e.kind, payload, "synergy@benjaminlife.one"), e.argv);
    assert.equal(emailSendDigest(e.kind, payload), e.digest);
  }
  for (const t of v.tweet) assert.equal(tweetSendDigest(t.text), t.digest);
  for (const m of v.message) assert.equal(messageSendDigest(m.room, m.body), m.digest);
});
