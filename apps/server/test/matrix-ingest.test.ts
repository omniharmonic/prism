/**
 * Matrix ingester (Phase 3) — sync parsing, platform detection, and the
 * upsert-by-room mapping, with a fake client + fake vault (no homeserver). The
 * live homeserver path is exercised by scripts/verify-matrix-ingest.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSync, detectPlatform, ingestMatrix, formatLine, TRIAGE_TAGS, type IngestVault, type SyncResult } from "../src/worker/matrix";
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
