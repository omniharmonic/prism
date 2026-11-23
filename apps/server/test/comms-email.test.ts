/**
 * Email in Comms (comms/email.ts, comms/email-send.ts). Synthetic data only. The vault is a fake,
 * and NOTHING here can reach SMTP: the executor is a fake (setEmailSendForTests) or the real
 * proton-send executor with a fake spawner that never starts a process.
 */
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db } from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { clearRateLimitsForTests } from "../src/middleware/ratelimit";
import type { Note } from "../src/parachute";
import {
  emailRichText, isLowMessage, mailboxes, parseNoteContent, projectEmail, replyRecipients, sanitizeEmailHtml, splitEmailBody, type EmailProjectDeps,
} from "../src/comms/email";
import { markdownIn, setEmailSendForTests } from "../src/comms/email-send";
import { listThreads, getThread } from "../src/comms/store";
import { setEmailNoteReaderForTests } from "../src/routes/comms";
import { setParticipantsReaderForTests, addressesIn } from "../src/omni/recipients";
import { setProtonSpawnerForTests, protonSendArgs } from "../src/omni/proton-send";
import { consumeSendGrant, emailSendDigest } from "../src/omni/send-grant";
import { getApproval, type ApprovalKind } from "../src/omni/approvals";
import { auditRows, resetOmniStoreForTests } from "../src/omni/store";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const OWNER = config.ownerEmail; // owner@test.local — also the account the notes arrived at
const ENV = ["COMMS_ENABLED", "COMMS_SEND_ENABLED", "COMMS_EMAIL_ENABLED", "COMMS_EMAIL_SEND_ENABLED", "OMNI_ENABLED", "OMNI_PROTON_SEND", "OMNI_EXECUTORS"] as const;
const saved: Record<string, string | undefined> = {};

let notes: Note[];
let people: Record<string, { id: string; name: string }>;
const deps = (): EmailProjectDeps => ({
  listEmailNotes: async () => notes.map((n) => ({ ...n, content: "" })),
  getNote: async (id) => notes.find((n) => n.id === id) ?? null,
  personByEmail: (a) => people[a] ?? null,
  selfAddresses: [OWNER],
});

let seq = 0;
function email(o: { id?: string; from: string; to?: string; cc?: string; subject?: string; body?: string; threadId: string; labels?: string[]; at: number; unread?: boolean; account?: string | null; tags?: string[]; html?: string; replyTo?: string }): Note {
  const id = o.id ?? `n${++seq}`;
  const mid = `${id}@mail.example.test`;
  return {
    id, path: `vault/messages/email/${id}`, createdAt: new Date(o.at).toISOString(), updatedAt: new Date(o.at).toISOString(), tags: ["email", ...(o.tags ?? [])],
    content: `# ${o.subject ?? "Hello"}\n\n**From:** ${o.from}  \n**To:** ${o.to ?? OWNER}  \n**Date:** 2026-11-20 10:00  \n\n---\n\n${o.body ?? "Hi there"}`,
    metadata: {
      type: "email", subject: o.subject ?? "Hello", from: o.from, to: o.to ?? OWNER, cc: o.cc ?? "", labels: o.labels ?? ["INBOX", "DIRECT"],
      threadId: o.threadId, messageId: mid, lastMessageAt: o.at, isUnread: o.unread ?? false, account: o.account === undefined ? OWNER : o.account,
      ...(o.html ? { html: o.html } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}),
    },
  };
}

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  db.exec("DELETE FROM comms_conversations; DELETE FROM comms_threads; DELETE FROM comms_thread_members; DELETE FROM comms_conversation_members; DELETE FROM comms_events; DELETE FROM comms_email_messages; DELETE FROM comms_email_sent; DELETE FROM comms_sends;");
  for (const k of ENV) saved[k] = process.env[k];
  Object.assign(process.env, { COMMS_ENABLED: "true", COMMS_SEND_ENABLED: "true", COMMS_EMAIL_ENABLED: "true", COMMS_EMAIL_SEND_ENABLED: "true", OMNI_ENABLED: "true", OMNI_PROTON_SEND: process.execPath });
  delete process.env.OMNI_EXECUTORS;
  clearRateLimitsForTests("comms");
  notes = [];
  people = {};
  setEmailNoteReaderForTests(async (id) => notes.find((n) => n.id === id) ?? null);
  setEmailSendForTests({ readNote: async (id) => notes.find((n) => n.id === id) ?? null, exec: null });
  setParticipantsReaderForTests(async (id) => {
    const n = notes.find((x) => x.id === id);
    return n ? { addresses: addressesIn(n.metadata ?? {}), hasCc: true } : null;
  });
});
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  setEmailNoteReaderForTests(null);
  delete process.env.OMNI_EMAIL_EXECUTOR;
  setEmailSendForTests({ exec: null });
  setParticipantsReaderForTests(null);
  setProtonSpawnerForTests(null);
});

const device = () => ({ authorization: `Bearer ${issueDeviceToken(OWNER, "Comms (test)", "comms-native").token}` });
const J = { "content-type": "application/json" };
const getJ = async (path: string) => {
  const r = await createApp().request(path, { headers: { cookie: sessionCookie(makeSession(OWNER)) } });
  return { status: r.status, body: (await r.json()) as any };
};
const post = (path: string, body: unknown, headers: Record<string, string> = device()) =>
  createApp().request(path, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });
const emailThreads = () => listThreads({ limit: 100 }).threads.filter((t) => t.networks[0] === "email");

// ── pure helpers ─────────────────────────────────────────────────────────────

test("headers: mailboxes parse display names and addresses (lowercased)", () => {
  assert.deepEqual(mailboxes(`"Ann Lee" <Ann@Example.test>, bob@x.test`), [{ name: "Ann Lee", addr: "ann@example.test" }, { name: "", addr: "bob@x.test" }]);
  assert.deepEqual(mailboxes(""), []);
});

test("labels: newsletters / automated / promotions are low; DIRECT never", () => {
  for (const l of ["BULK", "AUTOMATED", "SOCIAL", "CHAT", "PROMOTIONS", "TRANSACTIONAL"]) assert.equal(isLowMessage(["INBOX", l]), true, l);
  assert.equal(isLowMessage(["INBOX", "DIRECT"]), false);
  assert.equal(isLowMessage(["INBOX", "BULK", "DIRECT"]), false);
  assert.equal(isLowMessage(["INBOX"]), false);
});

test("bodies: quoted history and signature collapse; a bare forward shows everything", () => {
  const b = "Sounds good, see you then.\n\nBest,\nAnn\n-- \nAnn Lee | Example Co\n\nOn Mon, Nov 17, 2026 at 9:00 AM Owner <owner@test.local> wrote:\n> Lunch on Thursday?\n";
  const s = splitEmailBody(b);
  assert.equal(s.fresh, "Sounds good, see you then.\n\nBest,\nAnn");
  assert.match(s.collapsed, /^-- \nAnn Lee/);
  assert.match(s.collapsed, /> Lunch on Thursday\?/);
  assert.deepEqual(splitEmailBody("Hi\n\nOn Tue, Nov 18 2026, Bob <b@x.test>\nwrote:\n> old").fresh, "Hi");
  assert.deepEqual(splitEmailBody("Thanks!\n\n> earlier\n> more\n").fresh, "Thanks!");
  assert.deepEqual(splitEmailBody("Inline > not a quote\nmore").collapsed, "");
  assert.deepEqual(splitEmailBody("---------- Forwarded message ---------\nFrom: x"), { fresh: "---------- Forwarded message ---------\nFrom: x", collapsed: "" });
  const rt = emailRichText(b);
  assert.equal(rt.quotedCollapsed, true);
  assert.equal(rt.body.plain, "Sounds good, see you then.\n\nBest,\nAnn");
  assert.equal(rt.body.spans.at(-1)!.t, "quote");
  // Plain text is never interpreted as markup.
  assert.deepEqual(emailRichText("**not bold** <b>x</b>").body.spans, [{ t: "text", v: "**not bold** <b>x</b>" }]);
});

test("note content: body after the header rule; attachments listed by name", () => {
  const c = "# S\n\n**From:** a@x.test  \n**Attachments:** a.pdf, b.png  \n\n---\n\nBody line\n\n[… truncated …]";
  assert.deepEqual(parseNoteContent(c), { body: "Body line", attachments: ["a.pdf", "b.png"] });
});

test("HTML for 'View full email': scripts, handlers, forms and remote loads are removed", () => {
  const bypass = sanitizeEmailHtml(`<img/src="https://t.example/a.gif"><img/onerror=alert(1) src=x><a href="https://ok.example" ping="https://t.example/p">p</a><p style="background:u&#114;l(https://t.example/x)">e</p><p style="color:red">ok url( text</p>`);
  assert.doesNotMatch(bypass, /t\.example|onerror|ping=/);
  assert.match(bypass, /style="color:red"/);
  assert.match(bypass, /ok url\( text/, "text is left alone");
  const h = sanitizeEmailHtml(`<p onclick="x()">Hi <img src="https://track.example/p.gif"><img src="cid:logo"><a href="javascript:alert(1)">j</a><a href="https://ok.example">ok</a></p><script>alert(1)</script><style>@import url(https://e/x.css)</style><form action="https://e"><input></form><div style="background:url(https://e/b.png)">x</div><iframe src="https://e"></iframe>`);
  assert.doesNotMatch(h, /script|onclick|javascript:|track\.example|<form|<input|iframe|url\(https/i);
  assert.match(h, /cid:logo/);
  assert.match(h, /href="https:\/\/ok\.example"/);
});

test("replies: reply-all from the thread, minus the owner; Reply-To wins", () => {
  assert.deepEqual(replyRecipients({ from: "Ann <ann@x.test>", to: `${OWNER}, bob@x.test`, cc: "carol@x.test, owner@test.local" }, [OWNER]), { to: ["ann@x.test"], cc: ["bob@x.test", "carol@x.test"] });
  assert.deepEqual(replyRecipients({ from: "Ann <ann@x.test>", to: OWNER, cc: "", replyTo: "list@x.test" }, [OWNER]), { to: ["list@x.test"], cc: [] });
});

test("plain text only: the same shapes proton_send.py refuses", () => {
  for (const b of ["**b**", "# H", "- item", "> quote", "[t](https://x)", "`c`", "```"]) assert.ok(markdownIn(b), b);
  for (const b of ["Hi Ann,\n\nThanks — see you at 3.\n\nBen", "1. first", "Price: $5 * 2"]) assert.equal(markdownIn(b), null, b);
});

// ── projection ──────────────────────────────────────────────────────────────

test("projection: one DM per correspondent thread, titled by the sender, subject + snippet preview, trusted unread", async () => {
  notes = [
    email({ from: "Ann Lee <ann@x.test>", subject: "Lunch?", body: "Are you free Thursday?\n\n> old", threadId: "t1", at: 1_000, unread: true }),
    email({ from: "Ann Lee <ann@x.test>", subject: "Re: Lunch?", body: "Or Friday works too.", threadId: "t1", at: 2_000, unread: true }),
    email({ from: "Ann Lee <ann@x.test>", subject: "Other topic", threadId: "t2", at: 1_500 }),
  ];
  const r = await projectEmail(deps());
  assert.equal(r.conversations, 2);
  const ts = emailThreads();
  assert.equal(ts.length, 2, "two threads of the same sender stay two conversations");
  const t1 = ts.find((t) => t.lastMessage?.subject === "Re: Lunch?")!;
  assert.equal(t1.title, "Ann Lee");
  assert.equal(t1.titleSource, "email");
  assert.equal(t1.kind, "dm");
  assert.equal(t1.folder, "inbox");
  assert.deepEqual(t1.unread, { count: 2, trusted: true });
  assert.equal(t1.lastMessage!.text, "Or Friday works too.");
  assert.equal(t1.lastMessage!.senderName, "Ann Lee");
  assert.equal(t1.channels[0]!.accountLabel, OWNER);
  assert.equal(t1.channels[0]!.capabilities?.attachments, false);
});

test("projection: a confident strong key links the person (title + person page); no key, no link", async () => {
  people = { "ann@x.test": { id: "p-ann", name: "Ann Lee-Smith" } };
  notes = [email({ from: "Annie <ann@x.test>", threadId: "t1", at: 1 }), email({ from: "Ann Other <ann2@x.test>", threadId: "t2", at: 2 })];
  await projectEmail(deps());
  const linked = listThreads({ limit: 10, personId: "p-ann" }).threads;
  assert.equal(linked.length, 1);
  assert.equal(linked[0]!.title, "Ann Lee-Smith");
  assert.equal(linked[0]!.titleSource, "person");
  const other = emailThreads().find((t) => t.title === "Ann Other")!;
  assert.equal(other.personId, undefined, "a name is never a key");
});

test("projection: Low by header labels; one DIRECT message or an owner reply keeps it in the inbox; tag `low` wins", async () => {
  notes = [
    email({ from: "News <news@shop.test>", subject: "Sale", threadId: "promo", labels: ["INBOX", "BULK", "PROMOTIONS"], at: 1 }),
    email({ from: "Bank <noreply@bank.test>", subject: "Receipt", threadId: "tx", labels: ["INBOX", "AUTOMATED", "TRANSACTIONAL"], at: 2 }),
    email({ from: "List <l@list.test>", subject: "Digest", threadId: "mixed", labels: ["INBOX", "BULK"], at: 3 }),
    email({ from: "Ann <ann@list.test>", subject: "Re: Digest", threadId: "mixed", labels: ["INBOX", "DIRECT"], at: 4 }),
    email({ from: "Ann <ann@x.test>", subject: "Hi", threadId: "tagged", at: 5, tags: ["low"] }),
    email({ from: "Owner <owner@test.local>", to: "news2@shop.test", subject: "Unsubscribe", threadId: "mine", labels: ["INBOX"], at: 6 }),
    email({ from: "News2 <news2@shop.test>", subject: "Re: Unsubscribe", threadId: "mine", labels: ["INBOX", "BULK"], at: 7 }),
  ];
  await projectEmail(deps());
  const folder = (subj: string) => emailThreads().find((t) => t.lastMessage?.subject === subj)?.folder;
  assert.equal(folder("Sale"), "low");
  assert.equal(folder("Receipt"), "low");
  assert.equal(folder("Re: Digest"), "inbox");
  assert.equal(folder("Hi"), "low");
  assert.equal(folder("Re: Unsubscribe"), "inbox", "the owner wrote in it");
  assert.equal(listThreads({ limit: 10, folder: "inbox" }).threads.filter((t) => t.networks[0] === "email").length, 2, "the default inbox listing leaves Low out");
});

test("projection: Cc'd people make a group still titled by the sender; accounts never merge; vanished threads go", async () => {
  notes = [
    email({ from: "Ann <ann@x.test>", cc: "bob@x.test, carol@x.test", subject: "Plan", threadId: "g", at: 1 }),
    email({ from: "Ann <ann@x.test>", subject: "Same id", threadId: "shared", at: 2 }),
    email({ from: "Ann <ann@x.test>", subject: "Same id", threadId: "shared", at: 3, account: "other@test.local", id: "other-acct" }),
  ];
  await projectEmail(deps());
  const g = emailThreads().find((t) => t.lastMessage?.subject === "Plan")!;
  assert.equal(g.kind, "group");
  assert.equal(g.title, "Ann");
  assert.equal(emailThreads().filter((t) => t.lastMessage?.subject === "Same id").length, 2);
  notes = notes.filter((n) => (n.metadata as any).threadId !== "g");
  const r = await projectEmail(deps());
  assert.equal(r.removed, 1);
  assert.equal(emailThreads().some((t) => t.lastMessage?.subject === "Plan"), false);
});

test("projection: a quiet re-run appends no thread.updated; a new message in a known thread is message.created", async () => {
  notes = [email({ from: "Ann <ann@x.test>", threadId: "t", at: 1 })];
  await projectEmail(deps());
  const n0 = (db.prepare(`SELECT COUNT(*) AS n FROM comms_events`).get() as { n: number }).n;
  await projectEmail(deps());
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM comms_events`).get() as { n: number }).n, n0);
  notes.push(email({ from: "Ann <ann@x.test>", threadId: "t", at: 2, body: "Second" }));
  await projectEmail(deps());
  const kinds = (db.prepare(`SELECT kind FROM comms_events WHERE id > ?`).all(n0) as { kind: string }[]).map((r) => r.kind);
  assert.ok(kinds.includes("message.created"));
  assert.ok(kinds.includes("thread.updated"));
});

// ── read routes ─────────────────────────────────────────────────────────────

test("routes: email bubbles (subject, collapsed quotes, plain text) and the composer's reply header", async () => {
  notes = [
    email({ id: "m1", from: "Ann Lee <ann@x.test>", to: `${OWNER}, bob@x.test`, subject: "Plan", body: "Here's the plan.\n\nOn Mon Owner wrote:\n> what's the plan?", threadId: "t", at: 1_000, html: "<p>Here's <b>the</b> plan<script>x</script></p>" }),
  ];
  await projectEmail(deps());
  const t = emailThreads()[0]!;
  const d = await getJ(`/api/comms/threads/${t.id}`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.email, {
    account: OWNER,
    reply: { to: ["ann@x.test"], cc: [], subject: "Re: Plan" },
    replyAll: { to: ["ann@x.test"], cc: ["bob@x.test"], subject: "Re: Plan" },
  });
  assert.equal(d.body.capabilities.send, true);
  const m = await getJ(`/api/comms/threads/${t.id}/messages`);
  assert.equal(m.status, 200);
  const msg = m.body.messages[0];
  assert.equal(msg.email.subject, "Plan");
  assert.equal(msg.email.quotedCollapsed, true);
  assert.equal(msg.email.hasHtml, true);
  assert.deepEqual(msg.email.to, [OWNER, "bob@x.test"]);
  assert.equal(msg.body.plain, "Here's the plan.");
  assert.equal(msg.sender.name, "Ann Lee");
  const o = await getJ(`/api/comms/threads/${t.id}/messages/m1/original`);
  assert.equal(o.status, 200);
  assert.match(o.body.text, /what's the plan/);
  assert.doesNotMatch(o.body.html, /script/);
  assert.equal((await getJ(`/api/comms/threads/${t.id}/messages/nope/original`)).status, 404);
});

test("routes: a thread of another account has no reply (no fallback account)", async () => {
  notes = [email({ from: "Ann <ann@x.test>", threadId: "t", at: 1, account: "work@else.test" })];
  await projectEmail(deps());
  const d = await getJ(`/api/comms/threads/${emailThreads()[0]!.id}`);
  assert.deepEqual(d.body.email, { account: "work@else.test", reply: null, replyAll: null, replyUnavailable: "account" });
});

// ── sending: the one door ───────────────────────────────────────────────────

type Call = { kind: ApprovalKind; payload: Record<string, unknown>; approvalId: string; status: string | null };
async function setupThread(): Promise<string> {
  notes = [email({ id: "m1", from: "Ann Lee <ann@x.test>", to: `${OWNER}, bob@x.test`, subject: "Plan", threadId: "t", at: 1_000 })];
  await projectEmail(deps());
  return emailThreads()[0]!.id;
}
const ECHO = { to: ["ann@x.test"], cc: ["bob@x.test"], subject: "Re: Plan" };

test("send: the device press creates the email-reply approval, claims it with the exact digest, the executor runs it once", async () => {
  const th = await setupThread();
  const calls: Call[] = [];
  setEmailSendForTests({ exec: async (o) => { calls.push({ ...o, status: getApproval(OWNER, o.approvalId)?.status ?? null }); return { status: "sent", detail: { executor: "fake", messageId: "<sent1@x>" } }; } });
  const clientId = crypto.randomUUID();
  const r = await post(`/api/comms/threads/${th}/messages`, { clientId, text: "Thanks Ann — works for me.", email: ECHO });
  assert.equal(r.status, 200, await r.clone().text());
  const body = (await r.json()) as any;
  assert.equal(body.status, "sent");
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.kind, "email-reply");
  assert.equal(c.status, "approved", "claimed before the executor runs");
  assert.deepEqual(c.payload, {
    noteId: "m1", expectTo: ["ann@x.test"], cc: ["bob@x.test"], body: "Thanks Ann — works for me.",
    subject: "Re: Plan", inReplyTo: "<m1@mail.example.test>", references: "<t> <m1@mail.example.test>",
  });
  const a = getApproval(OWNER, c.approvalId)!;
  assert.equal(a.status, "sent");
  assert.equal(a.decidedVia, "comms-device");
  assert.ok(auditRows().some((x) => x.action === "approval.approve" && x.approval_id === c.approvalId));
  // Replay: same clientId → stored answer, no second send.
  const again = await post(`/api/comms/threads/${th}/messages`, { clientId, text: "Thanks Ann — works for me.", email: ECHO });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(calls.length, 1);
  // The sent reply shows in the thread (the vault syncs INBOX only), with its clientId.
  const m = await getJ(`/api/comms/threads/${th}/messages`);
  const mine = m.body.messages.at(-1);
  assert.equal(mine.sender.isSelf, true);
  assert.equal(mine.clientId, clientId);
  assert.equal(mine.email.subject, "Re: Plan");
  assert.equal(getThread(th)!.lastMessage!.isSelf, true);
});

test("send: the real proton-send executor gets a grant bound to exactly this reply (fake spawner — no process, no SMTP)", async () => {
  const th = await setupThread();
  let seen: { args: string[]; input: string; verdict: unknown; mismatch: unknown } | null = null;
  setProtonSpawnerForTests(async (_cmd, args, o) => {
    const approvalId = o.env.PRISM_SEND_GRANT_APPROVAL!;
    const a = getApproval(OWNER, approvalId)!;
    const status = (id: string) => getApproval(OWNER, id)?.status ?? null;
    // The script computes the digest from its own argv + stdin; it must equal the approved payload's.
    seen = { args: args.slice(1), input: o.input, verdict: consumeSendGrant(approvalId, o.grant, emailSendDigest("email-reply", a.payload), status), mismatch: null };
    seen.mismatch = consumeSendGrant(approvalId, o.grant, emailSendDigest("email-reply", { ...a.payload, body: "other" }), status);
    return { code: 0, signal: null, stdout: '{"messageId": "<x@y>"}', stderr: "", timedOut: false };
  });
  const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "See you then.", email: ECHO });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(seen);
  const s = seen as { args: string[]; input: string; verdict: unknown; mismatch: unknown };
  assert.deepEqual(s.verdict, { ok: true });
  assert.deepEqual(s.mismatch, { ok: false, error: "invalid_grant" }, "single use");
  assert.equal(s.input, "See you then.");
  const a = getApproval(OWNER, db.prepare(`SELECT id FROM omni_approvals ORDER BY created_at DESC LIMIT 1`).pluck().get() as string)!;
  assert.deepEqual(s.args, protonSendArgs("email-reply", a.payload, OWNER));
  assert.ok(s.args.includes("--reply-to-note") && s.args.includes("--in-reply-to"));
  assert.deepEqual(s.args.filter((_, i) => s.args[i - 1] === "--to"), ["ann@x.test"]);
  assert.deepEqual(s.args.filter((_, i) => s.args[i - 1] === "--cc"), ["bob@x.test"]);
});

test("send: what the owner saw is what is sent — a changed To/Cc/Subject is refused before any approval", async () => {
  const th = await setupThread();
  let ran = 0;
  setEmailSendForTests({ exec: async () => { ran++; return { status: "sent", detail: {} }; } });
  for (const email of [{ ...ECHO, to: ["mallory@evil.test"] }, { ...ECHO, cc: ["mallory@evil.test"] }, { ...ECHO, cc: ["bob@x.test", "mallory@evil.test"] }, { ...ECHO, to: ["ann@x.test", "bob@x.test"], cc: [] }, { ...ECHO, subject: "Re: Other" }]) {
    const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi", email });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as any).error, "target_changed");
  }
  const missing = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi" });
  assert.equal(missing.status, 422);
  assert.equal(ran, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM omni_approvals`).pluck().get(), 0);
});

test("send: markdown is refused (plain text only); attachments and per-message replies are refused", async () => {
  const th = await setupThread();
  setEmailSendForTests({ exec: async () => assert.fail("never executed") });
  const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "**Yes**", email: ECHO });
  assert.equal(r.status, 422);
  assert.equal(((await r.json()) as any).error, "not_plain_text");
  const rep = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi", replyTo: "$ev:x", email: ECHO });
  assert.equal(rep.status, 422);
  const fd = new FormData();
  fd.append("clientId", crypto.randomUUID());
  fd.append("kind", "file");
  fd.append("file", new Blob([Buffer.from("%PDF-1.7\n")]), "a.pdf");
  const att = await createApp().request(`/api/comms/threads/${th}/attachments`, { method: "POST", headers: device(), body: fd });
  assert.equal(att.status, 409);
});

test("send: only the owner's device — a session, an agent downgrade or another account sends nothing", async () => {
  const th = await setupThread();
  setEmailSendForTests({ exec: async () => assert.fail("never executed") });
  const body = () => ({ clientId: crypto.randomUUID(), text: "hi", email: ECHO });
  assert.equal((await post(`/api/comms/threads/${th}/messages`, body(), { cookie: sessionCookie(makeSession(OWNER)) })).status, 403);
  assert.equal((await post(`/api/comms/threads/${th}/messages`, body(), { ...device(), "x-prism-action-origin": "agent" })).status, 403);
  assert.equal((await post(`/api/comms/threads/${th}/messages`, body(), { authorization: `Bearer ${issueDeviceToken("stranger@test.local", "x", "comms-native").token}` })).status, 403);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM omni_approvals`).pluck().get(), 0);
});

test("send: flags — COMMS_EMAIL_SEND_ENABLED off (default), OMNI off, or the executor off → send_disabled, capability send:false", async () => {
  const th = await setupThread();
  setEmailSendForTests({ exec: async () => assert.fail("never executed") });
  for (const [k, v] of [["COMMS_EMAIL_SEND_ENABLED", undefined], ["OMNI_ENABLED", "false"], ["OMNI_EXECUTORS", "off"], ["OMNI_PROTON_SEND", undefined]] as const) {
    const prev = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi", email: ECHO });
    assert.equal(r.status, 403, k);
    assert.equal(((await r.json()) as any).error, "send_disabled", k);
    assert.equal((await getJ(`/api/comms/threads/${th}`)).body.capabilities.send, false, k);
    if (prev === undefined) delete process.env[k]; else process.env[k] = prev;
  }
});

test("send: wrong account refused; a recipient no longer on the email refused before the executor (approval cancelled)", async () => {
  const th = await setupThread();
  setEmailSendForTests({ exec: async () => assert.fail("never executed") });
  (notes[0]!.metadata as any).account = "other@test.local";
  const w = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi", email: ECHO });
  assert.equal(w.status, 409);
  assert.equal(((await w.json()) as any).error, "wrong_account");
  (notes[0]!.metadata as any).account = OWNER;
  // The participants reader (fresh read in the one-door check) no longer lists Bob.
  setParticipantsReaderForTests(async () => ({ addresses: ["ann@x.test", OWNER], hasCc: true }));
  const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi", email: ECHO });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as any).error, "target_changed");
  const a = db.prepare(`SELECT status FROM omni_approvals`).pluck().all();
  assert.deepEqual(a, ["cancelled"]);
});

test("send: failed → not sent (clientId free again); unknown → maybe sent, never retried", async () => {
  const th = await setupThread();
  let outcome: "failed" | "unknown" = "failed";
  let runs = 0;
  setEmailSendForTests({ exec: async () => { runs++; return { status: outcome, detail: { error: "ERROR: Refusing to send" } }; } });
  const id1 = crypto.randomUUID();
  const f = await post(`/api/comms/threads/${th}/messages`, { clientId: id1, text: "hi", email: ECHO });
  assert.equal(f.status, 502);
  assert.equal(((await f.json()) as any).maybeSent, false);
  outcome = "unknown";
  const id2 = crypto.randomUUID();
  const u = await post(`/api/comms/threads/${th}/messages`, { clientId: id2, text: "hello", email: ECHO });
  assert.equal(u.status, 502);
  assert.equal(((await u.json()) as any).maybeSent, true);
  const again = await post(`/api/comms/threads/${th}/messages`, { clientId: id2, text: "hello", email: ECHO });
  assert.equal(again.status, 502, "a maybe-sent email is not retried");
  assert.equal(runs, 2);
  assert.deepEqual(db.prepare(`SELECT status FROM omni_approvals ORDER BY created_at`).pluck().all(), ["failed", "unknown"]);
});

test("new email (D11): To: an address, a subject → an `email` approval; the sent message opens its own conversation", async () => {
  const calls: Call[] = [];
  setEmailSendForTests({ exec: async (o) => { calls.push({ ...o, status: null }); return { status: "sent", detail: { messageId: "<new1@mail.test>" } }; } });
  const r = await post(`/api/comms/conversations`, { clientId: crypto.randomUUID(), network: "email", handle: "Dana@Example.test", subject: "Hello", text: "Hi Dana,\n\nQuick question." });
  assert.equal(r.status, 200, await r.clone().text());
  const b = (await r.json()) as any;
  assert.equal(calls[0]!.kind, "email");
  assert.deepEqual(calls[0]!.payload, { to: ["dana@example.test"], subject: "Hello", body: "Hi Dana,\n\nQuick question." });
  assert.equal(b.thread.title, "dana@example.test");
  assert.equal(b.thread.lastMessage.subject, "Hello");
  // Dana's reply (thread root = our Message-ID) lands in the same conversation; the sent echo stays.
  notes = [email({ from: "Dana <dana@example.test>", subject: "Re: Hello", threadId: "new1@mail.test", at: Date.now() + 1000 })];
  await projectEmail(deps());
  const ts = emailThreads();
  assert.equal(ts.length, 1);
  assert.equal(ts[0]!.id, b.threadId);
  const bad = await post(`/api/comms/conversations`, { clientId: crypto.randomUUID(), network: "email", handle: "+15550001", subject: "x", text: "y" });
  assert.equal(bad.status, 422);
  const noSubj = await post(`/api/comms/conversations`, { clientId: crypto.randomUUID(), network: "email", handle: "a@b.test", text: "y" });
  assert.equal(noSubj.status, 422);
});


// ── fix round 1 ─────────────────────────────────────────────────────────────

const REPLY = { to: ["ann@x.test"], cc: [], subject: "Re: Plan" };

test("I1: Reply (sender only) is the default option and sends to the sender alone; the digest binds the chosen set", async () => {
  const th = await setupThread();
  const calls: Call[] = [];
  setEmailSendForTests({ exec: async (o) => { calls.push({ ...o, status: null }); return { status: "sent", detail: {} }; } });
  const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "Just you, Ann.", email: REPLY });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(calls[0]!.payload.expectTo, ["ann@x.test"]);
  assert.equal(calls[0]!.payload.cc, undefined, "no Cc on a Reply");
  const a = getApproval(OWNER, calls[0]!.approvalId)!;
  assert.equal(a.digest.length, 64);
  // The same text as Reply All is a different approval (different recipients, different digest).
  await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "Just you, Ann.", email: ECHO });
  const b = getApproval(OWNER, calls[1]!.approvalId)!;
  assert.deepEqual(b.payload.cc, ["bob@x.test"]);
  assert.notEqual(a.digest, b.digest);
});

test("I1: only addresses on the thread — a reply's recipients are derived from it and checked against every email in it", async () => {
  const { threadAddresses } = await import("../src/comms/email");
  const th = await setupThread();
  const conv = db.prepare(`SELECT conversation_id FROM comms_thread_members WHERE thread_id = ?`).pluck().get(th) as string;
  assert.deepEqual([...threadAddresses(conv)].sort(), ["ann@x.test", "bob@x.test", OWNER].sort());
});

test("M1: Reply-To — the header and the send agree (To = Reply-To), and the send goes through", async () => {
  notes = [email({ id: "m1", from: "Ann Lee <ann@x.test>", replyTo: "Desk <desk@x.test>", subject: "Plan", threadId: "t", at: 1_000 })];
  await projectEmail(deps());
  const th = emailThreads()[0]!.id;
  const d = await getJ(`/api/comms/threads/${th}`);
  assert.deepEqual(d.body.email.reply, { to: ["desk@x.test"], cc: [], subject: "Re: Plan" });
  setEmailSendForTests({ exec: async () => ({ status: "sent", detail: {} }) });
  const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "ok", email: d.body.email.reply });
  assert.equal(r.status, 200, await r.clone().text());
});

test("M7: more recipients than an approval holds → no Reply All (Reply stays)", async () => {
  const many = Array.from({ length: 21 }, (_, i) => `p${i}@x.test`).join(", ");
  notes = [email({ id: "m1", from: "Ann <ann@x.test>", cc: many, subject: "Big", threadId: "t", at: 1 })];
  await projectEmail(deps());
  const d = await getJ(`/api/comms/threads/${emailThreads()[0]!.id}`);
  assert.deepEqual(d.body.email.reply, { to: ["ann@x.test"], cc: [], subject: "Re: Big" });
  assert.equal(d.body.email.replyAll, null);
});

test("M2: the live-actions email executor never carries a Comms email (proton_send.py only)", async () => {
  const th = await setupThread();
  process.env.OMNI_EMAIL_EXECUTOR = "live-actions";
  const r = await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi", email: REPLY });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as any).error, "send_disabled");
});

test("M3: the claimed-approval runner runs only an approval claimed via the Comms door, with its stored payload", async () => {
  const { runClaimedApproval } = await import("../src/routes/omni");
  const { createApproval, claimApproval } = await import("../src/omni/approvals");
  const a = createApproval({ owner: OWNER, threadId: null, kind: "email", payload: { to: ["a@x.test"], subject: "s", body: "b" }, ttlMs: 60_000 });
  assert.deepEqual(await runClaimedApproval(a.id, "comms-device"), { status: "disabled", detail: { error: "not_claimed" } }, "pending");
  claimApproval(a.id, a.digest, "device", null, "k-other-door");
  assert.deepEqual(await runClaimedApproval(a.id, "comms-device"), { status: "disabled", detail: { error: "not_claimed" } }, "claimed by another door");
  assert.deepEqual(await runClaimedApproval("apr_nope", "comms-device"), { status: "disabled", detail: { error: "not_claimed" } });
});

test("M6: what is kept of a failed send names no address or subject", async () => {
  const { safeOutcomeDetail } = await import("../src/comms/email-send");
  const d = safeOutcomeDetail({ executor: "proton-send", exitCode: 1, error: "Reply context from vault/x:\n  to: ann@x.test\n  subject: Secret plan\nERROR: Refused recipients: bob@x.test, carol@x.test" });
  assert.deepEqual(d, { executor: "proton-send", exitCode: 1, error: "ERROR: Refused recipients: [address], [address]" });
  assert.deepEqual(safeOutcomeDetail({ error: "timeout" }), { error: "timeout" });
  const th = await setupThread();
  setEmailSendForTests({ exec: async () => ({ status: "failed", detail: { error: "to: ann@x.test subject: Plan\nERROR: Refusing to send to bob@x.test" } }) });
  await post(`/api/comms/threads/${th}/messages`, { clientId: crypto.randomUUID(), text: "hi", email: REPLY });
  const rows = JSON.stringify([db.prepare(`SELECT result FROM omni_approvals`).all(), auditRows()]);
  assert.doesNotMatch(rows, /ann@x\.test|bob@x\.test|Plan/);
});

test("M9: a new email to someone a conversation already knows is titled by their person", async () => {
  people = { "ann@x.test": { id: "p-ann", name: "Ann Lee" } };
  notes = [email({ from: "Ann <ann@x.test>", threadId: "old", at: 1 })];
  await projectEmail(deps());
  setEmailSendForTests({ exec: async () => ({ status: "sent", detail: { messageId: "<n2@mail.test>" } }) });
  const r = await post(`/api/comms/conversations`, { clientId: crypto.randomUUID(), network: "email", handle: "ann@x.test", subject: "Hi", text: "Hello" });
  const b = (await r.json()) as any;
  assert.equal(b.thread.title, "Ann Lee");
  assert.equal(b.thread.personId, "p-ann");
});

test("projection: an empty or sharply shrunk listing removes nothing (a vault mid-reindex; final review M8)", async () => {
  notes = Array.from({ length: 10 }, (_, i) => email({ from: "Ann <ann@x.test>", subject: `S${i}`, threadId: `t${i}`, at: i + 1 }));
  await projectEmail(deps());
  assert.equal(emailThreads().length, 10);
  const all = notes;
  notes = [];
  assert.equal((await projectEmail(deps())).removed, 0, "empty listing");
  notes = all.slice(0, 3);
  assert.equal((await projectEmail(deps())).removed, 0, "7 of 10 gone at once");
  assert.equal(emailThreads().length, 10);
  notes = all.slice(0, 9);
  assert.equal((await projectEmail(deps())).removed, 1, "an ordinary pass removes what is really gone");
  assert.equal(emailThreads().length, 9);
});
