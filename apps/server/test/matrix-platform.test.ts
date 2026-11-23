/**
 * Matrix → vault thread platform (e2e staging O3) — see matrix-thread-identity.test.ts. Thread identity (e2e staging O3 + O4, both pre-existing on main):
 *  - O4: an unnamed room's thread note was titled by its room id ("# !abc:hs — whatsapp",
 *    a room-id path slug, no metadata.title). It now takes the Comms precedence
 *    (comms/naming.ts resolveTitle): person → room name → m.bridge channel name → member
 *    display names (never self/bots) → formatted handle. An existing note's PATH never
 *    changes; its title (metadata.title + a room-id heading) is repaired on its next ingest.
 *  - O3: `metadata.platform` flipped "whatsapp" → "matrix" after an incremental batch whose
 *    members were only the owner and the bridge bot. A specific platform is never downgraded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestMatrix, type IngestVault, type MatrixEvent, type SyncResult } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

const OWNER = "@owner:hs";
const BOT = "@whatsappbot:hs";
const GHOST = "@whatsapp_15550001:hs";

function fakeVault(seed: Note[] = []) {
  const creates: Array<{ path?: string; metadata?: Record<string, unknown>; content: string }> = [];
  const updates: Array<{ id: string; content?: string; metadata?: Record<string, unknown>; path?: string }> = [];
  const notes = new Map(seed.map((n) => [n.id, n]));
  const vault: IngestVault = {
    async listNotes() {
      return [...notes.values()];
    },
    async createNote(p) {
      creates.push(p);
      const n: Note = { id: `new-${creates.length}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
      notes.set(n.id, n);
      return n;
    },
    async updateNote(id, p) {
      updates.push({ id, ...p });
      const prev = notes.get(id)!;
      const n: Note = { ...prev, content: p.content ?? prev.content, metadata: { ...(prev.metadata ?? {}), ...(p.metadata ?? {}) } };
      notes.set(id, n);
      return n;
    },
  };
  return { vault, creates, updates, notes };
}

const bridge = (protocol: string, channel?: string): MatrixEvent => ({
  type: "m.bridge",
  state_key: "x",
  content: { protocol: { id: protocol }, ...(channel ? { channel: { id: "c", displayname: channel } } : {}) },
});

function sync(roomId: string, opts: { name?: string | null; memberIds: string[]; displayNames?: Record<string, string>; sender: string; body?: string; ts?: number }): SyncResult {
  return {
    nextBatch: "s2",
    invites: [],
    rooms: [{
      roomId,
      name: opts.name ?? null,
      memberIds: opts.memberIds,
      displayNames: opts.displayNames ?? {},
      messages: [{ sender: opts.sender, body: opts.body ?? "hi", ts: opts.ts ?? Date.UTC(2026, 10, 21, 9, 0), eventId: `$${opts.ts ?? 1}` }],
    }],
  };
}

/** A client whose full room state and joined members are known (the identity reads). */
function client(s: SyncResult, room: { state?: MatrixEvent[]; members: Record<string, string> }) {
  const calls = { roomState: 0 };
  return {
    calls,
    sync: async () => s,
    roomState: async () => { calls.roomState++; return room.state ?? []; },
    joinedMembers: async () => room.members,
    whoami: async () => OWNER,
  };
}

test("platform stays whatsapp across an incremental batch whose members are only self + bot", async () => {
  const existing: Note = {
    id: "w1", path: "vault/messages/whatsapp/alice-example",
    content: "# Alice Example — whatsapp\n\n[2026-11-20 08:00] Alice Example: old",
    metadata: { type: "message-thread", platform: "whatsapp", matrixRoomId: "!wa:hs", title: "Alice Example", messageCount: 1 },
    tags: ["message-thread"], createdAt: "", updatedAt: "u1",
  };
  const fv = fakeVault([existing]);
  const s = sync("!wa:hs", { memberIds: [OWNER, BOT], displayNames: { [OWNER]: "Owner" }, sender: OWNER, body: "reply" });
  // A client with no state reads at all: the stored platform is all there is.
  await ingestMatrix({ sync: async () => s }, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.platform, "whatsapp");
  assert.equal(fv.notes.get("w1")!.metadata?.platform, "whatsapp");
});

test("a genuinely plain Matrix room stays matrix", async () => {
  const fv = fakeVault();
  const alice = "@alice:hs";
  const s = sync("!plain:hs", { memberIds: [OWNER, alice], displayNames: { [alice]: "alice" }, sender: alice });
  await ingestMatrix(client(s, { state: [], members: { [OWNER]: "", [alice]: "alice" } }), fv.vault, { selfUserId: OWNER });
  const c = fv.creates[0]!;
  assert.equal(c.metadata?.platform, "matrix");
  // …and an incremental batch keeps it matrix.
  const s2 = sync("!plain:hs", { memberIds: [], displayNames: { [alice]: "alice" }, sender: alice, body: "more", ts: Date.UTC(2026, 10, 21, 11, 0) });
  await ingestMatrix({ sync: async () => s2 }, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.platform, "matrix");
});
