/**
 * Matrix ingester (Phase 3) — sync parsing, platform detection, and the
 * upsert-by-room mapping, with a fake client + fake vault (no homeserver). The
 * live homeserver path is exercised by scripts/verify-matrix-ingest.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSync, detectPlatform, ingestMatrix, reconcileMatrix, formatLine, TRIAGE_TAGS, type IngestVault, type SyncResult } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

test("parseSync extracts name + joined members + messages per room", () => {
  const res = parseSync({
    next_batch: "s_2",
    rooms: {
      join: {
        "!room1:hs": {
          state: { events: [{ type: "m.room.name", content: { name: "Family" } }, { type: "m.room.member", state_key: "@whatsapp_123:hs", content: { membership: "join", displayname: "Alice (WA)" } }] },
          timeline: { events: [{ type: "m.room.message", sender: "@whatsapp_123:hs", event_id: "$e1", origin_server_ts: 1000, content: { body: "hi", msgtype: "m.text" } }] },
        },
      },
    },
  });
  assert.equal(res.nextBatch, "s_2");
  assert.deepEqual(res.invites, []);
  assert.equal(res.rooms.length, 1);
  const r = res.rooms[0]!;
  assert.equal(r.name, "Family");
  assert.deepEqual(r.memberIds, ["@whatsapp_123:hs"]);
  assert.deepEqual(r.displayNames, { "@whatsapp_123:hs": "Alice (WA)" });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0]!.body, "hi");
});

test("formatLine stamps UTC time + display name (desktop format), falls back to short sender id", () => {
  const m = { sender: "@whatsapp_lid-155611094364236:hs", body: "hello", ts: Date.UTC(2026, 7, 23, 20, 12, 30), eventId: "$1" };
  assert.equal(formatLine(m, { "@whatsapp_lid-155611094364236:hs": "Benjamin" }), "[2026-08-23 20:12] Benjamin: hello");
  assert.equal(formatLine(m), "[2026-08-23 20:12] lid-155611094364236: hello");
});

test("detectPlatform maps mautrix puppet prefixes", () => {
  assert.equal(detectPlatform(["@whatsapp_1:hs"]), "whatsapp");
  assert.equal(detectPlatform(["@alice:hs", "@telegram_2:hs"]), "telegram");
  assert.equal(detectPlatform(["@signal_3:hs"]), "signal");
  assert.equal(detectPlatform(["@alice:hs", "@bob:hs"]), "matrix");
});

/** A fake vault that records creates/updates. */
function fakeVault(seed: Note[] = []) {
  const creates: Array<{ path?: string; tags?: string[]; metadata?: Record<string, unknown>; content: string }> = [];
  const updates: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }> = [];
  const removed: Array<{ id: string; tags: string[] }> = [];
  const vault: IngestVault = {
    async removeTags(id, tags) {
      removed.push({ id, tags });
    },
    async listNotes() {
      return seed;
    },
    async createNote(p) {
      creates.push(p);
      return { id: `new-${creates.length}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
    },
    async updateNote(id, p) {
      updates.push({ id, ...p });
      return { id, content: p.content ?? "", path: null, metadata: p.metadata ?? null, tags: null, createdAt: "", updatedAt: "" };
    },
  };
  return { vault, creates, updates, removed };
}

const oneRoomSync = (roomId: string): SyncResult => ({
  nextBatch: "s2",
  invites: [],
  rooms: [{ roomId, name: "Chat", memberIds: ["@whatsapp_9:hs"], displayNames: { "@whatsapp_9:hs": "Nine" }, messages: [{ sender: "@whatsapp_9:hs", body: "yo", ts: Date.UTC(2026, 0, 2, 3, 4), eventId: "$x" }] }],
});

test("ingestMatrix CREATES a message-thread note for a new room", async () => {
  const fv = fakeVault([]);
  const client = { sync: async () => oneRoomSync("!new:hs") };
  const res = await ingestMatrix(client, fv.vault);
  assert.equal(res.created, 1);
  assert.equal(res.updated, 0);
  assert.equal(res.messages, 1);
  const c = fv.creates[0]!;
  assert.deepEqual(c.tags, ["message-thread"]);
  assert.equal(c.metadata?.matrixRoomId, "!new:hs");
  assert.equal(c.metadata?.platform, "whatsapp");
  assert.match(c.path ?? "", /^vault\/messages\/whatsapp\//);
  assert.match(c.content, /\[2026-01-02 03:04\] Nine: yo/);
  assert.equal(c.metadata?.messageCount, 1);
  assert.deepEqual(c.metadata?.participants, ["Nine"]);
});

test("ingestMatrix UPDATES an existing note matched by matrixRoomId", async () => {
  const existing: Note = { id: "n1", content: "# Chat — whatsapp\n\nold", path: null, metadata: { type: "message-thread", matrixRoomId: "!exist:hs", messageCount: 7, participants: ["Old Timer (WA)"] }, tags: ["message-thread", "triaged", "low"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([existing]);
  const client = { sync: async () => oneRoomSync("!exist:hs") };
  const res = await ingestMatrix(client, fv.vault);
  assert.equal(res.created, 0);
  assert.equal(res.updated, 1);
  assert.equal(fv.updates[0]!.id, "n1");
  assert.match(fv.updates[0]!.content ?? "", /old\n\[2026-01-02 03:04\] Nine: yo/); // appended, old preserved, dated + named
  assert.equal(fv.updates[0]!.metadata?.messageCount, 8);
  assert.deepEqual(fv.updates[0]!.metadata?.participants, ["Old Timer (WA)", "Nine"]); // union, not replace
  // stale triage verdict cleared so the hourly classifier re-triages the thread
  assert.deepEqual(fv.removed, [{ id: "n1", tags: ["triaged", "low"] }]);
});

test("ingestMatrix leaves tags alone on an untriaged thread", async () => {
  const existing: Note = { id: "n2", content: "x", path: null, metadata: { matrixRoomId: "!e2:hs" }, tags: ["message-thread"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([existing]);
  await ingestMatrix({ sync: async () => oneRoomSync("!e2:hs") }, fv.vault);
  assert.deepEqual(fv.removed, []);
  assert.ok(TRIAGE_TAGS.includes("triaged"));
});

test("ingestMatrix clears triage-failed so a failed thread is re-triaged on new messages", async () => {
  // Regression: the classifier hard-excludes `triage-failed`, so if the ingester
  // does not strip it on append, a thread that failed once is skipped by every
  // later run forever — new messages can never earn a fresh attempt.
  const existing: Note = { id: "n3", content: "old", path: null, metadata: { matrixRoomId: "!e3:hs", messageCount: 7 }, tags: ["message-thread", "triage-failed"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([existing]);
  const res = await ingestMatrix({ sync: async () => oneRoomSync("!e3:hs") }, fv.vault);
  assert.equal(res.updated, 1);
  assert.deepEqual(fv.removed, [{ id: "n3", tags: ["triage-failed"] }]);
  assert.ok(TRIAGE_TAGS.includes("triage-failed"));
});

test("ingestMatrix returns nextBatch and skips empty rooms", async () => {
  const client = {
    sync: async (): Promise<SyncResult> => ({ nextBatch: "s9", rooms: [{ roomId: "!empty:hs", name: "x", memberIds: [], displayNames: {}, messages: [] }], invites: [] }),
  };
  const fv = fakeVault([]);
  const res = await ingestMatrix(client, fv.vault);
  assert.equal(res.nextBatch, "s9");
  assert.equal(res.created, 0);
  assert.equal(res.messages, 0);
});

test("parseSync surfaces pending invites (rooms.invite) with their stripped-state name", () => {
  const res = parseSync({
    next_batch: "s3",
    rooms: { invite: { "!inv:hs": { invite_state: { events: [{ type: "m.room.name", content: { name: "New Chat" } }, { type: "m.room.member", state_key: "@me:hs", content: { membership: "invite" } }] } } } },
  });
  assert.deepEqual(res.invites, [{ roomId: "!inv:hs", name: "New Chat" }]);
  assert.equal(res.rooms.length, 0);
});

test("ingestMatrix accepts invites only when autoJoin is on, throttled by maxJoinsPerRun", async () => {
  const joinedIds: string[] = [];
  const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", rooms: [], invites: [{ roomId: "!a:hs", name: "A" }, { roomId: "!b:hs", name: null }, { roomId: "!c:hs", name: "C" }] });
  const client = { sync, join: async (id: string) => { joinedIds.push(id); } };
  const off = await ingestMatrix(client, fakeVault().vault);
  assert.equal(off.joined, 0);
  assert.equal(off.invitesPending, 3);
  assert.deepEqual(joinedIds, []);
  const on = await ingestMatrix(client, fakeVault().vault, { autoJoin: true, maxJoinsPerRun: 2 });
  assert.equal(on.joined, 2);
  assert.deepEqual(joinedIds, ["!a:hs", "!b:hs"]);
});

test("ingestMatrix keeps going when one join fails", async () => {
  const joinedIds: string[] = [];
  const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", rooms: [], invites: [{ roomId: "!bad:hs", name: null }, { roomId: "!ok:hs", name: null }] });
  const client = { sync, join: async (id: string) => { if (id === "!bad:hs") throw new Error("403"); joinedIds.push(id); } };
  const res = await ingestMatrix(client, fakeVault().vault, { autoJoin: true });
  assert.equal(res.joined, 1);
  assert.deepEqual(joinedIds, ["!ok:hs"]);
});

test("ingestMatrix merges the invite probe (backlog) with fresh invites from incremental sync, deduped", async () => {
  const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", rooms: [], invites: [{ roomId: "!new:hs", name: "New" }] });
  const pendingInvites = async () => [{ roomId: "!new:hs", name: "New" }, { roomId: "!old:hs", name: "Old" }];
  const joinedIds: string[] = [];
  const client = { sync, pendingInvites, join: async (id: string) => { joinedIds.push(id); } };
  const noProbe = await ingestMatrix(client, fakeVault().vault);
  assert.equal(noProbe.invitesPending, 1);
  const probed = await ingestMatrix(client, fakeVault().vault, { probeInvites: true, autoJoin: true });
  assert.equal(probed.invitesPending, 2);
  assert.deepEqual(joinedIds, ["!new:hs", "!old:hs"]);
});

test("ingestMatrix stops the join batch on a 429 (Synapse join rate limit)", async () => {
  const joinedIds: string[] = [];
  const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", rooms: [], invites: [{ roomId: "!1:hs", name: null }, { roomId: "!2:hs", name: null }, { roomId: "!3:hs", name: null }] });
  const client = { sync, join: async (id: string) => { if (id === "!2:hs") throw new Error("matrix join !2:hs → 429"); joinedIds.push(id); } };
  const res = await ingestMatrix(client, fakeVault().vault, { autoJoin: true });
  assert.equal(res.joined, 1);
  assert.deepEqual(joinedIds, ["!1:hs"]); // !3 never attempted
});

test("ingestMatrix drops probe invites that /joined_rooms says are already joined (stale probe cache)", async () => {
  const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", rooms: [], invites: [] });
  const pendingInvites = async () => [{ roomId: "!stale:hs", name: null }, { roomId: "!real:hs", name: null }];
  const joinedRooms = async () => ["!stale:hs"];
  const joinedIds: string[] = [];
  const client = { sync, pendingInvites, joinedRooms, join: async (id: string) => { joinedIds.push(id); } };
  const res = await ingestMatrix(client, fakeVault().vault, { probeInvites: true, autoJoin: true });
  assert.equal(res.invitesPending, 1);
  assert.deepEqual(joinedIds, ["!real:hs"]);
});

test("ingestMatrix retries a 409 create with a room-id-suffixed path", async () => {
  const fv = fakeVault([]);
  const orig = fv.vault.createNote;
  let calls = 0;
  fv.vault.createNote = async (p) => { calls++; if (calls === 1) throw new Error("POST /notes: 409"); return orig(p); };
  const res = await ingestMatrix({ sync: async () => oneRoomSync("!AbCdEfGh1234:hs") }, fv.vault);
  assert.equal(res.created, 1);
  assert.equal(fv.creates.length, 1);
  assert.match(fv.creates[0]!.path ?? "", /^vault\/messages\/whatsapp\/chat-abcdefgh$/);
});

test("ingestMatrix isolates a failing room — the others still land and nextBatch advances", async () => {
  const fv = fakeVault([]);
  const orig = fv.vault.createNote;
  fv.vault.createNote = async (p) => { if (/boom/.test(p.content)) throw new Error("POST /notes: 500 kaboom"); return orig(p); };
  const room = (id: string, body: string) => ({ roomId: id, name: body, memberIds: ["@whatsapp_1:hs"], displayNames: {}, messages: [{ sender: "@whatsapp_1:hs", body, ts: 1, eventId: "$" }] });
  const client = { sync: async (): Promise<SyncResult> => ({ nextBatch: "s9", rooms: [room("!a:hs", "ok1"), room("!b:hs", "boom"), room("!c:hs", "ok2")], invites: [] }) };
  const res = await ingestMatrix(client, fv.vault);
  assert.equal(res.created, 2);
  assert.equal(res.nextBatch, "s9");
  assert.equal(fv.creates.length, 2);
});

test("ingestMatrix rejects an un-joinable (404) invite so it leaves the queue, but keeps 429s pending", async () => {
  const left: string[] = []; const joinedIds: string[] = [];
  const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", rooms: [], invites: [{ roomId: "!dead:hs", name: "Dead" }, { roomId: "!ok:hs", name: null }, { roomId: "!limited:hs", name: null }] });
  const client = {
    sync,
    join: async (id: string) => { if (id === "!dead:hs") throw new Error("matrix join !dead:hs → 404"); if (id === "!limited:hs") throw new Error("matrix join !limited:hs → 429"); joinedIds.push(id); },
    leave: async (id: string) => { left.push(id); },
  };
  await ingestMatrix(client, fakeVault().vault, { autoJoin: true });
  assert.deepEqual(left, ["!dead:hs"]);   // rejected, gone from queue
  assert.deepEqual(joinedIds, ["!ok:hs"]); // still joined after the 404
});

// ── truncated timelines + the repair sweep ───────────────────────────────────

const msg = (id: string, ts: number, body = id) => ({ sender: "@telegram_1:hs", body, ts, eventId: id });

test("parseSync flags a limited timeline and keeps its prev_batch", () => {
  const res = parseSync({
    next_batch: "s3",
    rooms: { join: { "!busy:hs": { timeline: { limited: true, prev_batch: "p1", events: [] } }, "!calm:hs": { timeline: { events: [] } } } },
  });
  const busy = res.rooms.find((r) => r.roomId === "!busy:hs")!;
  const calm = res.rooms.find((r) => r.roomId === "!calm:hs")!;
  assert.equal(busy.limited, true);
  assert.equal(busy.prevBatch, "p1");
  assert.equal(calm.limited, undefined);
});

test("ingestMatrix gap-fills a LIMITED room back to the previous cursor (exact `to`)", async () => {
  const fv = fakeVault([{ id: "n", content: "# T", path: null, tags: ["message-thread"], metadata: { matrixRoomId: "!busy:hs", lastMessageAt: 500 }, createdAt: "", updatedAt: "" }]);
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    sync: async (): Promise<SyncResult> => ({
      nextBatch: "s9",
      invites: [],
      rooms: [{ roomId: "!busy:hs", name: "Techne", memberIds: ["@telegram_1:hs"], displayNames: {}, messages: [msg("$31", 31_000)], limited: true, prevBatch: "p9" }],
    }),
    messagesBefore: async (_room: string, o: Record<string, unknown>) => {
      calls.push(o);
      return { messages: [msg("$1", 1_000), msg("$2", 2_000), msg("$31", 31_000)], capped: false };
    },
  };
  const res = await ingestMatrix(client, fv.vault, { since: "s8" });
  assert.deepEqual(calls[0], { from: "p9", to: "s8" });
  assert.equal(res.messages, 3); // gap + tail, the tail's duplicate event dropped
  const lines = fv.updates[0]!.content!.split("\n").filter((l) => l.startsWith("["));
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /: \$1$/);
});

test("ingestMatrix pages a NEWLY JOINED limited room back to its start (bridge backfill predates the cursor)", async () => {
  const fv = fakeVault([]);
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    sync: async (): Promise<SyncResult> => ({ nextBatch: "s9", invites: [], rooms: [{ roomId: "!new:hs", name: "N", memberIds: [], displayNames: {}, messages: [msg("$9", 9_000)], limited: true, prevBatch: "p9" }] }),
    messagesBefore: async (_r: string, o: Record<string, unknown>) => { calls.push(o); return { messages: [msg("$1", 1_000)], capped: false }; },
  };
  await ingestMatrix({ ...client, joinedMembers: async () => ({ "@telegram_1:hs": "Mathilda" }) }, fv.vault, { since: "s8" });
  assert.deepEqual(calls[0], { from: "p9", sinceTs: 0 });
  assert.match(fv.creates[0]!.content, /\] Mathilda: \$1/); // gap senders resolved to names, not numeric ids
  assert.equal(fv.creates[0]!.content.split("\n").filter((l) => l.startsWith("[")).length, 2);
});

test("ingestMatrix never rewinds lastMessageAt when a bridge backfills OLD timestamps late", async () => {
  const existing: Note = { id: "n1", content: "# T", path: null, tags: ["message-thread"], metadata: { matrixRoomId: "!r:hs", lastMessageAt: 50_000, messageCount: 5 }, createdAt: "", updatedAt: "" };
  const fv = fakeVault([existing]);
  const client = { sync: async (): Promise<SyncResult> => ({ nextBatch: "s", invites: [], rooms: [{ roomId: "!r:hs", name: null, memberIds: [], displayNames: {}, messages: [msg("$old", 10_000)] }] }) };
  await ingestMatrix(client, fv.vault);
  assert.equal(fv.updates[0]!.metadata!.lastMessageAt, 50_000);
});

test("reconcileMatrix repairs rooms whose newest message is not in the vault — and only those", async () => {
  const upToDate: Note = { id: "ok", content: "# ok", path: null, tags: ["message-thread"], metadata: { matrixRoomId: "!ok:hs", lastMessageAt: 9_000 }, createdAt: "", updatedAt: "" };
  const stale: Note = { id: "st", content: "# st\n[1970-01-01 00:00] One: $a", path: null, tags: ["message-thread"], metadata: { matrixRoomId: "!stale:hs", lastMessageAt: 5_000, messageCount: 1 }, createdAt: "", updatedAt: "" };
  const fv = fakeVault([upToDate, stale]);
  const history: Record<string, ReturnType<typeof msg>[]> = {
    "!ok:hs": [msg("$k", 9_000)],
    "!stale:hs": [msg("$a", 5_000, "$a"), msg("$b", 6_000), msg("$c", 7_000)],
    "!missing:hs": [msg("$m1", 1_000), msg("$m2", 2_000)],
    "!empty:hs": [],
  };
  const client = {
    joinedRooms: async () => Object.keys(history),
    messagesBefore: async (room: string, o: { from?: string; sinceTs?: number; cap?: number }) => {
      assert.equal(o.from, "cursor");
      const all = history[room]!;
      if (o.cap === 1) return { messages: all.slice(-1), capped: false };
      return { messages: all.filter((m) => m.ts >= (o.sinceTs ?? 0)), capped: false };
    },
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async (room: string) => (room === "!missing:hs" ? "Techne Coordination" : null),
  };
  const r = await reconcileMatrix(client, fv.vault, { upTo: "cursor" });
  assert.deepEqual({ scanned: r.scanned, behind: r.behind, repaired: r.repaired, deferred: r.deferred }, { scanned: 4, behind: 2, repaired: 2, deferred: 0 });
  // The note-less room becomes a new thread, named and platform-detected.
  assert.equal(fv.creates.length, 1);
  assert.equal(fv.creates[0]!.path, "vault/messages/telegram/techne-coordination");
  // The stale room gets only the gap; the boundary line already in the note is not duplicated.
  assert.equal(fv.updates.length, 1);
  const appended = fv.updates[0]!.content!.split("\n").filter((l) => l.startsWith("["));
  assert.equal(appended.length, 3); // 1 existing + 2 new
  assert.equal(fv.updates[0]!.metadata!.lastMessageAt, 7_000);
});

test("reconcileMatrix respects the per-sweep repair budget, most-recent first", async () => {
  const fv = fakeVault([]);
  const rooms = ["!a:hs", "!b:hs", "!c:hs"];
  const client = {
    joinedRooms: async () => rooms,
    messagesBefore: async (room: string) => ({ messages: [msg(`$${room}`, room === "!b:hs" ? 9_000 : 1_000)], capped: false }),
    joinedMembers: async () => ({}),
    roomName: async (room: string) => room,
  };
  const r = await reconcileMatrix(client, fv.vault, { upTo: "c", maxRepairs: 1 });
  assert.equal(r.repaired, 1);
  assert.equal(r.deferred, 2);
  assert.equal(fv.creates[0]!.metadata!.matrixRoomId, "!b:hs");
});

test("ingestMatrix resolves senders' names on an ordinary (non-limited) incremental pass — members, then profile for leavers", async () => {
  const fv = fakeVault([{ id: "n", content: "# T", path: null, tags: ["message-thread"], metadata: { matrixRoomId: "!t:hs", lastMessageAt: 500 }, createdAt: "", updatedAt: "" }]);
  const left = { ...msg("$2", 2_000), sender: "@telegram_2:hs" };
  const client = {
    sync: async (): Promise<SyncResult> => ({ nextBatch: "s9", invites: [], rooms: [{ roomId: "!t:hs", name: "T", memberIds: [], displayNames: {}, messages: [msg("$1", 1_000), left] }] }),
    joinedMembers: async () => ({ "@telegram_1:hs": "Kevin Owocki" }),
    profileName: async (id: string) => (id === "@telegram_2:hs" ? "Lucian" : null),
  };
  await ingestMatrix(client, fv.vault, { since: "s8" });
  const content = fv.updates[0]!.content!;
  assert.match(content, /\] Kevin Owocki: \$1/);
  assert.match(content, /\] Lucian: \$2/);
  assert.doesNotMatch(content, /\] \d+: /);
});
