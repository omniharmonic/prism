process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { addVaultEntry } from "../src/db";
import { startRebuild } from "../src/comms/project-deps";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const CAPS = "/api/integrations/comms/capabilities";
const prev = process.env.COMMS_ENABLED;
beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; });
afterEach(() => { if (prev === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prev; });
const get = (path = CAPS, email = config.ownerEmail, vault?: string) =>
  createApp().request(path, { headers: { cookie: sessionCookie(makeSession(email)), ...(vault ? { "X-Prism-Vault": vault } : {}) } });

test("comms disabled returns 404 comms_disabled", async () => {
  process.env.COMMS_ENABLED = "false";
  for (const path of [CAPS, "/api/comms/anything"]) {
    const r = await get(path);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "comms_disabled" });
  }
});

test("non-owner session gets 403", async () => {
  assert.equal((await get(CAPS, "stranger@test.local")).status, 403);
});

test("secondary vault gets 409 source_vault_unavailable", async () => {
  addVaultEntry({ id: "secondary", label: "Secondary", url: "https://other.example.test", vault: "second", token: "other-token" });
  const r = await get(CAPS, config.ownerEmail, "secondary");
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "source_vault_unavailable" });
});

test("owner gets capabilities exactly", async () => {
  const r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await r.json(), {
    integration: "comms", clientId: "comms-native", restricted: true, schemaVersions: [1],
    operations: ["threads:read", "messages:read", "media:read", "stream:read"],
    networks: ["whatsapp", "telegram", "discord", "messenger", "x", "signal", "slack", "instagram", "linkedin", "matrix", "imessage", "sms"],
    send: { enabled: false, maxAttachmentBytes: 50 * 1024 * 1024 },
    omni: { enabled: false },
  });
});

test("unmatched /api/comms path: owner 404 not_found (never the gateway), non-owner 403", async () => {
  const owner = await get("/api/comms/does-not-exist");
  assert.equal(owner.status, 404);
  assert.deepEqual(await owner.json(), { error: "not_found" });
  assert.equal((await get("/api/comms/does-not-exist", "stranger@test.local")).status, 403);
});

test("admin rebuild: Matrix not configured → synchronous 409 matrix_unavailable, nothing started", async () => {
  const r = await createApp().request("/api/comms/admin/rebuild", { method: "POST", headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "matrix_unavailable" });
  // nothing is in flight: a run started now is the first
  let release!: () => void;
  assert.deepEqual(startRebuild(() => new Promise((res) => { release = () => res(null); })), { started: true });
  release();
  await new Promise((res) => setTimeout(res, 10));
});

test("admin rebuild: owner only; 202 started, then running while in flight", async () => {
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture_secret" }));
  const post = (email: string) => createApp().request("/api/comms/admin/rebuild", { method: "POST", headers: { cookie: sessionCookie(makeSession(email)) } });
  assert.equal((await post("stranger@test.local")).status, 403);
  let release!: () => void;
  const first = startRebuild(() => new Promise((r) => { release = () => r(null); }));
  assert.deepEqual(first, { started: true });
  const r = await post(config.ownerEmail);
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { started: false, running: true });
  release();
  await new Promise((r) => setTimeout(r, 10));
  // (A route-started run would talk to the configured vault/homeserver; the started path is
  // startRebuild's own, asserted above. Without the credential the route refuses up front.)
  deleteSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix");
  assert.equal((await post(config.ownerEmail)).status, 409);
});

// ───────────────────────── Task 9: thread and timeline routes ─────────────────────────
// Synthetic data only. The reader is the test hook (setCommsReaderForTests), like threads.test.ts.
import { writeFileSync } from "node:fs";
import { db, resolveVaultEntry } from "../src/db";
import { putSecret, deleteSecret } from "../src/secrets";
import { MatrixClient, type MatrixEvent } from "../src/worker/matrix";
import { upsertConversation, ensureSingleThread, appendEvent, type ConversationRow } from "../src/comms/store";
import { setCommsReaderForTests, setTimelineLimitsForTests, type CommsReader } from "../src/comms/timeline";

const ROOM = "!room:example.test";
const ME = "@me:example.test";
const ALEX = "@whatsapp_111:example.test";
const PIC = "mxc://example.test/picture";
const CAPS_ALL = { react: true, edit: true, unsend: true, reply: true, typing: false, receipts: true, attachments: true };

function conv(id: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:example.test`, kind: "dm", title: `Title ${id}`, titleSource: "contact",
    avatar: { mxc: `mxc://example.test/av-${id}` }, lastEventAt: "2026-11-20T10:00:00.000Z", lastPreview: null,
    unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null,
    accountLabel: null, capabilities: CAPS_ALL, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}

const ts = (n: number) => 1_790_000_000_000 + n * 1000;
const ev = (id: string, n: number, sender: string, type: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}): MatrixEvent =>
  ({ event_id: id, origin_server_ts: ts(n), sender, type, content, ...extra }) as MatrixEvent;

/** Newest page (Matrix order: newest first). Covers every message feature. */
const NEWEST: MatrixEvent[] = [
  ev("$react1", 20, ALEX, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: "$hello", key: "👍" } }),
  ev("$reactOld", 19, ALEX, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: "$old1", key: "❤️" } }),
  ev("$gone", 18, ALEX, "m.room.message", {}, { unsigned: { redacted_because: { type: "m.room.redaction" } } }),
  ev("$edit1", 17, ME, "m.room.message", { msgtype: "m.text", body: "* hello there", "m.new_content": { msgtype: "m.text", body: "hello there" }, "m.relates_to": { rel_type: "m.replace", event_id: "$hello" } }),
  ev("$reply", 16, ALEX, "m.room.message", { msgtype: "m.text", body: "sure thing", "m.relates_to": { "m.in_reply_to": { event_id: "$hello" } } }),
  ev("$link", 15, ALEX, "m.room.message", { msgtype: "m.text", body: "look https://example.org", "com.beeper.linkpreviews": [{ matched_url: "https://example.org", "og:title": "Example", "og:image": "mxc://example.test/og" }] }),
  ev("$photo", 14, ALEX, "m.room.message", { msgtype: "m.image", body: "photo.jpg", url: "mxc://example.test/photo", info: { mimetype: "image/jpeg", w: 800, h: 600, size: 1234 } }),
  ev("$hello", 13, ME, "m.room.message", { msgtype: "m.text", body: "hello" }),
  ev("$join", 12, ALEX, "m.room.member", { membership: "join", displayname: "Alex" }, { state_key: ALEX }),
];
/** Older page: holds $old1, the target of the pending reaction above. */
const OLDER: MatrixEvent[] = [
  ev("$old1", 5, ALEX, "m.room.message", { msgtype: "m.text", body: "an older message" }),
];

let pages: Array<{ room: string; from?: string; limit: number }>;
let readerImpl: () => CommsReader;
const defaultReader = (): CommsReader => ({
  whoami: async () => ME,
  memberProfiles: async () => ({ [ME]: { name: "Me", avatar: null }, [ALEX]: { name: "Alex", avatar: PIC }, "@whatsappbot:example.test": { name: "bridge bot", avatar: null } }),
  timelinePage: async (room, from, limit = 50) => {
    pages.push({ room, from, limit });
    if (!from) return { chunk: NEWEST, start: "s0", end: "tok_page1" };
    if (from === "tok_page1") return { chunk: OLDER, start: "tok_page1", end: "tok_page2" };
    return { chunk: [], start: from, end: null };
  },
});

function setupTimeline() {
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture_secret" }));
  pages = [];
  readerImpl = defaultReader;
  setCommsReaderForTests(() => readerImpl());
  return conv("room1", { sourceRef: ROOM, avatar: { monogram: "AL", members: [{ mxc: PIC }] } });
}
afterEach(() => setCommsReaderForTests(null));

const owner = (path: string) => get(path);
const json = async (r: Response) => (await r.json()) as any;

test("threads list paginates and filters", async () => {
  setupTimeline();
  for (let i = 0; i < 5; i++) conv(`c${i}`, { lastEventAt: `2026-11-2${i}T00:00:00.000Z`, unreadCount: i % 2, network: i === 4 ? "telegram" : "whatsapp" });
  conv("lowone", { folder: "low" });
  const p1 = await owner("/api/comms/threads?limit=2");
  assert.equal(p1.status, 200);
  assert.equal(p1.headers.get("cache-control"), "private, no-store");
  const b1 = await json(p1);
  assert.equal(b1.threads.length, 2);
  assert.deepEqual(b1.threads.map((t: any) => t.id), ["th_c4", "th_c3"]);
  assert.ok(b1.next);
  const b2 = await json(await owner(`/api/comms/threads?limit=2&cursor=${b1.next}`));
  assert.deepEqual(b2.threads.map((t: any) => t.id), ["th_c2", "th_c1"]);
  // default folder is inbox: the low thread never appears without folder=low
  const all = await json(await owner("/api/comms/threads"));
  assert.ok(!all.threads.some((t: any) => t.id === "th_lowone"));
  assert.deepEqual((await json(await owner("/api/comms/threads?folder=low"))).threads.map((t: any) => t.id), ["th_lowone"]);
  assert.deepEqual((await json(await owner("/api/comms/threads?network=telegram"))).threads.map((t: any) => t.id), ["th_c4"]);
  assert.deepEqual((await json(await owner("/api/comms/threads?unread=1"))).threads.map((t: any) => t.id).sort(), ["th_c1", "th_c3"]);
  assert.deepEqual((await json(await owner("/api/comms/threads?q=title%20c2"))).threads.map((t: any) => t.id), ["th_c2"]);
  // avatars are tokens, never mxc
  assert.ok(!JSON.stringify(all).includes("mxc://"));
  assert.ok(all.threads.every((t: any) => t.avatar === null || "token" in t.avatar || "monogram" in t.avatar));
  for (const bad of ["limit=0", "limit=101", "limit=abc"]) {
    const r = await owner(`/api/comms/threads?${bad}`);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "invalid_limit" });
  }
  assert.equal((await owner("/api/comms/threads?folder=nope")).status, 400);
  assert.equal((await owner("/api/comms/threads?network=myspace")).status, 400);
  const badCursor = await owner("/api/comms/threads?cursor=%%%");
  assert.equal(badCursor.status, 400);
  assert.equal((await owner("/api/comms/threads?cursor=bm90IGpzb24")).status, 400);
  assert.equal((await get("/api/comms/threads", "stranger@test.local")).status, 403);
  if (process.env.WRITE_FIXTURES === "1") writeFixture("comms-threads.json", all);
});

test("thread detail includes capabilities", async () => {
  const id = setupTimeline();
  const r = await owner(`/api/comms/threads/${id}`);
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.thread.id, id);
  // `send` is added on the wire (sending off in this file: false).
  assert.deepEqual(b.capabilities, { ...CAPS_ALL, react: false, send: false }); // react/send: Comms can act here (sending off)
  assert.deepEqual(b.members.map((m: any) => [m.id, m.name]), [[ME, "Me"], [ALEX, "Alex"]]);
  assert.ok(b.members[1].avatar.token);
  assert.equal(b.members[0].avatar, null);
  assert.ok(b.thread.avatar.monogram && b.thread.avatar.members[0].token);
  assert.ok(!JSON.stringify(b).includes("mxc://"));
  // members degrade to [] when the source is down; the detail still answers
  readerImpl = () => ({ ...defaultReader(), memberProfiles: async () => { throw new Error("down"); } });
  const d = await json(await owner(`/api/comms/threads/${id}`));
  assert.deepEqual(d.members, []);
});

test("timeline returns normalized messages newest-last with media tokens not mxc", async () => {
  const id = setupTimeline();
  const r = await owner(`/api/comms/threads/${id}/messages`);
  assert.equal(r.status, 200);
  const b = await json(r);
  const text = JSON.stringify(b);
  assert.ok(!text.includes("mxc://"), "no raw mxc in the response");
  assert.ok(!text.includes("tok_page1") && !text.includes("syt_fixture_secret"), "no raw Matrix token");
  const ids = b.messages.map((m: any) => m.id);
  assert.deepEqual(ids, ["$join", "$hello", "$photo", "$link", "$reply", "$gone"]);
  const at = (i: string) => b.messages.find((m: any) => m.id === i);
  assert.equal(at("$join").system.kind, "member");
  assert.equal(at("$hello").body.plain, "hello there");
  assert.ok(at("$hello").editedAt);
  assert.deepEqual(at("$hello").reactions.map((x: any) => [x.key, x.count]), [["👍", 1]]);
  assert.equal(at("$reply").replyTo.messageId, "$hello");
  assert.equal(at("$gone").redacted, true);
  const photo = at("$photo").attachments[0];
  assert.ok(photo.mediaToken && photo.thumbToken && !("mxc" in photo));
  const lp = at("$link").linkPreviews[0];
  assert.ok(lp.imageToken && !("imageMxc" in lp));
  assert.ok(at("$photo").sender.avatar.token);
  assert.equal(b.hasMore, true);
  assert.match(b.before, /^tc_[A-Za-z0-9_-]{24}$/);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.limit, 50);
  // cache-first: a second read is served from the window without touching the source
  const again = await json(await owner(`/api/comms/threads/${id}/messages`));
  assert.deepEqual(again.messages.map((m: any) => m.id), ids);
  assert.equal(pages.length, 1);
  // a newer thread.updated makes the window stale → the source is read again
  appendEvent("thread.updated", id, { threadId: id });
  await owner(`/api/comms/threads/${id}/messages`);
  assert.equal(pages.length, 2);
  // a smaller limit from cache pages through the window before the source
  const small = await json(await owner(`/api/comms/threads/${id}/messages?limit=2`));
  assert.deepEqual(small.messages.map((m: any) => m.id), ["$reply", "$gone"]);
  const rest = await json(await owner(`/api/comms/threads/${id}/messages?limit=10&before=${small.before}`));
  assert.deepEqual(rest.messages.map((m: any) => m.id), ["$join", "$hello", "$photo", "$link"]);
  assert.equal(pages.length, 2);
  for (const bad of ["limit=0", "limit=101"]) assert.equal((await owner(`/api/comms/threads/${id}/messages?${bad}`)).status, 400);
  if (process.env.WRITE_FIXTURES === "1") writeFixture("comms-messages.json", b);
});

test("timeline before cursor fetches older page and reapplies pending relations", async () => {
  const id = setupTimeline();
  const first = await json(await owner(`/api/comms/threads/${id}/messages`));
  const older = await json(await owner(`/api/comms/threads/${id}/messages?before=${first.before}`));
  assert.deepEqual(pages.map((p) => p.from), [undefined, "tok_page1"]);
  assert.deepEqual(older.messages.map((m: any) => m.id), ["$old1"]);
  assert.deepEqual(older.messages[0].reactions.map((x: any) => [x.key, x.count, x.senders[0].name]), [["❤️", 1, "Alex"]]);
  assert.equal(older.hasMore, true);
  const last = await json(await owner(`/api/comms/threads/${id}/messages?before=${older.before}`));
  assert.deepEqual(last.messages, []);
  assert.equal(last.hasMore, false);
  assert.equal(last.before, null);
  // a cursor is bound to its thread
  const other = conv("room2", { sourceRef: "!room2:example.test" });
  const foreign = await owner(`/api/comms/threads/${other}/messages?before=${first.before}`);
  assert.equal(foreign.status, 400);
  assert.deepEqual(await foreign.json(), { error: "invalid_cursor" });
});

test("source unavailable → 503 source_unavailable; the list still answers", async () => {
  const id = setupTimeline();
  readerImpl = () => ({ ...defaultReader(), timelinePage: async () => { throw new Error("matrix down"); } });
  const r = await owner(`/api/comms/threads/${id}/messages`);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "source_unavailable", network: "whatsapp" });
  assert.equal((await owner("/api/comms/threads")).status, 200);
  db.prepare("DELETE FROM tenant_secrets").run();
  assert.equal((await owner(`/api/comms/threads/${id}/messages`)).status, 503);
});

test("unknown thread → 404 thread_unavailable", async () => {
  setupTimeline();
  for (const path of ["/api/comms/threads/th_nope", "/api/comms/threads/th_nope/messages"]) {
    const r = await owner(path);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "thread_unavailable" });
  }
  assert.deepEqual(pages, []);
});

test("cursor abuse → 400 invalid_cursor", async () => {
  const id = setupTimeline();
  for (const c of ["a".repeat(2049), "tc_abc%0Adef", "tc_%00", "tok_page1", "tc_" + "A".repeat(24)]) {
    const r = await owner(`/api/comms/threads/${id}/messages?before=${c}`);
    assert.equal(r.status, 400, c.slice(0, 20));
    assert.deepEqual(await r.json(), { error: "invalid_cursor" });
  }
  assert.deepEqual(pages, []);
});

test("access revoked mid-read → 403 access_changed", async () => {
  const id = setupTimeline();
  readerImpl = () => ({
    ...defaultReader(),
    timelinePage: async () => { db.prepare("DELETE FROM sessions").run(); return { chunk: NEWEST, start: null, end: null }; },
  });
  const r = await owner(`/api/comms/threads/${id}/messages`);
  assert.equal(r.status, 403);
  const body = await r.text();
  assert.ok(body.includes("access_changed") && !body.includes("hello"));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comms_messages").get() as { n: number }).n, 0, "nothing cached for a revoked read");
});

test("MatrixClient.timelinePage widens the type filter; messagePage is unchanged", async () => {
  const urls: string[] = [];
  const client = new MatrixClient({ homeserver: "https://example.test", accessToken: "fixture" }, (async (input: unknown) => {
    urls.push(String(input));
    return Response.json({ chunk: [], start: "a", end: "b" });
  }) as typeof fetch);
  await client.messagePage(ROOM, "x", 50);
  await client.timelinePage(ROOM, "y", 500);
  const [legacy, wide] = urls.map((u) => new URL(u));
  assert.deepEqual(JSON.parse(legacy!.searchParams.get("filter")!), { types: ["m.room.message", "m.room.redaction"] });
  const types = JSON.parse(wide!.searchParams.get("filter")!).types;
  for (const t of ["m.room.message", "m.room.redaction", "m.reaction", "com.beeper.message_send_status", "m.sticker", "m.room.member", "m.room.name", "m.room.topic", "m.room.avatar", "m.room.encrypted"])
    assert.ok(types.includes(t), t);
  assert.equal(wide!.searchParams.get("limit"), "100");
  assert.equal(wide!.searchParams.get("from"), "y");
  assert.equal(wide!.searchParams.get("dir"), "b");
});

function writeFixture(name: string, body: unknown) {
  writeFileSync(new URL(`../../../swift/PrismKit/Tests/PrismModelsTests/Fixtures/${name}`, import.meta.url), JSON.stringify(body, null, 2) + "\n");
}

// ── fix round 1: cursors follow the current window; bounded cursor state ──────────────

/** A fake room with stable tokens ("below:<event id>"), so prepending new events keeps old tokens valid. */
function fakeRoom(n: number) {
  const events: MatrixEvent[] = []; // newest first
  const add = (k: number) => events.unshift(ev(`$m${k}`, k, ALEX, "m.room.message", { msgtype: "m.text", body: `message ${k}` }));
  for (let k = 0; k < n; k++) add(k);
  let next = n;
  const reads: Array<string | undefined> = [];
  const reader = (): CommsReader => ({
    ...defaultReader(),
    timelinePage: async (_room, from, limit = 50) => {
      reads.push(from);
      const off = from ? events.findIndex((e) => e.event_id === from.slice("below:".length)) + 1 : 0;
      const chunk = events.slice(off, off + limit);
      const last = chunk[chunk.length - 1];
      return { chunk, start: from ?? "s", end: last && off + limit < events.length ? `below:${last.event_id}` : null };
    },
  });
  return { reader, reads, grow: (k: number) => { for (let i = 0; i < k; i++) add(next++); } };
}

async function pageToEnd(id: string, cursor: string | null, limit: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; cursor && i < 100; i++) {
    const b = await json(await owner(`/api/comms/threads/${id}/messages?limit=${limit}&before=${cursor}`));
    out.unshift(...b.messages.map((m: any) => m.id));
    cursor = b.before;
  }
  return out;
}
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `$m${a + i}`);

test("a window cursor minted before a refill continues at the CURRENT window's bottom: no gap", async () => {
  const id = setupTimeline();
  const room = fakeRoom(120);
  readerImpl = room.reader;
  await owner(`/api/comms/threads/${id}/messages`); // fill: m70..m119
  const top = await json(await owner(`/api/comms/threads/${id}/messages?limit=2`)); // from the window
  assert.deepEqual(top.messages.map((m: any) => m.id), ["$m118", "$m119"]);
  assert.equal(room.reads.length, 1);
  room.grow(10);
  appendEvent("thread.updated", id, { threadId: id });
  await owner(`/api/comms/threads/${id}/messages?limit=2`); // refill with ≥ 50 events: m80..m129
  assert.equal(room.reads.length, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comms_messages").get() as { n: number }).n, 50, "limit=2 never shrinks the window");
  const older = await pageToEnd(id, top.before, 10);
  assert.deepEqual(older, range(0, 118));
});

test("a window cursor whose message was pushed out of the window skips forward, no gap and no repeat", async () => {
  const id = setupTimeline();
  const room = fakeRoom(120);
  readerImpl = room.reader;
  let b = await json(await owner(`/api/comms/threads/${id}/messages?limit=10`));
  const seen: string[] = b.messages.map((m: any) => m.id);
  for (let i = 0; i < 4; i++) { // page the window down to m70
    b = await json(await owner(`/api/comms/threads/${id}/messages?limit=10&before=${b.before}`));
    seen.unshift(...b.messages.map((m: any) => m.id));
  }
  assert.equal(seen[0], "$m70");
  room.grow(10);
  appendEvent("thread.updated", id, { threadId: id });
  await owner(`/api/comms/threads/${id}/messages?limit=10`); // refill: m80..m129, m70 is gone
  const rest = await pageToEnd(id, b.before, 3);
  assert.deepEqual(rest, range(0, 70));
});

test("cursor state is bounded: identical cursors are reused, pending stored once, global cap evicts oldest", async () => {
  const id = setupTimeline();
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) ids.add((await json(await owner(`/api/comms/threads/${id}/messages?limit=2`))).before);
  assert.equal(ids.size, 1, "polling the newest page mints one cursor");
  assert.equal(count("comms_timeline_cursors"), 1);
  assert.equal(count("comms_timeline_pending"), 1, "the window's pending set is stored once");
  setTimelineLimitsForTests({ total: 3 });
  try {
    const room = fakeRoom(60);
    readerImpl = room.reader;
    appendEvent("thread.updated", id, { threadId: id });
    let c = (await json(await owner(`/api/comms/threads/${id}/messages?limit=5`))).before;
    const first = c;
    for (let i = 0; i < 6; i++) c = (await json(await owner(`/api/comms/threads/${id}/messages?limit=5&before=${c}`))).before;
    assert.ok(count("comms_timeline_cursors") <= 3);
    assert.equal((await owner(`/api/comms/threads/${id}/messages?before=${first}`)).status, 400, "the oldest was evicted");
    const referenced = (db.prepare(`SELECT COUNT(*) AS n FROM comms_timeline_pending WHERE hash NOT IN (SELECT pending_hash FROM comms_timeline_cursors) AND hash NOT IN (SELECT pending_hash FROM comms_timeline_windows)`).get() as { n: number }).n;
    assert.equal(referenced, 0, "unreferenced pending sets are collected");
  } finally {
    setTimelineLimitsForTests(null);
  }
});

test("a cursor is bound to the room it was read from", async () => {
  const id = setupTimeline();
  const b = await json(await owner(`/api/comms/threads/${id}/messages`));
  upsertConversation({
    id: "room1", network: "whatsapp", sourceRef: "!other:example.test", kind: "dm", title: "t", titleSource: "contact", avatar: null,
    lastEventAt: "2026-11-20T10:00:00.000Z", lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false,
    muted: false, archived: false, triage: null, accountLabel: null, capabilities: CAPS_ALL, vaultNoteId: null,
  });
  const r = await owner(`/api/comms/threads/${id}/messages?before=${b.before}`);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "invalid_cursor" });
});

test("up to two empty filtered chunks with a token are read through; a third stops", async () => {
  const id = setupTimeline();
  const reads: Array<string | undefined> = [];
  const script: Record<string, { chunk: MatrixEvent[]; end: string | null }> = {
    "": { chunk: [], end: "e1" }, e1: { chunk: [], end: "e2" }, e2: { chunk: OLDER, end: "e3" },
    e3: { chunk: [], end: "e4" }, e4: { chunk: [], end: "e5" }, e5: { chunk: [], end: "e6" }, e6: { chunk: OLDER, end: null },
  };
  readerImpl = () => ({
    ...defaultReader(),
    timelinePage: async (_r, from) => { reads.push(from); const p = script[from ?? ""]!; return { chunk: p.chunk, start: from ?? "s", end: p.end }; },
  });
  const b = await json(await owner(`/api/comms/threads/${id}/messages`));
  assert.deepEqual(b.messages.map((m: any) => m.id), ["$old1"]);
  assert.deepEqual(reads, [undefined, "e1", "e2"]);
  assert.equal(b.hasMore, true);
  const next = await json(await owner(`/api/comms/threads/${id}/messages?before=${b.before}`));
  assert.deepEqual(next.messages, []);
  assert.equal(next.hasMore, false, "three empty chunks in a row end the room");
  assert.deepEqual(reads.slice(3), ["e3", "e4", "e5"]);
});
