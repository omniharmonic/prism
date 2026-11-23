// Sprint Task 8: pins (owner overrides, order, max 9, routes, events) and inbound delivery /
// read receipts (m.receipt projection per room, out-of-order receipts, ignored readers, the
// bridgev2 delivery status, BlueBubbles dates, the live listener + stream). Synthetic data only.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, resolveVaultEntry } from "../src/db";
import { putSecret } from "../src/secrets";
import { ingestMatrix, parseSync, MatrixClient, type MatrixEvent } from "../src/worker/matrix";
import { handleLiveBatch, liveSettled, setLiveDepsForTests, startCommsLive, stopCommsLive, type LiveDeps } from "../src/comms/live";
import { commsBus } from "../src/comms/bus";
import { projectRoom, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { PeopleIndex } from "../src/worker/people";
import { upsertConversation, ensureSingleThread, listThreads, eventsAfter, type ConversationRow } from "../src/comms/store";
import { setCommsReaderForTests, type CommsReader } from "../src/comms/timeline";
import { normalizeEvents } from "../src/comms/normalize";
import { readEntriesOf, recordReceipts, roomReaders, withReadState } from "../src/comms/receipts";
import { MAX_PINS } from "../src/comms/pins";
import { toCommsMessage } from "../src/bluebubbles/map";
import type { BbMessage } from "../src/bluebubbles/client";
import type { Message } from "../src/comms/types";
import type { Note } from "../src/parachute";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const env = { comms: process.env.COMMS_ENABLED, pins: process.env.COMMS_PINS_ENABLED, rr: process.env.COMMS_RECEIPTS_ENABLED };
const logs = { warn: console.warn, log: console.log };
beforeEach(() => {
  resetDb();
  process.env.COMMS_ENABLED = "true";
  process.env.COMMS_PINS_ENABLED = "true";
  process.env.COMMS_RECEIPTS_ENABLED = "true";
  console.warn = console.log = () => {};
});
afterEach(() => {
  Object.assign(console, logs);
  for (const [k, v] of [["COMMS_ENABLED", env.comms], ["COMMS_PINS_ENABLED", env.pins], ["COMMS_RECEIPTS_ENABLED", env.rr]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  stopCommsLive();
  setLiveDepsForTests(null);
  setCommsReaderForTests(null);
});

const owner = (extra: Record<string, string> = {}) => ({ cookie: sessionCookie(makeSession(config.ownerEmail)), ...extra });
const json = { "content-type": "application/json" };
const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();

// ── pins ─────────────────────────────────────────────────────────────────────

function conv(id: string, n: number): ConversationRow {
  return {
    id, network: "telegram", sourceRef: `!${id}:hs`, kind: "dm", title: `Title ${id}`, titleSource: "room",
    avatar: null, lastEventAt: at(n), lastPreview: null, unreadCount: 0, unreadTrusted: true,
    folder: "inbox", pinned: false, muted: false, archived: false, triage: null, accountLabel: null,
    capabilities: null, vaultNoteId: null,
  };
}
const add = (id: string, n = 1): string => { upsertConversation(conv(id, n)); return ensureSingleThread(id); };
const app = () => createApp();
const pin = (id: string) => app().request(`/api/comms/threads/${id}/pin`, { method: "POST", headers: owner() });
const unpin = (id: string) => app().request(`/api/comms/threads/${id}/pin`, { method: "DELETE", headers: owner() });
const pins = async () => ((await (await app().request("/api/comms/pins", { headers: owner() })).json()) as { threads: { id: string; pinOrder?: number }[] }).threads;

test("pins: off by default → 404 pins_disabled; capabilities name the operation only when on", async () => {
  const a = add("a");
  delete process.env.COMMS_PINS_ENABLED;
  const r = await pin(a);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "pins_disabled" });
  let caps = (await (await app().request("/api/comms/capabilities", { headers: owner() })).json()) as { operations: string[] };
  assert.ok(!caps.operations.includes("threads:pin"));
  process.env.COMMS_PINS_ENABLED = "true";
  caps = (await (await app().request("/api/comms/capabilities", { headers: owner() })).json()) as { operations: string[] };
  assert.ok(caps.operations.includes("threads:pin"));
  assert.ok(caps.operations.includes("receipts:read"));
});

test("pins: owner only", async () => {
  const a = add("a");
  const r = await app().request(`/api/comms/threads/${a}/pin`, { method: "POST", headers: { cookie: sessionCookie(makeSession("someone@example.test")) } });
  assert.equal(r.status, 403);
});

test("pins: pin appends in order, idempotent, max 9, unpin compacts, list carries pinOrder", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => add(`t${i}`, i));
  for (const id of ids.slice(0, 3)) assert.equal((await pin(id)).status, 200);
  const again = await pin(ids[0]!);
  assert.equal(again.status, 200);
  assert.deepEqual((await pins()).map((t) => [t.id, t.pinOrder]), [[ids[0], 0], [ids[1], 1], [ids[2], 2]]);
  for (const id of ids.slice(3, 9)) assert.equal((await pin(id)).status, 200);
  assert.equal((await pins()).length, MAX_PINS);
  const tenth = await pin(ids[9]!);
  assert.equal(tenth.status, 409);
  assert.deepEqual(await tenth.json(), { error: "pin_limit", max: 9 });
  assert.equal((await unpin(ids[1]!)).status, 200);
  const now = await pins();
  assert.deepEqual(now.map((t) => t.pinOrder), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(!now.some((t) => t.id === ids[1]));
  // The regular list: pinned first (the client splits them off), each with its order.
  const list = listThreads({ limit: 50, folder: "inbox" }).threads;
  assert.equal(list.filter((t) => t.pinned).length, 8);
  assert.equal(list.find((t) => t.id === ids[1])!.pinOrder, undefined);
  assert.equal(list.find((t) => t.id === ids[0])!.pinOrder, 0);
  assert.equal((await pin("missing-thread")).status, 404);
});

test("pins: every change is announced so other devices refetch", async () => {
  const a = add("a");
  const b = add("b");
  const start = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM comms_events`).get() as { m: number }).m;
  await pin(a);
  await pin(b);
  await pin(a); // no change → no event
  const put = await app().request("/api/comms/pins", { method: "PUT", headers: owner(json), body: JSON.stringify({ threadIds: [b, a] }) });
  assert.equal(put.status, 200);
  assert.deepEqual(((await put.json()) as { threads: { id: string }[] }).threads.map((t) => t.id), [b, a]);
  await unpin(b);
  // Unpinning the first pin moves the next one up: a list-wide refresh too.
  const evs = eventsAfter(start, 50).map((e) => [e.kind, (e.payload as { threadId: string | null }).threadId]);
  assert.deepEqual(evs, [["thread.updated", a], ["thread.updated", b], ["thread.updated", null], ["thread.updated", b], ["thread.updated", null]]);
});

test("pins: a source-side pin without an order is healed; the new pin goes last and other devices are told", async () => {
  const a = add("a");
  const n = add("n");
  db.prepare(`UPDATE comms_threads SET o_pinned = 1 WHERE id = ?`).run(a); // pinned elsewhere, no order
  const start = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM comms_events`).get() as { m: number }).m;
  await pin(n);
  assert.deepEqual((await pins()).map((t) => [t.id, t.pinOrder]), [[a, 0], [n, 1]]);
  assert.deepEqual(eventsAfter(start, 10).map((e) => (e.payload as { threadId: string | null }).threadId), [n, null]);
});

test("pins: reorder must name exactly the pinned set; bad bodies refused", async () => {
  const a = add("a"), b = add("b"), c = add("c");
  await pin(a); await pin(b);
  const stale = await app().request("/api/comms/pins", { method: "PUT", headers: owner(json), body: JSON.stringify({ threadIds: [b, c] }) });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "pins_changed", threadIds: [a, b] });
  const dup = await app().request("/api/comms/pins", { method: "PUT", headers: owner(json), body: JSON.stringify({ threadIds: [a, a] }) });
  assert.equal(dup.status, 409);
  const bad = await app().request("/api/comms/pins", { method: "PUT", headers: owner(json), body: JSON.stringify({ threadIds: "x" }) });
  assert.equal(bad.status, 400);
  const notJson = await app().request("/api/comms/pins", { method: "PUT", headers: owner({ "content-type": "text/plain" }), body: "{}" });
  assert.equal(notJson.status, 415);
  assert.deepEqual((await pins()).map((t) => t.id), [a, b]);
});

// ── receipts: parsing, storing, projecting ───────────────────────────────────

const ME = "@me:hs";
const ALEX = "@whatsapp_alex:hs";
const SAM = "@whatsapp_sam:hs";
const BOT = "@whatsappbot:hs";

function mine(id: string, n: number, over: Partial<Message> = {}): Message {
  return {
    id, threadId: "t", channel: { network: "whatsapp", accountLabel: null }, source: { network: "whatsapp", eventId: id, ref: id },
    sender: { id: ME, name: "Me", avatar: null, isSelf: true, isOmni: false }, sentAt: at(n), body: null,
    attachments: [], linkPreviews: [], reactions: [], delivery: "sent", redacted: false, ...over,
  };
}
const ctx = (ts: Record<string, number> = {}) => ({
  ignore: (u: string) => u === ME || u === BOT,
  eventTs: (id: string) => ts[id] ?? null,
  nameOf: (u: string) => ({ [ALEX]: "Alex", [SAM]: "Sam" } as Record<string, string>)[u] ?? null,
});
const ms = (n: number) => Date.parse(at(n));

test("receipts: only public m.read entries are read", () => {
  const e = readEntriesOf({
    $a: { "m.read": { [ALEX]: { ts: 5 } }, "m.read.private": { [ME]: { ts: 6 } } },
    $b: { "m.read": { [SAM]: { ts: "x" } } },
    junk: { "m.read": { [SAM]: { ts: 1 } } },
  });
  assert.deepEqual(e, [{ eventId: "$a", userId: ALEX, ts: 5 }, { eventId: "$b", userId: SAM, ts: null }]);
  assert.deepEqual(readEntriesOf(null), []);
});

test("receipts: newest per reader; an older receipt arriving late never moves a reader back", () => {
  const ts = { $m1: ms(1), $m2: ms(2), $m3: ms(3) };
  assert.equal(recordReceipts("!r", [{ eventId: "$m3", userId: ALEX, ts: ms(4) }], ctx(ts)), true);
  assert.equal(recordReceipts("!r", [{ eventId: "$m1", userId: ALEX, ts: ms(5) }], ctx(ts)), false, "older event, later delivery");
  assert.equal(recordReceipts("!r", [{ eventId: "$m3", userId: ALEX, ts: ms(6) }], ctx(ts)), false, "same event again");
  // Several in one batch: the newest wins regardless of order.
  recordReceipts("!r", [{ eventId: "$m2", userId: SAM, ts: ms(7) }, { eventId: "$m1", userId: SAM, ts: ms(8) }], ctx(ts));
  const rows = roomReaders("!r").sort((a, b) => (a.userId < b.userId ? -1 : 1));
  assert.deepEqual(rows.map((r) => [r.userId, r.eventId, r.name]), [[ALEX, "$m3", "Alex"], [SAM, "$m2", "Sam"]]);
});

test("receipts: the owner, bridge bots (delivery_receipts) and ignored ids never count as readers", () => {
  assert.equal(recordReceipts("!r", [{ eventId: "$m1", userId: ME, ts: 1 }, { eventId: "$m1", userId: BOT, ts: 1 }], ctx()), false);
  assert.deepEqual(roomReaders("!r"), []);
});

test("receipts: DM → read with the reader's time; group → readBy per person; failed/pending untouched", () => {
  recordReceipts("!dm", [{ eventId: "$m2", userId: ALEX, ts: ms(9) }], ctx({ $m2: ms(2) }));
  const out = withReadState([mine("$m1", 1), mine("$m2", 2), mine("$m3", 3), mine("$f", 1, { delivery: "failed" }), mine("$p", 1, { delivery: "pending" })], "!dm");
  assert.deepEqual(out.map((m) => m.delivery), ["read", "read", "sent", "failed", "pending"]);
  assert.equal(out[1]!.readAt, at(9));
  assert.deepEqual(out[0]!.readBy, [{ id: ALEX, name: "Alex", readAt: at(9) }]);
  // Group: Sam read up to $m3, Alex only to $m2.
  recordReceipts("!g", [{ eventId: "$m2", userId: ALEX, ts: ms(9) }, { eventId: "$m3", userId: SAM, ts: ms(10) }], ctx({ $m2: ms(2), $m3: ms(3) }));
  const g = withReadState([mine("$m2", 2), mine("$m3", 3)], "!g");
  assert.deepEqual(g[0]!.readBy!.map((r) => r.name), ["Alex", "Sam"]);
  assert.deepEqual(g[1]!.readBy!.map((r) => r.name), ["Sam"]);
  assert.equal(g[1]!.readAt, at(10));
  // Someone else's message is never "read".
  const theirs = { ...mine("$x", 1), sender: { id: ALEX, name: "Alex", avatar: null, isSelf: false, isOmni: false }, delivery: null };
  assert.equal(withReadState([theirs], "!g")[0]!.delivery, null);
});

test("receipts: an unknown receipted event falls back to the receipt's own time", () => {
  recordReceipts("!u", [{ eventId: "$unknown", userId: ALEX, ts: ms(5) }], ctx());
  const out = withReadState([mine("$m1", 4), mine("$m2", 6)], "!u");
  assert.deepEqual(out.map((m) => m.delivery), ["read", "sent"]);
});

test("receipts: flag off → nothing is projected", () => {
  recordReceipts("!dm", [{ eventId: "$m1", userId: ALEX, ts: ms(9) }], ctx({ $m1: ms(1) }));
  delete process.env.COMMS_RECEIPTS_ENABLED;
  assert.equal(withReadState([mine("$m1", 1)], "!dm")[0]!.delivery, "sent");
});

// ── per network: what the bridges send (bridgev2 v26.11, mautrix sources) ────

test("delivery: bridgev2 message status — SUCCESS = sent, SUCCESS + delivered_to_users = delivered, monotonic", () => {
  const base = { event_id: "$mine", origin_server_ts: ms(1), sender: ME, type: "m.room.message", content: { msgtype: "m.text", body: "hi" } } as MatrixEvent;
  const status = (id: string, n: number, content: Record<string, unknown>) =>
    ({ event_id: id, origin_server_ts: ms(n), sender: BOT, type: "com.beeper.message_send_status", content: { "m.relates_to": { rel_type: "m.reference", event_id: "$mine" }, ...content } }) as MatrixEvent;
  const run = (evs: MatrixEvent[]) =>
    normalizeEvents(evs, { threadId: "t", network: "whatsapp", selfIds: [ME], agentIds: [], names: {}, avatars: {} }).messages.find((m) => m.id === "$mine")!;
  assert.equal(run([base, status("$s1", 2, { status: "SUCCESS" })]).delivery, "sent");
  assert.equal(run([base, status("$s1", 2, { status: "SUCCESS" }), status("$s2", 3, { status: "SUCCESS", delivered_to_users: [ALEX] })]).delivery, "delivered");
  // Out of order / late: a plain SUCCESS or a FAIL after delivery never moves it back.
  assert.equal(run([base, status("$s2", 3, { status: "SUCCESS", delivered_to_users: [ALEX] }), status("$s1", 4, { status: "SUCCESS" })]).delivery, "delivered");
  assert.equal(run([base, status("$s2", 3, { status: "SUCCESS", delivered_to_users: [ALEX] }), status("$s3", 4, { status: "FAIL", message: "x" })]).delivery, "delivered");
  assert.equal(run([base, status("$s3", 2, { status: "FAIL", message: "Not sent" })]).delivery, "failed");
});

// ── BlueBubbles (iMessage / SMS) ─────────────────────────────────────────────

test("BlueBubbles: dateDelivered → delivered, dateRead → read with readAt, error → failed", () => {
  const wctx = { threadId: "t", network: "imessage" as const, nameOf: () => null };
  const m = (over: Partial<BbMessage>) => toCommsMessage({ guid: "g1", text: "hi", isFromMe: true, dateCreated: ms(1), handle: null, ...over } as BbMessage, wctx)!;
  assert.equal(m({}).delivery, "sent");
  assert.equal(m({ dateDelivered: ms(2) }).delivery, "delivered");
  assert.equal(m({ isDelivered: true }).delivery, "delivered");
  const read = m({ dateDelivered: ms(2), dateRead: ms(3) });
  assert.equal(read.delivery, "read");
  assert.equal(read.readAt, at(3));
  assert.equal(m({ error: 22 }).delivery, "failed");
  assert.equal(m({ isFromMe: false, dateRead: ms(3) }).delivery, null);
});

// ── sync: receipts are asked for and published only with the flag ───────────

test("sync: the long-poll filter asks for m.receipt only with COMMS_RECEIPTS_ENABLED; receipt-only rooms reach the bus", async () => {
  const urls: string[] = [];
  const fake = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ next_batch: "n", rooms: {} }), { status: 200 }); }) as typeof fetch;
  await new MatrixClient({ homeserver: "https://hs", accessToken: "x" }, fake).sync(undefined, 1000);
  assert.match(decodeURIComponent(urls[0]!), /"ephemeral":\{"types":\["m\.receipt"\]\}/);
  delete process.env.COMMS_RECEIPTS_ENABLED;
  await new MatrixClient({ homeserver: "https://hs", accessToken: "x" }, fake).sync(undefined, 1000);
  assert.match(decodeURIComponent(urls[1]!), /"ephemeral":\{"types":\[\]\}/);
  process.env.COMMS_RECEIPTS_ENABLED = "true";

  const raw = { next_batch: "s", rooms: { join: { "!r:hs": { ephemeral: { events: [
    { type: "m.receipt", content: { $m1: { "m.read": { [ALEX]: { ts: 5 } } } } },
    { type: "m.typing", content: { user_ids: [ALEX] } },
  ] } } } } };
  const sync = parseSync(structuredClone(raw) as Parameters<typeof parseSync>[0]);
  assert.equal(sync.rooms[0]!.receipts!.length, 1);
  const published: Array<{ roomId: string; receipts?: unknown[] }> = [];
  await ingestMatrix({ sync: async () => sync }, { listNotes: async () => [], getNote: async () => { throw new Error("no"); }, createNote: async () => { throw new Error("no"); }, updateNote: async () => { throw new Error("no"); }, removeTags: async () => {} }, {
    publish: (b) => published.push(b),
  });
  assert.equal(published.length, 1);
  assert.equal(published[0]!.receipts!.length, 1);
  delete process.env.COMMS_RECEIPTS_ENABLED;
  assert.equal(parseSync(structuredClone(raw) as Parameters<typeof parseSync>[0]).rooms[0]!.receipts, undefined);
});

// ── live: a receipt batch updates the cached message, the page and the stream ─

const ROOM = "!live:hs";
const NOTE: Note = {
  id: "thread-note", content: "", path: "vault/messages/whatsapp/Alex", createdAt: "t", updatedAt: "u1", tags: ["message-thread"],
  metadata: { type: "message-thread", platform: "whatsapp", matrixRoomId: ROOM, lastMessageAt: ms(13), lastMessageText: "hello", lastMessageSender: ALEX, lastMessageIsSelf: false },
};
const PROFILES = { [ME]: { name: "Me", avatar: null }, [ALEX]: { name: "Alex", avatar: null } };
const ev = (id: string, n: number, sender: string, type: string, content: Record<string, unknown>): MatrixEvent =>
  ({ event_id: id, origin_server_ts: ms(n), sender, type, content }) as MatrixEvent;

async function liveSetup() {
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture" }));
  const reader: CommsReader = {
    whoami: async () => ME,
    memberProfiles: async () => PROFILES,
    timelinePage: async (_r, from) => from ? { chunk: [], start: from, end: null } : { chunk: [ev("$hello", 13, ALEX, "m.room.message", { msgtype: "m.text", body: "hello" }), ev("$mine", 12, ME, "m.room.message", { msgtype: "m.text", body: "hi" })], start: "s0", end: "tok" },
  };
  setCommsReaderForTests(() => reader);
  const project: ProjectDeps = {
    vault: { listByTag: async () => [NOTE] },
    reader: { whoami: async () => ME, roomState: async () => [] as never, memberProfiles: async () => PROFILES },
    people: peopleAdapter(new PeopleIndex([])),
  };
  const deps: LiveDeps = { project, getNote: async () => structuredClone(NOTE) };
  setLiveDepsForTests(async () => deps);
  const tid = await projectRoom(project, ROOM, NOTE);
  type Page = { messages: Array<{ id: string; delivery: string | null; readAt?: string; readBy?: { name: string }[] }> };
  const page = async () => (await (await app().request(`/api/comms/threads/${tid}/messages`, { headers: owner() })).json()) as Page;
  return { deps, tid, page };
}
const receipt = (eventId: string, user: string, n: number) => ({ type: "m.receipt", content: { [eventId]: { "m.read": { [user]: { ts: ms(n) } } } } }) as MatrixEvent;

test("live (review I1): receipts survive the queue merging batches for the same room", async () => {
  const { page } = await liveSetup();
  assert.equal((await page()).messages.find((m) => m.id === "$mine")!.delivery, "sent");
  startCommsLive();
  // Published in the same turn: the second (receipt-only) batch is merged into the waiting one.
  commsBus.publish({ roomId: ROOM, noteId: NOTE.id, events: [ev("$new", 21, ALEX, "m.room.message", { msgtype: "m.text", body: "later" })] });
  commsBus.publish({ roomId: ROOM, events: [], receipts: [receipt("$mine", ALEX, 20)] });
  await liveSettled();
  assert.equal(roomReaders(ROOM).length, 1, "the receipt was stored");
  const m = (await page()).messages.find((x) => x.id === "$mine")!;
  assert.equal(m.delivery, "read");
});

test("live (review I1): a receipt for a room not projected yet is still stored", async () => {
  const { deps } = await liveSetup();
  await handleLiveBatch(deps, { roomId: "!elsewhere:hs", events: [], receipts: [receipt("$x", ALEX, 20)] });
  assert.deepEqual(roomReaders("!elsewhere:hs").map((r) => r.userId), [ALEX]);
});

test("live (review M3): the owner's own bridge ghost reading is never 'the other side read it'", async () => {
  const { deps, page } = await liveSetup();
  await page();
  const GHOST = "@whatsapp_owner:hs";
  db.prepare(`INSERT INTO comms_owner_senders (mxid, source, stats_json) VALUES (?, 'detected', NULL)`).run(GHOST);
  await handleLiveBatch(deps, { roomId: ROOM, events: [], receipts: [receipt("$mine", GHOST, 20)] });
  assert.deepEqual(roomReaders(ROOM), []);
  assert.equal((await page()).messages.find((x) => x.id === "$mine")!.delivery, "sent");
});

test("receipts (review M1): a receipt stored before its event was known uses the event's time once the page has it", () => {
  // Stored with no event time (event unknown then), received at minute 9.
  recordReceipts("!m1", [{ eventId: "$old", userId: ALEX, ts: ms(9) }], ctx());
  // The page holds that event (minute 1) and a later owner message (minute 5): only the first is read.
  const out = withReadState([mine("$old", 1), mine("$m5", 5)], "!m1");
  assert.deepEqual(out.map((m) => m.delivery), ["read", "sent"]);
});

test("live: an m.receipt batch marks the owner's message read — window stays warm, no Matrix read, frame carries the state", async () => {
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture" }));
  let reads = 0;
  const reader: CommsReader = {
    whoami: async () => ME,
    memberProfiles: async () => PROFILES,
    timelinePage: async (_r, from) => { reads++; return from ? { chunk: [], start: from, end: null } : { chunk: [ev("$hello", 13, ALEX, "m.room.message", { msgtype: "m.text", body: "hello" }), ev("$mine", 12, ME, "m.room.message", { msgtype: "m.text", body: "hi" })], start: "s0", end: "tok" }; },
  };
  setCommsReaderForTests(() => reader);
  const project: ProjectDeps = {
    vault: { listByTag: async () => [NOTE] },
    reader: { whoami: async () => ME, roomState: async () => [] as never, memberProfiles: async () => PROFILES },
    people: peopleAdapter(new PeopleIndex([])),
  };
  const deps: LiveDeps = { project, getNote: async () => structuredClone(NOTE) };
  const tid = await projectRoom(project, ROOM, NOTE);
  type Page = { messages: Array<{ id: string; delivery: string | null; readAt?: string; readBy?: { name: string }[] }> };
  const page = async () => (await (await app().request(`/api/comms/threads/${tid}/messages`, { headers: owner() })).json()) as Page;
  assert.equal((await page()).messages.find((m) => m.id === "$mine")!.delivery, "sent");
  assert.equal(reads, 1);
  const start = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM comms_events`).get() as { m: number }).m;
  await handleLiveBatch(deps, { roomId: ROOM, events: [], receipts: [
    { type: "m.receipt", content: { $mine: { "m.read": { [ALEX]: { ts: ms(20) }, [ME]: { ts: ms(20) } } } } } as MatrixEvent,
  ] });
  const evs = eventsAfter(start, 10).filter((e) => e.kind !== "thread.updated");
  assert.deepEqual(evs.map((e) => [e.kind, (e.payload as { message: { id: string } }).message.id]), [["message.updated", "$mine"]]);
  const p = await page();
  assert.equal(reads, 1, "served from the warm window");
  const m = p.messages.find((x) => x.id === "$mine")!;
  assert.equal(m.delivery, "read");
  assert.equal(m.readAt, at(20));
  assert.deepEqual(m.readBy!.map((r) => r.name), ["Alex"]);
  assert.equal(p.messages.find((x) => x.id === "$hello")!.delivery, null);
  // The same receipt again: nothing new is announced.
  const mark = (db.prepare(`SELECT MAX(id) AS m FROM comms_events`).get() as { m: number }).m;
  await handleLiveBatch(deps, { roomId: ROOM, events: [], receipts: [{ type: "m.receipt", content: { $mine: { "m.read": { [ALEX]: { ts: ms(20) } } } } } as MatrixEvent] });
  assert.equal(eventsAfter(mark, 10).filter((e) => e.kind !== "thread.updated").length, 0);
  // The stream projects the state at send time.
  const res = await app().request("/api/comms/stream", { headers: owner({ "Last-Event-ID": String(start) }) });
  const r = res.body!.getReader();
  let buf = "";
  while (!buf.includes("message.updated")) buf += new TextDecoder().decode((await r.read()).value);
  while (!/message\.updated\ndata: .*\n\n/.test(buf)) buf += new TextDecoder().decode((await r.read()).value);
  await r.cancel();
  const data = JSON.parse(/event: message\.updated\ndata: (.*)\n/.exec(buf)![1]!) as { message: { delivery: string; readAt: string } };
  assert.equal(data.message.delivery, "read");
  assert.equal(data.message.readAt, at(20));
});
