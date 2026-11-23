// Regressions found by verifying Comms against production data (2026-11-22). Synthetic fixtures
// only: every id, name and text below is invented; the SHAPES reproduce what production holds.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { rebuildProjection, projectRoom, conversationIdFor, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { detectOwnerPuppets, detectOwners, reconcileOwners, type RoomMembers } from "../src/comms/owner-detect";
import { commsSelfIds, storedOwnerSenders, storedOwnerSenderRows } from "../src/comms/owner";
import { PROFILE_RETAIN_MAX_MEMBERS } from "../src/comms/project";
import { looksLikeId, resolveTitle, formatHandle } from "../src/comms/naming";
import { PeopleIndex } from "../src/worker/people";
import { getThread, listThreads, upsertConversation, ensureSingleThread } from "../src/comms/store";
import { handleLiveBatch, type LiveDeps } from "../src/comms/live";
import { setCommsReaderForTests, type CommsReader } from "../src/comms/timeline";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, resolveVaultEntry } from "../src/db";
import { putSecret } from "../src/secrets";
import type { MatrixEvent } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

const prevComms = process.env.COMMS_ENABLED;
beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; delete process.env.COMMS_OWNER_GHOSTS; delete process.env.COMMS_OWNER_DETECT; });
afterEach(() => {
  setCommsReaderForTests(null);
  delete process.env.COMMS_OWNER_GHOSTS;
  delete process.env.COMMS_OWNER_DETECT;
  if (prevComms === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prevComms;
});

// The Matrix account the bridges are logged into is the agent's own user (whoami), and the
// owner's own words arrive from his OWN bridge ghosts (no double puppeting): one per network,
// a member of (nearly) every portal of that network.
const ME = "@agent:hs";
const OWN_TG = "@telegram_900001:hs";
const OWN_WA = "@whatsapp_15550009999:hs";
const tgContact = (i: number) => `@telegram_${100000 + i}:hs`;
const waContact = (i: number) => `@whatsapp_1555000${String(i).padStart(4, "0")}:hs`;
const TG_BOT = "@telegrambot:hs";
const WA_BOT = "@whatsappbot:hs";

const ts = (n: number) => 1_790_000_000_000 + n * 1000;
const ev = (id: string, n: number, sender: string, type: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}): MatrixEvent =>
  ({ event_id: id, origin_server_ts: ts(n), sender, type, content, ...extra }) as MatrixEvent;
const text = (id: string, n: number, sender: string, body: string) => ev(id, n, sender, "m.room.message", { msgtype: "m.text", body });

const note = (id: string, roomId: string, md: Record<string, unknown> = {}): Note => ({
  id, content: "", path: `Messages/${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: ["message-thread"],
  metadata: { type: "message-thread", matrixRoomId: roomId, lastMessageAt: ts(50), ...md },
});
const dmState = (proto: string): unknown[] => [
  { type: "m.bridge", state_key: "x", content: { protocol: { id: proto }, "com.beeper.room_type": "dm" } },
];

interface Room { profiles: Record<string, { name: string | null; avatar: string | null }>; state?: unknown[]; events?: MatrixEvent[]; forbidden?: boolean }
function deps(notes: Note[], rooms: Record<string, Room>, opts: { joined?: string[]; people?: Note[]; timelineCalls?: string[] } = {}): ProjectDeps {
  const forbidden = (r: string) => { if (rooms[r]?.forbidden || !rooms[r]) throw new Error(`matrix /rooms/${encodeURIComponent(r)}/state → 403`); };
  return {
    vault: { listByTag: async (tag) => notes.filter((n) => n.tags?.includes(tag)) },
    reader: {
      whoami: async () => ME,
      roomState: async (r) => { forbidden(r); return (rooms[r]!.state ?? []) as never; },
      memberProfiles: async (r) => { forbidden(r); return rooms[r]!.profiles; },
      timelinePage: async (r) => { opts.timelineCalls?.push(r); forbidden(r); return { chunk: [...(rooms[r]!.events ?? [])].reverse(), start: "s", end: null }; },
      ...(opts.joined ? { joinedRooms: async () => opts.joined! } : {}),
    },
    people: peopleAdapter(new PeopleIndex(opts.people ?? [])),
  };
}
const p = (name: string | null) => ({ name, avatar: null });

/** Ten Telegram and ten WhatsApp DMs, one per contact; the owner's ghosts sit in all of them. */
function fleet(): { notes: Note[]; rooms: Record<string, Room> } {
  const notes: Note[] = [];
  const rooms: Record<string, Room> = {};
  for (let i = 0; i < 10; i++) {
    const tg = `!tg${i}:hs`, wa = `!wa${i}:hs`;
    rooms[tg] = { state: dmState("telegram"), profiles: { [ME]: p("Agent"), [TG_BOT]: p("Telegram bridge"), [OWN_TG]: p("Owen Owner"), [tgContact(i)]: p(`Contact T${i}`) } };
    rooms[wa] = { state: dmState("whatsapp"), profiles: { [ME]: p("Agent"), [WA_BOT]: p("WhatsApp bridge"), [OWN_WA]: p("Owen Owner"), [waContact(i)]: p(`Contact W${i}`) } };
    notes.push(note(`ntg${i}`, tg, { lastMessageText: `hi from T${i}`, lastMessageSender: tgContact(i), lastMessageIsSelf: false }));
    notes.push(note(`nwa${i}`, wa, { lastMessageText: `hi from W${i}`, lastMessageSender: waContact(i), lastMessageIsSelf: false }));
  }
  return { notes, rooms };
}

// ── 1. the owner's own bridge ghosts are self ──────────────────────────────────────────────

test("detectOwnerPuppets: the ghost in (nearly) every portal of a network is the owner's", () => {
  const { rooms } = fleet();
  const lists = Object.values(rooms).map((r) => Object.keys(r.profiles));
  assert.deepEqual(detectOwnerPuppets(lists, [ME]).sort(), [OWN_TG, OWN_WA].sort());
});

const tgDm = (contact: string, own: string | null = OWN_TG) => [ME, TG_BOT, contact, ...(own ? [own] : [])];
const waDm = (contact: string, own: string | null = OWN_WA) => [ME, WA_BOT, contact, ...(own ? [own] : [])];

test("detectOwners: a spouse's DM + family groups (spouse + 1 each) is never the owner (no owner ghost)", () => {
  const SPOUSE = waContact(1);
  // Review round 1, I1: all four rooms hold ≤ 2 ghosts (DM-like) and the spouse is in every one.
  const small = [waDm(SPOUSE, null), ...[2, 3, 4].map((i) => [ME, WA_BOT, SPOUSE, waContact(i)])];
  assert.deepEqual(detectOwnerPuppets(small, [ME]), []);
  // The same household at the size gate: 1 DM + 10 groups of spouse + 1 other each, plus the
  // other contacts' own DMs — every contact's DM holds only that contact.
  const big = [waDm(SPOUSE, null), ...Array.from({ length: 10 }, (_, i) => [ME, WA_BOT, SPOUSE, waContact(10 + i)])];
  for (let i = 0; i < 10; i++) big.push(waDm(waContact(30 + i), null));
  assert.deepEqual(detectOwnerPuppets(big, [ME]), []);
});

test("detectOwners: a frequent contact in big groups fails the share and dominance gates", () => {
  // No owner ghost; one contact in 9 of 12 big groups + 3 DMs of others: share 0.6, DM share 0.
  const lists: string[][] = [];
  for (let i = 0; i < 9; i++) lists.push([ME, TG_BOT, tgContact(1), tgContact(10 + i), tgContact(20 + i), tgContact(30 + i)]);
  for (let i = 0; i < 3; i++) lists.push(tgDm(tgContact(40 + i), null));
  assert.deepEqual(detectOwnerPuppets(lists, [ME]), []);
  // Owner ghost in all 12 DMs, but a housemate in 7 of them too: 12 < 2 × 7 → not dominant, nothing guessed.
  const shared: string[][] = [];
  for (let i = 0; i < 12; i++) shared.push(i < 7 ? [ME, TG_BOT, OWN_TG, tgContact(1)] : tgDm(tgContact(50 + i)));
  assert.deepEqual(detectOwnerPuppets(shared, [ME]), []);
  // Below 80 % of the portals: not the owner.
  const partial: string[][] = [];
  for (let i = 0; i < 12; i++) partial.push(tgDm(tgContact(60 + i), i < 9 ? OWN_TG : null));
  assert.deepEqual(detectOwnerPuppets(partial, [ME]), []);
  // Too few portals to tell: nothing is guessed.
  assert.deepEqual(detectOwnerPuppets(Array.from({ length: 9 }, (_, i) => tgDm(tgContact(i))), [ME]), []);
  // Excluded ids (the agent's own relays) are never picked.
  const { rooms } = fleet();
  assert.deepEqual(detectOwnerPuppets(Object.values(rooms).map((r) => Object.keys(r.profiles)), [ME, OWN_TG]), [OWN_WA]);
});

test("detectOwners: alone in more than one DM-like portal = a contact, not the owner", () => {
  const lists = Array.from({ length: 12 }, (_, i) => tgDm(tgContact(i)));
  lists.push([ME, TG_BOT, OWN_TG]); // one note-to-self room is fine
  assert.deepEqual(detectOwnerPuppets(lists, [ME]), [OWN_TG]);
  lists.push([ME, TG_BOT, OWN_TG]);
  assert.deepEqual(detectOwnerPuppets(lists, [ME]), []);
  // ...but in a big network a few such rooms (≤ 5 % of its DM-like rooms) are tolerated:
  // production had the owner's Telegram ghost alone in 9 of 268 (unbridged channels).
  const big = Array.from({ length: 200 }, (_, i) => tgDm(tgContact(1000 + i)));
  for (let i = 0; i < 9; i++) big.push([ME, TG_BOT, OWN_TG]);
  assert.deepEqual(detectOwnerPuppets(big, [ME]), [OWN_TG]);
  for (let i = 0; i < 4; i++) big.push([ME, TG_BOT, OWN_TG]);
  assert.deepEqual(detectOwnerPuppets(big, [ME]), [], "13 of 213 is more than 5 %");
});

test("detectOwners: the owner's phone and LID forms (one fills the other's gaps) are both found", () => {
  const LID = "@whatsapp_lid-77700001:hs";
  // Phone form in 7 portals, LID form in 5 others: neither passes alone, together they do.
  const lists = Array.from({ length: 12 }, (_, i) => waDm(waContact(i), i < 7 ? OWN_WA : LID));
  assert.deepEqual(detectOwnerPuppets(lists, [ME]).sort(), [LID, OWN_WA].sort());
  // Mostly the phone form + a LID form in 3 DMs: both kept.
  const most = Array.from({ length: 12 }, (_, i) => waDm(waContact(i), i < 9 ? OWN_WA : LID));
  most.push(waDm(waContact(99)));
  assert.deepEqual(detectOwnerPuppets(most, [ME]).sort(), [LID, OWN_WA].sort());
  // Production shape: the bridge also put BOTH forms in a few portals — still one owner.
  const together = Array.from({ length: 12 }, (_, i) => waDm(waContact(i), i < 7 ? OWN_WA : LID));
  together.push([ME, WA_BOT, OWN_WA, LID]);
  assert.deepEqual(detectOwnerPuppets(together, [ME]).sort(), [LID, OWN_WA].sort());
  // A LID contact who fills only one of the gaps is a contact, not the owner's other form.
  const gap = Array.from({ length: 12 }, (_, i) => waDm(waContact(i), i < 9 ? OWN_WA : null));
  gap[9] = [ME, WA_BOT, waContact(9), "@whatsapp_lid-55500009:hs"];
  assert.deepEqual(detectOwnerPuppets(gap, [ME]), []);
});

test("rebuild: an owner-ghost last message is self (no unread, no prefix), DMs are titled by the contact", async () => {
  const { notes, rooms } = fleet();
  // The vault wrote this evidence without knowing the owner's ghost: isSelf false.
  notes[0] = note("ntg0", "!tg0:hs", { lastMessageText: "my reply", lastMessageSender: OWN_TG, lastMessageIsSelf: false });
  const r = await rebuildProjection(deps(notes, rooms));
  assert.equal(r.failed.length, 0);
  assert.deepEqual(storedOwnerSenders().filter((i) => i !== ME.toLowerCase()).sort(), [OWN_TG, OWN_WA].sort());
  const t0 = getThread(`th_${conversationIdFor("!tg0:hs")}`)!;
  assert.equal(t0.lastMessage?.isSelf, true);
  assert.equal(t0.lastMessage?.text, "my reply");
  assert.equal(t0.unread.count, 0);
  assert.equal(t0.title, "Contact T0", "the owner's own ghost never names a DM");
  assert.notEqual(t0.folder, "unknown", "a DM where the owner spoke is not 'unknown'");
  const t1 = getThread(`th_${conversationIdFor("!tg1:hs")}`)!;
  assert.equal(t1.lastMessage?.isSelf, false);
  assert.equal(t1.unread.count, 1);
  for (const t of listThreads({ folder: "unknown", limit: 100 }).threads) assert.ok(!t.title.includes("Owen"));
});

test("timeline: the owner's ghost messages are isSelf once the projection detected it", async () => {
  const { notes, rooms } = fleet();
  await rebuildProjection(deps(notes, rooms));
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture" }));
  const events = [text("$in", 1, tgContact(2), "question"), text("$out", 2, OWN_TG, "answer"), text("$agent", 3, ME, "relayed")];
  setCommsReaderForTests((): CommsReader => ({
    whoami: async () => ME,
    memberProfiles: async () => rooms["!tg2:hs"]!.profiles,
    timelinePage: async () => ({ chunk: [...events].reverse(), start: "s", end: null }),
  }));
  const tid = `th_${conversationIdFor("!tg2:hs")}`;
  const res = await createApp().request(`/api/comms/threads/${tid}/messages`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { messages: Array<{ id: string; sender: { isSelf: boolean } }> };
  assert.deepEqual(body.messages.map((m) => [m.id, m.sender.isSelf]), [["$in", false], ["$out", true], ["$agent", true]]);
});

test("live: an owner-ghost message arrives as isSelf and the preview is self", async () => {
  const { notes, rooms } = fleet();
  const d = deps(notes, rooms);
  await rebuildProjection(d);
  const n = note("ntg3", "!tg3:hs", { lastMessageText: "on my way", lastMessageSender: OWN_TG, lastMessageIsSelf: false });
  const live: LiveDeps = { project: d, getNote: async () => n };
  await handleLiveBatch(live, { roomId: "!tg3:hs", noteId: n.id, events: [text("$live", 60, OWN_TG, "on my way")] });
  const row = db.prepare(`SELECT json_extract(payload_json, '$.message.sender.isSelf') AS self FROM comms_events WHERE kind = 'message.created'`).get() as { self: number };
  assert.equal(row.self, 1);
  const t = getThread(`th_${conversationIdFor("!tg3:hs")}`)!;
  assert.equal(t.lastMessage?.isSelf, true);
  assert.equal(t.unread.count, 0);
});

test("commsSelfIds: whoami + agents + stored owner ids, lowercased", async () => {
  const { notes, rooms } = fleet();
  await rebuildProjection(deps(notes, rooms));
  const ids = commsSelfIds("@Agent:hs");
  for (const i of ["@agent:hs", OWN_TG, OWN_WA, "@omni-agent:localhost"]) assert.ok(ids.includes(i), i);
});

// ── 2. every thread with a message has a preview ───────────────────────────────────────────

test("rebuild: a note without lastMessage evidence gets its preview from one bounded source read", async () => {
  const { notes, rooms } = fleet();
  // Older vault notes carry lastMessageAt but no lastMessageText/Sender/IsSelf at all.
  notes[1] = note("nwa0", "!wa0:hs");
  rooms["!wa0:hs"]!.events = [text("$a", 1, waContact(0), "first"), text("$b", 2, OWN_WA, "latest from me"), ev("$j", 3, waContact(0), "m.room.member", { membership: "join" }, { state_key: waContact(0) })];
  notes[2] = note("ntg1", "!tg1:hs");
  rooms["!tg1:hs"]!.events = [text("$c", 1, tgContact(1), "a question?")];
  // A room with evidence whose last line is the owner's needs no read at all.
  notes[4] = note("ntg2", "!tg2:hs", { lastMessageText: "mine", lastMessageSender: OWN_TG, lastMessageIsSelf: false });
  const calls: string[] = [];
  await rebuildProjection(deps(notes, rooms, { timelineCalls: calls }));
  const wa = getThread(`th_${conversationIdFor("!wa0:hs")}`)!;
  assert.equal(wa.lastMessage?.text, "latest from me");
  assert.equal(wa.lastMessage?.isSelf, true);
  assert.equal(wa.unread.count, 0);
  const tg = getThread(`th_${conversationIdFor("!tg1:hs")}`)!;
  assert.equal(tg.lastMessage?.text, "a question?");
  assert.equal(tg.lastMessage?.isSelf, false);
  assert.ok(!calls.includes("!tg2:hs"));
  // Bounded: at most one read per room.
  assert.equal(new Set(calls).size, calls.length);
});

test("rebuild: a failing fallback read still projects the room (no preview)", async () => {
  const { notes, rooms } = fleet();
  notes[2] = note("ntg1", "!tg1:hs");
  const d = deps(notes, rooms);
  d.reader.timelinePage = async () => { throw new Error("matrix /rooms/x/messages → 500"); };
  const r = await rebuildProjection(d);
  assert.equal(r.failed.length, 0);
  assert.ok(getThread(`th_${conversationIdFor("!tg1:hs")}`) && !getThread(`th_${conversationIdFor("!tg1:hs")}`)!.lastMessage);
});

// ── 3. left rooms are excluded, failures are logged redacted ────────────────────────────────

test("rebuild: rooms the owner left are excluded (not failed) and dropped from the projection", async () => {
  const { notes, rooms } = fleet();
  const LEFT = "!left:hs";
  notes.push(note("nleft", LEFT, { lastMessageText: "old", lastMessageSender: tgContact(1), lastMessageIsSelf: false }));
  const cid = conversationIdFor(LEFT);
  upsertConversation({
    id: cid, network: "telegram", sourceRef: LEFT, kind: "dm", title: "Old", titleSource: "contact", avatar: null, lastEventAt: "2026-01-01T00:00:00.000Z",
    lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: "nleft",
  });
  ensureSingleThread(cid);
  const joined = Object.keys(rooms);
  const r = await rebuildProjection(deps(notes, rooms, { joined }));
  assert.deepEqual(r.failed, []);
  assert.equal(r.left, 1);
  assert.equal(getThread(`th_${cid}`), null);
  // Without a joined list, a 403 on the room's own reads also means "left", not "failed".
  resetDb();
  const r2 = await rebuildProjection(deps(notes, rooms));
  assert.deepEqual(r2.failed, []);
  assert.equal(r2.left, 1);
});

test("rebuild: a failed room is logged with a redacted id and its error class", async () => {
  const { notes, rooms } = fleet();
  const d = deps(notes, rooms);
  const base = d.reader.roomState;
  d.reader.roomState = async (r) => { if (r === "!tg4:hs") throw new Error(`matrix /rooms/${encodeURIComponent(r)}/state → 502`); return base(r); };
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const r = await rebuildProjection(d);
    assert.deepEqual(r.failed, ["!tg4:hs"]);
  } finally {
    console.warn = warn;
  }
  const out = lines.join("\n");
  assert.match(out, /http_502/);
  assert.match(out, new RegExp(conversationIdFor("!tg4:hs").slice(0, 8)));
  assert.ok(!out.includes("!tg4") && !out.includes("tg4%3A"), "the room id itself is never logged");
});

// ── 4. id-like titles ─────────────────────────────────────────────────────────────────────

test("a WhatsApp LID ghost localpart is id-like and never a title", () => {
  assert.equal(looksLikeId("whatsapp_lid-12345678901234"), true);
  assert.equal(formatHandle("@whatsapp_lid-12345678901234:hs"), "WhatsApp user");
  const t = resolveTitle({ memberDisplayNames: ["whatsapp_lid-12345678901234"], handle: "@whatsapp_lid-12345678901234:hs", kind: "dm" });
  assert.equal(t.titleSource, "handle");
  assert.ok(!/\d{6}/.test(t.title));
});

// ── 5. "unknown" never holds a DM the owner has written in ───────────────────────────────────

test("rebuild: an unlinked DM where the owner wrote (older than the last line) is not 'unknown'", async () => {
  const { notes, rooms } = fleet();
  // Last line is the contact's; the vault has no lastSelfReplyAt (it never knew the owner's ghost).
  rooms["!tg5:hs"]!.events = [text("$q", 1, tgContact(5), "hello?"), text("$r", 2, OWN_TG, "hi!"), text("$s", 3, tgContact(5), "great")];
  rooms["!tg4:hs"]!.events = [text("$t", 1, tgContact(4), "buy now")];
  await rebuildProjection(deps(notes, rooms));
  assert.equal(getThread(`th_${conversationIdFor("!tg5:hs")}`)?.folder, "inbox");
  assert.equal(getThread(`th_${conversationIdFor("!tg4:hs")}`)?.folder, "unknown");
});

test("projectRoom (live path) uses the stored owner ids", async () => {
  const { notes, rooms } = fleet();
  const d = deps(notes, rooms);
  await rebuildProjection(d);
  const n = note("nwa2", "!wa2:hs", { lastMessageText: "sent from phone", lastMessageSender: OWN_WA, lastMessageIsSelf: false });
  await projectRoom(d, "!wa2:hs", n);
  assert.equal(getThread(`th_${conversationIdFor("!wa2:hs")}`)?.lastMessage?.isSelf, true);
});

// ── review round 1 ───────────────────────────────────────────────────────────────────────

test("I2: a degraded rebuild (pass-1 timeouts) keeps the owner ids; a healthy one drops only judged ones", async () => {
  const { notes, rooms } = fleet();
  await rebuildProjection(deps(notes, rooms));
  assert.deepEqual(storedOwnerSenders().sort(), [OWN_TG, OWN_WA].sort());
  // Half the rooms' member reads fail: detection would find nothing — the ids are kept.
  const d = deps(notes, rooms);
  const base = d.reader.memberProfiles;
  d.reader.memberProfiles = async (r) => { if (/^!(tg[0-7]|wa[0-7]):/.test(r)) throw new Error("matrix /rooms/x/joined_members → 502"); return base(r); };
  const r = await rebuildProjection(d);
  assert.equal(r.degraded, true);
  assert.deepEqual(storedOwnerSenders().sort(), [OWN_TG, OWN_WA].sort());
  // Healthy pass with no WhatsApp portals at all: the WhatsApp id is kept (no evidence against it).
  const tgOnly = notes.filter((n) => String(n.metadata?.matrixRoomId).startsWith("!tg"));
  await rebuildProjection(deps(tgOnly, rooms));
  assert.deepEqual(storedOwnerSenders().sort(), [OWN_TG, OWN_WA].sort());
  // Healthy pass where WhatsApp is judged and the old ghost is gone from it: dropped.
  for (let i = 0; i < 10; i++) delete rooms[`!wa${i}:hs`]!.profiles[OWN_WA];
  const r2 = await rebuildProjection(deps(notes, rooms));
  assert.equal(r2.degraded, false);
  assert.deepEqual(storedOwnerSenders(), [OWN_TG]);
});

test("I3: COMMS_OWNER_GHOSTS replaces detection; COMMS_OWNER_DETECT=off detects nothing", async () => {
  const { notes, rooms } = fleet();
  process.env.COMMS_OWNER_GHOSTS = ` ${OWN_WA.toUpperCase()} , not-an-id`;
  const r = await rebuildProjection(deps(notes, rooms));
  assert.equal(r.ownerDetection, "override");
  assert.deepEqual(storedOwnerSenderRows().map((r) => [r.mxid, r.source]), [[OWN_WA, "override"]]);
  delete process.env.COMMS_OWNER_GHOSTS;
  process.env.COMMS_OWNER_DETECT = "off";
  const r2 = await rebuildProjection(deps(notes, rooms));
  assert.equal(r2.ownerDetection, "off");
  assert.deepEqual(storedOwnerSenders(), []);
});

test("I3: owner ids are logged redacted and served unredacted on the owner-only admin route", async () => {
  const { notes, rooms } = fleet();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await rebuildProjection(deps(notes, rooms));
  } finally {
    console.log = log;
  }
  const out = lines.join("\n");
  assert.match(out, /owner ghosts \(auto\): (telegram|whatsapp):[0-9a-f]{8}, (telegram|whatsapp):[0-9a-f]{8}/);
  assert.ok(!out.includes("900001") && !out.includes("15550009999"), "ids never logged in clear");
  const res = await createApp().request("/api/comms/admin/owner-ids", { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { detection: string; ids: Array<{ mxid: string; source: string }> };
  assert.equal(body.detection, "auto");
  assert.deepEqual(body.ids.map((i) => i.mxid).sort(), [OWN_TG, OWN_WA].sort());
  const other = await createApp().request("/api/comms/admin/owner-ids", { headers: { cookie: sessionCookie(makeSession("stranger@test.local")) } });
  assert.equal(other.status, 403);
});

test("I4: pass 1 retains full profiles only for small rooms; a big room is read again in pass 2", async () => {
  const { notes, rooms } = fleet();
  const BIG = "!big:hs";
  const profiles: Room["profiles"] = { [ME]: p("Agent"), [TG_BOT]: p("bridge"), [OWN_TG]: p("Owen Owner") };
  for (let i = 0; i < PROFILE_RETAIN_MAX_MEMBERS + 10; i++) profiles[tgContact(500 + i)] = p(`Member ${i}`);
  rooms[BIG] = { profiles, state: [{ type: "m.room.name", state_key: "", content: { name: "Big group" } }] };
  notes.push(note("nbig", BIG, { lastMessageText: "hi all", lastMessageSender: tgContact(501), lastMessageIsSelf: false }));
  const d = deps(notes, rooms);
  const reads = new Map<string, number>();
  const base = d.reader.memberProfiles;
  d.reader.memberProfiles = async (r) => { reads.set(r, (reads.get(r) ?? 0) + 1); return base(r); };
  await rebuildProjection(d);
  assert.equal(reads.get(BIG), 2, "a big room's profiles are not held between the passes");
  assert.equal(reads.get("!tg0:hs"), 1, "a small room is read once");
  assert.equal(getThread(`th_${conversationIdFor(BIG)}`)?.title, "Big group");
});

test("5: an empty or badly short joined-rooms list is ignored (per-room 403s decide)", async () => {
  const { notes, rooms } = fleet();
  for (const joined of [[], ["!tg0:hs"]]) {
    resetDb();
    const r = await rebuildProjection(deps(notes, rooms, { joined }));
    assert.equal(r.left, 0);
    assert.equal(r.conversations, notes.length);
  }
});

test("6: a restart re-reads no evidence-less room whose note names no newer message", async () => {
  const { notes, rooms } = fleet();
  notes[2] = note("ntg1", "!tg1:hs");
  rooms["!tg1:hs"]!.events = [text("$q", 1, tgContact(1), "a question?")];
  await rebuildProjection(deps(notes, rooms));
  assert.equal(getThread(`th_${conversationIdFor("!tg1:hs")}`)?.lastMessage?.text, "a question?");
  const calls: string[] = [];
  await rebuildProjection(deps(notes, rooms, { timelineCalls: calls }));
  assert.ok(!calls.includes("!tg1:hs"), "the stored source preview is reused");
  const t = getThread(`th_${conversationIdFor("!tg1:hs")}`)!;
  assert.equal(t.lastMessage?.text, "a question?");
  assert.equal(t.unread.count, 1);
  // A newer lastMessageAt on the note → read again.
  notes[2] = note("ntg1", "!tg1:hs", { lastMessageAt: ts(5000) });
  rooms["!tg1:hs"]!.events!.push(text("$r", 5000, OWN_TG, "answered"));
  await rebuildProjection(deps(notes, rooms, { timelineCalls: calls }));
  assert.ok(calls.includes("!tg1:hs"));
  assert.equal(getThread(`th_${conversationIdFor("!tg1:hs")}`)?.lastMessage?.isSelf, true);
});

// ── review round 2 (adversarial shapes from the reviewer, folded in) ───────────────────────

const wa1 = (n: number) => `@whatsapp_1555${String(n).padStart(6, "0")}:hs`;
const wl1 = (n: number) => `@whatsapp_lid-9${String(n).padStart(7, "0")}:hs`;
const tg1 = (n: number) => `@telegram_${100000 + n}:hs`;

test("R2 adversarial: shapes the member counts reject", () => {
  // A2: double puppeting ON (no owner ghost), an assistant in 21 of 27 portals.
  { const X = wa1(1); const r: string[][] = [[ME, WA_BOT, X]]; for (let i = 0; i < 20; i++) r.push([ME, WA_BOT, X, wa1(100 + i)]); for (let i = 0; i < 6; i++) r.push([ME, WA_BOT, wa1(300 + i)]); assert.deepEqual(detectOwnerPuppets(r, [ME]), []); }
  // A3: double puppeting, a spouse in 10 big family groups: DM share 1/3.
  { const S = wa1(2); const r: string[][] = [[ME, WA_BOT, S]]; for (let i = 0; i < 10; i++) r.push([ME, WA_BOT, S, wa1(200 + i), wa1(210 + i), wa1(220 + i)]); r.push([ME, WA_BOT, wa1(500)], [ME, WA_BOT, wa1(501)]); assert.deepEqual(detectOwnerPuppets(r, [ME]), []); }
  // B: owner ghost everywhere but a coworker in 31 of 60: not dominant → nothing guessed (safe).
  { const O = tg1(0), C = tg1(1); const r: string[][] = [[ME, TG_BOT, O, C]]; for (let i = 0; i < 30; i++) r.push([ME, TG_BOT, O, C, tg1(100 + i), tg1(200 + i)]); for (let i = 0; i < 29; i++) r.push([ME, TG_BOT, O, tg1(300 + i)]); assert.deepEqual(detectOwnerPuppets(r, [ME]), []); }
  // B2: a coworker co-present everywhere with the owner: indistinguishable → nothing.
  { const O = tg1(0), C = tg1(1); const r: string[][] = [[ME, TG_BOT, O, C]]; for (let i = 0; i < 40; i++) r.push([ME, TG_BOT, O, C, tg1(100 + i)]); assert.deepEqual(detectOwnerPuppets(r, [ME]), []); }
  // C: double puppeting, a channel admin alone in 12 channels.
  { const A = tg1(9); const r: string[][] = []; for (let i = 0; i < 12; i++) r.push([ME, TG_BOT, A]); r.push([ME, TG_BOT, tg1(50)]); assert.deepEqual(detectOwnerPuppets(r, [ME]), []); }
  // D2: owner fully LID; a spouse's phone form fills the 7 gaps but is ALONE in 4 of them.
  { const OL = wl1(0), S = wa1(7); const r: string[][] = []; for (let i = 0; i < 100; i++) r.push([ME, WA_BOT, OL, wl1(100 + i)]); for (let i = 0; i < 4; i++) r.push([ME, WA_BOT, S]); for (let i = 0; i < 3; i++) r.push([ME, WA_BOT, S, wa1(800 + i)]); assert.deepEqual(detectOwnerPuppets(r, [ME]), [OL]); }
});

test("R2 I1: the second form is the one filling the most gaps, mostly absent where the first is (busy spouse)", () => {
  // D: owner LID in most portals; a spouse's phone form in 48 (40 shared family groups + 8 old
  // two-ghost groups with the owner's phone form); the owner's real phone form in 12.
  const OL = wl1(0), OP = wa1(0), S = wa1(7), SL = wl1(7);
  const r: string[][] = [];
  for (let i = 0; i < 150; i++) r.push([ME, WA_BOT, OL, wl1(100 + i)]);
  r.push([ME, WA_BOT, OL, SL]);
  for (let i = 0; i < 40; i++) r.push([ME, WA_BOT, OL, S, wl1(300 + i), wl1(400 + i)]);
  for (let i = 0; i < 8; i++) r.push([ME, WA_BOT, OP, S]);
  for (let i = 0; i < 4; i++) r.push([ME, WA_BOT, OP, wa1(600 + i)]);
  assert.deepEqual(detectOwnerPuppets(r, [ME]).sort(), [OL, OP].sort());
});

test("R2 veto: a ghost whose display name shares no word with the owner's names is never the owner", () => {
  // A / A1 / E: an assistant in every client trio, a relay ghost in every portal — the member
  // counts cannot tell them from the owner's own ghost; the owner's name can.
  const X = wa1(1);
  const a: string[][] = [[ME, WA_BOT, X]];
  for (let i = 0; i < 20; i++) a.push([ME, WA_BOT, X, wa1(100 + i)]);
  assert.deepEqual(detectOwnerPuppets(a, [ME]), [X], "structure alone cannot tell (documented)");
  const names = new Map([[X, "Asha Assistant"]]);
  assert.deepEqual(detectOwnerPuppets(a, [ME], { ownerNames: ["Owen Owner"], displayNames: names }), []);
  const R = tg1(42);
  const e: string[][] = Array.from({ length: 12 }, (_, i) => [ME, TG_BOT, R, tg1(100 + i)]);
  assert.deepEqual(detectOwnerPuppets(e, [ME], { ownerNames: ["Owen Owner"], displayNames: new Map([[R, "Relay Bot"]]) }), []);
  // The owner's own ghost under a nickname sharing his first name passes; an unknown name is no veto.
  assert.deepEqual(detectOwnerPuppets(e, [ME], { ownerNames: ["Owen Owner"], displayNames: new Map([[R, "owen (phone)"]]) }), [R]);
  assert.deepEqual(detectOwnerPuppets(e, [ME], { ownerNames: ["Owen Owner"] }), [R]);
});

test("R2 I2: an untyped single-ghost room (a channel) is no DM portal; a bridge-typed one is", () => {
  const O = tg1(0);
  const typed = (members: string[], type: "dm" | "group" | null): RoomMembers => ({ members, type });
  // C2 as production has it: the owner alone in 10 of 100 rooms — untyped channels → still the owner.
  const ch: RoomMembers[] = [];
  for (let i = 0; i < 90; i++) ch.push(typed([ME, TG_BOT, O, tg1(100 + i)], "dm"));
  for (let i = 0; i < 10; i++) ch.push(typed([ME, TG_BOT, O], null));
  assert.deepEqual(detectOwnerPuppets(ch, [ME]), [O]);
  // ...the same ten as bridge-typed DMs → 10 % alone → not the owner.
  const dm = ch.map((r, i) => (i >= 90 ? typed([ME, TG_BOT, O], "dm") : r));
  assert.deepEqual(detectOwnerPuppets(dm, [ME]), []);
  // C typed: an admin alone in 12 untyped channels is in no DM portal at all → nothing.
  const admin: RoomMembers[] = Array.from({ length: 12 }, () => typed([ME, TG_BOT, tg1(9)], null));
  assert.deepEqual(detectOwnerPuppets(admin, [ME]), []);
  // A bridge "group" with two ghosts is not DM-like.
  const groups: RoomMembers[] = Array.from({ length: 12 }, (_, i) => typed([ME, TG_BOT, tg1(1), tg1(200 + i)], "group"));
  assert.deepEqual(detectOwnerPuppets(groups, [ME]), []);
});

test("R2 I2: hysteresis — a stored id survives a marginal pass and is dropped only on a clear failure", () => {
  const O = tg1(0);
  const pass = (aloneRooms: number, withOwner = 100): string[][] => {
    const r: string[][] = [];
    for (let i = 0; i < 100; i++) r.push(i < withOwner ? [ME, TG_BOT, O, tg1(100 + i)] : [ME, TG_BOT, tg1(100 + i)]);
    for (let i = 0; i < aloneRooms; i++) r.push([ME, TG_BOT, O]);
    return r;
  };
  // 7 alone of 107: fails the 5 % gate as a NEW id, but not clearly (≤ 10 %) → kept.
  const d1 = detectOwners(pass(7), [ME], { stats: [O] });
  assert.deepEqual(d1.owners, []);
  assert.deepEqual(reconcileOwners(d1, [O], [], true).ids, [O]);
  // 75 % of portals: below the 80 % gate, above the 70 % drop line → kept.
  const d2 = detectOwners(pass(0, 75), [ME], { stats: [O] });
  assert.deepEqual(reconcileOwners(d2, [O], [], true).ids, [O]);
  // 15 alone of 115 (> 10 %) → dropped, and the network is blocked.
  const d3 = detectOwners(pass(15), [ME], { stats: [O] });
  const r3 = reconcileOwners(d3, [O], [], true);
  assert.deepEqual(r3.ids, []);
  assert.deepEqual(r3.removed, [O]);
  assert.deepEqual(r3.blocked, ["telegram"]);
  // A degraded pass never drops.
  assert.deepEqual(reconcileOwners(d3, [O], [], false).ids, [O]);
});

test("R2 I3: a vanished owner ghost is not replaced (double puppeting turned on) until a reset", async () => {
  const { notes, rooms } = fleet();
  await rebuildProjection(deps(notes, rooms));
  assert.ok(storedOwnerSenders().includes(OWN_TG));
  // Double puppeting turned on for Telegram: the owner's ghost leaves every portal, and the
  // agent's... a contact now sits in all of them (as the reviewer's assistant case).
  const NEW = tgContact(77);
  for (let i = 0; i < 10; i++) { delete rooms[`!tg${i}:hs`]!.profiles[OWN_TG]; rooms[`!tg${i}:hs`]!.profiles[NEW] = p("Asha"); }
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  try {
    await rebuildProjection(deps(notes, rooms));
  } finally {
    console.warn = warn;
  }
  assert.ok(!storedOwnerSenders().includes(OWN_TG));
  assert.ok(!storedOwnerSenders().includes(NEW), "no replacement adopted on the blocked network");
  assert.ok(storedOwnerSenders().includes(OWN_WA));
  const out = warns.join("\n");
  assert.match(out, /owner ghosts changed: \+\[\] -\[telegram:[0-9a-f]{8}\]/);
  assert.match(out, /NOT adopted/);
  assert.ok(!out.includes("900001"));
  // The owner-only route shows the block and per-id evidence; a reset lets detection start over.
  const h = { cookie: sessionCookie(makeSession(config.ownerEmail)) };
  const body = (await (await createApp().request("/api/comms/admin/owner-ids", { headers: h })).json()) as { blocked: string[]; ids: Array<{ mxid: string; stats: { portals: number; share: number; alone: number } | null }> };
  assert.deepEqual(body.blocked, ["telegram"]);
  const wa = body.ids.find((i) => i.mxid === OWN_WA)!;
  assert.equal(wa.stats?.portals, 10);
  assert.equal(wa.stats?.share, 1);
  assert.equal(wa.stats?.alone, 0);
  const reset = await createApp().request("/api/comms/admin/owner-ids/reset", { method: "POST", headers: h });
  assert.equal(reset.status, 202);
  await rebuildProjection(deps(notes, rooms));
  assert.ok(storedOwnerSenders().includes(NEW), "after a reset detection starts over");
});

test("V1: name veto — digits are unknown, a ≥ 3-letter prefix matches, a veto is logged hashed", async () => {
  const R = tg1(42);
  const e: string[][] = Array.from({ length: 12 }, (_, i) => [ME, TG_BOT, R, tg1(100 + i)]);
  const names = (n: string) => ({ ownerNames: ["Benjamin Owner"], displayNames: new Map([[R, n]]) });
  assert.deepEqual(detectOwnerPuppets(e, [ME], names("+1 555 000 0042")), [R], "a phone-number name is unknown, no veto");
  assert.deepEqual(detectOwnerPuppets(e, [ME], names("12345")), [R]);
  assert.deepEqual(detectOwnerPuppets(e, [ME], names("Ben")), [R], "prefix: Ben ↔ Benjamin");
  assert.deepEqual(detectOwnerPuppets(e, [ME], names("Benji 📱")), [R], "prefix: Benji ↔ Benjamin");
  assert.deepEqual(detectOwnerPuppets(e, [ME], names("Be")), [R], "no ≥ 3-letter word: unknown");
  const d = detectOwners(e, [ME], names("Relay Bot"));
  assert.deepEqual(d.owners, []);
  assert.deepEqual(d.vetoed, [R]);
  // The rebuild logs the veto with a hashed id only.
  const { notes, rooms } = fleet();
  for (let i = 0; i < 10; i++) rooms[`!tg${i}:hs`]!.profiles[OWN_TG] = p("Relay Bot");
  const dd = deps(notes, rooms);
  dd.ownerNames = ["Owen Owner"];
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  try {
    await rebuildProjection(dd);
  } finally {
    console.warn = warn;
  }
  const out = warns.join("\n");
  assert.match(out, /owner ghost on telegram vetoed by name: telegram:[0-9a-f]{8}/);
  assert.ok(!out.includes("900001"));
  assert.ok(!storedOwnerSenders().includes(OWN_TG));
  assert.ok(storedOwnerSenders().includes(OWN_WA), "the WhatsApp ghost (named Owen Owner) still passes");
});

// ── stale reuse across owner sets (prod 2026-11-22, prism-v2026.11.22-2) ─────────────────────

test("reuse: rows computed with an empty owner set are re-derived once owner ids exist; same set → no re-read", async () => {
  const { notes, rooms } = fleet();
  // Evidence-less DM; the owner (his ghost) spoke, then the contact did — and before that the
  // owner's ghost was unknown, so the earlier projection called it a stranger.
  notes[2] = note("ntg1", "!tg1:hs");
  rooms["!tg1:hs"]!.events = [text("$a", 1, tgContact(1), "hello?"), text("$b", 2, OWN_TG, "hi, it's me"), text("$c", 3, tgContact(1), "great")];
  notes[4] = note("ntg2", "!tg2:hs");
  rooms["!tg2:hs"]!.events = [text("$d", 1, tgContact(2), "q"), text("$e", 2, OWN_TG, "my answer")];
  process.env.COMMS_OWNER_DETECT = "off"; // the previous release: no owner ids at all
  await rebuildProjection(deps(notes, rooms));
  assert.equal(getThread(`th_${conversationIdFor("!tg1:hs")}`)?.folder, "unknown");
  assert.equal(getThread(`th_${conversationIdFor("!tg2:hs")}`)?.lastMessage?.isSelf, false);
  delete process.env.COMMS_OWNER_DETECT;
  const calls: string[] = [];
  await rebuildProjection(deps(notes, rooms, { timelineCalls: calls }));
  assert.ok(calls.includes("!tg1:hs") && calls.includes("!tg2:hs"), "a different owner set → one bounded re-read");
  assert.equal(getThread(`th_${conversationIdFor("!tg1:hs")}`)?.folder, "inbox", "the owner spoke: not unknown");
  const t2 = getThread(`th_${conversationIdFor("!tg2:hs")}`)!;
  assert.equal(t2.lastMessage?.isSelf, true);
  assert.equal(t2.unread.count, 0);
  // Unchanged set (a restart): nothing is read again.
  const again: string[] = [];
  await rebuildProjection(deps(notes, rooms, { timelineCalls: again }));
  assert.ok(!again.includes("!tg1:hs") && !again.includes("!tg2:hs"), "same owner epoch → reused, no read");
  assert.equal(getThread(`th_${conversationIdFor("!tg1:hs")}`)?.folder, "inbox");
  assert.equal(getThread(`th_${conversationIdFor("!tg2:hs")}`)?.lastMessage?.isSelf, true);
});

test("reuse: a row from before the evidence table existed (no epoch) is never reused", async () => {
  const { notes, rooms } = fleet();
  notes[2] = note("ntg1", "!tg1:hs");
  rooms["!tg1:hs"]!.events = [text("$a", 1, OWN_TG, "mine")];
  await rebuildProjection(deps(notes, rooms));
  db.prepare(`DELETE FROM comms_projection_evidence`).run(); // what the previous release left behind
  const calls: string[] = [];
  await rebuildProjection(deps(notes, rooms, { timelineCalls: calls }));
  assert.ok(calls.includes("!tg1:hs"));
});
