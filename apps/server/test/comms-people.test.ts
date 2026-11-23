// Comms phase 2a (server): triage status on threads, status/attention filters, the person page with
// shared chats, and per-thread contact data. Synthetic fixtures only.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, resolveVaultEntry, migrateCommsStatus } from "../src/db";
import Database from "better-sqlite3";
import { putSecret } from "../src/secrets";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { commsStatus, COMMS_STATUSES } from "../src/comms/triage";
import { upsertConversation, ensureSingleThread, listThreads, statusCounts, setStatusForNote, eventsAfter, type ConversationRow } from "../src/comms/store";
import { rebuildProjection, projectRoom, conversationIdFor, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { applyTreeChange, syncAllStatuses } from "../src/comms/status-sync";
import { contactFor, ghostContact, setPersonSourceForTests } from "../src/comms/people";
import { setCommsReaderForTests, type CommsReader } from "../src/comms/timeline";
import { PeopleIndex } from "../src/worker/people";
import { issueDeviceToken } from "../src/auth/device";
import { commsPathAllowed } from "../src/middleware/client-scope";
import type { Note } from "../src/parachute";
import type { TreeRow } from "../src/tree";

const prevComms = process.env.COMMS_ENABLED;
beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; });
afterEach(() => {
  if (prevComms === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prevComms;
  setPersonSourceForTests(null);
  setCommsReaderForTests(null);
});

// ── status derivation ────────────────────────────────────────────────────────

test("commsStatus: every precedence case, partial tags, unknown tags", () => {
  assert.equal(commsStatus([]), "unclassified");
  assert.equal(commsStatus(null), "unclassified");
  assert.equal(commsStatus(undefined), "unclassified");
  assert.equal(commsStatus(["message-thread"]), "unclassified");
  assert.equal(commsStatus(["needs-triage"]), "unclassified");
  assert.equal(commsStatus(["triage-failed"]), "triage-failed");
  assert.equal(commsStatus(["triaged"]), "triaged");
  // the classifier's verdict beats the failure marker
  assert.equal(commsStatus(["triage-failed", "urgent"]), "urgent");
  assert.equal(commsStatus(["triage-failed", "triaged"]), "triaged");
  // a partial mutation (importance tag without `triaged`, `triaged` without one) still lands in ONE status
  assert.equal(commsStatus(["low"]), "low");
  assert.equal(commsStatus(["triaged", "social"]), "social");
  assert.equal(commsStatus(["triaged", "informational", "low"]), "informational");
  // precedence: handled > urgent > action-required > informational > low > social > triaged
  assert.equal(commsStatus(["triaged", "social", "low", "informational", "action-required", "urgent", "handled"]), "handled");
  assert.equal(commsStatus(["triaged", "social", "low", "informational", "action-required", "urgent"]), "urgent");
  assert.equal(commsStatus(["triaged", "social", "low", "informational", "action-required"]), "action-required");
  assert.equal(commsStatus(["triaged", "social", "low", "informational"]), "informational");
  assert.equal(commsStatus(["triaged", "social", "low"]), "low");
  assert.equal(commsStatus(["triaged", "social"]), "social");
  assert.equal(commsStatus(["handled", "triage-failed"]), "handled");
  assert.equal(COMMS_STATUSES.length, 9);
});

// ── store + routes ───────────────────────────────────────────────────────────

const at = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString();
function conv(id: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title: `Title ${id}`, titleSource: "contact", avatar: null,
    lastEventAt: at(1), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false, muted: false,
    archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}
const get = (path: string, email = config.ownerEmail) => createApp().request(path, { headers: { cookie: sessionCookie(makeSession(email)) } });
const json = async (r: Response) => (await r.json()) as any;

test("thread wire carries status; default is unclassified", async () => {
  conv("a"); conv("b", { status: "urgent" });
  const b = await json(await get("/api/comms/threads"));
  const byId = Object.fromEntries(b.threads.map((t: any) => [t.id, t.status]));
  assert.deepEqual(byId, { th_a: "unclassified", th_b: "urgent" });
});

test("status filter: single, repeated, comma, attention, combined; folder still applies; pagination holds", async () => {
  const st = ["urgent", "action-required", "unclassified", "triage-failed", "informational", "low", "social", "triaged", "handled"] as const;
  st.forEach((s, i) => conv(`s${i}`, { status: s, lastEventAt: at(i) }));
  conv("lowfolder", { status: "urgent", folder: "low", lastEventAt: at(50) });
  const ids = async (q: string) => (await json(await get(`/api/comms/threads?${q}`))).threads.map((t: any) => t.status).sort();
  assert.deepEqual(await ids("status=urgent"), ["urgent"]); // the folder=low urgent thread is not in the inbox
  assert.deepEqual(await ids("status=urgent&status=handled"), ["handled", "urgent"]);
  assert.deepEqual(await ids("status=social,low"), ["low", "social"]);
  assert.deepEqual(await ids("attention=true"), ["action-required", "urgent"]);
  assert.deepEqual(await ids("attention=1"), ["action-required", "urgent"]);
  assert.deepEqual(await ids("attention=false"), [...st].sort());
  assert.deepEqual(await ids("attention=true&status=triaged"), ["action-required", "triaged", "urgent"]);
  assert.deepEqual(await ids("folder=low&attention=true"), ["urgent"]);
  assert.equal((await get("/api/comms/threads?status=bogus")).status, 400);
  assert.deepEqual(await (await get("/api/comms/threads?status=bogus")).json(), { error: "invalid_status" });
  // pagination within a status filter: no skips, no repeats
  for (let i = 0; i < 7; i++) conv(`u${i}`, { status: "urgent", lastEventAt: at(100 + i) });
  const p1 = await json(await get("/api/comms/threads?status=urgent&limit=3"));
  const p2 = await json(await get(`/api/comms/threads?status=urgent&limit=3&cursor=${p1.next}`));
  const p3 = await json(await get(`/api/comms/threads?status=urgent&limit=3&cursor=${p2.next}`));
  const all = [...p1.threads, ...p2.threads, ...p3.threads].map((t: any) => t.id);
  assert.equal(all.length, 8);
  assert.equal(new Set(all).size, 8);
  assert.equal(p3.next, null);
  assert.ok(p1.threads.every((t: any) => t.status === "urgent"));
});

test("status-counts per folder", async () => {
  conv("a", { status: "urgent" }); conv("b", { status: "urgent" }); conv("c", { status: "action-required" });
  conv("d", { status: "handled" }); conv("e", { status: "urgent", folder: "low" });
  const b = await json(await get("/api/comms/threads/status-counts"));
  assert.deepEqual(b, { folder: "inbox", counts: { urgent: 2, "action-required": 1, handled: 1 }, attention: 3, unread: { threads: 0, attention: 0 } });
  assert.deepEqual(statusCounts("low"), { urgent: 1 });
  assert.equal((await get("/api/comms/threads/status-counts?folder=x")).status, 400);
  assert.equal((await get("/api/comms/threads/status-counts", "stranger@test.local")).status, 403);
});

// ── projection: status from tags, kept fresh when tags change ───────────────

const ME = "@me:hs";
const note = (id: string, roomId: string, tags = ["message-thread"], md: Record<string, unknown> = {}): Note => ({
  id, content: "", path: `Messages/${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags,
  metadata: { type: "message-thread", matrixRoomId: roomId, lastMessageAt: 1_760_000_000_000, lastMessageText: "hello", lastMessageSender: "@whatsapp_15550001111:hs", lastMessageIsSelf: false, ...md },
});
const person = (id: string, title: string, md: Record<string, unknown>): Note => ({
  id, content: "", path: `People/${title}`, createdAt: "", updatedAt: null, tags: ["person"], displayTitle: title, metadata: md,
});
interface Room { profiles: Record<string, { name: string | null; avatar: string | null }> }
function deps(notes: Note[], rooms: Record<string, Room>, people: Note[] = []): ProjectDeps {
  return {
    vault: { listByTag: async (tag) => notes.filter((n) => n.tags?.includes(tag)) },
    reader: { whoami: async () => ME, roomState: async () => [] as never, memberProfiles: async (r) => rooms[r]!.profiles },
    people: peopleAdapter(new PeopleIndex(people)),
  };
}
const dm = (ghost: string, name = "Alice WA"): Room => ({ profiles: { [ME]: { name: "Me", avatar: null }, [ghost]: { name, avatar: null } } });

test("projection stores status from tags; a live re-projection and tree changes refresh it", async () => {
  const d = deps([note("n1", "!a:hs", ["message-thread", "triaged", "action-required"]), note("n2", "!b:hs"), note("n3", "!c:hs", ["message-thread", "triage-failed"])],
    { "!a:hs": dm("@whatsapp_15550001111:hs"), "!b:hs": dm("@whatsapp_15550002222:hs", "Bob"), "!c:hs": dm("@whatsapp_15550003333:hs", "Cy") });
  await rebuildProjection(d);
  const status = (n: string) => listThreads({ limit: 50 }).threads.find((t) => t.id === `th_${conversationIdFor(n)}`)?.status;
  assert.equal(status("!a:hs"), "action-required");
  assert.equal(status("!b:hs"), "unclassified");
  assert.equal(status("!c:hs"), "triage-failed");

  // ingest strips the classifier tags on a new message: the live projection reads the note again
  await projectRoom(d, "!a:hs", note("n1", "!a:hs"));
  assert.equal(status("!a:hs"), "unclassified");

  // a tag change with no message (classifier / status control) arrives through the vault tree
  const row = (id: string, tags: string[], prevTags?: string[]): Parameters<typeof applyTreeChange>[0] => ({
    kind: "upsert", row: { id, tags, path: null, updatedAt: null } as TreeRow, prev: prevTags ? { id, tags: prevTags, path: null, updatedAt: null } as TreeRow : undefined,
  });
  const none = async () => [];
  const before = eventsAfter(0, 1000).length;
  assert.equal(await applyTreeChange(row("n2", ["message-thread", "triaged", "urgent"], ["message-thread"]), none), 1);
  assert.equal(status("!b:hs"), "urgent");
  assert.equal(eventsAfter(0, 1000).length, before + 1); // thread.updated announced
  // an unrelated note, an unchanged tag set, a trashed note: nothing
  assert.equal(await applyTreeChange(row("zzz", ["person", "urgent"]), none), 0);
  assert.equal(await applyTreeChange(row("n2", ["message-thread", "triaged", "urgent"], ["message-thread", "triaged", "urgent"]), none), 0);
  assert.equal(await applyTreeChange({ kind: "remove", id: "n2", prev: {} as TreeRow }, none), 0);
  // handled by a person
  assert.equal(await applyTreeChange(row("n2", ["message-thread", "handled", "urgent"], ["message-thread", "triaged", "urgent"]), none), 1);
  assert.equal(status("!b:hs"), "handled");
  // a resync carries no tags: one listing settles everything
  const listing = async () => [{ id: "n1", tags: ["message-thread", "low"] }, { id: "n2", tags: ["message-thread"] }, { id: "n3", tags: ["message-thread", "triage-failed"] }];
  assert.equal(await applyTreeChange({ kind: "resync" }, listing), 2);
  assert.equal(status("!a:hs"), "low");
  assert.equal(status("!b:hs"), "unclassified");
  assert.equal(setStatusForNote("n1", "low"), 0);
});

// ── contact derivation ──────────────────────────────────────────────────────

test("ghostContact: WhatsApp phone, Signal phone, Telegram id/username, Slack, LID skipped", () => {
  assert.deepEqual(ghostContact("@whatsapp_15550001111:hs"), { phone: { value: "+15550001111", label: "WhatsApp" }, handle: { network: "whatsapp", value: "+15550001111", kind: "phone" } });
  assert.deepEqual(ghostContact("@signal_447700900123:hs").handle, { network: "signal", value: "+447700900123", kind: "phone" });
  assert.deepEqual(ghostContact("@whatsapp_lid-123456789012:hs"), {});
  assert.deepEqual(ghostContact("@signal_0b7a1d2e-1111-2222-3333-444455556666:hs"), {});
  assert.deepEqual(ghostContact("@telegram_123456789:hs").handle, { network: "telegram", value: "123456789", kind: "userId" });
  assert.deepEqual(ghostContact("@telegram_alice_x:hs").handle, { network: "telegram", value: "@alice_x", kind: "username" });
  assert.deepEqual(ghostContact("@slack_t0abc123-u0def456:hs").handle, { network: "slack", value: "T0ABC123-U0DEF456", kind: "userId" });
  assert.deepEqual(ghostContact("@twitter_9876543:hs").handle, { network: "x", value: "9876543", kind: "userId" });
  assert.deepEqual(ghostContact("@pat_smith:matrix.org"), {});
  assert.deepEqual(ghostContact("@whatsappbot:hs"), {});
});

test("contactFor: note phone + email + telegram username, ghosts merged and deduplicated", () => {
  const n = person("p1", "Pat", { phone: "+1 (555) 000-1111", email: "Pat@Example.test", telegram: "@pat_tg" });
  const c = contactFor(n, ["@whatsapp_15550001111:hs", "@telegram_555000111:hs"]);
  assert.deepEqual(c.phones, [{ label: "WhatsApp", value: "+15550001111" }]); // the same number once, label kept
  assert.deepEqual(c.emails, [{ value: "pat@example.test" }]);
  assert.deepEqual(c.handles.map((h) => `${h.network}:${h.kind}:${h.value}`).sort(), ["telegram:userId:555000111", "telegram:username:@pat_tg", "whatsapp:phone:+15550001111"]);
  assert.deepEqual(contactFor(null, []), { phones: [], emails: [], handles: [] });
  assert.deepEqual(contactFor(person("p2", "Q", { phone: "303 555 0100" }), []).phones, []); // no country code: not a usable key
});

// ── person endpoint + thread detail ─────────────────────────────────────────

const PIC = "mxc://hs/person-photo";
const PAT = person("p-pat", "Pat Person", { phone: "+1 555 000 1111", email: "pat@example.test", telegram: "@pat_tg", photo: PIC, matrixId: "@telegram_555000111:hs" });
const OTHER = person("p-lee", "Lee Other", { phone: "+1 555 000 3333" });

async function seed() {
  const notes = [
    note("t-wa", "!wa:hs", ["message-thread"], { lastMessageAt: 1_760_000_300_000, lastMessageSender: "@whatsapp_15550001111:hs" }),
    note("t-tg", "!tg:hs", ["message-thread", "urgent"], { lastMessageAt: 1_760_000_100_000, lastMessageSender: "@telegram_555000111:hs" }),
    note("t-grp", "!grp:hs", ["message-thread"], { lastMessageAt: 1_760_000_200_000 }),
    note("t-lee", "!lee:hs", ["message-thread"], { lastMessageAt: 1_760_000_400_000, lastMessageSender: "@whatsapp_15550003333:hs" }),
    note("t-grp2", "!grp2:hs", ["message-thread"], { lastMessageAt: 1_760_000_050_000 }),
  ];
  const rooms: Record<string, Room> = {
    "!wa:hs": dm("@whatsapp_15550001111:hs", "Pat WA"),
    "!tg:hs": dm("@telegram_555000111:hs", "Pat TG"),
    "!lee:hs": dm("@whatsapp_15550003333:hs", "Lee"),
    "!grp:hs": { profiles: { [ME]: { name: "Me", avatar: null }, "@whatsapp_15550001111:hs": { name: "Pat WA", avatar: null }, "@whatsapp_15550003333:hs": { name: "Lee", avatar: null }, "@whatsapp_15559990000:hs": { name: "Stranger", avatar: null } } },
    // a group Pat is NOT in
    "!grp2:hs": { profiles: { [ME]: { name: "Me", avatar: null }, "@whatsapp_15550003333:hs": { name: "Lee", avatar: null }, "@whatsapp_15559990000:hs": { name: "Stranger", avatar: null }, "@whatsapp_15559990001:hs": { name: "Other", avatar: null } } },
  };
  await rebuildProjection(deps(notes, rooms, [PAT, OTHER]));
  setPersonSourceForTests(async (_v, id) => [PAT, OTHER].find((p) => p.id === id) ?? null);
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture_secret" }));
  const reader = (room: Room): CommsReader => ({ whoami: async () => ME, memberProfiles: async () => room.profiles, timelinePage: async () => ({ chunk: [], start: "s", end: null }) } as never);
  setCommsReaderForTests(() => reader(rooms["!grp:hs"]!));
  return { rooms, reader };
}
const tid = (room: string) => `th_${conversationIdFor(room)}`;

test("person endpoint: contact, every DM network + groups, newest first; other people's chats excluded", async () => {
  await seed();
  const r = await get("/api/comms/people/p-pat");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const b = await json(r);
  assert.equal(b.id, "p-pat");
  assert.equal(b.noteId, "p-pat");
  assert.equal(b.name, "Pat Person");
  assert.ok(b.avatar.token && !JSON.stringify(b).includes("mxc://"));
  assert.deepEqual(b.phones, [{ value: "+15550001111", label: "WhatsApp" }]);
  assert.deepEqual(b.emails, [{ value: "pat@example.test" }]);
  assert.deepEqual(b.handles.map((h: any) => `${h.network}:${h.kind}:${h.value}`).sort(),
    ["telegram:userId:555000111", "telegram:username:@pat_tg", "whatsapp:phone:+15550001111"]);
  // WhatsApp DM, Telegram DM and the group Pat is in; Lee's DM and the other group are not here

  assert.deepEqual(new Set(b.threads.map((t: any) => t.id)), new Set([tid("!wa:hs"), tid("!tg:hs"), tid("!grp:hs")]));
  const times = b.threads.map((t: any) => Date.parse(t.lastActivityAt));
  assert.deepEqual(times, [...times].sort((x, y) => y - x));
  assert.deepEqual(new Set(b.threads.map((t: any) => t.networks[0])), new Set(["whatsapp", "telegram"]));
  assert.equal(b.threads.find((t: any) => t.id === tid("!tg:hs")).status, "urgent");
  assert.equal(b.threads.find((t: any) => t.id === tid("!wa:hs")).personId, "p-pat");
});

test("threads?person= filters to the person's chats (every folder unless one is asked)", async () => {
  await seed();
  db.prepare(`UPDATE comms_conversations SET folder = 'archived' WHERE id = ?`).run(conversationIdFor("!tg:hs"));
  const ids = async (q: string) => new Set((await json(await get(`/api/comms/threads?${q}`))).threads.map((t: any) => t.id));
  assert.deepEqual(await ids("person=p-pat"), new Set([tid("!wa:hs"), tid("!tg:hs"), tid("!grp:hs")]));
  assert.deepEqual(await ids("person=p-pat&folder=inbox"), new Set([tid("!wa:hs"), tid("!grp:hs")]));
  assert.deepEqual(await ids("person=p-lee"), new Set([tid("!lee:hs"), tid("!grp:hs"), tid("!grp2:hs")]));
  assert.deepEqual(await ids("person=nobody"), new Set());
  assert.equal((await get(`/api/comms/threads?person=${"x".repeat(201)}`)).status, 400);
});

test("person endpoint: unknown / non-person → 404, source down → 503, non-owner → 403", async () => {
  await seed();
  const nf = await get("/api/comms/people/nobody");
  assert.equal(nf.status, 404);
  assert.deepEqual(await nf.json(), { error: "person_unavailable" });
  assert.equal((await get(`/api/comms/people/${"x".repeat(300)}`)).status, 404);
  setPersonSourceForTests(async () => { throw new Error("vault down"); });
  const down = await get("/api/comms/people/p-pat");
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: "source_unavailable" });
  assert.equal((await get("/api/comms/people/p-pat", "stranger@test.local")).status, 403);
  // comms off: 404 comms_disabled like every comms route
  process.env.COMMS_ENABLED = "false";
  assert.deepEqual(await (await get("/api/comms/people/p-pat")).json(), { error: "comms_disabled" });
});

test("person with no chats yet: contact only, empty threads", async () => {
  await seed();
  setPersonSourceForTests(async () => person("p-new", "New Person", { email: "new@example.test" }));
  const b = await json(await get("/api/comms/people/p-new"));
  assert.deepEqual({ threads: b.threads, emails: b.emails, phones: b.phones, handles: b.handles }, { threads: [], emails: [{ value: "new@example.test" }], phones: [], handles: [] });
  assert.ok(!("avatar" in b));
});

test("thread detail: DM contact from person note + ghost; unknown DM contact from the ghost alone; telegram username", async () => {
  await seed();
  const wa = await json(await get(`/api/comms/threads/${tid("!wa:hs")}`));
  assert.deepEqual(wa.contact.phones, [{ value: "+15550001111", label: "WhatsApp" }]);
  assert.deepEqual(wa.contact.emails, [{ value: "pat@example.test" }]);
  assert.ok(wa.contact.handles.some((h: any) => h.network === "telegram" && h.kind === "username" && h.value === "@pat_tg"));
  assert.equal(wa.thread.status, "unclassified");

  // a stranger DM (no person note): the phone is derived from the WhatsApp ghost alone
  const notes = [note("t-x", "!x:hs", ["message-thread"], { lastMessageSender: "@whatsapp_15557770000:hs" })];
  await rebuildProjection(deps(notes, { "!x:hs": dm("@whatsapp_15557770000:hs", "Stranger") }));
  const x = await json(await get(`/api/comms/threads/${tid("!x:hs")}`));
  assert.deepEqual(x.contact, { phones: [{ label: "WhatsApp", value: "+15557770000" }], emails: [], handles: [{ network: "whatsapp", value: "+15557770000", kind: "phone" }] });

  // a Telegram DM with a username ghost and no person note
  await rebuildProjection(deps([note("t-u", "!u:hs", ["message-thread"], { lastMessageSender: "@telegram_dana_k:hs" })], { "!u:hs": dm("@telegram_dana_k:hs", "Dana K") }));
  const u = await json(await get(`/api/comms/threads/${tid("!u:hs")}`));
  assert.deepEqual(u.contact, { phones: [], emails: [], handles: [{ network: "telegram", value: "@dana_k", kind: "username" }] });

  // a person-note read failure degrades to ghost-derived contact; the detail still answers
  setPersonSourceForTests(async () => { throw new Error("vault down"); });
  const degraded = await json(await get(`/api/comms/threads/${tid("!wa:hs")}`));
  assert.deepEqual(degraded.contact.phones, [{ label: "WhatsApp", value: "+15550001111" }]);
  assert.deepEqual(degraded.contact.emails, []);
});

test("thread detail: group has members with personId where known and no contact", async () => {
  await seed();
  const g = await json(await get(`/api/comms/threads/${tid("!grp:hs")}`));
  assert.ok(!("contact" in g));
  const byId = Object.fromEntries(g.members.map((m: any) => [m.id, m.personId ?? null]));
  assert.deepEqual(byId, { [ME]: null, "@whatsapp_15550001111:hs": "p-pat", "@whatsapp_15550003333:hs": "p-lee", "@whatsapp_15559990000:hs": null });
  assert.ok(g.members.every((m: any) => typeof m.name === "string"));
});

test("client-scope: the comms-native path rules allow /api/comms/people/* and still deny admin", () => {
  assert.equal(commsPathAllowed("/api/comms/people/abc"), true);
  assert.equal(commsPathAllowed("/api/comms/threads/status-counts"), true);
  assert.equal(commsPathAllowed("/api/comms/admin/rebuild"), false);
  assert.equal(commsPathAllowed("/api/people/abc"), false);
  assert.equal(commsPathAllowed("/api/comms/people/a%2fb"), false);
});

test("a comms-native device token reaches the people route and status filters, not the person vault gateway", async () => {
  await seed();
  const t = issueDeviceToken(config.ownerEmail, "Comms (test)", "comms-native").token;
  const h = { authorization: `Bearer ${t}` };
  const app = createApp();
  const p = await app.request("/api/comms/people/p-pat", { headers: h });
  assert.equal(p.status, 200);
  assert.equal(((await p.json()) as any).id, "p-pat");
  assert.equal((await app.request("/api/comms/threads?attention=true", { headers: h })).status, 200);
  assert.equal((await app.request("/api/comms/admin/owner-ids", { headers: h })).status, 403);
  assert.equal((await app.request("/api/notes/p-pat", { headers: h })).status, 403);
});


// ── fix round 1 ──────────────────────────────────────────────────────────────

test("backfill without Matrix: the rebuild fails, a vault-only listing still fills every status", async () => {
  // rows an earlier version projected (status column = migration default)
  conv("c1", { vaultNoteId: "n1" }); conv("c2", { vaultNoteId: "n2" }); conv("c3", { vaultNoteId: "n3" });
  const down: ProjectDeps = {
    vault: { listByTag: async () => [note("n1", "!a:hs")] },
    reader: { whoami: async () => { throw new Error("matrix down"); }, roomState: async () => [] as never, memberProfiles: async () => ({}) },
    people: peopleAdapter(new PeopleIndex([])),
  };
  await assert.rejects(rebuildProjection(down));
  assert.deepEqual(statusCounts("inbox"), { unclassified: 3 });
  const n = await syncAllStatuses(async () => [
    { id: "n1", tags: ["message-thread", "urgent"] }, { id: "n2", tags: ["message-thread", "handled"] }, { id: "n3", tags: ["message-thread"] },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(statusCounts("inbox"), { urgent: 1, unclassified: 1, handled: 1 });
});

test("migration: an old database gets the status column, rows read unclassified; re-running is a no-op", () => {
  const old = new Database(":memory:");
  old.exec(`CREATE TABLE comms_conversations (id TEXT PRIMARY KEY, network TEXT NOT NULL, triage TEXT)`);
  old.prepare(`INSERT INTO comms_conversations (id, network) VALUES ('x', 'whatsapp')`).run();
  migrateCommsStatus(old as never);
  migrateCommsStatus(old as never);
  assert.deepEqual(old.prepare(`SELECT id, status FROM comms_conversations`).all(), [{ id: "x", status: "unclassified" }]);
  old.close();
});

test("first rebuild after the migration: status-only thread.updated events are bounded, one summary folds the rest", async () => {
  const N = 130;
  const notes: Note[] = [];
  const rooms: Record<string, Room> = {};
  for (let i = 0; i < N; i++) {
    notes.push(note(`n${i}`, `!r${i}:hs`, ["message-thread", "urgent"]));
    rooms[`!r${i}:hs`] = dm(`@whatsapp_1555000${String(i).padStart(4, "0")}:hs`, `P${i}`);
  }
  await rebuildProjection(deps(notes, rooms)); // first projection: rows are new
  db.prepare(`UPDATE comms_conversations SET status = 'unclassified'`).run(); // the migrated state
  const before = eventsAfter(0, 100000).length;
  await rebuildProjection(deps(notes, rooms));
  const ev = eventsAfter(0, 100000).slice(before);
  assert.equal(ev.filter((e) => (e.payload as any)?.threadId).length, 100);
  assert.equal(ev.filter((e) => (e.payload as any)?.threadId === null).length, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM comms_conversations WHERE status = 'urgent'`).get() as { n: number }).n, N); // every row corrected, only the events are folded
});

test("invalid params: empty/oversized person, more than 20 statuses; empty status= is no filter", async () => {
  conv("a", { status: "urgent" });
  assert.deepEqual(await (await get("/api/comms/threads?person=")).json(), { error: "invalid_person" });
  assert.equal((await get(`/api/comms/threads?person=${"x".repeat(201)}`)).status, 400);
  const many = Array.from({ length: 21 }, () => "status=urgent").join("&");
  assert.equal((await get(`/api/comms/threads?${many}`)).status, 400);
  const ok20 = Array.from({ length: 20 }, () => "status=urgent").join("&");
  assert.equal((await get(`/api/comms/threads?${ok20}`)).status, 200);
  assert.equal((await json(await get("/api/comms/threads?status="))).threads.length, 1);
});

test("people route: path lookups use the note's own id; merged tombstones are 404; failures are logged without personal data", async () => {
  await seed();
  setPersonSourceForTests(async (_v, id) => (id === "People/Pat" || id === "p-pat" ? PAT : id === "old" ? person("old", "Old", { merged_into: "p-pat" }) : null));
  const b = await json(await get("/api/comms/people/People%2FPat"));
  assert.equal(b.id, "p-pat");
  assert.equal(b.threads.length, 3);
  assert.equal((await get("/api/comms/people/old")).status, 404);
  const warns: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
  try {
    setPersonSourceForTests(async () => { throw new TypeError("secret +15550001111"); });
    assert.equal((await get("/api/comms/people/p-pat")).status, 503);
  } finally { console.warn = w; }
  assert.ok(warns.some((m) => m.includes("person read failed: TypeError")));
  assert.ok(!warns.join(" ").includes("15550001111") && !warns.join(" ").includes("p-pat"));
});
