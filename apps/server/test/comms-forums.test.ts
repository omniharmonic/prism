// Telegram forums in Comms (comms/forums.ts): one thread per forum, topics as sub-conversations,
// thread-level state on the forum, the migration of per-topic threads, "All topics" paging, sending
// to a concrete topic, unread sums, live batches and notifications. Synthetic data only: fake
// homeserver reader, fake send client, fake vault — nothing reaches a network.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, resolveVaultEntry } from "../src/db";
import { putSecret } from "../src/secrets";
import { issueDeviceToken } from "../src/auth/device";
import { clearRateLimitsForTests } from "../src/middleware/ratelimit";
import { setMatrixActionClientForTests } from "../src/actions/matrix";
import { rebuildProjection, conversationIdFor, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { PeopleIndex } from "../src/worker/people";
import { appendEvent, getThread, listThreads, setOverride, unreadSummary, statusCounts } from "../src/comms/store";
import { forumThreadId, forumTopics, resolveThreadRedirect, topicCacheId } from "../src/comms/forums";
import { setCommsReaderForTests, type CommsReader } from "../src/comms/timeline";
import { setCommsSendClientForTests, type CommsSendClient } from "../src/comms/send";
import { storeOwnerSenders } from "../src/comms/owner";
import { handleLiveBatch, type LiveDeps } from "../src/comms/live";
import { _resetNotifyForTests, buildCommsNotification, blocked, decideOnArrival, flush, processEvents, setNotifyDepsForTests } from "../src/comms/notify";
import { _resetNotifySettingsForTests, updateNotifySettings } from "../src/comms/notify-settings";
import { DEFAULT_NOTIFY_SETTINGS } from "../src/comms/notify-settings";
import { setReceiptSenderForTests, _resetReceiptMemoryForTests } from "../src/comms/read-state";
import { setStatusVaultForTests, setThreadStatus, undoThreadStatus } from "../src/comms/thread-actions";
import type { MatrixEvent } from "../src/worker/matrix";
import type { Note } from "../src/parachute";
import type { Message } from "../src/comms/types";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const ME = "@me:hs";
const ANN = "@telegram_11:hs";
const BO = "@telegram_12:hs";
const FORUM = { id: "channel:1001:-1", displayname: "Treegens DAO", avatar_url: "mxc://hs/forum" };
const T = { general: "!t1:hs", dev: "!t2:hs", random: "!t3:hs" } as const;
const GROUP = "!g:hs";
const TOPIC_IDS: Record<string, string> = { [T.general]: "1", [T.dev]: "7", [T.random]: "9" };
const TOPIC_NAMES: Record<string, string> = { [T.general]: "General", [T.dev]: "Dev", [T.random]: "Random" };
const ts = (n: number) => 1_790_000_000_000 + n * 60_000;
const iso = (n: number) => new Date(ts(n)).toISOString();

/** m.bridge + m.room.name state. `forum` false = a build before forum detection (no parent section, no topic id). */
const topicState = (room: string, forum = true): MatrixEvent[] => [
  { type: "m.room.name", state_key: "", content: { name: TOPIC_NAMES[room] } },
  ...(forum ? [{ type: "m.bridge", state_key: "x", content: { protocol: { id: "telegram" }, channel: { id: `channel:1001:${TOPIC_IDS[room]}`, displayname: TOPIC_NAMES[room] }, network: FORUM } }] : []),
] as MatrixEvent[];
const groupState: MatrixEvent[] = [
  { type: "m.room.name", state_key: "", content: { name: "Crew" } },
  { type: "m.bridge", state_key: "x", content: { protocol: { id: "telegram" }, channel: { id: "channel:2002", displayname: "Crew" } } },
] as MatrixEvent[];

const note = (id: string, room: string, at: number, text: string, tags = ["message-thread"]): Note => ({
  id, content: "", path: `Messages/${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags,
  metadata: { type: "message-thread", matrixRoomId: room, lastMessageAt: ts(at), lastMessageText: text, lastMessageSender: ANN, lastMessageIsSelf: false },
});
const NOTES = (tags: Record<string, string[]> = {}): Note[] => [
  note("n-gen", T.general, 10, "gm all", tags["n-gen"]),
  note("n-dev", T.dev, 11, "PR is up", tags["n-dev"]),
  note("n-rnd", T.random, 9, "lol", tags["n-rnd"]),
  note("n-grp", GROUP, 5, "see you", tags["n-grp"]),
];
const PROFILES = { [ME]: { name: "Me", avatar: null }, [ANN]: { name: "Ann Lee", avatar: null }, [BO]: { name: "Bo", avatar: null }, "@telegram_13:hs": { name: "Cy", avatar: null }, "@telegrambot:hs": { name: "bot", avatar: null } };

function deps(notes: Note[], forum = true): ProjectDeps {
  return {
    vault: { listByTag: async (tag) => notes.filter((n) => n.tags?.includes(tag)) },
    reader: {
      whoami: async () => ME,
      roomState: async (r) => (r === GROUP ? groupState : topicState(r, forum)) as never,
      memberProfiles: async () => PROFILES,
    },
    people: peopleAdapter(new PeopleIndex([])),
  };
}

// ── per-room timelines (fake homeserver) ──────────────────────────────────────
/** Messages per topic, by minute: merged they are 1..11, each minute once. */
const MINUTES: Record<string, number[]> = { [T.general]: [1, 4, 7, 10], [T.dev]: [2, 5, 8, 11], [T.random]: [3, 6, 9] };
const textEv = (room: string, n: number, sender = ANN): MatrixEvent =>
  ({ event_id: `$m${n}`, origin_server_ts: ts(n), sender, type: "m.room.message", content: { msgtype: "m.text", body: `msg ${n} in ${TOPIC_NAMES[room]}` } }) as MatrixEvent;
let pageReads: Array<{ room: string; from?: string }>;
const reader = (): CommsReader => ({
  whoami: async () => ME,
  memberProfiles: async () => PROFILES,
  timelinePage: async (room, from, limit = 50) => {
    pageReads.push({ room, ...(from ? { from } : {}) });
    const all = [...(MINUTES[room] ?? [])].sort((a, b) => b - a).map((n) => textEv(room, n));
    const off = from ? Number(from.split("|")[1]) : 0;
    const chunk = all.slice(off, off + limit);
    const end = off + limit < all.length ? `${room}|${off + limit}` : null;
    return { chunk, start: from ?? "s0", end };
  },
});

const envKeys = ["COMMS_ENABLED", "COMMS_SEND_ENABLED", "COMMS_FOLDERS_ENABLED", "COMMS_THREAD_ACTIONS_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};
const savedMatrixFlag = config.actionsMatrixEnabled;
const logs = { warn: console.warn, log: console.log };
beforeEach(() => {
  resetDb();
  for (const k of envKeys) saved[k] = process.env[k];
  process.env.COMMS_ENABLED = "true";
  process.env.COMMS_SEND_ENABLED = "true";
  process.env.COMMS_FOLDERS_ENABLED = "true";
  process.env.COMMS_THREAD_ACTIONS_ENABLED = "true";
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = true;
  clearRateLimitsForTests("comms");
  clearRateLimitsForTests("actions");
  pageReads = [];
  setCommsReaderForTests(() => reader());
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://hs.example.test", accessToken: "stub-matrix-token" }));
  console.warn = console.log = () => {};
});
afterEach(() => {
  Object.assign(console, logs);
  for (const k of envKeys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = savedMatrixFlag;
  setCommsReaderForTests(null);
  setCommsSendClientForTests(null);
  setStatusVaultForTests(null);
});

const FT = forumThreadId("telegram:channel:1001");
const topicConv = (room: string) => conversationIdFor(room);
const oldThread = (room: string) => `th_${topicConv(room)}`;
const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const device = () => ({ authorization: `Bearer ${issueDeviceToken(config.ownerEmail, "Comms (test)", "comms-native").token}` });
const get = async (path: string) => {
  const r = await createApp().request(path, { headers: owner() });
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (path: string, body: unknown, headers: Record<string, string> = device()) => {
  const r = await createApp().request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

// ── projection ────────────────────────────────────────────────────────────────

test("a forum's topics project as ONE thread (forum name + avatar, newest topic's preview, sums); a plain Telegram group is unaffected", async () => {
  await rebuildProjection(deps(NOTES()));
  const list = listThreads({ limit: 50 }).threads;
  assert.equal(list.length, 2, "forum + group, no per-topic rows");
  const f = list.find((t) => t.id === FT)!;
  assert.ok(f, "the forum thread lists");
  assert.equal(f.title, "Treegens DAO");
  assert.deepEqual(f.avatar, { mxc: "mxc://hs/forum" });
  assert.equal(f.kind, "group");
  assert.deepEqual(f.networks, ["telegram"]);
  assert.equal(f.lastActivityAt, iso(11), "lastActivity = the newest topic");
  assert.equal(f.lastMessage?.text, "Dev · Ann: PR is up", "Topic · sender: text");
  assert.deepEqual(f.unread, { count: 3, trusted: false }, "the topics' guesses summed");
  assert.deepEqual(f.forum, { topicCount: 3 });
  assert.equal(f.noteId, "n-dev", "the newest topic's note (Status is offered)");
  // The plain supergroup is its own thread as before.
  const g = list.find((t) => t.id === `th_${conversationIdFor(GROUP)}`)!;
  assert.equal(g.title, "Crew");
  assert.equal(g.lastMessage?.text, "Ann: see you");
  assert.equal(g.forum, undefined);
  // Topics, newest first; each the topic room's own title.
  assert.deepEqual(forumTopics(FT).map((t) => [t.title, t.topicId]), [["Dev", "7"], ["General", "1"], ["Random", "9"]]);
  // Counts count the forum once.
  assert.equal(Object.values(statusCounts()).reduce((a, b) => a + b, 0), 2);
  assert.equal(unreadSummary().threads, 2);
  // The topic notes find the forum (Prism web opens a topic note).
  assert.deepEqual(listThreads({ limit: 5, noteId: "n-rnd" }).threads.map((t) => t.id), [FT]);
  // Idempotent: a second rebuild changes nothing.
  const snap = () => JSON.stringify([db.prepare("SELECT * FROM comms_conversations ORDER BY id").all(), db.prepare("SELECT * FROM comms_thread_members ORDER BY thread_id, conversation_id").all()]);
  const a = snap();
  await rebuildProjection(deps(NOTES()));
  assert.equal(snap(), a);
});

test("forum status = its most pressing topic's; Handled only when every topic is", async () => {
  await rebuildProjection(deps(NOTES({ "n-gen": ["message-thread", "handled"], "n-dev": ["message-thread", "informational"], "n-rnd": ["message-thread", "urgent"] })));
  assert.equal(getThread(FT)?.status, "urgent");
  await rebuildProjection(deps(NOTES({ "n-gen": ["message-thread", "handled"], "n-dev": ["message-thread", "handled"], "n-rnd": ["message-thread", "handled"] })));
  assert.equal(getThread(FT)?.status, "handled");
});

// ── migration ─────────────────────────────────────────────────────────────────

function folder(id: string, name: string): void {
  db.prepare(`INSERT INTO comms_folders (id, name, position, created_at, updated_at) VALUES (?, ?, 0, 0, 0)`).run(id, name);
}
const inFolder = (f: string, t: string) => db.prepare(`INSERT INTO comms_folder_members (folder_id, thread_id, added_at) VALUES (?, ?, 0)`).run(f, t);

test("migration: per-topic threads merge into the forum (archived only when every topic was, pins, folders, read marker) and their ids redirect", async () => {
  // A build from before grouping: one thread per topic.
  await rebuildProjection(deps(NOTES(), false));
  assert.equal(listThreads({ limit: 50 }).threads.length, 4);
  for (const r of [T.general, T.dev, T.random]) setOverride(oldThread(r), { archived: true });
  setOverride(oldThread(T.general), { muted: true });
  db.prepare(`UPDATE comms_threads SET o_pinned = 1, o_pin_order = 3 WHERE id = ?`).run(oldThread(T.dev));
  folder("f1", "Work"); folder("f2", "DAO");
  inFolder("f1", oldThread(T.general)); inFolder("f2", oldThread(T.dev));
  db.prepare(`INSERT INTO comms_read_markers (thread_id, read_at, manual_unread, updated_at) VALUES (?, ?, 0, 0), (?, ?, 0, 0)`).run(oldThread(T.general), iso(10), oldThread(T.random), iso(9));
  db.prepare(`INSERT INTO comms_search_rows (dedupe_key, origin, thread_id, sender_name, sent_at) VALUES ('k1', 'live', ?, 'Ann', 1)`).run(oldThread(T.dev));

  await rebuildProjection(deps(NOTES()));
  const f = getThread(FT)!;
  assert.equal(f.folder, "archived", "every topic was archived → the forum is");
  assert.equal(f.muted, false, "only one topic was muted");
  assert.equal(f.pinned, false, "an archived forum holds no pin (as an archived thread never does)");
  assert.deepEqual(f.folderIds, ["f1", "f2"], "folders united");
  // Read state per topic: each old marker is its topic's read point; the forum's marker is the oldest.
  assert.equal((db.prepare(`SELECT read_at FROM comms_read_markers WHERE thread_id = ?`).get(FT) as { read_at: string }).read_at, iso(9), "the oldest marker");
  assert.equal((db.prepare(`SELECT read_at FROM comms_topic_read_markers WHERE cache_id = ?`).get(oldThread(T.general)) as { read_at: string }).read_at, iso(10));
  assert.equal((db.prepare(`SELECT read_at FROM comms_topic_read_markers WHERE cache_id = ?`).get(oldThread(T.random)) as { read_at: string }).read_at, iso(9));
  // Every per-topic thread's state is recorded for recovery (review I-3).
  const log = db.prepare(`SELECT old_thread_id, state_json FROM comms_forum_merge_log WHERE forum_thread_id = ?`).all(FT) as { old_thread_id: string; state_json: string }[];
  assert.equal(log.length, 3);
  const gen = JSON.parse(log.find((l) => l.old_thread_id === oldThread(T.general))!.state_json);
  assert.deepEqual({ archived: gen.archived, muted: gen.muted, folderIds: gen.folderIds, readAt: gen.readMarker.read_at }, { archived: 1, muted: 1, folderIds: ["f1"], readAt: iso(10) });
  assert.equal((db.prepare(`SELECT thread_id FROM comms_search_rows WHERE dedupe_key = 'k1'`).get() as { thread_id: string }).thread_id, FT, "search hits link the forum");
  // The old ids are gone from every table and redirect.
  for (const r of [T.general, T.dev, T.random]) {
    assert.equal(getThread(oldThread(r)), null);
    assert.equal(resolveThreadRedirect(oldThread(r)), FT);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM comms_folder_members WHERE thread_id = ?`).get(oldThread(r)) as { n: number }).n, 0);
  }
  // Open clients / deep links: an old id answers with the forum thread; actions act on it.
  const old = await get(`/api/comms/threads/${oldThread(T.dev)}`);
  assert.equal(old.status, 200);
  assert.equal(old.body.thread.id, FT);
  const unarchive = await post(`/api/comms/threads/${oldThread(T.dev)}/archive`, { archived: false });
  assert.equal(unarchive.status, 200);
  assert.equal(getThread(FT)?.folder, "inbox");
  // Announced: each old id and one list-wide refresh.
  const events = db.prepare(`SELECT thread_id, payload_json FROM comms_events WHERE kind = 'thread.updated'`).all() as { thread_id: string | null; payload_json: string }[];
  assert.ok(events.some((e) => e.thread_id === oldThread(T.random)));
  assert.ok(events.some((e) => e.thread_id === null && JSON.parse(e.payload_json).reason === "forums"));
  // A later rebuild merges nothing more and keeps the owner's choice (unarchived) — archiving then sticks.
  await rebuildProjection(deps(NOTES()));
  assert.equal(getThread(FT)?.folder, "inbox");
  await post(`/api/comms/threads/${FT}/archive`, { archived: true });
  await rebuildProjection(deps(NOTES()));
  assert.equal(getThread(FT)?.folder, "archived", "archiving the forum sticks across rebuilds");
  assert.equal(listThreads({ limit: 50, folder: "inbox" }).threads.length, 1, "inbox: the group only");
});

test("migration: one topic not archived → the forum is not archived; muted only when every topic was", async () => {
  await rebuildProjection(deps(NOTES(), false));
  setOverride(oldThread(T.general), { archived: true, muted: true });
  setOverride(oldThread(T.dev), { archived: true, muted: true });
  setOverride(oldThread(T.random), { muted: true });
  db.prepare(`UPDATE comms_threads SET o_pinned = 1, o_pin_order = 2 WHERE id = ?`).run(oldThread(T.random));
  await rebuildProjection(deps(NOTES()));
  const f = getThread(FT)!;
  assert.equal(f.folder, "inbox");
  assert.equal(f.muted, true);
  assert.equal(f.pinned, true, "pinned when any topic was");
  assert.equal(f.pinOrder, 2);
});

// ── timeline ──────────────────────────────────────────────────────────────────

test("All topics: every message once, newest last, each tagged with its topic, paged across topics; one topic alone", async () => {
  await rebuildProjection(deps(NOTES()));
  const seen: number[] = [];
  let cursor: string | null = null;
  const pages: number[][] = [];
  for (let i = 0; i < 10; i++) {
    const r = await get(`/api/comms/threads/${FT}/messages?limit=3${cursor ? `&before=${cursor}` : ""}`);
    assert.equal(r.status, 200);
    const mins = (r.body.messages as Array<{ id: string; threadId: string; topic: { id: string; title: string }; body: { plain: string } }>).map((m) => {
      assert.equal(m.threadId, FT);
      assert.ok(m.body.plain.endsWith(m.topic.title), "tagged with the topic it came from");
      return Number(m.id.slice(2));
    });
    pages.push(mins);
    seen.push(...mins);
    cursor = r.body.before;
    if (!r.body.hasMore) break;
  }
  assert.deepEqual(pages, [[9, 10, 11], [6, 7, 8], [3, 4, 5], [1, 2]]);
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  // One topic: its own messages only, its own cursor.
  const dev = forumTopics(FT).find((t) => t.title === "Dev")!;
  const one = await get(`/api/comms/threads/${FT}/messages?topic=${dev.id}&limit=2`);
  assert.deepEqual(one.body.messages.map((m: { id: string }) => m.id), ["$m8", "$m11"]);
  const two = await get(`/api/comms/threads/${FT}/messages?topic=${dev.id}&limit=2&before=${one.body.before}`);
  assert.deepEqual(two.body.messages.map((m: { id: string }) => m.id), ["$m2", "$m5"]);
  // By Telegram's topic id too; unknown / malformed topics are refused.
  assert.equal((await get(`/api/comms/threads/${FT}/messages?topic=7&limit=1`)).body.messages[0].id, "$m11");
  assert.equal((await get(`/api/comms/threads/${FT}/messages?topic=nope`)).status, 404);
  assert.equal((await get(`/api/comms/threads/${FT}/messages?topic=a%20b`)).status, 400);
  // An All cursor is not a topic cursor.
  const all = await get(`/api/comms/threads/${FT}/messages?limit=3`);
  assert.equal((await get(`/api/comms/threads/${FT}/messages?topic=${dev.id}&before=${all.body.before}`)).status, 400);
});

test("All topics reads only the topics that can reach the page (a quiet topic is not read for the newest page)", async () => {
  await rebuildProjection(deps(NOTES()));
  MINUTES[T.random] = [3, 6, 9];
  // Make Random clearly older: its note says minute 1.
  db.prepare(`UPDATE comms_conversations SET last_event_at = ? WHERE id = ?`).run(iso(1), topicConv(T.random));
  pageReads = [];
  const r = await get(`/api/comms/threads/${FT}/messages?limit=2`);
  assert.deepEqual(r.body.messages.map((m: { id: string }) => m.id), ["$m10", "$m11"]);
  assert.ok(!pageReads.some((p) => p.room === T.random), "the quiet topic was not read");
});

// ── thread detail, read state ─────────────────────────────────────────────────

test("thread detail lists topics with unread per topic; the forum's unread is the sum after its read marker", async () => {
  await rebuildProjection(deps(NOTES()));
  // Fill each topic's window.
  for (const t of forumTopics(FT)) await get(`/api/comms/threads/${FT}/messages?topic=${t.id}`);
  const read = await post(`/api/comms/threads/${FT}/read`, { upTo: iso(8) });
  assert.equal(read.status, 200);
  const d = await get(`/api/comms/threads/${FT}`);
  const byTitle = Object.fromEntries(d.body.topics.map((t: { title: string; unread: number }) => [t.title, t.unread]));
  assert.deepEqual(byTitle, { General: 1, Dev: 1, Random: 1 }, "after minute 8: 10, 11, 9");
  assert.equal(d.body.thread.unread.count, 3);
  assert.equal(d.body.thread.unread.trusted, true);
  assert.equal(d.body.topics[0].title, "Dev", "newest first");
  // Reading the forum reads every topic.
  await post(`/api/comms/threads/${FT}/read`, {});
  assert.equal(getThread(FT)?.unread.count, 0);
  assert.equal((await get(`/api/comms/threads/${FT}`)).body.topics.every((t: { unread: number }) => t.unread === 0), true);
});

// ── sending ───────────────────────────────────────────────────────────────────

test("sending into a forum needs a concrete topic (never All) and goes to that topic's room", async () => {
  await rebuildProjection(deps(NOTES()));
  const sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
  const fake: Partial<CommsSendClient> = {
    async sendEvent(roomId, _type, _txn, content) { sent.push({ roomId, content }); return `$sent${sent.length}`; },
    async joinedRooms() { return [T.general, T.dev, T.random, GROUP]; },
    async whoamiInfo() { return { userId: ME, deviceId: "D1" }; },
    async roomEncrypted() { return false; },
    async memberProfiles() { return PROFILES; },
    async eventExists() { return true; },
    async mediaConfig() { return null; },
  };
  setCommsSendClientForTests(() => fake as CommsSendClient);
  setMatrixActionClientForTests(null);
  storeOwnerSenders([]);
  const send = (body: Record<string, unknown>) => post(`/api/comms/threads/${FT}/messages`, { clientId: crypto.randomUUID(), text: "hello", ...body });

  const none = await send({});
  assert.equal(none.status, 422);
  assert.equal(none.body.error, "topic_required");
  const unknown = await send({ topic: "zzzzzzzzzzzzzzzzzzzz" });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error, "topic_required");
  assert.equal((await send({ topic: "all" })).body.error, "topic_required", "All is not a topic");
  assert.equal(sent.length, 0, "nothing sent without a concrete topic");

  const dev = forumTopics(FT).find((t) => t.title === "Dev")!;
  const ok = await send({ topic: dev.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(sent.map((s) => s.roomId), [T.dev]);
  // By Telegram topic id as well; via an old per-topic id too (redirect).
  assert.equal((await send({ topic: "1" })).status, 200);
  assert.equal(sent[1]!.roomId, T.general);
  // Attachments: the topic is a query parameter (checked before the upload is read).
  const fd = new FormData();
  fd.append("clientId", crypto.randomUUID());
  fd.append("kind", "file");
  fd.append("file", new Blob([Buffer.from("%PDF-1.7\n")], { type: "application/pdf" }), "a.pdf");
  const att = await createApp().request(`/api/comms/threads/${FT}/attachments`, { method: "POST", headers: device(), body: fd });
  assert.equal(att.status, 422);
  assert.equal(((await att.json()) as { error: string }).error, "topic_required");
  // A plain group is unaffected (no topic needed).
  assert.equal((await post(`/api/comms/threads/th_${conversationIdFor(GROUP)}/messages`, { clientId: crypto.randomUUID(), text: "hi" })).status, 200);
});

// ── live + notifications ──────────────────────────────────────────────────────

test("live: a topic's batch is announced under the forum thread (topic-tagged, per-topic cache) and keeps that window warm", async () => {
  await rebuildProjection(deps(NOTES()));
  const gen = forumTopics(FT).find((t) => t.title === "General")!;
  await get(`/api/comms/threads/${FT}/messages?topic=${gen.id}`);
  const notes = new Map(NOTES().map((n) => [n.id, n]));
  const live: LiveDeps = { project: deps(NOTES()), getNote: async (id) => notes.get(id) ?? null };
  pageReads = [];
  MINUTES[T.general] = [1, 4, 7, 10, 12];
  await handleLiveBatch(live, { roomId: T.general, noteId: "n-gen", events: [textEv(T.general, 12, BO)] });
  const ev = db.prepare(`SELECT thread_id, cache_id, payload_json FROM comms_events WHERE kind = 'message.created' ORDER BY id DESC LIMIT 1`).get() as { thread_id: string; cache_id: string; payload_json: string };
  assert.equal(ev.thread_id, FT);
  assert.equal(ev.cache_id, topicCacheId(gen.id));
  const m = JSON.parse(ev.payload_json).message as Message;
  assert.equal(m.threadId, FT);
  assert.deepEqual(m.topic, { id: gen.id, title: "General" });
  // Warm: the topic page answers from the window, no homeserver read.
  const r = await get(`/api/comms/threads/${FT}/messages?topic=${gen.id}&limit=1`);
  assert.equal(r.body.messages[0].id, "$m12");
  assert.equal(pageReads.length, 0);
  MINUTES[T.general] = [1, 4, 7, 10];

  // Notifications: the forum's state decides; the alert names the topic.
  const thread = getThread(FT)!;
  const n = buildCommsNotification(thread, m, 1, DEFAULT_NOTIFY_SETTINGS, 0);
  const alert = (n.payload.aps as { alert: Record<string, string> }).alert;
  assert.equal(n.threadId, FT);
  assert.deepEqual(alert, { title: "Treegens DAO", subtitle: "General · Bo", body: "msg 12 in General" });
  assert.equal(blocked({ ...DEFAULT_NOTIFY_SETTINGS, enabled: true }, thread, m), false);
  await post(`/api/comms/threads/${FT}/mute`, { muted: true });
  assert.equal(blocked({ ...DEFAULT_NOTIFY_SETTINGS, enabled: true }, getThread(FT)!, m), true, "muting the forum silences every topic");
});

// ── status ────────────────────────────────────────────────────────────────────

test("setting the forum's status writes every topic note; one Undo reverts them all", async () => {
  await rebuildProjection(deps(NOTES({ "n-gen": ["message-thread", "urgent"], "n-dev": ["message-thread", "informational"], "n-rnd": ["message-thread"] })));
  const tags = new Map<string, string[]>([["n-gen", ["message-thread", "urgent"]], ["n-dev", ["message-thread", "informational"]], ["n-rnd", ["message-thread"]]]);
  const writes: string[] = [];
  setStatusVaultForTests(() => ({
    getNote: async (id) => ({ id, tags: tags.get(id) ?? [], content: "", path: id, metadata: {}, createdAt: "", updatedAt: "" }) as Note,
    updateNote: async (id, p) => {
      writes.push(id);
      const cur = new Set(tags.get(id) ?? []);
      for (const t of p.tags?.remove ?? []) cur.delete(t);
      for (const t of p.tags?.add ?? []) cur.add(t);
      tags.set(id, [...cur]);
      return { id, tags: [...cur] } as Note;
    },
  }));
  assert.equal(getThread(FT)?.status, "urgent");
  const r = await setThreadStatus("v", FT, "handled");
  assert.deepEqual(writes.sort(), ["n-dev", "n-gen", "n-rnd"]);
  assert.equal(r.thread.status, "handled");
  assert.equal(r.undo?.status, "urgent");
  await undoThreadStatus("v", FT, r.undo!.id);
  assert.equal(getThread(FT)?.status, "urgent");
  assert.deepEqual(tags.get("n-dev")?.sort(), ["informational", "message-thread"]);
});

// ── archive (controller ruling 2026-11-23) ─────────────────────────────────────

test("an archived forum stays archived when a topic gets a new message, and never pushes; a plain group still comes back", async () => {
  await rebuildProjection(deps(NOTES()));
  const GT = `th_${conversationIdFor(GROUP)}`;
  await post(`/api/comms/threads/${FT}/archive`, { archived: true });
  await post(`/api/comms/threads/${GT}/archive`, { archived: true });
  const later = new Date(Date.now() + 60_000).toISOString();
  const incoming = (threadId: string, id: string, topic?: { id: string; title: string }): Message => ({
    id, threadId, channel: { network: "telegram", accountLabel: null }, source: { network: "telegram", eventId: id, ref: id },
    sender: { id: ANN, name: "Ann Lee", avatar: null, isSelf: false, isOmni: false }, sentAt: later,
    body: { plain: "news", spans: [] } as unknown as Message["body"], attachments: [], linkPreviews: [], reactions: [],
    delivery: null, redacted: false, ...(topic ? { topic } : {}),
  });
  const gen = forumTopics(FT).find((t) => t.title === "General")!;

  // Notifications on, every message would notify (folder rule "all" equivalent: unclassified on).
  const prevNotify = process.env.COMMS_NOTIFY_ENABLED;
  process.env.COMMS_NOTIFY_ENABLED = "true";
  _resetNotifySettingsForTests();
  updateNotifySettings({ statuses: { unclassified: true } } as never);
  const sent: unknown[] = [];
  setNotifyDepsForTests({
    devices: () => [{ token: "ab".repeat(32), environment: "production", application: "comms" }],
    send: async (_r, n) => { sent.push(n); return { outcome: "sent", status: 200, reason: "" }; },
    enabled: () => true,
  });
  _resetNotifyForTests();
  try {
    const fm = incoming(FT, "$f1", { id: gen.id, title: gen.title });
    appendEvent("message.created", FT, { threadId: FT, message: fm }, topicCacheId(gen.id));
    assert.equal(getThread(FT)?.folder, "archived", "a forum stays archived");
    assert.equal(decideOnArrival({ ...DEFAULT_NOTIFY_SETTINGS, enabled: true, statuses: { ...DEFAULT_NOTIFY_SETTINGS.statuses, unclassified: true } }, getThread(FT)!, fm), "never");
    await processEvents();
    await flush(FT);
    assert.equal(sent.length, 0, "no push while the forum is archived");

    appendEvent("message.created", GT, { threadId: GT, message: incoming(GT, "$g1") });
    assert.equal(getThread(GT)?.folder, "inbox", "an ordinary group keeps the Messages rule (and comes back quietly)");

    // Only the owner's Unarchive brings the forum back.
    await post(`/api/comms/threads/${FT}/archive`, { archived: false });
    assert.equal(getThread(FT)?.folder, "inbox");
  } finally {
    setNotifyDepsForTests(null);
    _resetNotifyForTests();
    _resetNotifySettingsForTests();
    if (prevNotify === undefined) delete process.env.COMMS_NOTIFY_ENABLED; else process.env.COMMS_NOTIFY_ENABLED = prevNotify;
  }
});

// ── fix round 1 (forums-review.md) ────────────────────────────────────────────

function fakeSendClient(): Array<{ roomId: string; content: Record<string, unknown> }> {
  const sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
  const fake: Partial<CommsSendClient> = {
    async sendEvent(roomId, _type, _txn, content) { sent.push({ roomId, content }); return `$sent${sent.length}`; },
    async joinedRooms() { return [T.general, T.dev, T.random, GROUP]; },
    async whoamiInfo() { return { userId: ME, deviceId: "D1" }; },
    async roomEncrypted() { return false; },
    async memberProfiles() { return PROFILES; },
    async eventExists() { return true; },
    async mediaConfig() { return null; },
    async reactionsTo() { return []; },
  };
  setCommsSendClientForTests(() => fake as CommsSendClient);
  setMatrixActionClientForTests(null);
  storeOwnerSenders([]);
  return sent;
}

test("I-5: an old per-topic id means that topic — sends without a topic go there, a different declared topic is refused, its timeline is that topic", async () => {
  await rebuildProjection(deps(NOTES(), false));
  await rebuildProjection(deps(NOTES()));
  const sent = fakeSendClient();
  const dev = forumTopics(FT).find((t) => t.title === "Dev")!;
  const gen = forumTopics(FT).find((t) => t.title === "General")!;
  const viaOld = await post(`/api/comms/threads/${oldThread(T.dev)}/messages`, { clientId: crypto.randomUUID(), text: "from 0.3.5" });
  assert.equal(viaOld.status, 200, JSON.stringify(viaOld.body));
  assert.deepEqual(sent.map((s) => s.roomId), [T.dev], "the old id's own topic, never another");
  const mismatch = await post(`/api/comms/threads/${oldThread(T.dev)}/messages`, { clientId: crypto.randomUUID(), text: "x", topic: gen.id });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, "topic_mismatch");
  assert.equal((await post(`/api/comms/threads/${oldThread(T.dev)}/messages`, { clientId: crypto.randomUUID(), text: "y", topic: dev.id })).status, 200, "the same topic named explicitly");
  assert.equal(sent.length, 2, "nothing went out for the mismatch");
  // The forum id itself still needs a topic.
  assert.equal((await post(`/api/comms/threads/${FT}/messages`, { clientId: crypto.randomUUID(), text: "z" })).body.error, "topic_required");
  // An old id's timeline is that topic only.
  const page = await get(`/api/comms/threads/${oldThread(T.dev)}/messages?limit=50`);
  assert.deepEqual(page.body.messages.map((m: { id: string }) => m.id), ["$m2", "$m5", "$m8", "$m11"]);
});

test("C-1/I-2: a reply or a reaction is never re-routed — another topic's message under a declared topic is refused", async () => {
  await rebuildProjection(deps(NOTES()));
  const sent = fakeSendClient();
  const dev = forumTopics(FT).find((t) => t.title === "Dev")!;
  const gen = forumTopics(FT).find((t) => t.title === "General")!;
  for (const t of forumTopics(FT)) await get(`/api/comms/threads/${FT}/messages?topic=${t.id}`); // cache every window
  // $m10 is in General: replying to it while declaring Dev is refused, nothing sent.
  const wrong = await post(`/api/comms/threads/${FT}/messages`, { clientId: crypto.randomUUID(), text: "yes", replyTo: "$m10", topic: dev.id });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, "topic_mismatch");
  assert.equal(sent.length, 0);
  const right = await post(`/api/comms/threads/${FT}/messages`, { clientId: crypto.randomUUID(), text: "yes", replyTo: "$m10", topic: gen.id });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.deepEqual(sent.map((s) => s.roomId), [T.general]);
  const react = await post(`/api/comms/threads/${FT}/messages/$m10/reactions`, { clientId: crypto.randomUUID(), key: "👍", topic: dev.id });
  assert.equal(react.status, 409);
  assert.equal(react.body.error, "topic_mismatch");
});

test("I-4/m1: reading one topic moves only its read point; receipts name only that topic, once; the owner's word in one topic hides no other", async () => {
  await rebuildProjection(deps(NOTES()));
  for (const t of forumTopics(FT)) await get(`/api/comms/threads/${FT}/messages?topic=${t.id}`);
  const prev = process.env.COMMS_READ_RECEIPTS_ENABLED;
  process.env.COMMS_READ_RECEIPTS_ENABLED = "true";
  const receipts: Array<[string, string]> = [];
  setReceiptSenderForTests(async (room, ev) => { receipts.push([room, ev]); });
  _resetReceiptMemoryForTests();
  try {
    // A forum marker first (opening All Topics up to minute 6).
    await post(`/api/comms/threads/${FT}/read`, { upTo: iso(6) });
    const before = Object.fromEntries((await get(`/api/comms/threads/${FT}`)).body.topics.map((t: { title: string; unread: number }) => [t.title, t.unread]));
    assert.deepEqual(before, { Dev: 2, General: 2, Random: 1 }, "after minute 6: 8,11 · 7,10 · 9");
    const dev = forumTopics(FT).find((t) => t.title === "Dev")!;
    const r = await post(`/api/comms/threads/${FT}/read`, { topic: dev.id, explicit: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.receipt, "sent");
    assert.deepEqual(receipts, [[T.dev, "$m11"]], "one receipt, for the topic read");
    const after = Object.fromEntries((await get(`/api/comms/threads/${FT}`)).body.topics.map((t: { title: string; unread: number }) => [t.title, t.unread]));
    assert.deepEqual(after, { Dev: 0, General: 2, Random: 1 }, "other topics keep their unread");
    assert.equal(getThread(FT)?.unread.count, 3);
    // Reading the same topic again sends nothing more.
    await post(`/api/comms/threads/${FT}/read`, { topic: dev.id, explicit: true });
    assert.equal(receipts.length, 1);
    // A forum-wide read names only the topics it moved over (General, Random), not Dev again.
    await post(`/api/comms/threads/${FT}/read`, { explicit: true });
    assert.deepEqual(receipts.slice(1).map((x) => x[0]).sort(), [T.general, T.random].sort());
    // m1: the owner's own last word in General zeroes General only.
    await post(`/api/comms/threads/${FT}/unread`, {});
    db.prepare(`UPDATE comms_read_markers SET read_at = ?, manual_unread = 0 WHERE thread_id = ?`).run(iso(6), FT);
    db.prepare(`DELETE FROM comms_topic_read_markers`).run();
    db.prepare(`UPDATE comms_conversations SET last_preview_json = json_set(last_preview_json, '$.isSelf', json('true')) WHERE id = ?`).run(topicConv(T.general));
    const { refreshForumAggregate } = await import("../src/comms/store");
    refreshForumAggregate(db.prepare(`SELECT forum_id FROM comms_conversations WHERE id = ?`).pluck().get(topicConv(T.general)) as string);
    assert.equal(getThread(FT)?.unread.count, 3, "Dev 2 + Random 1 still unread");
  } finally {
    setReceiptSenderForTests(null);
    if (prev === undefined) delete process.env.COMMS_READ_RECEIPTS_ENABLED; else process.env.COMMS_READ_RECEIPTS_ENABLED = prev;
  }
});

test("I-1: an Omni draft binds the topic of the messages he pointed at, else the topic on screen; the draft names it", async () => {
  await rebuildProjection(deps(NOTES()));
  for (const t of forumTopics(FT)) await get(`/api/comms/threads/${FT}/messages?topic=${t.id}`);
  const prev = { o: process.env.OMNI_ENABLED, c: process.env.COMMS_OMNI_ENABLED };
  process.env.OMNI_ENABLED = "true";
  process.env.COMMS_OMNI_ENABLED = "true";
  try {
    const { assistPrompt, withCommsDraftContext } = await import("../src/comms/omni");
    const dev = forumTopics(FT).find((t) => t.title === "Dev")!;
    const gen = forumTopics(FT).find((t) => t.title === "General")!;
    // Newest topic is Dev (minute 11); he pointed at $m10 in General.
    assert.match(assistPrompt(FT, "reply", ["$m10"]), new RegExp(`"commsTopicId": "${gen.id}"`));
    assert.match(assistPrompt(FT, "reply", [], gen.id), new RegExp(`"roomId": "${T.general.replace(/[!$]/g, "\\$&")}"`));
    assert.match(assistPrompt(FT, "reply", []), new RegExp(`"commsTopicId": "${dev.id}"`), "nothing pointed at, no topic: the newest");
    const bound = withCommsDraftContext({ commsThreadId: FT, commsTopicId: gen.id, body: "On it" });
    assert.equal(bound.roomId, T.general);
    assert.equal(bound.commsTopicTitle, "General");
    assert.throws(() => withCommsDraftContext({ commsThreadId: FT, commsTopicId: gen.id, roomId: T.dev, body: "x" }), /roomId/);
    const { validatePayload } = await import("../src/omni/approvals");
    assert.equal(validatePayload("message", { commsThreadId: FT, commsTopicId: gen.id, body: "x", extra: 1 }).payload.commsTopicId, gen.id, "a draft keeps its topic");
    assert.equal(validatePayload("message", { roomId: "!r:hs", commsTopicId: gen.id, body: "x" }).payload.commsTopicId, undefined, "only on a Comms draft");
  } finally {
    for (const [k, v] of [["OMNI_ENABLED", prev.o], ["COMMS_OMNI_ENABLED", prev.c]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("m3: state the owner set on the forum row before the first merge is kept", async () => {
  await rebuildProjection(deps(NOTES(), false));
  for (const r of [T.general, T.dev, T.random]) setOverride(oldThread(r), { archived: true });
  // The forum thread exists (a topic attached, the merge not run yet) and the owner muted it.
  const { attachTopic } = await import("../src/comms/forums");
  attachTopic(topicConv(T.general), { key: "telegram:channel:1001", name: "Treegens DAO", avatar: null, topicId: "1" }, "General");
  db.prepare(`UPDATE comms_threads SET o_muted = 1 WHERE id = ?`).run(FT);
  await rebuildProjection(deps(NOTES()));
  assert.equal(getThread(FT)?.muted, true, "the owner's mute on the forum survives the merge");
});
