/**
 * Matrix ingester (Phase 3) — sync parsing, platform detection, and the
 * upsert-by-room mapping, with a fake client + fake vault (no homeserver). The
 * live homeserver path is exercised by scripts/verify-matrix-ingest.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSync, detectPlatform, ingestMatrix, type IngestVault, type SyncResult } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

test("parseSync extracts name + joined members + messages per room", () => {
  const res = parseSync({
    next_batch: "s_2",
    rooms: {
      join: {
        "!room1:hs": {
          state: { events: [{ type: "m.room.name", content: { name: "Family" } }, { type: "m.room.member", state_key: "@whatsapp_123:hs", content: { membership: "join" } }] },
          timeline: { events: [{ type: "m.room.message", sender: "@whatsapp_123:hs", event_id: "$e1", origin_server_ts: 1000, content: { body: "hi", msgtype: "m.text" } }] },
        },
      },
    },
  });
  assert.equal(res.nextBatch, "s_2");
  assert.equal(res.rooms.length, 1);
  const r = res.rooms[0]!;
  assert.equal(r.name, "Family");
  assert.deepEqual(r.memberIds, ["@whatsapp_123:hs"]);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0]!.body, "hi");
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
  const updates: Array<{ id: string; content?: string }> = [];
  const vault: IngestVault = {
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
  return { vault, creates, updates };
}

const oneRoomSync = (roomId: string): SyncResult => ({
  nextBatch: "s2",
  rooms: [{ roomId, name: "Chat", memberIds: ["@whatsapp_9:hs"], messages: [{ sender: "@whatsapp_9:hs", body: "yo", ts: 5, eventId: "$x" }] }],
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
  assert.match(c.content, /yo/);
});

test("ingestMatrix UPDATES an existing note matched by matrixRoomId", async () => {
  const existing: Note = { id: "n1", content: "# Chat — whatsapp\n\nold", path: null, metadata: { type: "message-thread", matrixRoomId: "!exist:hs" }, tags: ["message-thread"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([existing]);
  const client = { sync: async () => oneRoomSync("!exist:hs") };
  const res = await ingestMatrix(client, fv.vault);
  assert.equal(res.created, 0);
  assert.equal(res.updated, 1);
  assert.equal(fv.updates[0]!.id, "n1");
  assert.match(fv.updates[0]!.content ?? "", /old[\s\S]*yo/); // appended, old preserved
});

test("ingestMatrix returns nextBatch and skips empty rooms", async () => {
  const client = {
    sync: async (): Promise<SyncResult> => ({ nextBatch: "s9", rooms: [{ roomId: "!empty:hs", name: "x", memberIds: [], messages: [] }] }),
  };
  const fv = fakeVault([]);
  const res = await ingestMatrix(client, fv.vault);
  assert.equal(res.nextBatch, "s9");
  assert.equal(res.created, 0);
  assert.equal(res.messages, 0);
});
