/**
 * Live actions (Arch v2 WP1.5): /api/actions/* + /acl/actions/audit.
 *
 * Every transport is FAKED — nothing here reaches Proton Bridge, Google/gog or a
 * Matrix homeserver. The SMTP pin-before-AUTH tests run against a loopback stub
 * SMTP server with a throwaway self-signed cert (skipped without `openssl`).
 * Fixtures use example.test addresses only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFileSync } from "node:child_process";

process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");

import { config } from "../src/config";
import { actionsApi } from "../src/routes/actions";
import { acl } from "../src/routes/acl";
import { db, setMembership } from "../src/db";
import { putSecret, deleteSecret } from "../src/secrets";
import { integrations } from "../src/routes/integrations";
import { INPROCESS_ACTOR, INPROCESS_CLIENT_KEY } from "../src/auth/actor";
import { issueDeviceToken } from "../src/auth/device";
import { configureEmailActions, smtpSend, buildReply, validateSendInput, imapMailboxOps, pickExactUid, type MailboxOps, type MailboxResult, type SmtpSender, type ActionImapClient } from "../src/actions/email";
import { setActionsGogRunnerForTests } from "../src/actions/calendar";
import { setMatrixActionClientForTests, txnIdFor } from "../src/actions/matrix";
import { validateProtonCredential, type ProtonCredential } from "../src/worker/proton";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";

const J = { "content-type": "application/json" };
const VAULT = "primary";
const SELF = "me@example.test";
const PIN = "ab".repeat(32);
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
let keyN = 0;
const freshKey = () => `test-key-${Date.now()}-${++keyN}`;

type Sent = { envelope: { from: string; to: string[] }; raw: string };
let sent: Sent[];
let smtpBehaviour: "ok" | "fail-before" | "fail-unknown";
const fakeSmtp: SmtpSender = {
  async send(_cred, envelope, raw) {
    if (smtpBehaviour === "fail-before") {
      const { ActionTransportError } = await import("../src/actions/email");
      throw new ActionTransportError("proton-bridge smtp: cannot connect", false);
    }
    sent.push({ envelope, raw: raw.toString("utf8") });
    if (smtpBehaviour === "fail-unknown") {
      const { ActionTransportError } = await import("../src/actions/email");
      throw new ActionTransportError("proton-bridge smtp: send failed (socket closed)", "unknown");
    }
    return { accepted: envelope.to.length, rejected: 0 };
  },
};
let mboxCalls: Array<{ op: string; mailbox: string; messageId: string; arg: unknown }>;
let mboxFound: MailboxResult;
const fakeMailbox: MailboxOps = {
  async move(_c, mailbox, messageId, target) {
    mboxCalls.push({ op: "move", mailbox, messageId, arg: target });
    return mboxFound;
  },
  async setSeen(_c, mailbox, messageId, seen) {
    mboxCalls.push({ op: "seen", mailbox, messageId, arg: seen });
    return mboxFound;
  },
};
let gogCalls: string[][];
let mxEvents: Array<{ roomId: string; type: string; txnId: string; content: Record<string, unknown> }>;
let joined: string[];
let fv: FakeVault;

const FLAGS = ["actionsEmailEnabled", "actionsCalendarEnabled", "actionsMatrixEnabled", "actionsMatrixAgentRooms", "actionsEmailSendPerHour"] as const;
const saved: Record<string, unknown> = {};
for (const k of FLAGS) saved[k] = (config as Record<string, unknown>)[k];
const setCfg = (o: Partial<Record<(typeof FLAGS)[number], unknown>>) => Object.assign(config as Record<string, unknown>, o);

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  sent = [];
  smtpBehaviour = "ok";
  mboxCalls = [];
  mboxFound = "ok";
  gogCalls = [];
  mxEvents = [];
  joined = ["!room1:hs.example.test", "!agentroom:hs.example.test"];
  setCfg({ actionsEmailEnabled: true, actionsCalendarEnabled: true, actionsMatrixEnabled: true, actionsMatrixAgentRooms: ["!agentroom:hs.example.test"], actionsEmailSendPerHour: 1000 });
  configureEmailActions({ smtp: fakeSmtp, mailbox: fakeMailbox });
  setActionsGogRunnerForTests(async (args) => {
    gogCalls.push(args);
    return args[1] === "create" ? JSON.stringify({ event: { id: "evt123", htmlLink: "https://calendar.example.test/e/evt123" } }) : "{}";
  });
  setMatrixActionClientForTests(() => ({
    async sendEvent(roomId: string, type: "m.room.message" | "m.reaction", txnId: string, content: Record<string, unknown>) {
      mxEvents.push({ roomId, type, txnId, content });
      return `$ev${mxEvents.length}`;
    },
    async joinedRooms() {
      return joined;
    },
  }));
  putSecret(VAULT, config.ownerEmail, "proton-bridge", JSON.stringify({ host: "127.0.0.1", port: 1143, username: SELF, password: "stub-pw-not-real", security: "starttls", certSha256: PIN }));
  putSecret(VAULT, config.ownerEmail, "google", JSON.stringify({ account: SELF }));
  putSecret(VAULT, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://hs.example.test", accessToken: "stub-matrix-token" }));
});
afterEach(() => {
  fv.restore();
  configureEmailActions({ smtp: null, mailbox: null });
  setActionsGogRunnerForTests(null);
  setMatrixActionClientForTests(null);
  setCfg(saved);
});

const post = (p: string, body: unknown, headers: Record<string, string> = owner(), env?: object) =>
  actionsApi.request(p, { method: "POST", headers, body: JSON.stringify(body) }, env);
const auditRows = () => db.prepare("SELECT * FROM action_audit ORDER BY id").all() as Array<Record<string, unknown>>;
const sendBody = (over: Record<string, unknown> = {}) => ({ to: ["alice@example.test"], subject: "Hello there", body: "Body text that must never be audited", ...over });

// ── gate ────────────────────────────────────────────────────────────────────

const ROUTES: Array<[string, unknown]> = [
  ["/email/send", sendBody()],
  ["/email/reply", { noteId: "n1", body: "x", expectTo: ["a@example.test"] }],
  ["/email/archive", { messageId: "m@example.test" }],
  ["/email/mark-read", { messageId: "m@example.test", read: true }],
  ["/calendar/rsvp", { eventId: "abc", response: "accepted" }],
  ["/calendar/create", { title: "t", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z" }],
  ["/matrix/send", { roomId: "!room1:hs.example.test", body: "hi" }],
  ["/matrix/react", { roomId: "!room1:hs.example.test", eventId: "$e1", key: "👍" }],
];

test("gate: anon, capability link, guest, member, admin, another vault-role owner and a non-owner device → 403; nothing acts or audits", async () => {
  setMembership(VAULT, "member@example.test", "member", null);
  setMembership(VAULT, "admin@example.test", "admin", null);
  setMembership(VAULT, "coowner@example.test", "owner", null);
  const dev = issueDeviceToken("admin@example.test", "phone", "prism-ios").token;
  const callers: Record<string, Record<string, string>> = {
    anon: J,
    link: { ...J, authorization: `Capability ${makeCapability("note", "n1", "edit")}` },
    guest: { ...J, cookie: sessionCookie(makeSession("guest@example.test")) },
    member: { ...J, cookie: sessionCookie(makeSession("member@example.test")) },
    admin: { ...J, cookie: sessionCookie(makeSession("admin@example.test")) },
    "vault-role owner": { ...J, cookie: sessionCookie(makeSession("coowner@example.test")) },
    "admin device": { ...J, authorization: `Bearer ${dev}` },
  };
  for (const [who, h] of Object.entries(callers)) {
    for (const [p, b] of ROUTES) assert.equal((await post(p, b, { ...h, "idempotency-key": freshKey() })).status, 403, `${who} ${p}`);
    assert.equal((await actionsApi.request("/", { headers: h })).status, 403, `${who} status`);
    assert.equal((await acl.request("/actions/audit", { headers: h })).status, 403, `${who} audit`);
  }
  assert.equal(sent.length + gogCalls.length + mxEvents.length + mboxCalls.length, 0);
  assert.equal(auditRows().length, 0);
});

test("flags default off → 503 actions_disabled for the owner (nothing sent)", async () => {
  setCfg({ actionsEmailEnabled: false, actionsCalendarEnabled: false, actionsMatrixEnabled: false });
  for (const [p, b] of ROUTES) {
    const r = await post(p, b, { ...owner(), "idempotency-key": freshKey() });
    assert.equal(r.status, 503, p);
    assert.equal(((await r.json()) as { error: string }).error, "actions_disabled");
  }
  const st = (await (await actionsApi.request("/", { headers: owner() })).json()) as Record<string, { enabled: boolean; configured: boolean }>;
  assert.equal(st.email!.enabled, false);
  assert.equal(st.email!.configured, true);
  assert.equal(sent.length + gogCalls.length + mxEvents.length, 0);
});

// ── email send + audit + idempotency ────────────────────────────────────────

test("email send: composes a proper message from the Bridge account; audit holds hashes, never body/subject/address", async () => {
  const r = await post("/email/send", sendBody({ cc: ["bob@example.test"], html: "<p>hi</p>" }), { ...owner(), "idempotency-key": freshKey() });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; messageId: string; accepted: number };
  assert.equal(j.ok, true);
  assert.equal(j.accepted, 2);
  assert.match(j.messageId, /^<[0-9a-f-]+@example\.test>$/);
  assert.equal(sent.length, 1);
  const s = sent[0]!;
  assert.deepEqual(s.envelope, { from: SELF, to: ["alice@example.test", "bob@example.test"] });
  assert.match(s.raw, /^From: me@example\.test\r?$/m);
  assert.match(s.raw, /^To: alice@example\.test\r?$/m);
  assert.match(s.raw, /^Cc: bob@example\.test\r?$/m);
  assert.match(s.raw, /^Subject: Hello there\r?$/m);
  assert.match(s.raw, /multipart\/alternative/);
  assert.doesNotMatch(s.raw, /^Bcc:/im);
  const rows = auditRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.action, "email.send");
  assert.equal(row.status, "ok");
  assert.equal(row.via, "session");
  assert.equal(row.origin, "human");
  assert.equal(row.actor_email, config.ownerEmail);
  const dump = JSON.stringify(row);
  for (const secret of ["Body text", "Hello there", "alice@", "bob@"]) assert.ok(!dump.includes(secret), `audit leaks ${secret}`);
  const target = JSON.parse(row.target as string) as Record<string, unknown>;
  assert.equal(target.recipients, 2);
  assert.match(String(target.recipientsHash), /^[0-9a-f]{16}$/);
});

test("idempotency: same key → ONE send, replayed; different request on the same key → 422; key required for sends", async () => {
  const key = freshKey();
  const a = await post("/email/send", sendBody(), { ...owner(), "idempotency-key": key });
  const b = await post("/email/send", sendBody(), { ...owner(), "idempotency-key": key });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(await b.json(), await a.json());
  assert.equal(sent.length, 1, "never sent twice");
  // M1: a body-supplied key is NOT honoured (the header is required)
  const c = await post("/email/send", { ...sendBody(), idempotencyKey: freshKey() });
  assert.equal(c.status, 400);
  assert.equal(sent.length, 1);
  const d = await post("/email/send", sendBody({ body: "a different message" }), { ...owner(), "idempotency-key": key });
  assert.equal(d.status, 422);
  assert.equal(sent.length, 1);
  assert.equal((await post("/email/send", sendBody())).status, 400, "no key → 400");
  assert.equal((await post("/email/send", sendBody(), { ...owner(), "idempotency-key": "short" })).status, 400);
  assert.equal(sent.length, 1);
  const statuses = auditRows().map((r) => r.status);
  assert.deepEqual(statuses, ["ok", "replayed", "refused", "refused", "refused", "refused"]);
});

test("idempotency: a failure BEFORE sending releases the key; an outcome-unknown failure is replayed, never re-sent", async () => {
  const k1 = freshKey();
  smtpBehaviour = "fail-before";
  const a = await post("/email/send", sendBody(), { ...owner(), "idempotency-key": k1 });
  assert.equal(a.status, 502);
  assert.equal(((await a.json()) as { sent: unknown }).sent, false);
  smtpBehaviour = "ok";
  assert.equal((await post("/email/send", sendBody(), { ...owner(), "idempotency-key": k1 })).status, 200);
  assert.equal(sent.length, 1);

  const k2 = freshKey();
  smtpBehaviour = "fail-unknown";
  assert.equal((await post("/email/send", sendBody(), { ...owner(), "idempotency-key": k2 })).status, 502);
  smtpBehaviour = "ok";
  const again = await post("/email/send", sendBody(), { ...owner(), "idempotency-key": k2 });
  assert.equal(again.status, 502);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(((await again.json()) as { sent: unknown }).sent, "unknown");
  assert.equal(sent.length, 2, "the unknown attempt is not repeated");
  assert.ok(auditRows().some((r) => r.status === "failed"));
});

test("header injection + limits are refused before anything is sent", async () => {
  const bad: Array<Record<string, unknown>> = [
    sendBody({ subject: "hi\r\nBcc: evil@example.test" }),
    sendBody({ subject: "hi\nX-Injected: 1" }),
    sendBody({ to: ["alice@example.test\r\nBcc: evil@example.test"] }),
    sendBody({ to: ["Alice <alice@example.test>"] }),
    sendBody({ cc: ["not-an-address"] }),
    sendBody({ inReplyTo: "<a@b>\r\nBcc: x@example.test" }),
    sendBody({ references: ["<a@b>", "c@d\r\nX: y"] }),
    sendBody({ bcc: ["hidden@example.test"] }),
    sendBody({ to: Array.from({ length: 21 }, (_, i) => `r${i}@example.test`) }),
    sendBody({ to: Array.from({ length: 15 }, (_, i) => `r${i}@example.test`), cc: Array.from({ length: 6 }, (_, i) => `c${i}@example.test`) }),
    sendBody({ body: "x".repeat(200_001) }),
    sendBody({ body: "   " }),
    sendBody({ to: [] }),
  ];
  for (const b of bad) {
    const r = await post("/email/send", b, { ...owner(), "idempotency-key": freshKey() });
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 120));
  }
  assert.equal(sent.length, 0);
  assert.ok(auditRows().every((r) => r.status === "refused"));
  assert.doesNotThrow(() => validateSendInput(sendBody({ to: Array.from({ length: 20 }, (_, i) => `r${i}@example.test`) })));
});

test("rate limit: the email send bucket returns 429 past its max", async () => {
  setCfg({ actionsEmailSendPerHour: 2 });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await post("/email/send", sendBody(), { ...owner(), "idempotency-key": freshKey() })).status);
  // (the bucket is per process + owner; earlier tests may have consumed hits)
  assert.equal(statuses.at(-1), 429);
  assert.ok(sent.length <= 2);
});

// ── reply threading ─────────────────────────────────────────────────────────

const emailNote = (id: string, md: Record<string, unknown>) =>
  fv.put({ id, path: `vault/messages/email/x-${id}`, tags: ["email"], content: "# x", metadata: { type: "email", source: "proton-bridge", mailbox: "INBOX", isUnread: true, labels: ["INBOX", "UNREAD"], ...md } });

test("reply: In-Reply-To, References (thread root first), Re: subject, To = original sender", async () => {
  emailNote("n1", { subject: "Project update", from: "Alice Example <alice@example.test>", to: SELF, messageId: "m2@mail.example.test", threadId: "m1@mail.example.test" });
  const r = await post("/email/reply", { noteId: "n1", body: "Thanks!", expectTo: ["alice@example.test"] }, { ...owner(), "idempotency-key": freshKey() });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(((await r.json()) as { inReplyTo: string }).inReplyTo, "<m2@mail.example.test>");
  const raw = sent[0]!.raw;
  assert.match(raw, /^In-Reply-To: <m2@mail\.example\.test>\r?$/m);
  assert.match(raw, /^References: <m1@mail\.example\.test> <m2@mail\.example\.test>\r?$/m);
  assert.match(raw, /^Subject: Re: Project update\r?$/m);
  assert.deepEqual(sent[0]!.envelope.to, ["alice@example.test"]);
  const t = JSON.parse(auditRows()[0]!.target as string) as Record<string, unknown>;
  assert.equal(t.noteId, "n1");
  assert.match(String(t.inReplyToHash), /^[0-9a-f]{16}$/);
});

test("reply: existing Re: kept; a reply to our own message goes to its recipients; not-an-email → 422", async () => {
  emailNote("n2", { subject: "RE: Lunch", from: `Me <${SELF}>`, to: "Carol <carol@example.test>, me@example.test", messageId: "m9@mail.example.test", threadId: "m9@mail.example.test" });
  const r = await post("/email/reply", { noteId: "n2", body: "ok", expectTo: ["Carol@example.test"] }, { ...owner(), "idempotency-key": freshKey() });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(sent[0]!.raw, /^Subject: RE: Lunch\r?$/m);
  assert.match(sent[0]!.raw, /^References: <m9@mail\.example\.test>\r?$/m, "root == message → one reference");
  assert.deepEqual(sent[0]!.envelope.to, ["carol@example.test"]);
  fv.put({ id: "plain", path: "notes/plain", tags: ["note"], content: "x", metadata: {} });
  assert.equal((await post("/email/reply", { noteId: "plain", body: "x", expectTo: ["a@example.test"] }, { ...owner(), "idempotency-key": freshKey() })).status, 422);
  assert.equal((await post("/email/reply", { noteId: "missing", body: "x", expectTo: ["a@example.test"] }, { ...owner(), "idempotency-key": freshKey() })).status, 404);
  assert.equal(sent.length, 1);
  // A stored subject with a line break can never become a header injection.
  assert.equal(buildReply({ messageId: "x@y", subject: "s\r\nBcc: a@b.test", from: "a@example.test" }, SELF).subject, "Re: s Bcc: a@b.test");
  assert.throws(() => buildReply({ messageId: "x@y\r\nBcc: z", from: "a@example.test" }, SELF));
});

// ── archive / mark-read ─────────────────────────────────────────────────────

test("archive + mark-read: IMAP by Message-ID in the note's mailbox; mark-read reflects on the note", async () => {
  emailNote("n3", { subject: "s", from: "a@example.test", messageId: "m3@mail.example.test", threadId: "m3@mail.example.test" });
  assert.equal((await post("/email/archive", { noteId: "n3" })).status, 200);
  assert.deepEqual(mboxCalls[0], { op: "move", mailbox: "INBOX", messageId: "<m3@mail.example.test>", arg: "Archive" });
  assert.equal((await post("/email/mark-read", { noteId: "n3", read: true })).status, 200);
  assert.deepEqual(mboxCalls[1], { op: "seen", mailbox: "INBOX", messageId: "<m3@mail.example.test>", arg: true });
  const md = fv.notes.get("n3")!.metadata!;
  assert.equal(md.isUnread, false);
  assert.deepEqual(md.labels, ["INBOX"]);
  assert.equal((await post("/email/mark-read", { noteId: "n3" })).status, 400, "read is required");
  mboxFound = "not_found";
  assert.equal((await post("/email/archive", { messageId: "gone@mail.example.test" })).status, 404);
  assert.equal((await post("/email/archive", { messageId: "x@y", mailbox: "INBOX\r\nA1 DELETE" })).status, 400);
});

// ── calendar ────────────────────────────────────────────────────────────────

test("calendar rsvp + create: exact gog argv, one element per value; bad ids refused", async () => {
  assert.equal((await post("/calendar/rsvp", { eventId: "abc_20261001T150000Z", response: "tentative" })).status, 200);
  assert.deepEqual(gogCalls[0], ["calendar", "respond", "primary", "abc_20261001T150000Z", "--status=tentative", `--account=${SELF}`, "--json", "--no-input"]);
  const r = await post(
    "/calendar/create",
    { title: "Planning --with-zoom", start: "2026-10-02T15:00:00-06:00", end: "2026-10-02T16:00:00-06:00", attendees: ["alice@example.test"], location: "Room 1", description: "line1\nline2" },
    { ...owner(), "idempotency-key": freshKey() },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, eventId: "evt123", htmlLink: "https://calendar.example.test/e/evt123" });
  assert.deepEqual(gogCalls[1], [
    "calendar", "create", "primary",
    "--summary=Planning --with-zoom", "--from=2026-10-02T15:00:00-06:00", "--to=2026-10-02T16:00:00-06:00",
    "--attendees=alice@example.test", "--location=Room 1", "--description=line1\nline2", "--send-updates=all",
    `--account=${SELF}`, "--json", "--no-input",
  ]);
  const bad: Array<[string, unknown]> = [
    ["/calendar/rsvp", { eventId: "--account=evil", response: "accepted" }],
    ["/calendar/rsvp", { eventId: "abc", response: "maybe" }],
    ["/calendar/create", { title: "t", start: "tomorrow", end: "2026-10-02T16:00:00Z" }],
    ["/calendar/create", { title: "t", start: "2026-10-02T16:00:00Z", end: "2026-10-02T15:00:00Z" }],
    ["/calendar/create", { title: "t\r\nx", start: "2026-10-02T15:00:00Z", end: "2026-10-02T16:00:00Z" }],
    ["/calendar/create", { title: "t", start: "2026-10-02T15:00:00Z", end: "2026-10-02T16:00:00Z", attendees: ["bad"] }],
  ];
  for (const [p, b] of bad) assert.equal((await post(p, b, { ...owner(), "idempotency-key": freshKey() })).status, 400, JSON.stringify(b));
  assert.equal(gogCalls.length, 2);
  assert.equal((await post("/calendar/create", { title: "t", start: "2026-10-02T15:00:00Z", end: "2026-10-02T16:00:00Z" })).status, 400, "create needs a key");
});

// ── origin: human vs agent ──────────────────────────────────────────────────

const ownerActor = () => ({ kind: "user" as const, email: config.ownerEmail, role: "owner" as const, vaultId: VAULT, grants: [] });
const mcpEnv = () => ({ [INPROCESS_ACTOR]: ownerActor(), [INPROCESS_CLIENT_KEY]: "mcp:pat:t1" });

test("matrix: the human owner may send/react in any JOINED room; never in a room the account has not joined", async () => {
  const key = freshKey();
  const r = await post("/matrix/send", { roomId: "!room1:hs.example.test", body: "hello" }, { ...owner(), "idempotency-key": key });
  assert.equal(r.status, 200);
  assert.deepEqual(mxEvents[0], { roomId: "!room1:hs.example.test", type: "m.room.message", txnId: txnIdFor(key), content: { msgtype: "m.text", body: "hello" } });
  assert.equal((await post("/matrix/react", { roomId: "!room1:hs.example.test", eventId: "$abc", key: "👍" })).status, 200);
  assert.deepEqual(mxEvents[1]!.content, { "m.relates_to": { rel_type: "m.annotation", event_id: "$abc", key: "👍" } });
  const nj = await post("/matrix/send", { roomId: "!other:hs.example.test", body: "x" }, { ...owner(), "idempotency-key": freshKey() });
  assert.equal(nj.status, 403);
  assert.equal(((await nj.json()) as { error: string }).error, "room_not_joined");
  assert.equal(mxEvents.length, 2);
});

test("matrix allowlist: agent origin (in-process MCP, loopback owner token, or a self-downgrade) only in ACTIONS_MATRIX_AGENT_ROOMS", async () => {
  const body = { roomId: "!room1:hs.example.test", body: "from an agent" };
  const viaMcp = await post("/matrix/send", body, { ...J, "idempotency-key": freshKey() }, mcpEnv());
  assert.equal(viaMcp.status, 403);
  assert.equal(((await viaMcp.json()) as { error: string }).error, "room_not_allowlisted");
  const local = await post("/matrix/send", body, { ...J, authorization: `Bearer ${config.collabToken}`, "idempotency-key": freshKey() });
  assert.equal(local.status, 403, "loopback owner token counts as agent");
  const down = await post("/matrix/send", body, { ...owner(), "x-prism-action-origin": "agent", "idempotency-key": freshKey() });
  assert.equal(down.status, 403, "a client may downgrade itself to agent");
  assert.equal(mxEvents.length, 0);
  const ok = await post("/matrix/send", { roomId: "!agentroom:hs.example.test", body: "allowed" }, { ...J, "idempotency-key": freshKey() }, mcpEnv());
  assert.equal(ok.status, 200);
  assert.equal(mxEvents.length, 1);
  setCfg({ actionsMatrixAgentRooms: [] });
  assert.equal((await post("/matrix/react", { roomId: "!agentroom:hs.example.test", eventId: "$e", key: "x" }, J, mcpEnv())).status, 403, "empty allowlist = nowhere");
  const rows = auditRows();
  assert.deepEqual(rows.map((r) => [r.via, r.origin, r.status]), [
    ["mcp", "agent", "refused"],
    ["local-token", "agent", "refused"],
    ["session", "agent", "refused"],
    ["mcp", "agent", "ok"],
    ["mcp", "agent", "refused"],
  ]);
});

test("agent origin may not send email or touch the calendar at all; a device token counts as human", async () => {
  for (const [p, b] of ROUTES.filter(([p]) => !p.startsWith("/matrix"))) {
    const r = await post(p, b, { ...J, "idempotency-key": freshKey() }, mcpEnv());
    assert.equal(r.status, 403, p);
    assert.equal(((await r.json()) as { error: string }).error, "agent_origin_refused");
  }
  assert.equal(sent.length + gogCalls.length + mboxCalls.length, 0);
  const dev = issueDeviceToken(config.ownerEmail, "phone", "prism-ios").token;
  const r = await post("/email/send", sendBody(), { ...J, authorization: `Bearer ${dev}`, "idempotency-key": freshKey() });
  assert.equal(r.status, 200);
  const last = auditRows().at(-1)!;
  assert.equal(last.via, "device");
  assert.equal(last.origin, "human");
});

test("audit route: owner reads newest-first, filters by action; no bodies in the output", async () => {
  await post("/email/send", sendBody(), { ...owner(), "idempotency-key": freshKey() });
  await post("/matrix/send", { roomId: "!room1:hs.example.test", body: "secret words" }, { ...owner(), "idempotency-key": freshKey() });
  const r = await acl.request("/actions/audit", { headers: owner() });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { entries: Array<{ action: string; target: Record<string, unknown> }> };
  assert.deepEqual(j.entries.map((e) => e.action), ["matrix.send", "email.send"]);
  assert.equal(j.entries[0]!.target.roomId, "!room1:hs.example.test");
  const text = JSON.stringify(j);
  assert.ok(!text.includes("secret words") && !text.includes("Body text") && !text.includes("alice@"));
  const f = (await (await acl.request("/actions/audit?action=email.send", { headers: owner() })).json()) as { entries: unknown[] };
  assert.equal(f.entries.length, 1);
});

test("credential: optional SMTP fields validated; IMAP-only credential round-trips unchanged", () => {
  const base = { host: "127.0.0.1", port: 1143, username: SELF, password: "p", security: "starttls", certSha256: PIN };
  assert.deepEqual(validateProtonCredential(base), base);
  const c = validateProtonCredential({ ...base, smtpPort: "1026", smtpSecurity: "tls", smtpCertSha256: "CD".repeat(32) });
  assert.equal(c.smtpPort, 1026);
  assert.equal(c.smtpSecurity, "tls");
  assert.equal(c.smtpCertSha256, "cd".repeat(32));
  assert.throws(() => validateProtonCredential({ ...base, smtpPort: 0 }));
  assert.throws(() => validateProtonCredential({ ...base, smtpSecurity: "none" }));
  assert.throws(() => validateProtonCredential({ ...base, smtpCertSha256: "zz" }));
});

// ── SMTP pin before AUTH (real nodemailer client vs a loopback stub) ─────────

function selfSigned(): { key: string; cert: string; sha: string } | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actions-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    const key = fs.readFileSync(`${dir}/k.pem`, "utf8");
    const cert = fs.readFileSync(`${dir}/c.pem`, "utf8");
    fs.rmSync(dir, { recursive: true, force: true });
    return { key, cert, sha: crypto.createHash("sha256").update(new crypto.X509Certificate(cert).raw).digest("hex") };
  } catch {
    return null;
  }
}
const TLS = selfSigned();

/** Minimal SMTP stub: greets, answers EHLO / STARTTLS, refuses AUTH, records every (decrypted) byte. */
async function stubSmtp(mode: "starttls" | "tls" | "no-starttls") {
  const received: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const serve = (sock: net.Socket, secure: boolean) => {
    let buf = "";
    const onData = (d: Buffer) => {
      received.push(d);
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.split(" ")[0]!.toUpperCase();
        if (cmd === "EHLO") {
          const starttls = !secure && mode === "starttls" ? "250-STARTTLS\r\n" : "";
          sock.write(`250-stub.example.test\r\n${starttls}250 AUTH PLAIN LOGIN\r\n`);
        } else if (cmd === "STARTTLS" && mode === "starttls" && !secure) {
          sock.removeListener("data", onData);
          sock.pause();
          sock.write("220 go ahead\r\n", () => {
            const t = new tls.TLSSocket(sock, { isServer: true, key: TLS!.key, cert: TLS!.cert });
            t.on("error", () => {});
            serve(t, true);
          });
          return;
        } else if (cmd === "AUTH") sock.write("535 5.7.8 stub refuses\r\n");
        else if (cmd === "QUIT") sock.end("221 bye\r\n");
        else sock.write("502 5.5.2 unsupported\r\n");
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  };
  const onConn = (secure: boolean) => (sock: net.Socket) => {
    sockets.add(sock);
    sock.write("220 stub.example.test ESMTP\r\n");
    serve(sock, secure);
  };
  const server = mode === "tls" ? tls.createServer({ key: TLS!.key, cert: TLS!.cert }, onConn(true)) : net.createServer(onConn(false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    text: () => Buffer.concat(received).toString("latin1"),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const STUB_PW = "stub-only-smtp-password-not-real";
const smtpCred = (port: number, security: "starttls" | "tls", pin: string): ProtonCredential =>
  validateProtonCredential({ host: "127.0.0.1", port: 1143, username: SELF, password: STUB_PW, security: "starttls", certSha256: PIN, smtpPort: port, smtpSecurity: security, smtpCertSha256: pin });
const tryOnce = (cred: ProtonCredential) => smtpSend({ timeoutMs: 5000 }).send(cred, { from: SELF, to: ["alice@example.test"] }, Buffer.from("Subject: x\r\n\r\nbody\r\n"));

for (const security of ["starttls", "tls"] as const) {
  test(`SMTP ${security}: wrong pin ⇒ zero AUTH bytes; right pin ⇒ AUTH reaches the stub`, { skip: TLS ? false : "openssl unavailable" }, async () => {
    const stub = await stubSmtp(security);
    try {
      await assert.rejects(tryOnce(smtpCred(stub.port, security, "00".repeat(32))), (e: Error & { sent?: unknown }) => {
        assert.match(e.message, /fingerprint mismatch/);
        assert.equal(e.sent, false);
        return true;
      });
      assert.doesNotMatch(stub.text(), /AUTH/i);
      assert.ok(!stub.text().includes(STUB_PW) && !stub.text().includes(Buffer.from(STUB_PW).toString("base64")));
    } finally {
      await stub.close();
    }
    const stub2 = await stubSmtp(security);
    try {
      await assert.rejects(tryOnce(smtpCred(stub2.port, security, TLS!.sha)), (e: Error & { sent?: unknown }) => {
        assert.match(e.message, /rejected the login/);
        assert.ok(!e.message.includes(STUB_PW));
        assert.equal(e.sent, false);
        return true;
      });
      assert.match(stub2.text(), /\bAUTH\b/, "the pinned connection proceeds to AUTH");
    } finally {
      await stub2.close();
    }
  });
}

test("SMTP: a server without STARTTLS is refused before any credential is sent", { skip: TLS ? false : "openssl unavailable" }, async () => {
  const stub = await stubSmtp("no-starttls");
  try {
    await assert.rejects(tryOnce(smtpCred(stub.port, "starttls", TLS!.sha)));
    assert.doesNotMatch(stub.text(), /AUTH/i);
    assert.ok(!stub.text().includes(STUB_PW));
  } finally {
    await stub.close();
  }
});

test("SMTP: a non-loopback host is refused without connecting", async () => {
  const cred = { ...smtpCred(1, "starttls", PIN), host: "mail.example.test" };
  await assert.rejects(tryOnce(cred), /non-loopback/);
});

// ── security review fixes (M1–M3, L1–L3, L7) ────────────────────────────────

test("M1 CSRF: text/plain or form bodies → 415; cross-site / same-site fetch → 403; foreign Origin → 403; nothing sent", async () => {
  const body = JSON.stringify(sendBody());
  const req = (h: Record<string, string>) => actionsApi.request("/email/send", { method: "POST", headers: { cookie: owner().cookie, "idempotency-key": freshKey(), ...h }, body });
  assert.equal((await req({ "content-type": "text/plain" })).status, 415);
  assert.equal((await req({ "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await req({})).status, 415, "no content type");
  assert.equal((await req({ ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await req({ ...J, "sec-fetch-site": "same-site" })).status, 403, "a sibling subdomain is same-site");
  assert.equal((await req({ ...J, origin: "https://evil.example.test" })).status, 403);
  assert.equal(sent.length, 0);
  assert.equal((await req({ ...J, "sec-fetch-site": "same-origin", origin: config.appOrigin })).status, 200, "the PWA itself");
  assert.equal((await req({ ...J, origin: config.nativeOrigins[0]! })).status, 200, "a native shell origin");
  // A native bearer device token is not an ambient credential: its cross-site fetch is fine.
  const dev = issueDeviceToken(config.ownerEmail, "phone", "prism-ios").token;
  const r = await actionsApi.request("/matrix/send", {
    method: "POST",
    headers: { ...J, authorization: `Bearer ${dev}`, "sec-fetch-site": "cross-site", origin: "tauri://localhost", "idempotency-key": freshKey() },
    body: JSON.stringify({ roomId: "!room1:hs.example.test", body: "from the phone" }),
  });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 2);
});

test("M2: matrix/google credentials are server-owner-only to write; actions read ONLY the primary vault's credentials", async () => {
  setMembership(VAULT, "admin@example.test", "admin", null);
  const admin = { ...J, cookie: sessionCookie(makeSession("admin@example.test")) };
  const cases: Array<[string, Record<string, string>]> = [
    ["matrix", { homeserver: "https://evil.example.test", accessToken: "x" }],
    ["google", { account: "evil@example.test" }],
  ];
  for (const [kind, b] of cases) {
    assert.equal((await integrations.request(`/${kind}`, { method: "PUT", headers: admin, body: JSON.stringify(b) })).status, 403, `admin PUT ${kind}`);
    assert.equal((await integrations.request(`/${kind}`, { method: "DELETE", headers: admin })).status, 403, `admin DELETE ${kind}`);
    assert.equal((await integrations.request(`/${kind}`, { headers: admin })).status, 200, `admin may still read ${kind} status`);
    assert.equal((await integrations.request(`/${kind}`, { method: "PUT", headers: owner(), body: JSON.stringify(b) })).status, 200, `owner PUT ${kind}`);
  }
  // The credential only exists under another vault id → the action sees none.
  deleteSecret(VAULT, config.ownerEmail, "matrix");
  putSecret("other-vault", config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://evil.example.test", accessToken: "x" }));
  const r = await post("/matrix/send", { roomId: "!room1:hs.example.test", body: "x" }, { ...owner(), "x-prism-vault": "other-vault", "idempotency-key": freshKey() });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, "not_configured");
  assert.equal(mxEvents.length, 0);
});

/** A fake imapflow slice: SEARCH returns every uid whose Message-ID CONTAINS the term (like IMAP). */
function fakeImap(msgs: Array<{ uid: number; mid: string }>, log: string[]): ActionImapClient {
  return {
    async mailboxOpen() {
      return {};
    },
    async search(q: { header?: Record<string, string> }) {
      const term = q.header!["message-id"]!;
      return msgs.filter((m) => m.mid.includes(term)).map((m) => m.uid);
    },
    fetch(range: string) {
      const uids = new Set(String(range).split(",").map(Number));
      const hits = msgs.filter((m) => uids.has(m.uid));
      return (async function* () {
        for (const m of hits) yield { uid: m.uid, headers: Buffer.from(`Message-ID: ${m.mid}\r\n`) };
      })();
    },
    async messageMove(uid: string, target: string) {
      log.push(`move ${uid} ${target}`);
      return {};
    },
    async messageFlagsAdd(uid: string) {
      log.push(`seen ${uid}`);
      return true;
    },
    async messageFlagsRemove(uid: string) {
      log.push(`unseen ${uid}`);
      return true;
    },
    async logout() {},
    close() {},
  } as unknown as ActionImapClient;
}

test("M3: IMAP acts only on EXACTLY one exact Message-ID match (SEARCH is a substring match)", async () => {
  const cred = validateProtonCredential({ host: "127.0.0.1", port: 1143, username: SELF, password: "p", security: "starttls", certSha256: PIN });
  const log: string[] = [];
  const msgs = [
    { uid: 5, mid: "<a@mail.example.test>" },
    { uid: 9, mid: "<xa@mail.example.test>" },
    { uid: 12, mid: "<a@mail.example.test.evil>" },
  ];
  const ops = imapMailboxOps({ connect: async () => fakeImap(msgs, log) });
  assert.equal(await ops.move(cred, "INBOX", "<a@mail.example.test>", "Archive"), "ok");
  assert.deepEqual(log, ["move 5 Archive"], "not the highest substring hit (12)");
  assert.equal(await ops.setSeen(cred, "INBOX", "<a>", true), "not_found", "a short crafted id matches nothing exactly");
  const dup = imapMailboxOps({ connect: async () => fakeImap([{ uid: 1, mid: "<d@x.test>" }, { uid: 2, mid: "<d@x.test>" }], log) });
  assert.equal(await dup.setSeen(cred, "INBOX", "<d@x.test>", true), "ambiguous");
  assert.deepEqual(log, ["move 5 Archive"], "nothing done when ambiguous or absent");
  assert.deepEqual(pickExactUid([{ uid: 3, messageId: "a@b" }], "<a@b>"), { uid: 3 });
  mboxFound = "ambiguous";
  assert.equal((await post("/email/archive", { messageId: "d@x.test" })).status, 409, "route maps ambiguous → 409");
});

test("L1: a reply is refused (409 target_changed) when the derived recipients differ from what the UI showed", async () => {
  emailNote("n5", { subject: "Hi", from: "Alice <alice@example.test>", messageId: "m5@mail.example.test", threadId: "m5@mail.example.test" });
  const r = await post("/email/reply", { noteId: "n5", body: "x", expectTo: ["mallory@example.test"] }, { ...owner(), "idempotency-key": freshKey() });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, "target_changed");
  assert.equal((await post("/email/reply", { noteId: "n5", body: "x" }, { ...owner(), "idempotency-key": freshKey() })).status, 400, "expectTo required");
  assert.equal(sent.length, 0);
});

test("L2: reply recipients use a real address parser (last angle-addr, quoted names) and honour Reply-To", () => {
  assert.deepEqual(buildReply({ messageId: "m@x", from: '"Eve <eve@evil.example.test>" <real@example.test>' }, SELF).to, ["real@example.test"]);
  assert.deepEqual(buildReply({ messageId: "m@x", from: "Alice <alice@example.test>", replyTo: "List <list@example.test>" }, SELF).to, ["list@example.test"]);
  assert.deepEqual(buildReply({ messageId: "m@x", from: SELF, to: '"Doe, Jane" <jane@example.test>, me@example.test' }, SELF).to, ["jane@example.test"]);
});

test("L3: an invalid RSVP response never reaches the audit target", async () => {
  assert.equal((await post("/calendar/rsvp", { eventId: "abc", response: "maybe<script>" })).status, 400);
  const row = auditRows().at(-1)!;
  assert.equal(row.status, "refused");
  assert.ok(!String(row.target).includes("script"));
});

test("L7: an oversized body is refused without a declared length (streamed cap)", async () => {
  const big = JSON.stringify({ ...sendBody(), body: "x".repeat(1_300_000) });
  const stream = new ReadableStream({
    start(ctl) {
      ctl.enqueue(new TextEncoder().encode(big));
      ctl.close();
    },
  });
  const r = await actionsApi.request("/email/send", { method: "POST", headers: { ...owner(), "idempotency-key": freshKey() }, body: stream, duplex: "half" } as RequestInit);
  assert.equal(r.status, 413);
  assert.equal(sent.length, 0);
});
