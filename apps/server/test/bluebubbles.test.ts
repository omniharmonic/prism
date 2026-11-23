/**
 * BlueBubbles connector (iMessage/SMS) against a FAKE BlueBubbles Server — a real HTTP server
 * on 127.0.0.1 speaking the v1.9.12 REST shapes (password in the query, {status,data,metadata}
 * envelopes, string tapback types). Never the owner's real BlueBubbles; nothing is sent anywhere.
 */
process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { getWorkerCursor, resolveVaultEntry, db } from "../src/db";
import { putSecret } from "../src/secrets";
import type { Note } from "../src/parachute";
import type { IngestVault } from "../src/worker/matrix";
import { BlueBubblesClient, BlueBubblesError, type BbChat, type BbMessage } from "../src/bluebubbles/client";
import { isOneTimeCode, isShortCodeSender, parseAssociatedGuid, tapbackOf } from "../src/bluebubbles/map";
import { resetRecentStartsForTests } from "../src/comms/conversations";
import { resetBlueBubblesCachesForTests, runBlueBubblesOnce, setBlueBubblesDepsForTests, webhookQueueSettled, BACKFILL_CURSOR } from "../src/bluebubbles/service";
import { makeImessageTransport, ImessageSendError } from "../src/bluebubbles/send";
import { readBbTimeline, threadIdForChat, bbThreadSource } from "../src/bluebubbles/project";
import { makeContactBook } from "../src/bluebubbles/contacts";
import { secretEquals } from "../src/routes/bluebubbles";
import { messageOut } from "../src/comms/timeline";
import { getThread } from "../src/comms/store";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const PASSWORD = "bb-fixture-password-not-real";
const SECRET = "f".repeat(16) + "0123456789abcdef0123456789abcdef";
const DAY = 86_400_000;
const NOW = Date.now();

// ── the fake BlueBubbles Server ─────────────────────────────────────────────

interface Fake {
  chats: BbChat[];
  messages: (BbMessage & { chatGuid: string })[];
  contacts: Array<{ displayName: string; firstName?: string; phoneNumbers: { address: string }[]; emails: { address: string }[]; avatar?: string }>;
  attachments: Map<string, { bytes: Buffer; type: string }>;
  sends: Array<{ path: string; body: unknown }>;
  /** Fail the next send this way: "timeout" (no answer), 500, 400. */
  failNextSend: null | "timeout" | 500 | 400;
  requests: string[];
  sendSeq: number;
  /** message/text answers with the message's `chats` (real BlueBubbles serializes them). */
  answerWithChats?: boolean;
  /** Service prefix a NEW one-to-one chat is filed under (null = the one it was sent to). */
  newChatAs: string | null;
  /** chat/query's lastMessage as 1.9.12 really sends it: no `handle` (getChats joins none). */
  bareLastMessage?: boolean;
}
const fake: Fake = { chats: [], messages: [], contacts: [], attachments: new Map(), sends: [], failNextSend: null, requests: [], sendSeq: 0, newChatAs: null };
let server: http.Server;
let base = "";

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((r) => { const parts: Buffer[] = []; req.on("data", (c) => parts.push(c)); req.on("end", () => r(Buffer.concat(parts))); });
const withChat = (m: Fake["messages"][number]): BbMessage => {
  const { chatGuid, ...rest } = m;
  const chat = fake.chats.find((c) => c.guid === chatGuid)!;
  return { ...rest, chats: [chat] };
};

before(async () => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    fake.requests.push(u.pathname);
    if (u.searchParams.get("password") !== PASSWORD) return json(res, 401, { status: 401, message: "Unauthorized", error: { type: "Unauthorized" } });
    const body = await readBody(req);
    const p = u.pathname;
    if (p === "/api/v1/ping") return json(res, 200, { status: 200, message: "Ping received!", data: "pong" });
    if (p === "/api/v1/server/info") return json(res, 200, { status: 200, data: { computer_id: "x", os_version: "26.1", server_version: "1.9.12", private_api: false, proxy_service: "Dynamic DNS", helper_connected: false } });
    if (p === "/api/v1/chat/query") {
      const q = JSON.parse(body.toString() || "{}");
      const page = fake.chats.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 1000)).map((c) => {
        const last = fake.messages.filter((m) => m.chatGuid === c.guid).sort((a, b) => (b.dateCreated ?? 0) - (a.dateCreated ?? 0))[0];
        const lastMessage = last ? withChat(last) : null;
        if (lastMessage && fake.bareLastMessage) delete lastMessage.handle;
        return { ...c, ...(lastMessage ? { lastMessage } : {}) };
      });
      return json(res, 200, { status: 200, data: page, metadata: { total: fake.chats.length } });
    }
    const chatOne = /^\/api\/v1\/chat\/([^/]+)$/.exec(p);
    if (chatOne) {
      const c = fake.chats.find((x) => x.guid === decodeURIComponent(chatOne[1]!));
      return c ? json(res, 200, { status: 200, data: c }) : json(res, 404, { status: 404, error: { type: "NotFound" } });
    }
    if (p === "/api/v1/message/query") {
      const q = JSON.parse(body.toString() || "{}");
      let list = fake.messages.filter((m) => (!q.chatGuid || m.chatGuid === q.chatGuid) && (q.after === undefined || (m.dateCreated ?? 0) > q.after) && (q.before === undefined || (m.dateCreated ?? 0) < q.before));
      list = list.sort((a, b) => (q.sort === "ASC" ? 1 : -1) * ((a.dateCreated ?? 0) - (b.dateCreated ?? 0)));
      const page = list.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 100)).map(withChat);
      return json(res, 200, { status: 200, data: page, metadata: { total: list.length, offset: q.offset ?? 0, limit: q.limit, count: page.length } });
    }
    const msgOne = /^\/api\/v1\/message\/([^/]+)$/.exec(p);
    if (msgOne && req.method === "GET") {
      const m = fake.messages.find((x) => x.guid === decodeURIComponent(msgOne[1]!));
      return m ? json(res, 200, { status: 200, data: withChat(m) }) : json(res, 404, { status: 404, error: { type: "NotFound" } });
    }
    if (p === "/api/v1/contact/query") return json(res, 200, { status: 200, data: fake.contacts });
    const att = /^\/api\/v1\/attachment\/([^/]+)\/download$/.exec(p);
    if (att) {
      const a = fake.attachments.get(decodeURIComponent(att[1]!));
      if (!a) return json(res, 404, { status: 404 });
      res.writeHead(200, { "Content-Type": a.type, "Content-Length": String(a.bytes.length) });
      return res.end(a.bytes);
    }
    if (p === "/api/v1/message/text" || p === "/api/v1/message/attachment") {
      let parsed: Record<string, unknown>;
      if (p.endsWith("text")) parsed = JSON.parse(body.toString());
      else {
        const fd = await new Request("http://x/", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body }).formData();
        const file = fd.get("attachment") as File | null;
        parsed = { multipart: true, chatGuid: fd.get("chatGuid"), tempGuid: fd.get("tempGuid"), name: fd.get("name"), method: fd.get("method"), isAudioMessage: fd.get("isAudioMessage"), size: file?.size ?? 0, type: file?.type ?? null };
      }
      fake.sends.push({ path: p, body: parsed });
      const fail = fake.failNextSend;
      fake.failNextSend = null;
      const guid = `sent-${++fake.sendSeq}`;
      let chatGuid = String(parsed.chatGuid ?? fake.chats[0]!.guid);
      // A DM GUID Messages does not know yet: AppleScript's participant fallback creates the chat
      // (filed under `fake.newChatAs` when set, like `any;-;` on recent macOS).
      if (!fake.chats.some((c) => c.guid === chatGuid) && chatGuid.includes(";-;")) {
        const addr = chatGuid.slice(chatGuid.indexOf(";-;") + 3);
        const g = `${fake.newChatAs ?? chatGuid.split(";")[0]};-;${addr}`;
        if (!fake.chats.some((c) => c.guid === g)) fake.chats.push({ guid: g, style: 45, chatIdentifier: addr, displayName: "", participants: [{ address: addr, service: "iMessage" }] });
        chatGuid = g;
      }
      // A timeout / bare 500 may still have delivered it (that is the point of "unknown").
      if (fail !== 400) fake.messages.push({ guid, chatGuid, text: p.endsWith("text") ? String(parsed.message) : "\uFFFC", isFromMe: true, dateCreated: Date.now(), ...(p.endsWith("text") ? {} : { attachments: [{ guid: `a-${guid}`, transferName: String(parsed.name ?? "photo.png"), mimeType: String(parsed.type ?? "image/png") }] }) });
      if (fail === "timeout") return; // never answers
      if (fail === 500) return json(res, 500, { status: 500, message: "Message Send Error", error: { type: "iMessage Error" } });
      if (fail === 400) return json(res, 400, { status: 400, error: { type: "Bad Request" } });
      const sentChat = fake.chats.find((c) => c.guid === chatGuid);
      return json(res, 200, { status: 200, message: "Message sent!", data: { guid, isFromMe: true, text: parsed.message, ...(fake.answerWithChats && sentChat ? { chats: [sentChat] } : {}) } });
    }
    return json(res, 404, { status: 404 });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));

// ── a fake vault ────────────────────────────────────────────────────────────

function fakeVault() {
  const notes = new Map<string, Note>();
  let seq = 0;
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++tick * 1000).toISOString();
  const vault: IngestVault & { notes: Map<string, Note> } = {
    notes,
    async listNotes(o) {
      return [...notes.values()].filter((n) => !o.tags?.length || o.tags.every((t) => n.tags?.includes(t))).map((n) => ({ ...n, content: o.includeContent === false ? (undefined as unknown as string) : n.content }));
    },
    async getNote(id) {
      const n = notes.get(id);
      if (!n) throw Object.assign(new Error("404"), { status: 404 });
      return { ...n };
    },
    async createNote(p) {
      if ([...notes.values()].some((n) => n.path === p.path)) throw Object.assign(new Error("vault 409"), { status: 409 });
      const n = { id: `n${++seq}`, path: p.path ?? null, content: p.content, tags: p.tags ?? [], metadata: p.metadata ?? {}, createdAt: stamp(), updatedAt: stamp() } as unknown as Note;
      notes.set(n.id, n);
      return n;
    },
    async updateNote(id, p) {
      const n = notes.get(id)!;
      if (p.ifUpdatedAt && p.ifUpdatedAt !== n.updatedAt) throw Object.assign(new Error("409"), { status: 409 });
      const next = { ...n, ...(p.content !== undefined ? { content: p.content } : {}), ...(p.metadata ? { metadata: p.metadata } : {}), updatedAt: stamp() } as Note;
      notes.set(id, next);
      return next;
    },
    async removeTags(id, tags) {
      const n = notes.get(id)!;
      notes.set(id, { ...n, tags: (n.tags ?? []).filter((t) => !tags.includes(t)) });
    },
  };
  return vault;
}

// ── fixtures ────────────────────────────────────────────────────────────────

const ANN = "+15551230001";
const BOB = "bob@example.test";
const DM_ANN = `iMessage;-;${ANN}`;
const GROUP = "iMessage;+;chat123456";
const SHORT = "SMS;-;72975";

let vault: ReturnType<typeof fakeVault>;
function seed(): void {
  fake.chats = [
    { guid: DM_ANN, style: 45, chatIdentifier: ANN, displayName: "", participants: [{ address: ANN, service: "iMessage" }] },
    { guid: GROUP, style: 43, chatIdentifier: "chat123456", displayName: "Climbing", participants: [{ address: ANN, service: "iMessage" }, { address: BOB, service: "iMessage" }] },
    { guid: SHORT, style: 45, chatIdentifier: "72975", displayName: "", participants: [{ address: "72975", service: "SMS" }] },
  ];
  fake.messages = [];
  fake.contacts = [{ displayName: "Ann Example", phoneNumbers: [{ address: "(555) 123-0001" }], emails: [], avatar: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64") }];
  fake.attachments = new Map();
  fake.sends = [];
  fake.failNextSend = null;
  fake.requests = [];
  fake.newChatAs = null;
  fake.answerWithChats = false;
  fake.bareLastMessage = false;
  resetRecentStartsForTests();
}
const client = () => new BlueBubblesClient(base, PASSWORD, fetch, 5_000);

beforeEach(() => {
  resetDb();
  seed();
  vault = fakeVault();
  process.env.BLUEBUBBLES_ENABLED = "true";
  process.env.BLUEBUBBLES_URL = base;
  process.env.COMMS_ENABLED = "true";
  process.env.BLUEBUBBLES_BACKFILL_PAGE = "50";
  process.env.BLUEBUBBLES_BACKFILL_DAYS = "90";
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "bluebubbles", JSON.stringify({ password: PASSWORD, webhookSecret: SECRET }));
  setBlueBubblesDepsForTests(() => ({ client: client(), vault, people: async () => [] }));
  resetBlueBubblesCachesForTests();
});

const loop = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const webhook = (body: unknown, opts: { secret?: string; env?: unknown; headers?: Record<string, string> } = {}) =>
  createApp().request(`http://localhost:${config.port}/api/bluebubbles/webhook?secret=${encodeURIComponent(opts.secret ?? SECRET)}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) }, body: JSON.stringify(body),
  }, (opts.env ?? loop) as never);
const msg = (guid: string, chatGuid: string, at: number, extra: Partial<BbMessage> = {}): Fake["messages"][number] =>
  ({ guid, chatGuid, text: `message ${guid}`, isFromMe: false, handle: { address: chatGuid === GROUP ? BOB : chatGuid === SHORT ? "72975" : ANN }, dateCreated: at, ...extra });
const threadNote = (chatGuid: string) => [...vault.notes.values()].find((n) => n.metadata?.blueBubblesChatGuid === chatGuid);

// ── pure mapping ────────────────────────────────────────────────────────────

test("tapback mapping: REST names, numeric codes, removals, p:N/ and bp: targets", () => {
  assert.deepEqual(parseAssociatedGuid("p:1/ABC-1"), { guid: "ABC-1", part: 1 });
  assert.deepEqual(parseAssociatedGuid("bp:ABC-2"), { guid: "ABC-2", part: 0 });
  assert.deepEqual(tapbackOf({ associatedMessageType: "love", associatedMessageGuid: "p:0/T1" }), { kind: "tapback", target: "T1", part: 0, key: "❤️", remove: false });
  assert.deepEqual(tapbackOf({ associatedMessageType: "-laugh", associatedMessageGuid: "p:0/T1" }), { kind: "tapback", target: "T1", part: 0, key: "😂", remove: true });
  assert.deepEqual(tapbackOf({ associatedMessageType: 2001, associatedMessageGuid: "p:0/T2" }), { kind: "tapback", target: "T2", part: 0, key: "👍", remove: false });
  assert.deepEqual(tapbackOf({ associatedMessageType: "3005", associatedMessageGuid: "bp:T3" }), { kind: "tapback", target: "T3", part: 0, key: "❓", remove: true });
  assert.deepEqual(tapbackOf({ associatedMessageType: "2004", associatedMessageGuid: "p:0/T4" }), { kind: "tapback", target: "T4", part: 0, key: "‼️", remove: false });
  assert.deepEqual(tapbackOf({ associatedMessageType: "2006", associatedMessageGuid: "p:0/T5", text: "Reacted 🎉 to “hi”" }), { kind: "tapback", target: "T5", part: 0, key: "🎉", remove: false });
  assert.equal(tapbackOf({ associatedMessageType: "sticker", associatedMessageGuid: "p:0/T6" })?.kind, "ignored");
  assert.equal(tapbackOf({ associatedMessageType: null }), null);
  assert.equal(tapbackOf({ associatedMessageType: "0" }), null);
});

test("D13 detectors: one-time codes and short-code senders", () => {
  for (const t of ["Your Apple Account code is: 482913. Don't share it.", "G-123456 is your Google verification code.", "Your login code: 9921", "Use 123 456 to verify your account", "@example.com #847261"])
    assert.equal(isOneTimeCode(t), true, t);
  for (const t of ["See you at 1930?", "My number is 5551234567", "The code review is at 3", "Room 2041 tomorrow", ""])
    assert.equal(isOneTimeCode(t), false, t);
  for (const a of ["72975", "262966", "AMAZON", "+1 22395"]) assert.equal(isShortCodeSender(a), true, a);
  for (const a of ["+15551230001", "bob@example.test", "(555) 123-0001", ""]) assert.equal(isShortCodeSender(a), false, a);
});

test("secretEquals is exact (length and content), and the client never puts the password in an error", async () => {
  assert.equal(secretEquals(SECRET, SECRET), true);
  assert.equal(secretEquals(SECRET.slice(0, -1), SECRET), false);
  assert.equal(secretEquals(`${SECRET}x`, SECRET), false);
  const bad = new BlueBubblesClient(base, "wrong-password-value", fetch, 5_000);
  await assert.rejects(bad.ping(), (e: unknown) => e instanceof BlueBubblesError && e.status === 401 && !String(e).includes("wrong-password-value") && !String(e).includes("password="));
  const down = new BlueBubblesClient("http://127.0.0.1:9", PASSWORD, fetch, 2_000);
  await assert.rejects(down.ping(), (e: unknown) => e instanceof BlueBubblesError && !String(e).includes(PASSWORD));
});

// ── webhook auth ────────────────────────────────────────────────────────────

test("webhook auth: refused (404, nothing queued) off-loopback, behind a proxy, with a wrong/missing secret, or when disabled", async () => {
  const body = { type: "new-message", data: withChat(msg("W0", DM_ANN, NOW)) };
  fake.messages.push(msg("W0", DM_ANN, NOW));
  assert.equal((await webhook(body, { env: { incoming: { socket: { remoteAddress: "100.101.102.103" } } } })).status, 404);
  assert.equal((await webhook(body, { headers: { "X-Forwarded-For": "1.2.3.4" } })).status, 404);
  assert.equal((await webhook(body, { secret: "nope" })).status, 404);
  assert.equal((await webhook(body, { secret: "" })).status, 404);
  assert.equal((await webhook(body, { secret: SECRET.slice(0, -1) })).status, 404);
  process.env.BLUEBUBBLES_ENABLED = "false";
  assert.equal((await webhook(body)).status, 404);
  process.env.BLUEBUBBLES_ENABLED = "true";
  process.env.BLUEBUBBLES_URL = "http://10.0.0.5:1234"; // not loopback: connector off
  assert.equal((await webhook(body)).status, 404);
  process.env.BLUEBUBBLES_URL = base;
  await webhookQueueSettled();
  assert.equal(vault.notes.size, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comms_events").get() as { n: number }).n, 0);
  // Accepted: loopback + the right secret (query or header).
  const ok = await webhook(body);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal((await webhook({ type: "typing-indicator", data: { display: true, guid: DM_ANN } }, { secret: "", headers: { "X-Prism-Webhook-Secret": SECRET } })).status, 200);
  await webhookQueueSettled();
  const note = threadNote(DM_ANN)!;
  assert.ok(note, "thread note written");
  assert.equal(note.path, "vault/messages/imessage/ann-example");
  assert.equal(note.metadata?.platform, "imessage");
  assert.equal(note.metadata?.title, "Ann Example");
  assert.match(note.content, /^# Ann Example — imessage\n\n\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Ann Example: message W0$/);
  const t = getThread(threadIdForChat(DM_ANN))!;
  assert.equal(t.title, "Ann Example");
  assert.deepEqual(t.networks, ["imessage"]);
  assert.equal(t.channels[0]!.capabilities!.react, false);
  const kinds = (db.prepare("SELECT kind FROM comms_events ORDER BY id").all() as { kind: string }[]).map((r) => r.kind);
  assert.ok(kinds.includes("message.created") && kinds.includes("thread.updated"), kinds.join(","));
});

// ── D13 exclusion ───────────────────────────────────────────────────────────

test("OTP / short-code exclusion: never in the vault, still in Comms", async () => {
  const m1 = msg("O1", DM_ANN, NOW - 3000, { text: "hey" });
  const m2 = msg("O2", DM_ANN, NOW - 2000, { text: "Your verification code is 482913" });
  const m3 = msg("O3", SHORT, NOW - 1000, { text: "Bank alert: card used at Store" });
  fake.messages.push(m1, m2, m3);
  for (const m of [m1, m2, m3]) assert.equal((await webhook({ type: "new-message", data: withChat(m) })).status, 200);
  await webhookQueueSettled();
  const note = threadNote(DM_ANN)!;
  assert.match(note.content, /hey/);
  assert.doesNotMatch(note.content, /482913|verification/);
  assert.notEqual(note.metadata?.lastMessageText, "Your verification code is 482913");
  assert.equal(threadNote(SHORT), undefined, "short-code chat has no vault note");
  for (const n of vault.notes.values()) assert.doesNotMatch(JSON.stringify(n), /482913|Bank alert/);
  // Comms still shows them (read live), the short code in Low.
  assert.equal(getThread(threadIdForChat(SHORT))!.folder, "low");
  const created = (db.prepare("SELECT payload_json FROM comms_events WHERE kind = 'message.created'").all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json).message.id as string);
  assert.deepEqual(created.sort(), ["O1", "O2", "O3"]);
  // The poll later sees the same messages: still nothing new in the vault.
  const before = note.content;
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  assert.equal(threadNote(DM_ANN)!.content, before);
});

// ── backfill paging ─────────────────────────────────────────────────────────

test("backfill: newest first, bounded pages, resumable cursor, merged in time order, no duplicates, nothing past the floor", async () => {
  // 130 messages over the last 60 days in two chats, + 5 older than 90 days.
  for (let i = 0; i < 130; i++) fake.messages.push(msg(`B${i}`, i % 2 ? GROUP : DM_ANN, NOW - 60 * DAY + i * 10 * 60_000, { text: `backfill ${String(i).padStart(3, "0")}`, isFromMe: i % 5 === 0 }));
  for (let i = 0; i < 5; i++) fake.messages.push(msg(`X${i}`, DM_ANN, NOW - 120 * DAY + i, { text: `ancient ${i}` }));
  const entry = resolveVaultEntry(undefined);
  let passes = 0;
  for (; passes < 10; passes++) {
    await runBlueBubblesOnce(entry);
    if (JSON.parse(getWorkerCursor(entry.id, BACKFILL_CURSOR) ?? "{}").done) break;
  }
  assert.equal(passes, 2, "130 messages / 50 per page = 3 pages (the third short page ends it)");
  const dm = threadNote(DM_ANN)!.content;
  const group = threadNote(GROUP)!.content;
  const lines = (s: string) => s.split("\n").filter((l) => l.startsWith("["));
  assert.equal(lines(dm).length, 65);
  assert.equal(lines(group).length, 65);
  assert.doesNotMatch(dm, /ancient/);
  const nums = (s: string) => lines(s).map((l) => Number(/backfill (\d+)/.exec(l)![1]));
  for (const n of [nums(dm), nums(group)]) assert.deepEqual(n, [...n].sort((a, b) => a - b), "time order");
  assert.match(group, /^# Climbing — imessage\n/);
  assert.match(dm, /\] Me: backfill 000/); // the owner's own lines
  assert.equal(threadNote(GROUP)!.metadata?.messageCount, 65);
  // A new message after the backfill: appended once, even when both the webhook and the poll see it.
  const live = msg("L1", DM_ANN, Date.now() + 1000, { text: "fresh one" });
  fake.messages.push(live);
  await webhook({ type: "new-message", data: withChat(live) });
  await webhookQueueSettled();
  await runBlueBubblesOnce(entry);
  assert.equal((threadNote(DM_ANN)!.content.match(/fresh one/g) ?? []).length, 1);
});

// ── tapbacks + the read path ────────────────────────────────────────────────

test("timeline: tapbacks fold into their target's reactions (not bubbles), removal clears, edits/unsends surface", async () => {
  fake.messages.push(
    msg("T1", DM_ANN, NOW - 5000, { text: "climb saturday?" }),
    msg("T2", DM_ANN, NOW - 4000, { text: "", isFromMe: true, associatedMessageType: "love", associatedMessageGuid: "p:0/T1" }),
    msg("T3", DM_ANN, NOW - 3000, { text: "", associatedMessageType: "like", associatedMessageGuid: "p:0/T1" }),
    msg("T4", DM_ANN, NOW - 2000, { text: "", associatedMessageType: "-like", associatedMessageGuid: "p:0/T1" }),
    msg("T5", DM_ANN, NOW - 1000, { text: "edited text", dateEdited: NOW - 500 }),
    msg("T6", DM_ANN, NOW - 900, { text: "gone", dateRetracted: NOW - 100 }),
  );
  await runBlueBubblesOnce(resolveVaultEntry(undefined)); // projects the chat
  const threadId = threadIdForChat(DM_ANN);
  assert.deepEqual(bbThreadSource(threadId), { chatGuid: DM_ANN, network: "imessage" });
  const book = makeContactBook(fake.contacts, null);
  const page = (await readBbTimeline({ threadId, chatGuid: DM_ANN, network: "imessage", limit: 50, reader: client(), book }))!;
  assert.deepEqual(page.messages.map((m) => m.id), ["T1", "T5", "T6"]);
  const t1 = page.messages[0]!;
  assert.deepEqual(t1.reactions.map((r) => [r.key, r.count, r.mine]), [["❤️", 1, true]]);
  assert.ok(page.messages[1]!.editedAt);
  assert.equal(page.messages[2]!.redacted, true);
  assert.equal(page.messages[2]!.body, null);
  assert.equal(t1.sender.name, "Ann Example");
  // The vault holds the real messages only (no tapback lines, no unsent text).
  const note = threadNote(DM_ANN)!.content;
  assert.doesNotMatch(note, /\] [^:]+: $|gone/m);
  // Live: a tapback via the webhook emits reaction.changed for the TARGET.
  const tb = msg("T7", DM_ANN, NOW, { text: "", associatedMessageType: "laugh", associatedMessageGuid: "p:0/T5" });
  fake.messages.push(tb);
  await webhook({ type: "new-message", data: withChat(tb) });
  await webhookQueueSettled();
  const ev = db.prepare("SELECT payload_json FROM comms_events WHERE kind = 'reaction.changed' ORDER BY id DESC").get() as { payload_json: string };
  const target = JSON.parse(ev.payload_json).message;
  assert.equal(target.id, "T5");
  assert.deepEqual(target.reactions.map((r: { key: string }) => r.key), ["😂"]);
});

test("timeline paging: server-side tc_ cursor, newest last, no repeats", async () => {
  for (let i = 0; i < 25; i++) fake.messages.push(msg(`P${i}`, DM_ANN, NOW - (25 - i) * 1000, { text: `page ${i}` }));
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  const threadId = threadIdForChat(DM_ANN);
  const book = makeContactBook([], null);
  const p1 = (await readBbTimeline({ threadId, chatGuid: DM_ANN, network: "imessage", limit: 10, reader: client(), book }))!;
  assert.deepEqual(p1.messages.map((m) => m.id), Array.from({ length: 10 }, (_, i) => `P${15 + i}`));
  assert.match(p1.before!, /^tc_[A-Za-z0-9_-]{24}$/);
  const p2 = (await readBbTimeline({ threadId, chatGuid: DM_ANN, network: "imessage", limit: 10, before: p1.before!, reader: client(), book }))!;
  assert.deepEqual(p2.messages.map((m) => m.id), Array.from({ length: 10 }, (_, i) => `P${5 + i}`));
  assert.equal(await readBbTimeline({ threadId: "th_other", chatGuid: DM_ANN, network: "imessage", limit: 10, before: p1.before!, reader: client(), book }), null, "a cursor is bound to its thread");
  // Through the route: owner session, messages endpoint.
  const r = await createApp().request(`/api/comms/threads/${threadId}/messages?limit=5`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal(r.status, 200);
  const j = await r.json() as { messages: Array<{ id: string }>; hasMore: boolean };
  assert.deepEqual(j.messages.map((m) => m.id), ["P20", "P21", "P22", "P23", "P24"]);
  assert.equal(j.hasMore, true);
});

// ── attachments through the comms media token route ─────────────────────────

test("attachment token: bb:// ref → media token → bytes from BlueBubbles, type sniffed (never upstream's), active content refused", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  fake.attachments.set("ATT-1", { bytes: png, type: "text/html" }); // a lying Content-Type
  fake.attachments.set("ATT-2", { bytes: Buffer.from("<html><script>alert(1)</script></html>"), type: "image/png" });
  fake.messages.push(msg("A1", DM_ANN, NOW - 2000, { text: "￼", attachments: [{ guid: "ATT-1", mimeType: "image/png", transferName: "IMG_1.png", totalBytes: png.length }] }));
  fake.messages.push(msg("A2", DM_ANN, NOW - 1000, { text: "￼", attachments: [{ guid: "ATT-2", mimeType: "image/png", transferName: "evil.png", totalBytes: 40 }] }));
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  const threadId = threadIdForChat(DM_ANN);
  const page = (await readBbTimeline({ threadId, chatGuid: DM_ANN, network: "imessage", limit: 10, reader: client(), book: makeContactBook([], null) }))!;
  const actor = { email: config.ownerEmail };
  const wire = page.messages.map((m) => messageOut(m, actor));
  const a1 = wire[0]!.attachments[0] as { mediaToken?: string; thumbToken?: string; mxc?: string; kind: string };
  assert.equal(a1.kind, "image");
  assert.equal(a1.mxc, undefined, "no source ref on the wire");
  assert.ok(a1.mediaToken && a1.thumbToken);
  assert.doesNotMatch(JSON.stringify(wire), /bb:\/\/|ATT-1|password/);
  const get = (token: string) => createApp().request(`/api/comms/media/${token}`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  const r1 = await get(a1.mediaToken!);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("content-type"), "image/png");
  assert.equal(r1.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r1.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.deepEqual(Buffer.from(await r1.arrayBuffer()), png);
  const a2 = wire[1]!.attachments[0] as { mediaToken?: string };
  assert.equal((await get(a2.mediaToken!)).status, 415);
  // Someone else's session: refused before BlueBubbles is asked.
  const n = fake.requests.length;
  const other = await createApp().request(`/api/comms/media/${a1.mediaToken}`, { headers: { cookie: sessionCookie(makeSession("stranger@test.local")) } });
  assert.equal(other.status, 403);
  assert.equal(fake.requests.length, n);
  // The vault line names the file, never a ref.
  assert.match(threadNote(DM_ANN)!.content, /📎 IMG_1\.png/);
});

test("owner report: every iMessage attachment kind opens — HEIC/HEIF/TIFF/odd-mime PNG/converted JPEG/MOV/MP4 served inline with the SNIFFED type; plugin payloads hidden; mime-less attachments typed from UTI/name", async () => {
  const ftyp = (major: string, ...compat: string[]) => {
    const box = Buffer.alloc(16 + 4 * compat.length);
    box.writeUInt32BE(box.length, 0);
    box.write("ftyp", 4, "latin1");
    box.write(major, 8, "latin1");
    compat.forEach((c, i) => box.write(c, 16 + 4 * i, "latin1"));
    return Buffer.concat([box, Buffer.alloc(200, 7)]);
  };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const tiff = Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]), Buffer.alloc(100, 2)]);
  const cases: { guid: string; bytes: Buffer; upstream: string; meta: Record<string, unknown>; kind: string; served: string }[] = [
    { guid: "HEIC", bytes: ftyp("heic", "mif1", "heic"), upstream: "image/heic", meta: { mimeType: "image/heic", uti: "public.heic", transferName: "IMG_0001.HEIC" }, kind: "image", served: "image/heic" },
    { guid: "HEIX", bytes: ftyp("heix", "mif1"), upstream: "application/octet-stream", meta: { mimeType: "image/heic", transferName: "IMG_0002.HEIC" }, kind: "image", served: "image/heic" },
    { guid: "MIF1", bytes: ftyp("mif1", "heic", "miaf"), upstream: "image/heif", meta: { mimeType: "image/heif", transferName: "IMG_0003.HEIF" }, kind: "image", served: "image/heic" },
    { guid: "MSF1", bytes: ftyp("msf1", "msf1", "iso8"), upstream: "image/heif", meta: { mimeType: null, uti: "public.heif", transferName: "burst.heif" }, kind: "image", served: "image/heif" },
    { guid: "LIVE", bytes: ftyp("heic", "mif1"), upstream: "image/heic", meta: { mimeType: null, uti: null, transferName: "IMG_0004.HEIC" }, kind: "image", served: "image/heic" },
    { guid: "CONV", bytes: jpeg, upstream: "image/jpeg", meta: { mimeType: "image/heic", transferName: "IMG_0005.HEIC" }, kind: "image", served: "image/jpeg" },
    { guid: "TIFF", bytes: tiff, upstream: "image/tiff", meta: { mimeType: "image/tiff", transferName: "scan.tiff" }, kind: "image", served: "image/tiff" },
    { guid: "XPNG", bytes: png, upstream: "image/x-png", meta: { mimeType: "application/octet-stream", uti: "public.png", transferName: "Screenshot.png" }, kind: "image", served: "image/png" },
    { guid: "MOV", bytes: ftyp("qt  ", "qt  "), upstream: "video/quicktime", meta: { mimeType: "video/quicktime", transferName: "IMG_0006.MOV" }, kind: "video", served: "video/quicktime" },
    { guid: "MP4", bytes: ftyp("mp42", "isom"), upstream: "application/octet-stream", meta: { mimeType: null, uti: "public.mpeg-4", transferName: "clip.mp4" }, kind: "video", served: "video/mp4" },
  ];
  const all = [...cases.map((x) => ({ guid: x.guid, totalBytes: x.bytes.length, ...x.meta })),
    { guid: "PLUGIN", mimeType: null, uti: "com.apple.messages.MSMessageExtensionBalloonPlugin", transferName: "8D2F.pluginPayloadAttachment" }];
  for (const x of cases) fake.attachments.set(x.guid, { bytes: x.bytes, type: x.upstream });
  fake.messages.push(msg("K1", DM_ANN, NOW - 1000, { text: "￼".repeat(all.length), attachments: all as never }));
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  const threadId = threadIdForChat(DM_ANN);
  const page = (await readBbTimeline({ threadId, chatGuid: DM_ANN, network: "imessage", limit: 10, reader: client(), book: makeContactBook([], null) }))!;
  const wire = messageOut(page.messages[0]!, { email: config.ownerEmail });
  const atts = wire.attachments as { kind: string; mime?: string; name?: string; mediaToken?: string; thumbToken?: string }[];
  assert.equal(atts.length, cases.length, "the rich-link payload is not an attachment");
  assert.ok(!atts.some((a) => /pluginPayload/i.test(a.name ?? "")));
  assert.doesNotMatch(threadNote(DM_ANN)!.content, /pluginPayload/i);
  const get = (token: string) => createApp().request(`/api/comms/media/${token}`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  for (const [i, x] of cases.entries()) {
    const a = atts[i]!;
    assert.equal(a.kind, x.kind, x.guid);
    assert.ok(a.mediaToken && a.thumbToken, `${x.guid}: tappable (media + thumbnail tokens)`);
    const r = await get(a.mediaToken!);
    assert.equal(r.status, 200, x.guid);
    assert.equal(r.headers.get("content-type"), x.served, x.guid);
    assert.equal(r.headers.get("content-disposition"), null, `${x.guid}: inline, not a download`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), x.bytes, x.guid);
  }
  assert.equal(atts[4]!.mime, "image/heic", "a mime-less Live Photo still is typed from its name");
  assert.equal(atts[7]!.mime, "image/png", "octet-stream mime falls back to the UTI");
});

// ── send transport ──────────────────────────────────────────────────────────

test("send transport: idempotent by clientId; an unknown outcome is checked before resending; a definite refusal is retried", async () => {
  const t = makeImessageTransport(client());
  const id1 = "11111111-1111-4111-8111-111111111111";
  const r1 = await t.sendImessageText({ chatGuid: DM_ANN, clientId: id1, text: "hello there" });
  assert.equal(r1.status, "sent");
  const again = await t.sendImessageText({ chatGuid: DM_ANN, clientId: id1, text: "hello there" });
  assert.deepEqual(again, r1);
  assert.equal(fake.sends.length, 1, "same clientId → one send");
  assert.deepEqual(fake.sends[0]!.body, { chatGuid: DM_ANN, tempGuid: `prism-${id1}`, message: "hello there", method: "apple-script" });
  await assert.rejects(t.sendImessageText({ chatGuid: DM_ANN, clientId: id1, text: "different" }), (e: unknown) => e instanceof ImessageSendError && e.code === "client_id_reused");

  // A bare 500: maybe sent. The retry finds the delivered message and does NOT send again.
  const id2 = "22222222-2222-4222-8222-222222222222";
  fake.failNextSend = 500;
  await assert.rejects(t.sendImessageText({ chatGuid: DM_ANN, clientId: id2, text: "maybe delivered" }), (e: unknown) => e instanceof ImessageSendError && e.maybeSent === true);
  const sendsBefore = fake.sends.length;
  const r2 = await t.sendImessageText({ chatGuid: DM_ANN, clientId: id2, text: "maybe delivered" });
  assert.equal(fake.sends.length, sendsBefore, "found in the chat — not sent twice");
  assert.match(r2.eventId, /^sent-/);

  // A 400: definitely not sent; a retry sends.
  const id3 = "33333333-3333-4333-8333-333333333333";
  fake.failNextSend = 400;
  await assert.rejects(t.sendImessageText({ chatGuid: DM_ANN, clientId: id3, text: "refused once" }), (e: unknown) => e instanceof ImessageSendError && e.maybeSent === false);
  const r3 = await t.sendImessageText({ chatGuid: DM_ANN, clientId: id3, text: "refused once" });
  assert.equal(r3.status, "sent");
  assert.equal(fake.sends.filter((s) => (s.body as { message?: string }).message === "refused once").length, 2);

  // Attachment: multipart to /message/attachment, idempotent too.
  const id4 = "44444444-4444-4444-8444-444444444444";
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const a = await t.sendImessageAttachment({ chatGuid: DM_ANN, clientId: id4, name: "photo.png", mime: "image/png", bytes });
  const b = await t.sendImessageAttachment({ chatGuid: DM_ANN, clientId: id4, name: "photo.png", mime: "image/png", bytes });
  assert.deepEqual(a, b);
  assert.equal(fake.sends.filter((s) => s.path.endsWith("attachment")).length, 1);
  await assert.rejects(t.sendImessageText({ chatGuid: DM_ANN, clientId: "not-a-uuid", text: "x" }), (e: unknown) => e instanceof ImessageSendError && e.code === "invalid");
});

test("integrations: owner-only credential, write-only (never echoed), refused password not stored", async () => {
  const owner = { cookie: sessionCookie(makeSession(config.ownerEmail)), "Content-Type": "application/json" };
  const st = await createApp().request("/api/integrations/bluebubbles", { headers: owner });
  const body = await st.text();
  assert.equal(st.status, 200);
  assert.doesNotMatch(body, new RegExp(PASSWORD));
  assert.doesNotMatch(body, new RegExp(SECRET));
  assert.equal(JSON.parse(body).configured, true);
  const bad = await createApp().request("/api/integrations/bluebubbles", { method: "PUT", headers: owner, body: JSON.stringify({ password: "wrong", webhookSecret: SECRET }) });
  assert.equal(bad.status, 400);
  const short = await createApp().request("/api/integrations/bluebubbles", { method: "PUT", headers: owner, body: JSON.stringify({ password: PASSWORD, webhookSecret: "short" }) });
  assert.equal(short.status, 400);
  const ok = await createApp().request("/api/integrations/bluebubbles", { method: "PUT", headers: owner, body: JSON.stringify({ password: PASSWORD, webhookSecret: SECRET }) });
  assert.deepEqual(await ok.json(), { ok: true, verified: true });
});

// ── fix round 1 ─────────────────────────────────────────────────────────────

import { loopbackBaseUrl } from "../src/bluebubbles/config";
import { staleOtpGuids } from "../src/bluebubbles/state";
import { RETRY_CURSOR } from "../src/bluebubbles/service";

test("webhook: the tunnel's shape (cf-ray / cf-connecting-ip, public Host on a loopback socket) and an oversized tunnelled body get the same 404", async () => {
  const body = { type: "new-message", data: { guid: "Z" } };
  assert.equal((await webhook(body, { headers: { "cf-ray": "8abc", "cf-connecting-ip": "203.0.113.9" } })).status, 404);
  const pub = await createApp().request(`https://prism.example.test/api/bluebubbles/webhook?secret=${SECRET}`, { method: "POST", headers: { "Content-Type": "application/json", Host: "prism.example.test" }, body: JSON.stringify(body) }, loop as never);
  assert.equal(pub.status, 404);
  const big = await webhook({ type: "new-message", data: "x".repeat(3 * 1024 * 1024) }, { env: { incoming: { socket: { remoteAddress: "198.51.100.7" } } } });
  assert.equal(big.status, 404, "never 413 before the gate");
  const bigBad = await webhook({ type: "new-message", data: "x".repeat(3 * 1024 * 1024) }, { secret: "wrong" });
  assert.equal(bigBad.status, 404);
  assert.equal((await webhook({ type: "new-message", data: "x".repeat(2 * 1024 * 1024) })).status, 413, "only an authenticated loopback caller learns the size limit");
});

test("C1/M15: BLUEBUBBLES_URL may not be LM Studio's, Prism's or the vault's port; default is 1235", () => {
  const prev = process.env.BLUEBUBBLES_URL;
  delete process.env.BLUEBUBBLES_URL;
  assert.equal(config.blueBubblesUrl, "http://127.0.0.1:1235");
  assert.equal(loopbackBaseUrl("http://127.0.0.1:1235"), "http://127.0.0.1:1235");
  assert.equal(loopbackBaseUrl("http://127.0.0.1:1234"), null, "LM Studio (skills base URL) port");
  assert.equal(loopbackBaseUrl("http://localhost:1234"), null);
  assert.equal(loopbackBaseUrl(`http://127.0.0.1:${config.port}`), null, "Prism itself");
  assert.equal(loopbackBaseUrl("http://192.168.1.5:1235"), null);
  process.env.BLUEBUBBLES_URL = prev;
});

test("I8: a non-BlueBubbles service answering 2xx is never 'BlueBubbles with no messages', and the credential is refused", async () => {
  const other = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [] })); });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  try {
    const c = new BlueBubblesClient(url, PASSWORD, fetch, 5_000);
    await assert.rejects(c.ping(), (e: unknown) => e instanceof BlueBubblesError && /not a BlueBubbles response/.test(e.message));
    await assert.rejects(c.queryMessages({ limit: 5 }), (e: unknown) => e instanceof BlueBubblesError);
    await assert.rejects(c.serverInfo(), (e: unknown) => e instanceof BlueBubblesError);
    process.env.BLUEBUBBLES_URL = url;
    const owner = { cookie: sessionCookie(makeSession(config.ownerEmail)), "Content-Type": "application/json" };
    const r = await createApp().request("/api/integrations/bluebubbles", { method: "PUT", headers: owner, body: JSON.stringify({ password: "anything", webhookSecret: SECRET }) });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "not_bluebubbles");
  } finally {
    process.env.BLUEBUBBLES_URL = base;
    other.closeAllConnections?.();
    await new Promise<void>((r) => other.close(() => r()));
  }
});

test("integrations: a non-owner (even an admin session of another user) gets 403 on read and write", async () => {
  const h = { cookie: sessionCookie(makeSession("stranger@test.local")), "Content-Type": "application/json" };
  assert.equal((await createApp().request("/api/integrations/bluebubbles", { headers: h })).status, 403);
  assert.equal((await createApp().request("/api/integrations/bluebubbles", { method: "PUT", headers: h, body: JSON.stringify({ password: PASSWORD, webhookSecret: SECRET }) })).status, 403);
});

test("I1: identical lines in one minute from two people (or the same person twice) are all kept", async () => {
  const t0 = Date.UTC(2026, 10, 22, 10, 0, 5);
  const a = msg("D1", GROUP, t0, { text: "ok", handle: { address: ANN } });
  const b = msg("D2", GROUP, t0 + 20_000, { text: "ok", handle: { address: BOB } });
  const c = msg("D3", GROUP, t0 + 30_000, { text: "ok", handle: { address: BOB } });
  fake.messages.push(a, b, c);
  for (const m of [a, b, c]) await webhook({ type: "new-message", data: withChat(m) });
  await webhookQueueSettled();
  const lines = threadNote(GROUP)!.content.split("\n").filter((l) => l.startsWith("["));
  assert.deepEqual(lines, ["[2026-11-22 10:00] Ann Example: ok", `[2026-11-22 10:00] ${BOB}: ok`, `[2026-11-22 10:00] ${BOB}: ok`]);
});

test("I2: OTP rule v2 — no years/prices/amounts, Unicode codes caught; an older verdict is re-evaluated", async () => {
  for (const t of ["Can you confirm the 2025 budget by Friday?", "Security deposit is $1500, can you send it?", "Login to the wifi in Room 1204", "costs 1200 dollars", "area code 415 555 1234"])
    assert.equal(isOneTimeCode(t), false, t);
  for (const t of ["Ваш код 482913", "認証コード 482913", "Your code is 48 29 13", "G-482913", "验证码：482913，5分钟内有效", "Tu código de verificación es 482913"])
    assert.equal(isOneTimeCode(t), true, t);
  // A message an older rule called an OTP is not "seen" any more: the next pass re-reads it.
  const m = msg("R1", DM_ANN, NOW - 1000, { text: "Can you confirm the 2025 budget by Friday?" });
  fake.messages.push(m);
  db.prepare("INSERT INTO bluebubbles_seen (guid, at, outcome) VALUES (?, ?, ?)").run("R1", NOW, "excluded:otp:v1");
  assert.deepEqual(staleOtpGuids(10), ["R1"]);
  setWorkerCursorForTest();
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  assert.match(threadNote(DM_ANN)!.content, /confirm the 2025 budget/);
  assert.deepEqual(staleOtpGuids(10), []);
});
function setWorkerCursorForTest(): void {
  // Skip the first-run poll/backfill set-up noise: the poll window is "now".
  db.prepare("DELETE FROM settings WHERE key LIKE ?").run("%bluebubbles%");
}

test("I5: a new chat's first message by webhook during a pass → one thread note, not two", async () => {
  const NEW = "iMessage;-;+15559990000";
  fake.chats.push({ guid: NEW, style: 45, chatIdentifier: "+15559990000", participants: [{ address: "+15559990000", service: "iMessage" }] });
  const m = msg("N1", NEW, Date.now() - 1000, { text: "first ever", handle: { address: "+15559990000" } });
  fake.messages.push(m);
  const pass = runBlueBubblesOnce(resolveVaultEntry(undefined));
  const hook = webhook({ type: "new-message", data: withChat(m) });
  await Promise.all([pass, hook]);
  await webhookQueueSettled();
  const notes = [...vault.notes.values()].filter((n) => n.metadata?.blueBubblesChatGuid === NEW);
  assert.equal(notes.length, 1);
  assert.equal((notes[0]!.content.match(/first ever/g) ?? []).length, 1);
});

test("I6: a note someone else tagged with a chat GUID is never adopted (source must be bluebubbles)", async () => {
  await vault.createNote({ path: "vault/inbox/trap", content: "# trap", tags: ["message-thread"], metadata: { type: "message-thread", blueBubblesChatGuid: DM_ANN } });
  const m = msg("H1", DM_ANN, NOW, { text: "private" });
  fake.messages.push(m);
  await webhook({ type: "new-message", data: withChat(m) });
  await webhookQueueSettled();
  const trap = [...vault.notes.values()].find((n) => n.path === "vault/inbox/trap")!;
  assert.equal(trap.content, "# trap");
  const real = [...vault.notes.values()].filter((n) => n.metadata?.blueBubblesChatGuid === DM_ANN && n.path !== "vault/inbox/trap");
  assert.equal(real.length, 1);
  assert.equal(real[0]!.metadata?.source, "bluebubbles");
  assert.match(real[0]!.content, /private/);
});

test("M8: a chat that cannot be written does not stop the poll or the backfill; its messages are retried", async () => {
  for (let i = 0; i < 10; i++) fake.messages.push(msg(`Q${i}`, i % 2 ? GROUP : DM_ANN, NOW - DAY + i * 1000, { text: `q ${i}` }));
  const entry = resolveVaultEntry(undefined);
  const realCreate = vault.createNote.bind(vault);
  vault.createNote = async (p) => { if (p.metadata?.blueBubblesChatGuid === GROUP) throw Object.assign(new Error("vault 500"), { status: 500 }); return realCreate(p); };
  await assert.rejects(runBlueBubblesOnce(entry), /could not be written/);
  assert.equal((threadNote(DM_ANN)!.content.match(/q \d/g) ?? []).length, 5, "the healthy chat was written");
  assert.equal(JSON.parse(getWorkerCursor(entry.id, RETRY_CURSOR) ?? "[]").length, 5);
  vault.createNote = realCreate;
  await runBlueBubblesOnce(entry);
  assert.equal((threadNote(GROUP)!.content.match(/q \d/g) ?? []).length, 5);
  assert.deepEqual(JSON.parse(getWorkerCursor(entry.id, RETRY_CURSOR) ?? "[]"), []);
});

test("I3/I4/M10: a send that timed out after delivery is found from the try's START; a stale pending row recovers; an earlier identical message is never adopted", async () => {
  const delivered: BbMessage[] = [];
  let clock = 1_000_000;
  let sends = 0;
  const fakeClient = {
    async sendText(p: { chatGuid: string; tempGuid: string; message: string }) {
      sends++;
      delivered.push({ guid: `d${sends}`, isFromMe: true, text: p.message, dateCreated: clock + 2_000 }); // AppleScript delivers 2 s in…
      if (sends === 1) { clock += 125_000; throw new BlueBubblesError("message/text", null, "timeout"); } // …then the 120 s timeout fires
      return { guid: `d${sends}`, isFromMe: true };
    },
    async sendAttachment() { throw new Error("unused"); },
    async queryMessages(q: { after?: number }) { return { messages: delivered.filter((m) => (m.dateCreated ?? 0) > (q.after ?? 0)), total: null }; },
  };
  // An earlier, unrelated "ok" from the owner, already owned by another send.
  delivered.push({ guid: "old-ok", isFromMe: true, text: "ok", dateCreated: clock - 5_000 });
  db.prepare("INSERT INTO bluebubbles_send (client_id, chat_guid, kind, digest, state, message_guid, created_at, updated_at, attempt_at) VALUES ('x', ?, 'text', 'x', 'sent', 'old-ok', 0, 0, 0)").run(DM_ANN);
  const t = makeImessageTransport(fakeClient as never, { now: () => clock });
  const id = "55555555-5555-4555-8555-555555555555";
  await assert.rejects(t.sendImessageText({ chatGuid: DM_ANN, clientId: id, text: "ok" }), (e: unknown) => e instanceof ImessageSendError && e.maybeSent);
  const r = await t.sendImessageText({ chatGuid: DM_ANN, clientId: id, text: "ok" });
  assert.equal(r.eventId, "d1", "the delivered copy, not old-ok");
  assert.equal(sends, 1, "never sent twice");
  // A row left `pending` by a restart mid-send: within the timeout → in_flight; past it → recovered.
  const id2 = "66666666-6666-4666-8666-666666666666";
  db.prepare("INSERT INTO bluebubbles_send (client_id, chat_guid, kind, digest, state, created_at, updated_at, attempt_at) VALUES (?, ?, 'text', ?, 'pending', ?, ?, ?)")
    .run(id2, DM_ANN, createHash("sha256").update("text\u0000").update("orphan\u0000").digest("hex"), clock, clock, clock);
  await assert.rejects(t.sendImessageText({ chatGuid: DM_ANN, clientId: id2, text: "orphan" }), (e: unknown) => e instanceof ImessageSendError && e.code === "in_flight");
  clock += 181_000;
  const r2 = await t.sendImessageText({ chatGuid: DM_ANN, clientId: id2, text: "orphan" });
  assert.equal(r2.status, "sent");
  assert.equal(sends, 2, "nothing had landed, so it was sent once");
});

// ── integration: the comms send route over the BlueBubbles transport ────────

import { issueDeviceToken } from "../src/auth/device";
import { clearRateLimitsForTests } from "../src/middleware/ratelimit";
import { resetBlueBubblesReadyForTests } from "../src/bluebubbles/ready";

const devAuth = () => ({ authorization: `Bearer ${issueDeviceToken(config.ownerEmail, "Comms (test)", "comms-native").token}` });
const sendText = (threadId: string, body: unknown, headers: Record<string, string> = devAuth()) =>
  createApp().request(`/api/comms/threads/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const sendFile = (threadId: string, fields: Record<string, string>, file: { bytes: Buffer; name: string; type: string }) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set("file", new Blob([file.bytes], { type: file.type }), file.name);
  return createApp().request(`/api/comms/threads/${threadId}/attachments`, { method: "POST", headers: devAuth(), body: fd });
};
const sendAudit = () => db.prepare(`SELECT * FROM action_audit WHERE action = 'comms.send' ORDER BY id`).all() as Array<Record<string, string>>;

async function sendReady(): Promise<string> {
  process.env.COMMS_SEND_ENABLED = "true";
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = false; // iMessage needs no Matrix flag
  clearRateLimitsForTests("comms");
  resetBlueBubblesReadyForTests();
  fake.messages.push(msg("S0", DM_ANN, NOW - 60_000, { text: "hi" }));
  await runBlueBubblesOnce(resolveVaultEntry(undefined)); // projects the chat; BlueBubbles answered → reachable
  return threadIdForChat(DM_ANN);
}

test("integration: imessage/sms advertise send:true only with COMMS_SEND_ENABLED + BlueBubbles answering; react stays false", async () => {
  const th = await sendReady();
  const owner = { cookie: sessionCookie(makeSession(config.ownerEmail)) };
  const caps = async () => ((await (await createApp().request(`/api/comms/threads/${th}`, { headers: owner })).json()) as { capabilities: Record<string, boolean> }).capabilities;
  assert.equal((await caps()).send, true);
  assert.equal((await caps()).react, false);
  assert.equal((await caps()).attachments, true);
  const all = (await (await createApp().request("/api/comms/capabilities", { headers: owner })).json()) as { networks: string[]; send: { enabled: boolean } };
  assert.ok(all.networks.includes("imessage") && all.networks.includes("sms"));
  assert.equal(all.send.enabled, true);
  resetBlueBubblesReadyForTests(); // BlueBubbles stopped answering
  assert.equal((await caps()).send, false);
  assert.equal((await sendText(th, { clientId: crypto.randomUUID(), text: "x" })).status, 403);
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  process.env.COMMS_SEND_ENABLED = "false";
  assert.equal((await caps()).send, false);
  const off = await sendText(th, { clientId: crypto.randomUUID(), text: "x" });
  assert.equal(off.status, 403);
  assert.equal(((await off.json()) as { error: string }).error, "send_disabled");
  assert.equal(fake.sends.length, 0);
});

test("integration: text — device token only, apple-script with tempGuid from clientId, idempotent replay, echo carries clientId, audit has no text or number", async () => {
  const th = await sendReady();
  const id = crypto.randomUUID();
  // A browser session is not the owner's device: refused before anything is sent.
  const cookie = await sendText(th, { clientId: id, text: "hello from comms" }, { cookie: sessionCookie(makeSession(config.ownerEmail)) });
  assert.equal(cookie.status, 403);
  const r = await sendText(th, { clientId: id, text: "hello from comms" });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { clientId: string; eventId: string; status: string };
  assert.equal(body.status, "sent");
  assert.match(body.eventId, /^sent-/);
  assert.deepEqual(fake.sends[0]!.body, { chatGuid: DM_ANN, tempGuid: `prism-${id}`, message: "hello from comms", method: "apple-script" });
  const again = await sendText(th, { clientId: id, text: "hello from comms" });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(fake.sends.length, 1, "same clientId → one iMessage");
  assert.equal((await sendText(th, { clientId: id, text: "something else" })).status, 422);
  // Replies need the Private API: refused, nothing sent.
  const reply = await sendText(th, { clientId: crypto.randomUUID(), text: "re", replyTo: "$abc:example.test" });
  assert.equal(reply.status, 422);
  assert.equal(fake.sends.length, 1);
  const rows = sendAudit();
  assert.ok(rows.some((x) => x.status === "ok"));
  assert.doesNotMatch(JSON.stringify(rows), /hello from comms|5551230001|iMessage;-;/);
  // The echo (the poll / webhook) is reconciled to the clientId.
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  const page = (await (await createApp().request(`/api/comms/threads/${th}/messages?limit=5`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } })).json()) as { messages: Array<{ id: string; clientId?: string; sender: { isSelf: boolean } }> };
  const echo = page.messages.find((m) => m.id === body.eventId)!;
  assert.equal(echo.sender.isSelf, true);
  assert.equal(echo.clientId, id);
});

test("integration: a maybe-sent text is checked before a retry (no duplicate); a refused one is sent again", async () => {
  const th = await sendReady();
  const id = crypto.randomUUID();
  fake.failNextSend = 500;
  const first = await sendText(th, { clientId: id, text: "maybe" });
  assert.equal(first.status, 502);
  assert.equal(((await first.json()) as { maybeSent: boolean }).maybeSent, true);
  const retry = await sendText(th, { clientId: id, text: "maybe" });
  assert.equal(retry.status, 200);
  assert.equal(fake.sends.length, 1, "it had landed: found, not re-sent");
  const id2 = crypto.randomUUID();
  fake.failNextSend = 400;
  const refused = await sendText(th, { clientId: id2, text: "nope" });
  assert.equal(refused.status, 502);
  assert.equal(((await refused.json()) as { maybeSent: boolean }).maybeSent, false);
  assert.equal((await sendText(th, { clientId: id2, text: "nope" })).status, 200);
  assert.equal(fake.sends.length, 3);
});

/** A minimal CAF: file header, a 32-byte `desc` chunk with `format`, then a data chunk. */
function cafFile(format: string): Buffer {
  const head = Buffer.from("caff\x00\x01\x00\x00", "latin1");
  const desc = Buffer.alloc(12 + 32);
  desc.write("desc", 0, "latin1");
  desc.writeBigInt64BE(32n, 4);
  desc.writeDoubleBE(24_000, 12);
  desc.write(format, 20, "latin1");
  desc.writeUInt32BE(480, 32); // frames per packet
  desc.writeUInt32BE(1, 36); // channels
  const data = Buffer.concat([Buffer.from("data", "latin1"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 68]), Buffer.alloc(4), Buffer.alloc(64, 7)]);
  return Buffer.concat([head, desc, data]);
}

test("integration: attachments — image, M4A voice as an audio file, MP3 and Opus-CAF voice as a voice memo, Ogg voice refused; reactions refused", async () => {
  const th = await sendReady();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const img = await sendFile(th, { clientId: crypto.randomUUID(), kind: "image" }, { bytes: png, name: "photo.png", type: "image/png" });
  assert.equal(img.status, 200);
  const s1 = fake.sends.at(-1)!.body as Record<string, unknown>;
  assert.equal(s1.method, "apple-script");
  assert.equal(s1.isAudioMessage, null);
  assert.match(String(s1.tempGuid), /^prism-/);
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(64, 0)]);
  assert.equal((await sendFile(th, { clientId: crypto.randomUUID(), kind: "voice", durationMs: "3000" }, { bytes: m4a, name: "rec.m4a", type: "audio/mp4" })).status, 200);
  assert.equal((fake.sends.at(-1)!.body as Record<string, unknown>).isAudioMessage, null, "M4A: an ordinary audio file");
  // Two consecutive MPEG-1 layer III frames (128 kbit/s, 44.1 kHz: 417 bytes each).
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, 0)]);
  const mp3 = Buffer.concat([frame, frame, frame]);
  assert.equal((await sendFile(th, { clientId: crypto.randomUUID(), kind: "voice", durationMs: "3000" }, { bytes: mp3, name: "rec.mp3", type: "audio/mpeg" })).status, 200);
  assert.equal((fake.sends.at(-1)!.body as Record<string, unknown>).isAudioMessage, "true", "MP3: BlueBubbles converts it to a voice memo");
  // Opus in CAF (what Comms records for iMessage): a voice memo, under Messages' own name.
  const caf = cafFile("opus");
  assert.equal((await sendFile(th, { clientId: crypto.randomUUID(), kind: "voice", durationMs: "3000" }, { bytes: caf, name: "x.caf", type: "audio/x-caf" })).status, 200);
  const cafSend = fake.sends.at(-1)!.body as Record<string, unknown>;
  assert.equal(cafSend.isAudioMessage, "true", "Opus CAF: sent as an audio message");
  assert.equal(cafSend.name, "Audio Message.caf");
  // A CAF that is not Opus is not a voice note.
  const nAac = fake.sends.length;
  assert.equal((await sendFile(th, { clientId: crypto.randomUUID(), kind: "voice" }, { bytes: cafFile("aac "), name: "x.caf", type: "audio/x-caf" })).status, 415);
  assert.equal(fake.sends.length, nAac);
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(64, 0)]);
  const n = fake.sends.length;
  const o = await sendFile(th, { clientId: crypto.randomUUID(), kind: "voice" }, { bytes: ogg, name: "rec.ogg", type: "audio/ogg" });
  assert.equal(o.status, 415);
  assert.equal(fake.sends.length, n);
  const react = await createApp().request(`/api/comms/threads/${th}/messages/$S0abc/reactions`, { method: "POST", headers: { "content-type": "application/json", ...devAuth() }, body: JSON.stringify({ clientId: crypto.randomUUID(), key: "👍" }) });
  assert.equal(react.status, 409);
  assert.equal(fake.sends.length, n);
});

test("integration: '!' text is ordinary on iMessage (no bridge) — sent, not refused as a bridge command", async () => {
  const th = await sendReady();
  const r = await sendText(th, { clientId: crypto.randomUUID(), text: "!important see you at 5" });
  assert.equal(r.status, 200);
  assert.equal((fake.sends.at(-1)!.body as { message: string }).message, "!important see you at 5");
});

// ── final-review fixes ──────────────────────────────────────────────────────

import { projectChat as projectBbChat } from "../src/bluebubbles/project";
import { upsertConversation as upsertConv, ensureSingleThread as ensureThread, threadsOfPerson, threadMembers as membersOf } from "../src/comms/store";
import { conversationIdFor } from "../src/comms/project";
import { bbMemberId } from "../src/bluebubbles/contacts";

test("I1: a triage status from the thread note's tags survives the refresh and live projections; an unchanged refresh emits no thread.updated", async () => {
  const entry = resolveVaultEntry(undefined);
  fake.messages.push(msg("U1", DM_ANN, NOW - 5000, { text: "please call me" }));
  await runBlueBubblesOnce(entry); // projects, then the poll writes the thread note
  const note = threadNote(DM_ANN)!;
  vault.notes.set(note.id, { ...note, tags: [...(note.tags ?? []), "urgent"] });
  resetBlueBubblesCachesForTests(); // next pass refreshes every chat (the 30-min refresh)
  await runBlueBubblesOnce(entry);
  const th = threadIdForChat(DM_ANN);
  assert.equal(getThread(th)!.status, "urgent");
  // A live projection (webhook path) knows no tags: it keeps the row's status.
  await projectBbChat(fake.chats[0]!, makeContactBook(fake.contacts, null));
  assert.equal(getThread(th)!.status, "urgent");
  // Nothing changed → the refresh is silent.
  const before = (db.prepare("SELECT COUNT(*) AS n FROM comms_events WHERE kind = 'thread.updated'").get() as { n: number }).n;
  resetBlueBubblesCachesForTests();
  await runBlueBubblesOnce(entry);
  const after = (db.prepare("SELECT COUNT(*) AS n FROM comms_events WHERE kind = 'thread.updated'").get() as { n: number }).n;
  assert.equal(after, before);
});

test("I2: a Matrix-bridged imessage / gmessages (sms) room is never taken for a BlueBubbles chat", async () => {
  for (const [network, room] of [["imessage", "!imsg:hs.test"], ["sms", "!gmsg:hs.test"]] as const) {
    const id = conversationIdFor(room);
    upsertConv({
      id, network, sourceRef: room, kind: "dm", title: "Bridged", titleSource: "contact", avatar: null, lastEventAt: "2026-11-20T10:00:00.000Z",
      lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null,
      accountLabel: null, capabilities: { react: true, edit: true, unsend: true, reply: true, typing: true, receipts: true, attachments: true }, vaultNoteId: null,
    });
    assert.equal(bbThreadSource(ensureThread(id)), null, network);
  }
  // A non-Matrix ref whose conversation id is not the hash of that ref is not ours either.
  upsertConv({
    id: "notthehash", network: "imessage", sourceRef: DM_ANN, kind: "dm", title: "x", titleSource: "contact", avatar: null, lastEventAt: "2026-11-20T10:00:00.000Z",
    lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null,
    accountLabel: null, capabilities: null, vaultNoteId: null,
  });
  assert.equal(bbThreadSource(ensureThread("notthehash")), null);
  // Ours still resolve.
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  assert.deepEqual(bbThreadSource(threadIdForChat(DM_ANN)), { chatGuid: DM_ANN, network: "imessage" });
});

test("I4: iMessage handles link to person notes by E.164 phone / email — thread person, members, person page threads, contact", async () => {
  const ann: Note = { id: "p_ann", path: "vault/people/ann-person", content: "# Ann Person", tags: ["person"], metadata: { name: "Ann Person", phone: "+1 (555) 123-0001" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } as unknown as Note;
  const bob: Note = { id: "p_bob", path: "vault/people/bob", content: "# Bob", tags: ["person"], metadata: { name: "Bob Person", email: "Bob@Example.test" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } as unknown as Note;
  setBlueBubblesDepsForTests(() => ({ client: client(), vault, people: async () => [ann, bob] }));
  fake.messages.push(msg("K1", DM_ANN, NOW - 4000, { text: "hey" }), msg("K2", GROUP, NOW - 3000, { text: "group hey", handle: { address: BOB } }));
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  const dm = threadIdForChat(DM_ANN);
  assert.equal(getThread(dm)!.personId, "p_ann");
  assert.equal(getThread(dm)!.title, "Ann Person");
  assert.deepEqual(membersOf(dm), [{ memberId: "tel:+15551230001", personId: "p_ann" }]);
  assert.equal(bbMemberId("bob@EXAMPLE.test"), "mailto:bob@example.test");
  assert.equal(bbMemberId("5551230001"), "tel:5551230001", "a local number is no key (people rule)");
  const groupTh = threadIdForChat(GROUP);
  assert.equal(getThread(groupTh)!.personId, undefined, "a group has no single person");
  assert.ok(threadsOfPerson("p_ann").some((t) => t.id === dm));
  assert.ok(threadsOfPerson("p_bob").some((t) => t.id === groupTh), "Bob is a member of the group");
  // Thread detail: the DM's contact carries the number (Call menu), members carry person ids.
  const r = await createApp().request(`/api/comms/threads/${dm}`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  const body = (await r.json()) as { contact?: { phones: Array<{ value: string }> }; members: Array<{ id: string; personId?: string }> };
  assert.ok(body.contact?.phones.some((p) => p.value === "+15551230001"));
  assert.equal(body.members.find((m) => m.id === ANN)?.personId, "p_ann");
});

// ── S3: new conversations (POST /api/comms/conversations) ───────────────────

const startConv = (body: unknown, headers: Record<string, string> = devAuth()) =>
  createApp().request(`/api/comms/conversations`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("S3: an existing iMessage thread with the handle is returned, nothing is sent", async () => {
  const th = await sendReady();
  for (const handle of [ANN, "+1 (555) 123-0001", "0015551230001"]) {
    const r = await startConv({ clientId: crypto.randomUUID(), handle, network: "imessage", text: "hi" });
    assert.equal(r.status, 200, handle);
    const b = (await r.json()) as { existing: boolean; threadId: string; thread: { id: string; kind: string } };
    assert.deepEqual([b.existing, b.threadId, b.thread.id, b.thread.kind], [true, th, th, "dm"]);
  }
  // SMS asked, only an iMessage thread exists: that one is offered (Messages keeps one conversation).
  const sms = (await (await startConv({ clientId: crypto.randomUUID(), handle: ANN, network: "sms", text: "hi" })).json()) as { existing: boolean; threadId: string };
  assert.deepEqual([sms.existing, sms.threadId], [true, th]);
  assert.equal(fake.sends.length, 0);
});

test("S3: a new handle is sent to `iMessage;-;<handle>` (apple-script, tempGuid), projected, idempotent", async () => {
  await sendReady();
  const id = crypto.randomUUID();
  const NEW = "+15559870000";
  const r = await startConv({ clientId: id, handle: "+1 555 987 0000", network: "imessage", text: "Hello there" });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const b = (await r.json()) as { existing: boolean; threadId: string; eventId: string; clientId: string; status: string; pending: boolean; thread: { id: string; kind: string; networks: string[] } };
  assert.deepEqual(fake.sends[0]!.body, { chatGuid: `iMessage;-;${NEW}`, tempGuid: `prism-${id}`, message: "Hello there", method: "apple-script" });
  assert.deepEqual([b.existing, b.status, b.pending, b.clientId], [false, "sent", false, id]);
  assert.equal(b.threadId, threadIdForChat(`iMessage;-;${NEW}`));
  assert.deepEqual([b.thread.id, b.thread.kind, b.thread.networks[0]], [b.threadId, "dm", "imessage"]);
  // Replay: same body, nothing sent again — even though the conversation now exists.
  const again = await startConv({ clientId: id, handle: NEW, network: "imessage", text: "Hello there" });
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  const b2 = (await again.json()) as { existing: boolean; eventId: string; threadId: string };
  assert.deepEqual([b2.existing, b2.eventId, b2.threadId], [false, b.eventId, b.threadId]);
  assert.equal(fake.sends.length, 1);
  // A NEW clientId for the same handle now finds the thread: nothing sent.
  const third = (await (await startConv({ clientId: crypto.randomUUID(), handle: NEW, network: "imessage", text: "again" })).json()) as { existing: boolean; threadId: string };
  assert.deepEqual([third.existing, third.threadId], [true, b.threadId]);
  assert.equal(fake.sends.length, 1);
  // The same clientId for other content → 422.
  assert.equal((await startConv({ clientId: id, handle: NEW, network: "imessage", text: "different" })).status, 422);
  // Audit: no text, no number.
  assert.doesNotMatch(JSON.stringify(sendAudit()), /Hello there|5559870000/);
});

test("S3: Messages files the new chat as `any;-;…` — the real chat is read back and projected; an email works too", async () => {
  await sendReady();
  fake.newChatAs = "any";
  const r = (await (await startConv({ clientId: crypto.randomUUID(), handle: "Dana@Example.TEST", network: "imessage", text: "hey" })).json()) as { threadId: string; pending: boolean; thread: { id: string } };
  assert.equal(fake.sends.length, 1);
  assert.equal((fake.sends[0]!.body as { chatGuid: string }).chatGuid, "iMessage;-;dana@example.test");
  assert.equal(r.pending, false);
  assert.equal(r.threadId, threadIdForChat("any;-;dana@example.test"));
  assert.equal(r.thread.id, r.threadId);
});

test("S3: a maybe-sent first message is looked for under every prefix before a retry (never sent twice)", async () => {
  await sendReady();
  fake.newChatAs = "any";
  const id = crypto.randomUUID();
  fake.failNextSend = 500;
  const first = await startConv({ clientId: id, handle: "+15550001234", network: "imessage", text: "first try" });
  assert.equal(first.status, 502);
  assert.equal(((await first.json()) as { maybeSent: boolean }).maybeSent, true);
  const retry = await startConv({ clientId: id, handle: "+15550001234", network: "imessage", text: "first try" });
  assert.equal(retry.status, 200);
  const b = (await retry.json()) as { existing: boolean; threadId: string };
  assert.equal(b.existing, false, "a retry replays the send, it is never answered 'existing'");
  assert.equal(b.threadId, threadIdForChat("any;-;+15550001234"));
  assert.equal(fake.sends.length, 1);
});

test("S3: validation, gates and availability", async () => {
  await sendReady();
  const ok = { clientId: crypto.randomUUID(), handle: "+15550002222", network: "imessage", text: "x" };
  const code = async (body: unknown, headers?: Record<string, string>) => {
    const r = await startConv(body, headers);
    return [r.status, ((await r.json()) as { error: string }).error];
  };
  assert.deepEqual(await code({ ...ok, handle: "555 0002" }), [422, "invalid_handle"], "no country code");
  assert.deepEqual(await code({ ...ok, handle: "not an address" }), [422, "invalid_handle"]);
  assert.deepEqual(await code({ ...ok, handle: "a@b.test", network: "sms" }), [422, "invalid_handle"]);
  assert.deepEqual(await code({ ...ok, network: "whatsapp" }), [422, "invalid"]);
  assert.deepEqual(await code({ ...ok, roomId: "!x:hs" }), [422, "invalid"]);
  assert.deepEqual(await code({ ...ok, text: "   " }), [422, "invalid"]);
  assert.deepEqual(await code(ok, { cookie: sessionCookie(makeSession(config.ownerEmail)) }), [403, "device_required"]);
  process.env.COMMS_SEND_ENABLED = "false";
  assert.deepEqual(await code(ok), [403, "send_disabled"]);
  process.env.COMMS_SEND_ENABLED = "true";
  resetBlueBubblesReadyForTests(); // BlueBubbles not answering
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = true; // Matrix can still send: the route gate passes
  assert.deepEqual(await code(ok), [403, "send_disabled"]);
  process.env.BLUEBUBBLES_ENABLED = "false";
  assert.deepEqual(await code(ok), [409, "unsupported_network"]);
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = false;
  assert.equal(fake.sends.length, 0);
});

// ── fix round 1: an echo that arrives before the send's 200 carries clientId ─

test("echo before the 200 (BlueBubbles): the webhook's tempGuid prism-<clientId> is mapped onto the message; forged ones are not", async () => {
  const th = await sendReady();
  const { claimSend, RETRY_WINDOW_MS } = await import("../src/comms/send-ledger");
  const id = crypto.randomUUID();
  // The send is in flight: both ledgers hold the claim, no answer yet.
  claimSend({ clientId: id, actorEmail: config.ownerEmail, threadId: th, kind: "text", requestHash: "h", credHash: "c", retryWindowMs: RETRY_WINDOW_MS });
  db.prepare(`INSERT INTO bluebubbles_send (client_id, chat_guid, kind, digest, state, created_at, updated_at, attempt_at) VALUES (?, ?, 'text', 'd', 'pending', ?, ?, ?)`)
    .run(id, DM_ANN, Date.now(), Date.now(), Date.now());
  fake.messages.push(msg("E1", DM_ANN, Date.now(), { text: "sent from comms", isFromMe: true }));
  fake.messages.push(msg("E2", DM_ANN, Date.now() + 1, { text: "forged", isFromMe: true }));
  fake.messages.push(msg("E3", GROUP, Date.now() + 2, { text: "other chat", isFromMe: true }));
  assert.equal((await webhook({ type: "new-message", data: { guid: "E1", tempGuid: `prism-${id}` } })).status, 200);
  assert.equal((await webhook({ type: "new-message", data: { guid: "E2", tempGuid: `prism-${crypto.randomUUID()}` } })).status, 200); // unknown clientId
  assert.equal((await webhook({ type: "new-message", data: { guid: "E3", tempGuid: `prism-${id}` } })).status, 200); // another chat
  await webhookQueueSettled();
  // The live event (what /stream sends) and the timeline both carry it.
  const { messageOut } = await import("../src/comms/timeline");
  const ev = db.prepare(`SELECT payload_json FROM comms_events WHERE kind = 'message.created' ORDER BY id`).all() as { payload_json: string }[];
  const live = ev.map((r) => JSON.parse(r.payload_json).message).filter(Boolean).map((m: import("../src/comms/types").Message) => messageOut(m, { email: config.ownerEmail }));
  assert.equal(live.find((m) => m.id === "E1")?.clientId, id);
  assert.equal(live.find((m) => m.id === "E2")?.clientId, undefined);
  assert.equal(live.find((m) => m.id === "E3")?.clientId, undefined);
  const page = (await (await createApp().request(`/api/comms/threads/${th}/messages?limit=10`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } })).json()) as { messages: Array<{ id: string; clientId?: string }> };
  assert.equal(page.messages.find((m) => m.id === "E1")?.clientId, id);
});

// ── fix round 1: minors on POST /api/comms/conversations ────────────────────

test("fix round 1 (M1/M2): trunk (0), a 0 country code, bidi / zero-width / non-ASCII emails are refused", async () => {
  const { parseHandle } = await import("../src/comms/conversations");
  assert.deepEqual(parseHandle("+44 (0)20 7946 0018"), { kind: "phone", value: "+442079460018" });
  assert.equal(parseHandle("+0 555 123 4567"), null);
  assert.equal(parseHandle("0044 (0) 20 7946 0018")?.value, "+442079460018");
  for (const bad of ["ann\u202e@example.test", "an\u200bn@example.test", "änn@example.test", "+1 555\u2060 123 0001"]) assert.equal(parseHandle(bad), null, JSON.stringify(bad));
});

test("fix round 1 (M8/M6/M9): a second clientId to the same new handle within 30 s is refused; the answer names the handle; the send's own chats are used", async () => {
  await sendReady();
  fake.newChatAs = "any";
  fake.answerWithChats = true;
  const r = await startConv({ clientId: crypto.randomUUID(), handle: "+15550003333", network: "imessage", text: "one" });
  const b = (await r.json()) as { handle: { kind: string; value: string }; threadId: string; pending: boolean };
  assert.deepEqual(b.handle, { kind: "phone", value: "+15550003333" });
  assert.equal(b.threadId, threadIdForChat("any;-;+15550003333"), "the chat the send answered with");
  assert.ok(!fake.requests.some((p) => p.startsWith("/api/v1/message/sent-")), "no message re-read needed");
  // Another tap minting a new clientId while the first is not projected (simulate: drop the projection).
  db.prepare(`DELETE FROM comms_conversations`).run();
  const second = await startConv({ clientId: crypto.randomUUID(), handle: "+15550003333", network: "imessage", text: "one" });
  assert.equal(second.status, 409);
  assert.equal(((await second.json()) as { error: string }).error, "in_progress");
  assert.equal(fake.sends.length, 1);
});

test("fix round 1 (M9): route-level refusals on /conversations — agent origin, MCP-style session, rate limit", async () => {
  await sendReady();
  const ok = () => ({ clientId: crypto.randomUUID(), handle: "+15550004444", network: "imessage", text: "x" });
  const agent = await startConv(ok(), { ...devAuth(), "x-prism-action-origin": "agent" });
  assert.equal(agent.status, 403);
  assert.equal(((await agent.json()) as { error: string }).error, "device_required");
  process.env.COMMS_SEND_PER_10MIN = "1";
  clearRateLimitsForTests("comms");
  try {
    assert.equal((await startConv({ ...ok(), handle: ANN })).status, 200); // existing: spends the budget too
    const limited = await startConv(ok());
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  } finally {
    delete process.env.COMMS_SEND_PER_10MIN;
  }
  assert.equal(fake.sends.length, 0);
  assert.ok(sendAudit().some((x) => x.error === "device_required" && x.origin === "agent"));
});

test("integration: mentions are refused on iMessage (no mention pills there) — nothing sent", async () => {
  const th = await sendReady();
  const n = fake.sends.length;
  const r = await sendText(th, { clientId: crypto.randomUUID(), text: "Hi Sam", mentions: [{ userId: "@sam:example.test", start: 3, length: 3 }] });
  assert.equal(r.status, 422);
  assert.equal(fake.sends.length, n);
});

// ── owner report 2026-11-22: a photo from "+ → Files" refused 422 before BlueBubbles ──────────
import { swiftUploadInit } from "./swift-multipart";

/** A real baseline JPEG header (SOF0 4032×3024) — what the Mac sends after HEIC→JPEG + GPS strip. */
const MAC_JPEG = Buffer.concat([
  Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"),
  Buffer.from("ffc0001108", "hex"), Buffer.from([0x0b, 0xd0, 0x0f, 0xc0]), Buffer.from("03012200021101031101", "hex"),
  Buffer.alloc(256, 7), Buffer.from("ffd9", "hex"),
]);

test("owner report: the Mac client's exact multipart (streamed, Content-Length, kind image + w/h) reaches BlueBubbles — ASCII, spaces and Unicode names, legacy filename* too", async () => {
  const th = await sendReady();
  const names = ["IMG_4821.jpg", "Photo 22-11-2026 at 10.15.jpg", "Screenshot 2026-11-22 at 10.15.32 AM.png".replace(".png", ".jpg"), "Café 照片 🌅.jpg"];
  for (const style of ["legacy", "utf8"] as const) {
    for (const filename of names) {
      const before = fake.sends.length;
      const r = await createApp().request(`/api/comms/threads/${th}/attachments`, swiftUploadInit({
        clientId: crypto.randomUUID().toUpperCase(), kind: "image", w: 3024, h: 4032, filename, mime: "image/jpeg", bytes: MAC_JPEG, style,
      }, devAuth()));
      assert.equal(r.status, 200, `${style} ${JSON.stringify(filename)}: ${await r.clone().text()}`);
      assert.equal(fake.sends.length, before + 1, "BlueBubbles got it");
      const sent = fake.sends.at(-1)!;
      assert.ok(sent.path.endsWith("/message/attachment"));
      assert.equal((sent.body as { name?: string }).name, filename, "the owner's file name survives (UTF-8)");
    }
  }
});

// ── iMessage vs SMS on macOS 26's unified `any;` GUIDs; Messages-style group titles ─────────

import { membersTitle } from "../src/comms/naming";
import { conversationIdForChat } from "../src/bluebubbles/project";

const refresh = async () => {
  resetBlueBubblesCachesForTests(); // the next pass re-projects every chat (the 30-min refresh)
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
};
const svc = (address: string, service: string) => ({ address, service });
const C = "+15551230002"; // Cara
const D = "+15551230003"; // Dan
const UNKNOWN = "+15559870001";

test("service: unified any; GUIDs take iMessage vs SMS from the newest message's handle service, not the first participant; explicit GUIDs keep their prefix", async () => {
  fake.bareLastMessage = true;
  const dmImsg = `any;-;${C}`; // first participant handle says SMS, the conversation is iMessage
  const dmSms = `any;-;${D}`; // first participant handle says iMessage, the conversation is SMS
  const grp = "any;+;chat900001"; // first participant SMS, newest message iMessage
  const quiet = `any;-;${UNKNOWN}`; // no message at all: the participant's service is all there is
  fake.chats.push(
    { guid: dmImsg, style: 45, chatIdentifier: C, displayName: "", participants: [svc(C, "SMS")] },
    { guid: dmSms, style: 45, chatIdentifier: D, displayName: "", participants: [svc(D, "iMessage")] },
    { guid: grp, style: 43, chatIdentifier: "chat900001", displayName: "", participants: [svc(D, "SMS"), svc(C, "iMessage")] },
    { guid: quiet, style: 45, chatIdentifier: UNKNOWN, displayName: "", participants: [svc(UNKNOWN, "SMS")] },
  );
  fake.messages.push(
    msg("S1", dmImsg, NOW - 9000, { handle: svc(C, "SMS") }), // old SMS
    msg("S2", dmImsg, NOW - 8000, { handle: svc(C, "iMessage") }), // newest: iMessage
    msg("S3", dmImsg, NOW - 7000, { isFromMe: true, handle: svc(C, "iMessage"), error: 22 }), // failed: no evidence
    msg("S4", dmSms, NOW - 6000, { handle: svc(D, "SMS") }),
    msg("S5", dmSms, NOW - 5900, { isFromMe: true, handle: svc(D, "SMS") }),
    msg("S6", grp, NOW - 5000, { handle: svc(D, "SMS") }),
    msg("S7", grp, NOW - 4000, { handle: svc(C, "iMessage") }),
    msg("S8", grp, NOW - 3000, { isFromMe: true, handle: null }), // mine in a group: no handle, no evidence
    // An explicit GUID is believed over any message.
    msg("S9", DM_ANN, NOW - 2000, { handle: svc(ANN, "SMS") }),
  );
  await refresh();
  const net = (g: string) => getThread(threadIdForChat(g))!.networks;
  assert.deepEqual(net(dmImsg), ["imessage"], "newest message iMessage despite an SMS participant handle");
  assert.deepEqual(net(dmSms), ["sms"], "newest message SMS despite an iMessage participant handle");
  assert.deepEqual(net(grp), ["imessage"], "a group follows its newest message with a handle");
  assert.deepEqual(net(quiet), ["sms"], "no message known: the participant handle's service");
  assert.deepEqual(net(DM_ANN), ["imessage"], "iMessage; GUID");
  assert.deepEqual(net(SHORT), ["sms"], "SMS; GUID");
  // The vault thread note is filed under the same platform.
  assert.equal(threadNote(dmSms)?.metadata?.platform, "sms");
  assert.equal(threadNote(dmImsg)?.metadata?.platform, "imessage");
  // The read path of a unified chat keeps working (bbThreadSource resolves either network).
  assert.deepEqual(bbThreadSource(threadIdForChat(dmSms)), { chatGuid: dmSms, network: "sms" });
  // A second refresh is stable and asks BlueBubbles nothing extra per chat (evidence is stored).
  fake.requests = [];
  await refresh();
  assert.deepEqual(net(dmImsg), ["imessage"]);
  assert.deepEqual(net(dmSms), ["sms"]);
  assert.deepEqual(net(quiet), ["sms"]);
  assert.equal(fake.requests.filter((r) => r === "/api/v1/message/query").length, 1, "only the poll queries messages: no per-chat probe again");
});

test("service: a chat that moves from SMS to iMessage flips with the new message (webhook), survives a refresh, and an older SMS seen later does not flip it back", async () => {
  fake.bareLastMessage = true;
  const g = `any;-;${C}`;
  fake.chats.push({ guid: g, style: 45, chatIdentifier: C, displayName: "", participants: [svc(C, "SMS")] });
  fake.contacts.push({ displayName: "Cara Diaz", phoneNumbers: [{ address: C }], emails: [] });
  fake.messages.push(msg("F1", g, NOW - 60_000, { handle: svc(C, "SMS"), text: "green" }));
  await refresh();
  const th = threadIdForChat(g);
  assert.deepEqual(getThread(th)!.networks, ["sms"]);
  // Cara gets iMessage: her next message arrives over iMessage.
  const m2 = msg("F2", g, NOW - 1000, { handle: svc(C, "iMessage"), text: "blue now" });
  fake.messages.push(m2);
  const updatesBefore = (db.prepare("SELECT COUNT(*) AS n FROM comms_events WHERE kind = 'thread.updated'").get() as { n: number }).n;
  assert.equal((await webhook({ type: "new-message", data: withChat(m2) })).status, 200);
  await webhookQueueSettled();
  assert.deepEqual(getThread(th)!.networks, ["imessage"], "flipped by the new message");
  const updatesAfter = (db.prepare("SELECT COUNT(*) AS n FROM comms_events WHERE kind = 'thread.updated'").get() as { n: number }).n;
  assert.ok(updatesAfter > updatesBefore, "thread.updated tells the clients");
  const created = db.prepare("SELECT payload_json FROM comms_events WHERE kind = 'message.created' ORDER BY id DESC LIMIT 1").get() as { payload_json: string };
  assert.equal(JSON.parse(created.payload_json).message.id, "F2");
  // The 30-min refresh (lastMessage without a handle) keeps it.
  await refresh();
  assert.deepEqual(getThread(th)!.networks, ["imessage"]);
  // Reading older history (an SMS) never flips it back.
  await readBbTimeline({ threadId: th, chatGuid: g, network: "imessage", limit: 50, reader: client(), book: makeContactBook(fake.contacts, null) });
  await refresh();
  assert.deepEqual(getThread(th)!.networks, ["imessage"]);
  // A newer SMS (iMessage off on her phone) flips it to SMS again.
  const m3 = msg("F3", g, NOW, { handle: svc(C, "SMS"), text: "green again" });
  fake.messages.push(m3);
  assert.equal((await webhook({ type: "new-message", data: withChat(m3) })).status, 200);
  await webhookQueueSettled();
  assert.deepEqual(getThread(th)!.networks, ["sms"]);
});

test("group titles: membersTitle builds Messages' names (1 full name, 2 joined, N → '& N others')", () => {
  const m = (first: string | null, full: string | null, handle = "+15550000000") => ({ firstName: first, fullName: full, handle });
  assert.equal(membersTitle([]), null);
  assert.equal(membersTitle([m("Ann", "Ann Example")]), "Ann Example");
  assert.equal(membersTitle([m(null, null, "+15559870001")]), "+1 555-987-0001");
  assert.equal(membersTitle([m("Ann", "Ann Example"), m("Bob", "Bob Builder")]), "Ann & Bob");
  assert.equal(membersTitle([m("Ann", "Ann Example"), m("Bob", "Bob Builder"), m(null, null, "+15559870001")]), "Ann, Bob & 1 other");
  assert.equal(membersTitle([m(null, null, "+15559870001"), m("Ann", "Ann Example"), m(null, null), m(null, null), m(null, null), m(null, null)]), "+1 555-987-0001, Ann & 4 others");
  assert.equal(membersTitle([m(null, "Cara Diaz"), m(null, "bob@example.test", "bob@example.test")]), "Cara & bob@example.test");
});

test("group titles: unnamed groups are titled from their members (2, 3, 6; owner excluded; unknown numbers formatted), named groups keep their name, and a refresh re-titles existing rows", async () => {
  const OWNER_PHONE = "+15550009999";
  const owner: Note = { id: "p_owner", path: "vault/people/owner", content: "# Owner", tags: ["person"], metadata: { name: "Owner Person", email: config.ownerEmail, phone: OWNER_PHONE }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } as unknown as Note;
  const dan: Note = { id: "p_dan", path: "vault/people/dan", content: "# Dan", tags: ["person"], metadata: { name: "Daniel Person", phone: D }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } as unknown as Note;
  setBlueBubblesDepsForTests(() => ({ client: client(), vault, people: async () => [owner, dan] }));
  fake.contacts.push(
    { displayName: "Cara Diaz", firstName: "Cara", phoneNumbers: [{ address: C }], emails: [] },
    { displayName: "Me Myself", phoneNumbers: [{ address: OWNER_PHONE }], emails: [] }, // the owner's own card
    { displayName: "Eve Stone", phoneNumbers: [{ address: "+15551230005" }], emails: [] },
    { displayName: "Finn Wolf", phoneNumbers: [{ address: "+15551230006" }], emails: [] },
  );
  const g = (id: string, members: string[], displayName = "") =>
    ({ guid: `any;+;${id}`, style: 43, chatIdentifier: id, displayName, participants: members.map((a) => svc(a, "iMessage")) });
  const two = g("chat2", [ANN, C]);
  const three = g("chat3", [ANN, C, UNKNOWN]);
  const six = g("chat6", [ANN, C, D, "+15551230005", "+15551230006", UNKNOWN]);
  const withOwner = g("chatown", [OWNER_PHONE, ANN, C]);
  const unknownFirst = g("chatunk", [UNKNOWN, ANN]);
  const one = g("chat1", [D, OWNER_PHONE]);
  const named = g("chatnamed", [ANN, C, D], "Climbing Crew");
  fake.chats.push(two, three, six, withOwner, unknownFirst, one, named);
  // The production shape: a row titled with ONE member's contact name (the old rule).
  const stale = conversationIdForChat(three.guid);
  upsertConv({
    id: stale, network: "imessage", sourceRef: three.guid, kind: "group", title: "Ann Example", titleSource: "contact", avatar: null, lastEventAt: "2026-11-20T10:00:00.000Z",
    lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null,
    accountLabel: null, capabilities: null, vaultNoteId: null,
  });
  const th = ensureThread(stale);
  await refresh();
  const t = (c: BbChat) => { const x = getThread(threadIdForChat(c.guid))!; return [x.title, x.titleSource]; };
  assert.deepEqual(t(two), ["Ann & Cara", "members"]);
  assert.deepEqual(t(three), ["Ann, Cara & 1 other", "members"], "the stale 'Ann Example' row is re-titled");
  assert.equal(threadIdForChat(three.guid), th);
  assert.deepEqual(t(six), ["Ann, Cara & 4 others", "members"]);
  assert.deepEqual(t(withOwner), ["Ann & Cara", "members"], "the owner (person note, even with a Contacts card) is not a member of the title");
  assert.deepEqual(t(unknownFirst), ["+1 555-987-0001 & Ann", "members"], "an unknown number is shown formatted");
  assert.deepEqual(t(one), ["Daniel Person", "members"], "one other member: the full name (person note)");
  assert.deepEqual(t(named), ["Climbing Crew", "room"]);
  assert.deepEqual(t(fake.chats.find((c) => c.guid === GROUP)!), ["Climbing", "room"]);
  // DMs are unchanged: person note, Contacts, else the handle.
  assert.deepEqual(t(fake.chats.find((c) => c.guid === DM_ANN)!), ["Ann Example", "contact"]);
  // The re-title reached the clients.
  const updated = (db.prepare("SELECT payload_json FROM comms_events WHERE kind = 'thread.updated'").all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json).threadId);
  assert.ok(updated.includes(th));
  // A member who joins changes the count on the next refresh.
  fake.chats.find((c) => c.guid === two.guid)!.participants!.push(svc(UNKNOWN, "iMessage"));
  await refresh();
  assert.deepEqual(t(two), ["Ann, Cara & 1 other", "members"]);
  // A vault note for an unnamed group is filed under the member title too.
  fake.messages.push(msg("GT1", six.guid, NOW - 1000, { handle: svc(C, "iMessage"), text: "hi all" }));
  await runBlueBubblesOnce(resolveVaultEntry(undefined));
  assert.equal(threadNote(six.guid)?.metadata?.title, "Ann, Cara & 4 others");
});
