/**
 * Matrix → person linking (WP1.2 finding): the desktop's message_sync linked
 * every thread to its participants' person notes via person_linker; the server
 * ingester never ported it. Restored behind MATRIX_LINK_PEOPLE (default OFF).
 * Pinned here: off = byte-identical to before (no person reads, no links); on =
 * the desktop rule (create only in rooms of <=3 members, skip bridge bots) plus
 * one deviation (the sync user is not linked). Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestMatrix, participantLinks, isBridgeBot, MAX_MEMBERS_FOR_PERSON_CREATION, type IngestVault, type SyncResult } from "../src/worker/matrix";
import { PeopleIndex } from "../src/worker/people";
import { config } from "../src/config";
import type { Note, NoteLinkInput } from "../src/parachute";

function fakeVault(seed: Note[] = []) {
  const notes = [...seed];
  const creates: Array<{ path?: string; tags?: string[]; links?: NoteLinkInput[]; ifExists?: string }> = [];
  const updates: Array<{ id: string; links?: { add?: NoteLinkInput[] } }> = [];
  const lists: string[][] = [];
  const vault: IngestVault = {
    async listNotes(o) {
      lists.push(o.tags ?? []);
      return notes.filter((n) => !o.tags?.length || o.tags.some((t) => n.tags?.includes(t)));
    },
    async createNote(p) {
      creates.push(p);
      const hit = notes.find((n) => p.path && n.path === p.path);
      if (hit) {
        if (!p.ifExists || p.ifExists === "error") throw new Error("POST /notes: 409");
        return { ...hit, existed: true };
      }
      const n: Note = { id: `new-${creates.length}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
      notes.push(n);
      return n;
    },
    async updateNote(id, p) {
      updates.push({ id, links: p.links });
      return { id, content: p.content ?? "", path: null, metadata: p.metadata ?? null, tags: null, createdAt: "", updatedAt: "" };
    },
  };
  return { vault, creates, updates, lists, notes };
}

const SELF = "@owner:hs.example";
const room = (roomId: string): SyncResult => ({
  nextBatch: "s2",
  invites: [],
  rooms: [{ roomId, name: "Chat", memberIds: ["@telegram_42:hs.example"], displayNames: { "@telegram_42:hs.example": "Rin Example" }, messages: [{ sender: "@telegram_42:hs.example", body: "hi", ts: Date.UTC(2026, 0, 2), eventId: "$1" }] }],
});
const thread = (roomId: string): Note => ({ id: "t1", content: "# Chat\n\nold", path: "vault/messages/telegram/chat", metadata: { matrixRoomId: roomId }, tags: ["message-thread"], createdAt: "", updatedAt: "" });

test("MATRIX_LINK_PEOPLE defaults to off", () => {
  assert.equal(config.matrixLinkPeople, false);
});

test("off: no person reads, no joined-members call, no links — the pre-WP1.2 behaviour", async () => {
  const fv = fakeVault([thread("!r:hs")]);
  let membersCalls = 0;
  const client = { sync: async () => room("!r:hs"), joinedMembers: async () => (membersCalls++, {}) };
  const res = await ingestMatrix(client, fv.vault);
  assert.equal(res.updated, 1);
  assert.equal(membersCalls, 0);
  assert.equal(fv.lists.filter((l) => l.includes("person")).length, 0);
  assert.equal(fv.updates[0]!.links, undefined);
  assert.equal(res.peopleLinked, 0);
});

test("on, DM: the other side is created once and linked in the thread's own write; self + bridge bot skipped", async () => {
  const fv = fakeVault([thread("!dm:hs")]);
  const members = { [SELF]: "Owner", "@telegrambot:hs.example": "Telegram bridge bot", "@telegram_42:hs.example": "Rin Example (Telegram)" };
  const client = { sync: async () => room("!dm:hs"), joinedMembers: async () => members };
  const res = await ingestMatrix(client, fv.vault, { linkPeople: true, selfUserId: SELF });
  assert.equal(res.peopleCreated, 1);
  const person = fv.creates.find((c) => c.tags?.includes("person"))!;
  assert.equal(person.path, "vault/people/rin-example");
  assert.equal(person.ifExists, "ignore");
  assert.deepEqual(fv.updates[0]!.links, { add: [{ target: "new-1", relationship: "messages-with" }] });
  assert.equal(fv.updates.length, 1, "no separate link PATCH");

  // A second pass finds the person by Matrix id — nothing new is created.
  const again = await ingestMatrix(client, fv.vault, { linkPeople: true, selfUserId: SELF });
  assert.equal(again.peopleCreated, 0);
  assert.equal(fv.creates.filter((c) => c.tags?.includes("person")).length, 1);
});

test("on, group room (> 3 members): known people linked, nobody created", async () => {
  const known: Note = { id: "p-known", content: "# Known Person", path: "vault/people/known-person", metadata: { name: "Known Person" }, tags: ["person"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([thread("!grp:hs"), known]);
  const members = { [SELF]: "Owner", "@telegram_1:hs.example": "Known Person", "@telegram_2:hs.example": "Stranger One", "@telegram_3:hs.example": "Stranger Two", "@telegram_4:hs.example": "Stranger Three" };
  const res = await ingestMatrix({ sync: async () => room("!grp:hs"), joinedMembers: async () => members }, fv.vault, { linkPeople: true, selfUserId: SELF });
  assert.equal(res.peopleCreated, 0);
  assert.equal(fv.creates.length, 0);
  assert.deepEqual(fv.updates[0]!.links, { add: [{ target: "p-known", relationship: "messages-with" }] });
});

test("on, a new room's thread is created WITH its links", async () => {
  const fv = fakeVault();
  const members = { "@telegram_42:hs.example": "Rin Example" };
  await ingestMatrix({ sync: async () => room("!new:hs"), joinedMembers: async () => members }, fv.vault, { linkPeople: true });
  const t = fv.creates.find((c) => c.tags?.includes("message-thread"))!;
  assert.deepEqual(t.links, [{ target: "new-1", relationship: "messages-with" }]);
});

test("on, a joined-members failure skips linking but still ingests the room", async () => {
  const fv = fakeVault([thread("!r:hs")]);
  const res = await ingestMatrix({ sync: async () => room("!r:hs"), joinedMembers: async () => { throw new Error("matrix 502"); } }, fv.vault, { linkPeople: true });
  assert.equal(res.updated, 1);
  assert.equal(fv.updates[0]!.links, undefined);
});

test("participantLinks rules: bot detection, member cap, dedupe", async () => {
  assert.equal(isBridgeBot("@whatsappbot:hs"), true);
  assert.equal(isBridgeBot("@_discord_123:hs"), true);
  assert.equal(isBridgeBot("@telegram_5:hs"), false);
  assert.equal(MAX_MEMBERS_FOR_PERSON_CREATION, 3);
  const fv = fakeVault();
  const idx = new PeopleIndex();
  // Same human under two puppets → one link.
  const links = await participantLinks({ "@a:hs": "Pat Example", "@b:hs": "Pat Example (WA)" }, idx, fv.vault, { platform: "matrix" });
  assert.equal(links.length, 1);
  assert.equal(idx.created, 1);
});

test("new-thread path collision is resolved from the listing, not by eating a 409 (WP0.6)", async () => {
  const other: Note = { id: "o", content: "x", path: "vault/messages/telegram/chat", metadata: { matrixRoomId: "!other:hs" }, tags: ["message-thread"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([other]);
  await ingestMatrix({ sync: async () => room("!abcdef123:hs") }, fv.vault);
  assert.deepEqual(fv.creates.map((c) => c.path), ["vault/messages/telegram/chat-abcdef12"]);
});
