import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./helpers";
import { rebuildProjection, projectRoom, conversationIdFor, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { PeopleIndex } from "../src/worker/people";
import { listThreads, getThread, setOverride } from "../src/comms/store";
import { db } from "../src/db";
import type { Note } from "../src/parachute";

beforeEach(() => resetDb());

const ME = "@me:hs";
const note = (id: string, roomId: string, md: Record<string, unknown> = {}, tags = ["message-thread"]): Note => ({
  id, content: "", path: `Messages/${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags,
  metadata: { type: "message-thread", matrixRoomId: roomId, lastMessageAt: 1_760_000_000_000, lastMessageText: "hello", lastMessageSender: "@whatsapp_1:hs", lastMessageIsSelf: false, ...md },
});
const person = (id: string, title: string, md: Record<string, unknown>): Note => ({
  id, content: "", path: `People/${title}`, createdAt: "", updatedAt: null, tags: ["person"], displayTitle: title, metadata: md,
});

interface Room { profiles: Record<string, { name: string | null; avatar: string | null }>; state?: unknown[]; fail?: boolean; hang?: boolean }
function deps(notes: Note[], rooms: Record<string, Room>, people: Note[] = []): ProjectDeps {
  return {
    vault: { listByTag: async (tag) => notes.filter((n) => n.tags?.includes(tag)) },
    reader: {
      whoami: async () => ME,
      roomState: async (r) => { if (rooms[r]?.hang) await new Promise(() => {}); if (rooms[r]?.fail) throw new Error("boom"); return (rooms[r]?.state ?? []) as never; },
      memberProfiles: async (r) => rooms[r]!.profiles,
    },
    people: peopleAdapter(new PeopleIndex(people)),
  };
}
const dmRoom = (name: string | null = "Alice WA", avatar: string | null = "mxc://hs/alice"): Room => ({
  profiles: { [ME]: { name: "Me", avatar: null }, "@whatsapp_1:hs": { name, avatar } },
});

test("projects every message-thread note", async () => {
  const notes = [note("n1", "!a:hs"), note("n2", "!b:hs")];
  const r = await rebuildProjection(deps(notes, { "!a:hs": dmRoom(), "!b:hs": dmRoom("Bob") }));
  assert.deepEqual({ conversations: r.conversations, failed: r.failed, left: r.left }, { conversations: 2, failed: [], left: 0 });
  assert.equal(listThreads({ limit: 10 }).threads.length, 2);
  assert.equal(getThread(`th_${conversationIdFor("!a:hs")}`)?.title, "Alice WA");
});

test("skips archive notes", async () => {
  const notes = [note("n1", "!a:hs"), note("n2", "!b:hs", {}, ["message-thread", "message-archive"])];
  const r = await rebuildProjection(deps(notes, { "!a:hs": dmRoom(), "!b:hs": dmRoom() }));
  assert.equal(r.conversations, 1);
});

test("failed room is reported and does not abort rebuild", async () => {
  const notes = [note("n1", "!a:hs"), note("n2", "!b:hs"), note("n3", "!c:hs")];
  const r = await rebuildProjection(
    deps(notes, { "!a:hs": dmRoom(), "!b:hs": { ...dmRoom(), fail: true }, "!c:hs": { ...dmRoom(), hang: true } }),
    { roomTimeoutMs: 50 },
  );
  assert.equal(r.conversations, 1);
  assert.deepEqual(r.failed.sort(), ["!b:hs", "!c:hs"]);
});

test("person-linked DM gets person title and photo", async () => {
  const p = person("p1", "Alice Anderson", { matrixId: "@WhatsApp_1:hs", photo: "mxc://hs/person" });
  await rebuildProjection(deps([note("n1", "!a:hs")], { "!a:hs": dmRoom() }, [p]));
  const t = listThreads({ limit: 10 }).threads[0]!;
  assert.equal(t.title, "Alice Anderson");
  assert.equal(t.titleSource, "person");
  assert.deepEqual(t.avatar, { mxc: "mxc://hs/person" });
  assert.equal(t.folder, "inbox");
  assert.equal(t.lastMessage?.text, "hello");
  assert.deepEqual(t.unread, { count: 1, trusted: false });
});

test("unknown folder for unlinked never-replied DM", async () => {
  await rebuildProjection(deps([note("n1", "!a:hs"), note("n2", "!b:hs", { lastSelfReplyAt: 5 })], { "!a:hs": dmRoom(), "!b:hs": dmRoom() }));
  const by = Object.fromEntries(listThreads({ limit: 10 }).threads.map((t) => [t.id, t.folder]));
  assert.equal(by[`th_${conversationIdFor("!a:hs")}`], "unknown");
  assert.equal(by[`th_${conversationIdFor("!b:hs")}`], "inbox");
});

test("low triage tag and owner override", async () => {
  await rebuildProjection(deps([note("n1", "!a:hs", {}, ["message-thread", "low"])], { "!a:hs": dmRoom() }));
  const id = `th_${conversationIdFor("!a:hs")}`;
  assert.equal(getThread(id)?.folder, "low");
  setOverride(id, { folder: "inbox" } as never);
  await rebuildProjection(deps([note("n1", "!a:hs", {}, ["message-thread", "low"])], { "!a:hs": dmRoom() }));
  assert.equal(getThread(id)?.folder, "inbox");
});

test("group preview prefixes sender first name, self unread 0, no raw mxids", async () => {
  const room: Room = { profiles: { [ME]: { name: "Me", avatar: null }, "@a:hs": { name: "Ann Lee", avatar: null }, "@b:hs": { name: "Bo", avatar: null }, "@c:hs": { name: "Cy", avatar: null } },
    state: [{ type: "m.room.name", state_key: "", content: { name: "Crew" } }] };
  await rebuildProjection(deps([note("g", "!g:hs", { lastMessageSender: "@a:hs" }), note("s", "!s:hs", { lastMessageIsSelf: true, lastMessageSender: ME })], { "!g:hs": room, "!s:hs": room }));
  const g = getThread(`th_${conversationIdFor("!g:hs")}`)!;
  assert.equal(g.kind, "group");
  assert.equal(g.title, "Crew");
  assert.equal(g.lastMessage?.text, "Ann: hello");
  const s = getThread(`th_${conversationIdFor("!s:hs")}`)!;
  assert.equal(s.unread.count, 0);
  assert.equal(s.lastMessage?.text, "hello");
});

test("conversation id is lowercase base32, 20 chars, stable", () => {
  const id = conversationIdFor("!a:hs");
  assert.match(id, /^[a-z2-7]{20}$/);
  assert.equal(id, conversationIdFor("!a:hs"));
  assert.notEqual(id, conversationIdFor("!b:hs"));
});

test("rebuild is idempotent", async () => {
  const d = deps([note("n1", "!a:hs"), note("n2", "!b:hs")], { "!a:hs": dmRoom(), "!b:hs": dmRoom("Bob") });
  const snap = () => ({
    conv: db.prepare("SELECT * FROM comms_conversations ORDER BY id").all(),
    thr: db.prepare("SELECT * FROM comms_threads ORDER BY id").all(),
    mem: db.prepare("SELECT * FROM comms_thread_members ORDER BY thread_id").all(),
  });
  await rebuildProjection(d);
  const a = snap();
  await rebuildProjection(d);
  const events = () => (db.prepare("SELECT COUNT(*) n FROM comms_events").get() as { n: number }).n;
  const e1 = events();
  assert.equal(e1, 2);
  await rebuildProjection(d);
  assert.deepEqual(snap(), a);
  assert.equal(events(), e1);
  assert.equal(a.thr.length, 2);
});

test("projectRoom returns thread id and appends thread.updated", async () => {
  const n = note("n1", "!a:hs");
  const tid = await projectRoom(deps([n], { "!a:hs": dmRoom() }), "!a:hs", n);
  assert.equal(tid, `th_${conversationIdFor("!a:hs")}`);
  const ev = db.prepare("SELECT kind, thread_id FROM comms_events").all() as Array<{ kind: string }>;
  assert.ok(ev.some((e) => e.kind === "thread.updated"));
});

test("whoami failure fails fast and writes nothing", async () => {
  const d = deps([note("n1", "!a:hs")], { "!a:hs": dmRoom() });
  d.reader = { ...d.reader, whoami: async () => { throw new Error("401"); } };
  await assert.rejects(rebuildProjection(d), /401/);
  await assert.rejects(projectRoom(d, "!a:hs"), /401/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM comms_conversations").get() as { n: number }).n, 0);
});

test("ghost sender names never appear in group previews", async () => {
  const room: Room = { profiles: { [ME]: { name: "Me", avatar: null }, "@whatsapp_15551234567:hs": { name: "whatsapp_15551234567", avatar: null }, "@b:hs": { name: "Bo", avatar: null }, "@c:hs": { name: "Cy", avatar: null } } };
  await rebuildProjection(deps([note("g", "!g:hs", { lastMessageSender: "@whatsapp_15551234567:hs" })], { "!g:hs": room }));
  const t = getThread(`th_${conversationIdFor("!g:hs")}`)!;
  assert.equal(t.lastMessage?.text, "hello");
  assert.equal(t.lastMessage?.senderName, null);
});

test("S1: a rebuild flips a mis-kinded WhatsApp 'DM' (owner + 2 others) to a group titled by its room name", async () => {
  const roomId = "!grp:hs";
  const id = conversationIdFor(roomId);
  // A row an earlier build stored as a DM titled after one member.
  db.prepare(`INSERT INTO comms_conversations (id, network, source_ref, kind, title, title_source, last_event_at) VALUES (?, 'whatsapp', ?, 'dm', 'Dana Cruz', 'contact', '2026-01-01T00:00:00Z')`).run(id, roomId);
  const room: Room = {
    profiles: {
      [ME]: { name: "Me", avatar: null }, "@whatsappbot:hs": { name: "WhatsApp bridge bot", avatar: null },
      "@whatsapp_15550001111:hs": { name: "Dana Cruz", avatar: null }, "@whatsapp_15550002222:hs": { name: "Eli Park", avatar: null },
    },
    state: [{ type: "m.bridge", state_key: "b", content: { protocol: { id: "whatsapp" } } }, { type: "m.room.name", state_key: "", content: { name: "Family" } }],
  };
  const dana = person("p1", "Dana Cruz", { matrixId: "@whatsapp_15550001111:hs" });
  await rebuildProjection(deps([note("n1", roomId)], { [roomId]: room }, [dana]));
  const t = getThread(`th_${id}`)!;
  assert.deepEqual([t.kind, t.title, t.titleSource], ["group", "Family", "room"]);
  assert.equal(t.personId, undefined, "a group is nobody's DM");
});

test("S1: one contact as phone + LID ghost stays a DM titled after them", async () => {
  const roomId = "!lid:hs";
  const room: Room = {
    profiles: {
      [ME]: { name: "Me", avatar: null },
      "@whatsapp_15550001111:hs": { name: "Dana Cruz", avatar: null }, "@whatsapp_lid-123456789:hs": { name: "Dana Cruz", avatar: null },
    },
    state: [{ type: "m.bridge", state_key: "b", content: { protocol: { id: "whatsapp" } } }],
  };
  await rebuildProjection(deps([note("n1", roomId)], { [roomId]: room }));
  const t = getThread(`th_${conversationIdFor(roomId)}`)!;
  assert.deepEqual([t.kind, t.title], ["dm", "Dana Cruz"]);
});

// ── polish (Task 5): management rooms, Omni's bridge puppets ───────────────

test("a bridge management/status room (only the owner + bridge bots) is never listed; an existing row goes on rebuild", async () => {
  const notes = [note("n1", "!a:hs"), note("m", "!mgmt:hs", { lastMessageText: "Successfully synchronized chats for 123", lastMessageSender: "@telegrambot:hs" })];
  const mgmt: Room = { profiles: { [ME]: { name: "Me", avatar: null }, "@telegrambot:hs": { name: "Telegram bridge bot", avatar: null } } };
  // An earlier build listed it.
  const before = { ...mgmt, profiles: { ...mgmt.profiles, "@telegram_42:hs": { name: "Someone", avatar: null } } };
  await rebuildProjection(deps(notes, { "!a:hs": dmRoom(), "!mgmt:hs": before }));
  assert.ok(getThread(`th_${conversationIdFor("!mgmt:hs")}`), "listed while a person was in it");
  const r = await rebuildProjection(deps(notes, { "!a:hs": dmRoom(), "!mgmt:hs": mgmt }));
  assert.equal(getThread(`th_${conversationIdFor("!mgmt:hs")}`), null, "the management room is gone");
  assert.deepEqual(listThreads({ limit: 10 }).threads.map((t) => t.title), ["Alice WA"]);
  assert.equal(r.failed.length, 0);
  // A bare-named bot (@signal:hs) counts too; live projection answers "" (not projected).
  const bare: Room = { profiles: { [ME]: { name: "Me", avatar: null }, "@signal:hs": { name: "Signal", avatar: null } } };
  assert.equal(await projectRoom(deps([note("s", "!s:hs")], { "!s:hs": bare }), "!s:hs"), "");
  // A DM whose other person left (no bot) is still a conversation.
  const alone: Room = { profiles: { [ME]: { name: "Me", avatar: null } } };
  assert.notEqual(await projectRoom(deps([note("x", "!x:hs")], { "!x:hs": alone }), "!x:hs"), "");
});

test("Omni's bridge puppet (OMNI_AGENT_MATRIX_IDS) is the other side of the chat: not self, its messages not the owner's", async () => {
  const saved = process.env.OMNI_AGENT_MATRIX_IDS;
  process.env.OMNI_AGENT_MATRIX_IDS = "@telegram_777:hs";
  try {
    const bot: Room = { profiles: { [ME]: { name: "Me", avatar: null }, "@telegram_777:hs": { name: "Omni", avatar: null }, "@telegrambot:hs": { name: "bridge", avatar: null } } };
    const d = deps([note("o", "!o:hs", { lastMessageSender: "@telegram_777:hs", lastMessageIsSelf: true, lastMessageText: "Here is your brief" })], { "!o:hs": bot });
    d.extraSelfIds = ["@telegram_777:hs"]; // as production (project-deps: agentSenderIds())
    const id = await projectRoom(d, "!o:hs");
    assert.notEqual(id, "", "a real conversation, not a management room");
    const t = getThread(id)!;
    assert.equal(t.title, "Omni");
    assert.equal(t.lastMessage?.isSelf, false, "Omni's message is not the owner's");
  } finally {
    if (saved === undefined) delete process.env.OMNI_AGENT_MATRIX_IDS; else process.env.OMNI_AGENT_MATRIX_IDS = saved;
  }
});
