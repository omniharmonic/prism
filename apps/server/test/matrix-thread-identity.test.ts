/**
 * Matrix → vault thread identity (e2e staging O3 + O4, both pre-existing on main):
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
import { ingestMatrix, reconcileMatrix, type IngestVault, type MatrixEvent, type SyncResult } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

const OWNER = "@owner:hs";
const BOT = "@whatsappbot:hs";
const GHOST = "@whatsapp_15550001:hs";

function fakeVault(seed: Note[] = []) {
  const creates: Array<{ path?: string; metadata?: Record<string, unknown>; content: string }> = [];
  const updates: Array<{ id: string; content?: string; metadata?: Record<string, unknown>; path?: string }> = [];
  const notes = new Map(seed.map((n) => [n.id, n]));
  const vault: IngestVault = {
    async listNotes(o) {
      return [...notes.values()].filter((n) => (o.tags ?? []).every((t) => n.tags?.includes(t)));
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
  const calls = { roomState: 0, joinedMembers: 0 };
  return {
    calls,
    sync: async () => s,
    roomState: async () => { calls.roomState++; return room.state ?? []; },
    joinedMembers: async () => { calls.joinedMembers++; return room.members; },
    whoami: async () => OWNER,
  };
}

test("an unnamed WhatsApp DM is titled by the ghost's display name, not its room id", async () => {
  const fv = fakeVault();
  const s = sync("!QLTRRETypGHBxCMovE:hs", { memberIds: [OWNER, GHOST, BOT], displayNames: { [GHOST]: "Alice Example" }, sender: GHOST });
  await ingestMatrix(client(s, { state: [bridge("whatsapp")], members: { [OWNER]: "Owner", [GHOST]: "Alice Example", [BOT]: "WhatsApp bridge bot" } }), fv.vault, { selfUserId: OWNER });
  const c = fv.creates[0]!;
  assert.equal(c.metadata?.title, "Alice Example");
  assert.equal(c.metadata?.platform, "whatsapp");
  assert.match(c.content, /^# Alice Example — whatsapp\n/);
  assert.equal(c.path, "vault/messages/whatsapp/alice-example");
  assert.doesNotMatch(c.content, /!QLTRRE/);
});

test("an unnamed bridged DM takes the m.bridge channel name over a ghost-id display name", async () => {
  const fv = fakeVault();
  const s = sync("!dm2:hs", { memberIds: [OWNER, GHOST, BOT], displayNames: { [GHOST]: "whatsapp_15550001" }, sender: GHOST });
  await ingestMatrix(client(s, { state: [bridge("whatsapp", "Alice Example")], members: { [OWNER]: "", [GHOST]: "whatsapp_15550001", [BOT]: "" } }), fv.vault, { selfUserId: OWNER });
  assert.equal(fv.creates[0]!.metadata?.title, "Alice Example");
});

test("an unnamed DM whose ghost has no display name gets a formatted phone handle", async () => {
  const fv = fakeVault();
  const s = sync("!dm3:hs", { memberIds: [OWNER, GHOST, BOT], sender: GHOST });
  // No whoami-free self: the owner is found by whoami (no selfUserId passed).
  await ingestMatrix(client(s, { state: [bridge("whatsapp")], members: { [OWNER]: "Owner Name", [GHOST]: "", [BOT]: "" } }), fv.vault);
  const c = fv.creates[0]!;
  assert.equal(c.metadata?.title, "+1 555-0001");
  assert.match(c.content, /^# \+1 555-0001 — whatsapp\n/);
  assert.doesNotMatch(String(c.metadata?.title), /whatsapp_|!dm3|Owner Name/);
});

test("a named group keeps its room name", async () => {
  const fv = fakeVault();
  const a = "@telegram_111:hs", b = "@telegram_222:hs";
  const s = sync("!grp:hs", { name: "Trail Crew", memberIds: [OWNER, a, b], displayNames: { [a]: "alice", [b]: "bob" }, sender: a });
  await ingestMatrix(client(s, { state: [bridge("telegram"), { type: "m.room.name", state_key: "", content: { name: "Trail Crew" } }], members: { [OWNER]: "", [a]: "alice", [b]: "bob" } }), fv.vault, { selfUserId: OWNER });
  const c = fv.creates[0]!;
  assert.equal(c.metadata?.title, "Trail Crew");
  assert.equal(c.path, "vault/messages/telegram/trail-crew");
  assert.match(c.content, /^# Trail Crew — telegram\n/);
});

test("an existing note titled by its room id is repaired on its next ingest; its path never changes", async () => {
  const roomId = "!QLTRRETypGHBxCMovE:hs";
  const existing: Note = {
    id: "t1",
    path: "vault/messages/whatsapp/qltrretypghbxcmove-hs",
    content: `# ${roomId} — whatsapp\n\n[2026-11-20 08:00] Alice Example: old`,
    metadata: { type: "message-thread", platform: "whatsapp", matrixRoomId: roomId, messageCount: 1, participants: ["Alice Example"] },
    tags: ["message-thread"], createdAt: "", updatedAt: "u1",
  };
  const fv = fakeVault([existing]);
  const s = sync(roomId, { memberIds: [GHOST], displayNames: { [GHOST]: "Alice Example" }, sender: GHOST, ts: Date.UTC(2026, 10, 21, 9, 0) });
  const c = client(s, { state: [bridge("whatsapp")], members: { [OWNER]: "", [GHOST]: "Alice Example", [BOT]: "" } });
  await ingestMatrix(c, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.creates.length, 0, "no new note");
  const u = fv.updates[0]!;
  assert.equal(u.id, "t1");
  assert.equal(u.path, undefined, "the path is never rewritten");
  assert.equal(u.metadata?.title, "Alice Example");
  assert.match(u.content ?? "", /^# Alice Example — whatsapp\n\n\[2026-11-20 08:00\] Alice Example: old\n\[2026-11-21 09:00\] Alice Example: hi$/);
  assert.equal(fv.notes.get("t1")!.path, existing.path);
  assert.deepEqual(c.calls, { roomState: 1, joinedMembers: 1 }, "exactly one state read and one members read");

  // Idempotent: the next message neither re-reads the room state nor touches the title again.
  const s2 = sync(roomId, { memberIds: [], sender: GHOST, displayNames: { [GHOST]: "Alice Example" }, body: "again", ts: Date.UTC(2026, 10, 21, 10, 0) });
  const c2 = client(s2, { state: [bridge("whatsapp")], members: {} });
  await ingestMatrix(c2, fv.vault, { selfUserId: OWNER });
  assert.deepEqual(c2.calls, { roomState: 0, joinedMembers: 0 }, "and then none");
  assert.equal(fv.updates[1]!.metadata?.title, "Alice Example");
  assert.match(fv.updates[1]!.content ?? "", /^# Alice Example — whatsapp\n/);
});

test("an untitled note with a human heading adopts it as its title, with no Matrix read", async () => {
  const existing: Note = {
    id: "t2", path: "vault/messages/telegram/trail-crew",
    content: "# Trail Crew — telegram\n\n[2026-11-20 08:00] alice: old",
    metadata: { type: "message-thread", platform: "telegram", matrixRoomId: "!grp:hs", messageCount: 1 },
    tags: ["message-thread"], createdAt: "", updatedAt: "u1",
  };
  const fv = fakeVault([existing]);
  const a = "@telegram_111:hs";
  const s = sync("!grp:hs", { memberIds: [], displayNames: { [a]: "alice" }, sender: a });
  const c = client(s, { state: [bridge("telegram", "Somewhere Else")], members: { [OWNER]: "", [a]: "alice", "@telegram_2:hs": "bob" } });
  await ingestMatrix(c, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.title, "Trail Crew", "the human heading is adopted as the title");
  assert.deepEqual(c.calls, { roomState: 0, joinedMembers: 0 }, "with no Matrix read (I1a: no read wave at cutover)");
  assert.match(fv.updates[0]!.content ?? "", /^# Trail Crew — telegram\n/);
});

test("when the room state is read, the m.bridge protocol decides the platform", async () => {
  const existing: Note = {
    id: "w2", path: "vault/messages/matrix/abc",
    content: "# !abc:hs — matrix\n\n[2026-11-20 08:00] x: old",
    metadata: { type: "message-thread", platform: "matrix", matrixRoomId: "!abc:hs", messageCount: 1 },
    tags: ["message-thread"], createdAt: "", updatedAt: "u1",
  };
  const fv = fakeVault([existing]);
  const s = sync("!abc:hs", { memberIds: [OWNER, BOT], sender: OWNER });
  await ingestMatrix(client(s, { state: [bridge("whatsapp")], members: { [OWNER]: "", [BOT]: "", [GHOST]: "Alice Example" } }), fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.platform, "whatsapp");
  assert.equal(fv.notes.get("w2")!.path, "vault/messages/matrix/abc", "path unchanged");
});

test("a plain Matrix DM is titled by the other member, never the room id", async () => {
  const fv = fakeVault();
  const alice = "@alice:hs";
  const s = sync("!plain:hs", { memberIds: [OWNER, alice], displayNames: { [alice]: "alice" }, sender: alice });
  await ingestMatrix(client(s, { state: [], members: { [OWNER]: "", [alice]: "alice" } }), fv.vault, { selfUserId: OWNER });
  const c = fv.creates[0]!;
  assert.equal(c.metadata?.platform, "matrix");
  assert.equal(c.metadata?.title, "alice");
  assert.equal(c.path, "vault/messages/matrix/alice");
});

// ── round 1: reads that fail, back-off, renames, the owner ─────────────────────

const roomIdNote = (roomId: string, meta: Record<string, unknown> = {}): Note => ({
  id: "r1", path: "vault/messages/whatsapp/x-hs",
  content: `# ${roomId} — whatsapp\n\n[2026-11-20 08:00] x: old`,
  metadata: { type: "message-thread", platform: "whatsapp", matrixRoomId: roomId, messageCount: 1, ...meta },
  tags: ["message-thread"], createdAt: "", updatedAt: "u1",
});

test("both identity reads fail: no title is persisted (no guess from member deltas), a back-off marker is", async () => {
  const roomId = "!fail:hs";
  const fv = fakeVault([roomIdNote(roomId)]);
  const calls = { roomState: 0, joinedMembers: 0 };
  const failing = (s: SyncResult) => ({
    sync: async () => s,
    roomState: async () => { calls.roomState++; throw new Error("502"); },
    joinedMembers: async () => { calls.joinedMembers++; throw new Error("502"); },
  });
  // The batch's deltas would make this look like a DM with "Bob Delta" — that must not stick.
  const s = sync(roomId, { memberIds: ["@whatsapp_2:hs"], displayNames: { "@whatsapp_2:hs": "Bob Delta" }, sender: "@whatsapp_2:hs" });
  await ingestMatrix(failing(s), fv.vault, { selfUserId: OWNER });
  const u = fv.updates[0]!;
  assert.equal(u.metadata?.title, undefined);
  assert.equal(typeof u.metadata?.titleCheckedAt, "number");
  assert.equal(u.metadata?.titleChecks, 1);
  assert.match(u.content ?? "", new RegExp(`^# ${roomId.replace(/[!]/g, "\\$&")} — whatsapp`), "heading untouched");
  assert.deepEqual(calls, { roomState: 1, joinedMembers: 1 });

  // M4: the next batch, inside the back-off, reads nothing.
  await ingestMatrix(failing(sync(roomId, { memberIds: [], displayNames: { "@whatsapp_2:hs": "Bob Delta" }, sender: "@whatsapp_2:hs", body: "b", ts: 5 })), fv.vault, { selfUserId: OWNER });
  assert.deepEqual(calls, { roomState: 1, joinedMembers: 1 });
  assert.equal(fv.updates[1]!.metadata?.title, undefined);
});

test("past the back-off an unresolved room is read again, and resolves", async () => {
  const roomId = "!later:hs";
  const fv = fakeVault([roomIdNote(roomId, { titleCheckedAt: 1, titleChecks: 1 })]);
  const s = sync(roomId, { memberIds: [GHOST], displayNames: { [GHOST]: "Alice Example" }, sender: GHOST });
  const c = client(s, { state: [bridge("whatsapp")], members: { [OWNER]: "", [GHOST]: "Alice Example" } });
  await ingestMatrix(c, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.title, "Alice Example");
  assert.deepEqual(c.calls, { roomState: 1, joinedMembers: 1 });
});

test("one identity read succeeding is enough to persist a title", async () => {
  const roomId = "!half:hs";
  const fv = fakeVault([roomIdNote(roomId)]);
  const s = sync(roomId, { memberIds: [GHOST], displayNames: { [GHOST]: "Alice Example" }, sender: GHOST });
  await ingestMatrix({ sync: async () => s, roomState: async () => { throw new Error("timeout"); }, joinedMembers: async () => ({ [OWNER]: "", [GHOST]: "Alice Example", [BOT]: "" }) }, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.title, "Alice Example");
});

test("identity reads that never answer are abandoned at the identity timeout; the batch is still written", async () => {
  const roomId = "!hang:hs";
  const fv = fakeVault([roomIdNote(roomId)]);
  const never = () => new Promise<never>(() => {});
  const s = sync(roomId, { memberIds: [GHOST], displayNames: { [GHOST]: "Alice Example" }, sender: GHOST });
  const res = await ingestMatrix({ sync: async () => s, roomState: never, joinedMembers: never, whoami: never }, fv.vault, { identityTimeoutMs: 20 });
  assert.equal(res.updated, 1);
  assert.equal(fv.updates[0]!.metadata?.title, undefined);
  assert.equal(fv.updates[0]!.metadata?.titleChecks, 1);
});

test("a batch carrying a new m.room.name renames the stored title, with no read (M5); the path stays", async () => {
  const existing: Note = {
    id: "g1", path: "vault/messages/telegram/trail-crew",
    content: "# Trail Crew — telegram\n\n[2026-11-20 08:00] alice: old",
    metadata: { type: "message-thread", platform: "telegram", matrixRoomId: "!grp:hs", title: "Trail Crew", messageCount: 1 },
    tags: ["message-thread"], createdAt: "", updatedAt: "u1",
  };
  const fv = fakeVault([existing]);
  const a = "@telegram_111:hs";
  const s = sync("!grp:hs", { name: "Trail Crew 2027", memberIds: [], displayNames: { [a]: "alice" }, sender: a });
  const c = client(s, { state: [], members: {} });
  await ingestMatrix(c, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.title, "Trail Crew 2027");
  assert.match(fv.updates[0]!.content ?? "", /^# Trail Crew 2027 — telegram\n/, "the heading that read the old title follows");
  assert.deepEqual(c.calls, { roomState: 0, joinedMembers: 0 });
  assert.equal(fv.notes.get("g1")!.path, "vault/messages/telegram/trail-crew");
});

const OWNER_GHOST = "@whatsapp_19990000000:hs";

test("the owner's own bridge ghost never names a DM (ownerSenderIds), whatever the member order", async () => {
  const fv = fakeVault();
  const s = sync("!dmo:hs", { memberIds: [OWNER_GHOST, GHOST], displayNames: { [GHOST]: "Alice Example", [OWNER_GHOST]: "Owner Name" }, sender: GHOST });
  // joined_members lists the owner's ghost FIRST.
  const c = client(s, { state: [bridge("whatsapp")], members: { [OWNER_GHOST]: "Owner Name", [OWNER]: "", [GHOST]: "Alice Example", [BOT]: "" } });
  await ingestMatrix(c, fv.vault, { selfUserId: OWNER, ownerSenderIds: () => [OWNER, OWNER_GHOST] });
  assert.equal(fv.creates[0]!.metadata?.title, "Alice Example");
});

test("the owner's own person note never names a DM, nor makes its member a counterpart", async () => {
  const ownerNote: Note = { id: "p-owner", path: "vault/people/owner-name", content: "# Owner Name", metadata: { name: "Owner Name", matrixId: OWNER_GHOST }, tags: ["person"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([ownerNote]);
  const s = sync("!dmp:hs", { memberIds: [OWNER_GHOST, GHOST], displayNames: { [GHOST]: "Alice Example" }, sender: GHOST });
  const c = client(s, { state: [bridge("whatsapp")], members: { [OWNER_GHOST]: "Owner Name", [OWNER]: "", [GHOST]: "Alice Example" } });
  // ownerSenderIds does not know the ghost; the owner's person note does.
  await ingestMatrix(c, fv.vault, { selfUserId: OWNER, ownerSenderIds: () => [OWNER], titleOwnerPersonId: () => "p-owner" });
  assert.equal(fv.creates[0]!.metadata?.title, "Alice Example");
});

test("the reconcile sweep titles with the same self: the owner's ghost never names a DM", async () => {
  const fv = fakeVault();
  const msg = { sender: GHOST, body: "hi", ts: 1_000, eventId: "$r1" };
  const c = {
    joinedRooms: async () => ["!rdm:hs"],
    messagesBefore: async () => ({ messages: [msg], capped: false }),
    joinedMembers: async () => ({ [OWNER_GHOST]: "Owner Name", [OWNER]: "", [GHOST]: "Alice Example", [BOT]: "" }),
    roomName: async () => null,
    roomState: async () => [bridge("whatsapp")],
    whoami: async () => OWNER,
  };
  await reconcileMatrix(c, fv.vault, { upTo: "cursor", ownerSenderIds: () => [OWNER, OWNER_GHOST], identityKey: "t-reconcile" });
  assert.equal(fv.creates.length, 1);
  assert.equal(fv.creates[0]!.metadata?.title, "Alice Example");
  assert.equal(fv.creates[0]!.metadata?.platform, "whatsapp");
});

// ── round 2: member list only from a full read; per-pass breaker ───────────────

const member = (id: string, displayname: string): MatrixEvent => ({ type: "m.room.member", state_key: id, content: { membership: "join", displayname } });

test("state read ok + joined_members failing: the state's own members name an unnamed group in full", async () => {
  const fv = fakeVault();
  const [a, b, c] = ["@telegram_1:hs", "@telegram_2:hs", "@telegram_3:hs"];
  // The batch's deltas know only Ann: a delta-derived title would be "Ann" for good.
  const s = sync("!g3:hs", { memberIds: [a], displayNames: { [a]: "Ann" }, sender: a });
  const state = [bridge("telegram"), member(OWNER, "Owner"), member(a, "Ann"), member(b, "Ben"), member(c, "Cat"), { type: "m.room.member", state_key: "@telegram_4:hs", content: { membership: "leave", displayname: "Gone" } }];
  await ingestMatrix({ sync: async () => s, roomState: async () => state, joinedMembers: async () => { throw new Error("502"); } }, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.creates[0]!.metadata?.title, "Ann, Ben & Cat");
});

test("no full member list (state without members, joined_members failing): nothing persisted, back-off marker", async () => {
  const roomId = "!nomem:hs";
  const fv = fakeVault([roomIdNote(roomId)]);
  const s = sync(roomId, { memberIds: ["@whatsapp_2:hs"], displayNames: { "@whatsapp_2:hs": "Bob Delta" }, sender: "@whatsapp_2:hs" });
  await ingestMatrix({ sync: async () => s, roomState: async () => [bridge("whatsapp")], joinedMembers: async () => { throw new Error("502"); } }, fv.vault, { selfUserId: OWNER });
  assert.equal(fv.updates[0]!.metadata?.title, undefined);
  assert.equal(fv.updates[0]!.metadata?.titleChecks, 1);
});

test("a hung homeserver: after 3 unanswered identity reads the pass reads no more, and still writes every room", async () => {
  const fv = fakeVault();
  const calls = { roomState: 0, joinedMembers: 0 };
  const never = () => new Promise<never>(() => {});
  const rooms = Array.from({ length: 10 }, (_, i) => sync(`!h${i}:hs`, { memberIds: [GHOST], displayNames: { [GHOST]: "Alice Example" }, sender: GHOST, ts: 1000 + i }).rooms[0]!);
  const res = await ingestMatrix({
    sync: async () => ({ nextBatch: "s2", invites: [], rooms }),
    roomState: () => { calls.roomState++; return never(); },
    joinedMembers: () => { calls.joinedMembers++; return never(); },
  }, fv.vault, { selfUserId: OWNER, identityTimeoutMs: 20 });
  assert.equal(res.created, 10);
  assert.deepEqual(calls, { roomState: 3, joinedMembers: 3 });
  const checked = fv.creates.filter((c) => c.metadata?.titleChecks === 1).length;
  assert.equal(checked, 3, "only the rooms actually read get a back-off marker; the skipped ones are read next pass");
  assert.ok(fv.creates.every((c) => c.metadata?.title === undefined));
});
