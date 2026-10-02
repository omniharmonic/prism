/**
 * Forward linking on ingest (src/people-forward.ts + the opt-in hooks in the
 * Proton / Fathom / ClickUp / Matrix ingesters). Fakes only; synthetic data.
 * "Flags off = unchanged" is the existing ingest suites, which run untouched;
 * here: with the hook, the link rides in the note's OWN write and what cannot be
 * decided goes to the review queue.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLinkInput } from "../src/parachute";
import { ForwardLinker, IngestReviewSink } from "../src/people-forward";
import { ownerProfile } from "../src/identity";
import { listCandidates } from "../src/identity-store";
import { fathomNote, ingestFathom, type FathomMeeting } from "../src/worker/fathom";
import { ClickUpClient, ingestClickUp, type ClickUpVault } from "../src/worker/clickup";
import { ingestMatrix, type IngestVault, type RoomBatch } from "../src/worker/matrix";
import { syncProton, type ImapSource, type ProtonVault } from "../src/worker/proton";
import { ingestAndCleanupFireflies, type FirefliesVault } from "../src/worker/fireflies";
import { syncCalendarWindow, type CalendarVault } from "../src/worker/calendar";
import { resetDb } from "./helpers";

beforeEach(() => resetDb());

const note = (id: string, path: string, tags: string[], metadata: Record<string, unknown> = {}): Note => ({ id, path, tags, metadata, content: "", createdAt: "", updatedAt: `u-${id}` });
const PEOPLE = [
  note("p-owner", "vault/people/Owner Person", ["person"], { name: "Owner Person", email: "owner@example.test", emails: ["owner-alt@example.test"], aliases: ["Ozzy"], channels: { matrix: "@telegram_5559999:h.test" } }),
  note("p-alex", "vault/people/Alex Example", ["person"], { name: "Alex Example", email: "alex@example.test" }),
  note("p-casey", "vault/people/Casey Example", ["person"], { name: "Casey Example" }),
  note("p-blake", "vault/people/Blake Example", ["person"], { name: "Blake Example", channels: { matrix: "@telegram_5550001:h.test" } }),
  note("p-drew1", "vault/people/Drew Twin", ["person"], { name: "Drew Twin" }),
  note("p-drew2", "vault/people/drew-twin", ["person"], { name: "Drew Twin" }),
  note("proj-1", "vault/projects/proj-one", ["project"], { name: "Project One" }),
];

interface Rec {
  lists: Array<Record<string, unknown>>;
  creates: Array<{ path?: string; metadata?: Record<string, unknown>; tags?: string[]; links?: NoteLinkInput[] }>;
  updates: Array<{ id: string; metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[] } }>;
}
function fakeVault(seed: Note[] = PEOPLE) {
  const notes = [...seed];
  const rec: Rec = { lists: [], creates: [], updates: [] };
  let seq = 0;
  const vault = {
    async listNotes(o: { tags?: string[] } & Record<string, unknown>) {
      rec.lists.push({ ...o });
      return notes.filter((n) => (o.tags ?? []).every((t) => (n.tags ?? []).includes(t)));
    },
    async getNote(id: string) {
      return notes.find((n) => n.id === id)!;
    },
    async createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[]; links?: NoteLinkInput[] }) {
      rec.creates.push({ path: p.path, metadata: p.metadata, tags: p.tags, links: p.links });
      const n = note(`new-${++seq}`, p.path ?? "", p.tags ?? [], p.metadata ?? {});
      notes.push(n);
      return { ...n, existed: false };
    },
    async updateNote(id: string, p: { metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[] } }) {
      rec.updates.push({ id, metadata: p.metadata, links: p.links });
      return notes.find((n) => n.id === id)!;
    },
  };
  return { vault, rec, notes };
}
const linker = (vault: ReturnType<typeof fakeVault>["vault"], queue = true) =>
  new ForwardLinker(vault, { vaultId: "primary", origin: "ingest:test", owner: { emails: ["owner@example.test"] }, queue });
const targets = (links: NoteLinkInput[]) => links.map((l) => `${l.relationship}->${l.target}`).sort();

test("ForwardLinker.email: EXACT addresses only — a display name never links mail; bulk links an exact sender; never the owner", async () => {
  const { vault, rec } = fakeVault();
  const f = linker(vault);
  const a = await f.email({ from: "Alex Example <alex@example.test>", to: "Owner <owner@example.test>, Casey Example <casey@example.test>, billing@vendor.test" }, { sender: true, recipients: true });
  assert.deepEqual(targets(a.links), ["email-from->p-alex"], "Casey has no address on file: her name does not link");
  assert.deepEqual(a.pending.map((p) => `${p.relationship}:${p.reason}`), ["email-to:name-only"], "…it is a review item");
  assert.deepEqual((await f.email({ from: "Alex Example <alex@example.test>" }, { sender: false, recipients: true })).links, [], "sender not requested");
  const role = await f.email({ from: "Casey Example <noreply@service.test>", to: "owner@example.test" }, { sender: true, recipients: true });
  assert.deepEqual([role.links, role.pending], [[], []], "a role mailbox nobody claims: nothing, not even a review");
  // Owner decision: an exact address match links even on bulk mail — and nothing else does.
  const bulk = await f.email({ from: "Alex Example <alex@example.test>", to: "alex@example.test, casey@example.test", labels: ["INBOX", "BULK"] }, { sender: true, recipients: true });
  assert.deepEqual(targets(bulk.links), ["email-from->p-alex"]);
  const bulkName = await f.email({ from: "Casey Example <casey@lists.test>", labels: ["PROMOTIONS"] }, { sender: true, recipients: true });
  assert.deepEqual([bulkName.links, bulkName.pending], [[], []]);
  assert.deepEqual((await f.email({ from: "Owner <owner@example.test>", to: "alex@example.test" }, { sender: true, recipients: true })).links, [{ target: "p-alex", relationship: "email-to" }]);
  // H4: an address that resolves to the owner's own note (not in the config) never links.
  assert.deepEqual((await f.email({ from: "Me Elsewhere <owner-alt@example.test>", to: "owner-alt@example.test" }, { sender: true, recipients: true })).links, []);
  const many = Array.from({ length: 11 }, (_, i) => `r${i}@example.test`).join(", ") + ", alex@example.test";
  assert.deepEqual((await f.email({ from: "owner@example.test", to: many }, { sender: true, recipients: true })).links, [], "a mass mailing links no recipients");
  const d = await f.email({ from: "Drew Twin <drew@example.test>" }, { sender: true, recipients: false });
  assert.deepEqual(d.links, []);
  assert.equal(d.pending[0]!.reason, "ambiguous-name");
  assert.deepEqual(d.pending[0]!.candidateIds, ["p-drew1", "p-drew2"]);
  assert.equal(rec.lists.length, 1, "people are listed once per pass");
  assert.deepEqual(rec.lists[0]!.tags, ["person"]);
  assert.ok(Array.isArray(rec.lists[0]!.includeMetadata), "lean: identity keys only");
  assert.equal(rec.creates.length + rec.updates.length, 0, "a forward linker never writes to the vault");
});

test("ForwardLinker.attendees / task: strong keys link, names are review items, the owner by address or configured name, exact unique project", async () => {
  const { vault } = fakeVault();
  const f = linker(vault);
  const att = await f.attendees(["Owner Person", "Ozzy", "Blake Example", "Somebody Else", "12345", "Guest"], ["alex@example.test", "room@resource.calendar.google.com"]);
  assert.deepEqual(targets(att.links), ["attended-by->p-alex", "attended-by->p-owner"]);
  assert.deepEqual(att.pending.map((p) => p.reason).sort(), ["name-only", "single-token-name"], "Blake by name, and the single-token 'Ozzy' — never linked");
  const t = await f.task({ assignees: [{ name: "Owner Person", email: "owner@example.test" }, { name: "Casey Example" }, { name: "Drew" }, { name: "Whoever", email: "alex@example.test" }], project: "Project One" });
  assert.deepEqual(targets(t.links), ["assigned-to->p-alex", "assigned-to->p-owner", "belongs-to->proj-1"]);
  assert.deepEqual(t.pending.map((p) => p.reason), ["name-only"]);
  assert.deepEqual((await f.task({ project: "Nothing Like It" })).links, []);
});

test("queue(): a no-op unless enabled; when enabled the row names the created note", async () => {
  const { vault } = fakeVault();
  const off = linker(vault, false);
  const p = await off.email({ from: "Drew Twin <drew@example.test>" }, { sender: true, recipients: false });
  off.queue("n1", p.pending);
  assert.equal(listCandidates("primary").candidates.length, 0);
  const on = linker(vault, true);
  on.queue("n1", p.pending);
  on.queue("n1", p.pending);
  const rows = listCandidates("primary").candidates;
  assert.equal(rows.length, 1);
  assert.deepEqual({ source: rows[0]!.sourceNoteId, rel: rows[0]!.relationship, origin: rows[0]!.origin, kind: rows[0]!.key.kind }, { source: "n1", rel: "email-from", origin: "ingest:test", kind: "email" });
  assert.equal(on.queued, 1);
});

// ── Fathom ───────────────────────────────────────────────────────────────────

const MEETING: FathomMeeting = { recording_id: "r1", title: "Weekly Sync", scheduled_start_time: "2026-06-01T10:00:00Z", share_url: "https://f.test/r1", calendar_invitees: [{ name: "Alex Example", email: "alex@example.test" }, { name: "Drew Twin" }] };
const fathomClient = { listMeetings: async () => [MEETING], summary: async () => "summary", transcript: async () => "**A**: hi" };

test("Fathom: off = the create is exactly fathomNote(); on = attended-by rides in that same create and the rest is queued", async () => {
  const off = fakeVault();
  await ingestFathom(fathomClient, off.vault as unknown as IngestVault);
  assert.equal(off.rec.creates.length, 1);
  assert.equal(off.rec.creates[0]!.links, undefined);
  const expected = fathomNote(MEETING, "summary", "**A**: hi");
  assert.deepEqual({ ...off.rec.creates[0]!.metadata, synced_at: 0 }, { ...expected.metadata, synced_at: 0 });
  assert.equal(off.rec.lists.filter((l) => (l.tags as string[]).includes("person")).length, 0, "people are not even listed");

  const on = fakeVault();
  await ingestFathom(fathomClient, on.vault as unknown as IngestVault, { forward: linker(on.vault) });
  assert.equal(on.rec.creates.length, 1, "still one write");
  assert.equal(on.rec.updates.length, 0, "no follow-up PATCH");
  assert.deepEqual(on.rec.creates[0]!.links, [{ target: "p-alex", relationship: "attended-by" }]);
  assert.deepEqual({ ...on.rec.creates[0]!.metadata, synced_at: 0 }, { ...expected.metadata, synced_at: 0 }, "the note itself is unchanged");
  const q = listCandidates("primary").candidates;
  assert.equal(q.length, 1);
  assert.equal(q[0]!.sourceNoteId, "new-1");
  assert.equal(q[0]!.relationship, "attended-by");
});

// ── ClickUp ──────────────────────────────────────────────────────────────────

function clickupFetch(tasks: unknown[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/user") ? { user: { id: 7 } } : url.includes("/team/") ? { tasks, last_page: true } : { teams: [{ id: "t1", name: "Team" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const TASK = { id: "abc123", name: "Ship it", status: { status: "open" }, date_updated: "1755000000000", url: "https://app.clickup.test/t/abc123", assignees: [{ id: 7, username: "Alex E.", email: "alex@example.test" }], list: { name: "Project One" } };

test("ClickUp: on = assigned-to / belongs-to ride in the task's create and in a later update", async () => {
  const v = fakeVault();
  const client = new ClickUpClient("pk_test_x", clickupFetch([TASK]));
  await ingestClickUp(client, v.vault as unknown as ClickUpVault, { credential: { apiKey: "pk_test_x" }, sinceMs: null, sleep: async () => {}, forward: linker(v.vault) });
  assert.equal(v.rec.creates.length, 1);
  assert.deepEqual(targets(v.rec.creates[0]!.links ?? []), ["assigned-to->p-alex", "belongs-to->proj-1"]);
  assert.equal(v.rec.updates.length, 0);

  // The same task, changed upstream → ONE update carrying links.add.
  const client2 = new ClickUpClient("pk_test_x", clickupFetch([{ ...TASK, date_updated: "1755000009999" }]));
  await ingestClickUp(client2, v.vault as unknown as ClickUpVault, { credential: { apiKey: "pk_test_x" }, sinceMs: 1, sleep: async () => {}, forward: linker(v.vault) });
  assert.equal(v.rec.updates.length, 1);
  assert.deepEqual(targets(v.rec.updates[0]!.links?.add ?? []), ["assigned-to->p-alex", "belongs-to->proj-1"]);

  const off = fakeVault();
  await ingestClickUp(new ClickUpClient("pk_test_x", clickupFetch([TASK])), off.vault as unknown as ClickUpVault, { credential: { apiKey: "pk_test_x" }, sinceMs: null, sleep: async () => {} });
  assert.equal(off.rec.creates[0]!.links, undefined, "off: no links, no people listing");
  assert.equal(off.rec.lists.filter((l) => (l.tags as string[]).includes("person")).length, 0);
});

// ── Matrix ───────────────────────────────────────────────────────────────────

const batch = (roomId: string): RoomBatch => ({
  roomId,
  name: "Blake Example",
  messages: [{ eventId: "$1", sender: "@telegram_5550001:h.test", body: "hi", ts: 1_750_000_000_000 }],
  displayNames: { "@telegram_5550001:h.test": "Blake Example" },
  memberIds: ["@telegram_5550001:h.test"],
} as unknown as RoomBatch);
const matrixClient = (members: Record<string, string>) => ({
  sync: async () => ({ nextBatch: "s2", rooms: [batch("!dm:h.test")], invites: [] }),
  joinedMembers: async () => members,
});
const DM = { "@telegram_5550001:h.test": "Blake Example", "@telegram_5550009:h.test": "Brand New", "@owner:h.test": "Owner", "@telegrambot:h.test": "Telegram bridge bot" };

test("Matrix: MATRIX_LINK_EXISTING links known people and creates nobody; participantIds are stored only when asked", async () => {
  const v = fakeVault();
  const r = await ingestMatrix(matrixClient(DM) as never, v.vault as unknown as IngestVault, { linkExisting: true, storeParticipantIds: true, selfUserId: "@owner:h.test" });
  assert.equal(r.peopleCreated, 0);
  const thread = v.rec.creates.filter((c) => c.tags?.includes("message-thread"));
  assert.equal(thread.length, 1);
  assert.equal(v.rec.creates.length, 1, "no person note was created — even in a DM");
  assert.deepEqual(thread[0]!.links, [{ target: "p-blake", relationship: "messages-with" }]);
  assert.deepEqual(thread[0]!.metadata!.participantIds, Object.keys(DM));

  // The existing flag keeps its behaviour: in a small room it creates the unknown member.
  const legacy = fakeVault();
  const small = { "@telegram_5550001:h.test": "Blake Example", "@telegram_5550009:h.test": "Brand New" };
  const lr = await ingestMatrix(matrixClient(small) as never, legacy.vault as unknown as IngestVault, { linkPeople: true });
  assert.equal(lr.peopleCreated, 1);

  const off = fakeVault();
  await ingestMatrix(matrixClient(DM) as never, off.vault as unknown as IngestVault, {});
  assert.equal(off.rec.creates[0]!.links, undefined);
  assert.ok(!("participantIds" in off.rec.creates[0]!.metadata!), "off: the note shape is unchanged");
});

test("Matrix (H4 + decision 4): the owner's own note is never linked by a resolved match; an unresolved DM counterpart is queued once", async () => {
  const v = fakeVault();
  // A DM: the owner under a bridge id that is on their person note, and Casey under an unknown puppet.
  const dm = { "@telegram_5559999:h.test": "Owner Person", "@telegram_5550002:h.test": "Casey Example", "@telegrambot:h.test": "bot" };
  const sink = new IngestReviewSink({ vaultId: "primary", origin: "ingest:matrix", relationship: "messages-with" });
  const run = () =>
    ingestMatrix(matrixClient(dm) as never, v.vault as unknown as IngestVault, {
      linkExisting: true,
      ownerPersonId: (people) => ownerProfile(people.identity, { emails: ["owner@example.test"] }).person?.id ?? null,
      reviewSink: sink,
    });
  await run();
  const thread = v.rec.creates.find((c) => c.tags?.includes("message-thread"))!;
  assert.equal(thread.links, undefined, "the owner is not a participant link; Casey is not guessed from her display name");
  assert.equal(listCandidates("primary").candidates.length, 0, "a thread created this pass has no id yet");
  await run();
  await run();
  const q = listCandidates("primary").candidates;
  assert.equal(q.length, 1, "queued once the thread exists — and deduped across passes");
  assert.deepEqual({ rel: q[0]!.relationship, reason: q[0]!.reason, origin: q[0]!.origin, cands: q[0]!.candidateIds }, { rel: "messages-with", reason: "name-only", origin: "ingest:matrix", cands: ["p-casey"] });
  assert.equal(v.rec.creates.filter((c) => c.tags?.includes("person")).length, 0);

  // A GROUP room's roster never reaches the queue.
  const g = fakeVault();
  const group = { ...dm, "@telegram_5550010:h.test": "Drew Twin", "@telegram_5550011:h.test": "Someone Else" };
  const gs = new IngestReviewSink({ vaultId: "primary", origin: "ingest:matrix", relationship: "messages-with" });
  resetDb();
  for (let i = 0; i < 2; i++) await ingestMatrix(matrixClient(group) as never, g.vault as unknown as IngestVault, { linkExisting: true, reviewSink: gs });
  assert.equal(listCandidates("primary").candidates.length, 0);
});

// ── Proton ───────────────────────────────────────────────────────────────────

const RAW = Buffer.from(
  ["From: Stranger Name <stranger@example.test>", "To: Owner <owner@example.test>, Casey Example <casey@example.test>, Alex <alex@example.test>", "Subject: Planning", "Message-ID: <m1@example.test>", "Date: Mon, 28 Sep 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "Hello there."].join("\r\n"),
);
const imap = (): ImapSource => ({
  async connect() {
    return {
      openMailbox: async () => ({ uidValidity: "1" }),
      searchSince: async () => [1],
      fetchRefs: async () => [{ uid: 1, flags: [], messageId: "<m1@example.test>" }],
      fetchSource: async () => ({ source: RAW, flags: [] }),
      close: async () => {},
    };
  },
});
const pass = (over: Record<string, unknown> = {}) => ({ mailboxes: ["INBOX"], sinceDays: 7, maxPerMailbox: 200, shadow: false, account: "owner@example.test", tz: "UTC", now: Date.parse("2026-09-29T00:00:00Z"), ...over });

test("Proton: PROTON_LINK_RECIPIENTS adds email-to in the same create; without the hook nothing changes", async () => {
  const off = fakeVault();
  await syncProton(imap(), off.vault as unknown as ProtonVault, pass({ linkPeople: true }));
  assert.equal(off.rec.creates.length, 1);
  assert.equal(off.rec.creates[0]!.links, undefined, "the legacy flag alone: an unknown sender links nothing");

  const on = fakeVault();
  const r = await syncProton(imap(), on.vault as unknown as ProtonVault, pass({ linkPeople: true, linkRecipients: true, forward: linker(on.vault) }));
  assert.equal(r.created, 1);
  assert.equal(on.rec.creates.length, 1, "one write");
  assert.equal(on.rec.updates.length, 0);
  // The Proton note keeps recipient ADDRESSES only (script parity), so a recipient
  // links by address — Casey has none on file and is, correctly, not guessed.
  assert.deepEqual(targets(on.rec.creates[0]!.links ?? []), ["email-to->p-alex"], "never the owner");
  assert.deepEqual(on.rec.creates[0]!.metadata, off.rec.creates[0]!.metadata, "the note itself is byte-identical");

  // Recipients off, sender on via the hook: nothing to link, nothing queued (no candidate).
  const s = fakeVault();
  await syncProton(imap(), s.vault as unknown as ProtonVault, pass({ linkPeople: true, forward: linker(s.vault) }));
  assert.equal(s.rec.creates[0]!.links, undefined);
  assert.equal(listCandidates("primary").candidates.length, 0);
});

test("M5 Proton: turning on recipients / the queue never makes the SENDER link by display name", async () => {
  const raw = Buffer.from(["From: Casey Example <unknown-sender@example.test>", "To: Owner <owner@example.test>", "Subject: Hi", "Message-ID: <m2@example.test>", "Date: Mon, 28 Sep 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "Hello."].join("\r\n"));
  const source: ImapSource = { async connect() { return { openMailbox: async () => ({ uidValidity: "1" }), searchSince: async () => [2], fetchRefs: async () => [{ uid: 2, flags: [], messageId: "<m2@example.test>" }], fetchSource: async () => ({ source: raw, flags: [] }), close: async () => {} }; } };
  const v = fakeVault();
  await syncProton(source, v.vault as unknown as ProtonVault, pass({ linkPeople: true, linkRecipients: true, forward: linker(v.vault, true) }));
  assert.equal(v.rec.creates[0]!.links, undefined, "a display name equal to a person's name is NOT a sender link");
  const q = listCandidates("primary").candidates;
  assert.equal(q.length, 1, "it is a review item");
  assert.deepEqual({ rel: q[0]!.relationship, reason: q[0]!.reason, cands: q[0]!.candidateIds }, { rel: "email-from", reason: "name-only", cands: ["p-casey"] });
});

// ── Fireflies ────────────────────────────────────────────────────────────────

test("Fireflies: on = attended-by rides in the transcript's create; off = no links, no people listing", async () => {
  const t = { id: "ff-1", title: "Planning", date: Date.parse("2026-06-01T10:00:00Z"), meeting_attendees: [{ displayName: "Alex Example", email: "alex@example.test" }, { displayName: "Drew Twin", email: null }] };
  const client = {
    listTranscripts: async () => [t],
    getTranscript: async () => ({ summary: { overview: "sum" }, sentences: [{ speaker_name: "A", text: "x".repeat(400) }] }),
    deleteTranscript: async () => true,
  };
  const budget = () => {
    let left = 999;
    return { remaining: () => left, spend: (n: number) => void (left -= n) };
  };
  const off = fakeVault();
  const r0 = await ingestAndCleanupFireflies(client as never, off.vault as unknown as FirefliesVault, { budget: budget() as never, sleep: async () => {} });
  assert.equal(r0.created, 1);
  assert.equal(off.rec.creates[0]!.links, undefined);
  assert.equal(off.rec.lists.filter((l) => (l.tags as string[]).includes("person")).length, 0);

  const on = fakeVault();
  const r1 = await ingestAndCleanupFireflies(client as never, on.vault as unknown as FirefliesVault, { budget: budget() as never, sleep: async () => {}, forward: linker(on.vault) });
  assert.equal(r1.created, 1);
  assert.equal(on.rec.creates.length, 1, "one write");
  assert.equal(on.rec.updates.length, 0);
  assert.deepEqual(on.rec.creates[0]!.links, [{ target: "p-alex", relationship: "attended-by" }]);
  assert.deepEqual({ ...on.rec.creates[0]!.metadata, synced_at: 0 }, { ...off.rec.creates[0]!.metadata, synced_at: 0 }, "the note itself is unchanged");
  const q = listCandidates("primary").candidates;
  assert.deepEqual(q.map((c) => `${c.sourceNoteId}:${c.relationship}:${c.reason}`), ["new-1:attended-by:ambiguous-name"]);
});

// ── Calendar ─────────────────────────────────────────────────────────────────

test("Calendar (M7): attendees that are not linked reach the review queue when a sink is given; without one nothing changes", async () => {
  const event = { id: "ev1", summary: "Sync", start: { dateTime: "2026-10-05T10:00:00Z" }, end: { dateTime: "2026-10-05T11:00:00Z" }, attendees: [{ displayName: "Alex Example", email: "alex@example.test" }, { displayName: "Drew Twin", email: "drew@example.test" }] };
  const client = { listEventsRange: async () => ({ events: [event] }) };
  const base = { from: "2026-10-01", to: "2026-10-31", max: 250, shadow: false, deleteMode: "log" as const, source: "worker" as const, now: Date.parse("2026-10-02T00:00:00Z") };
  const calVault = (v: ReturnType<typeof fakeVault>) => ({ ...v.vault, deleteNote: async () => {} }) as unknown as CalendarVault;

  const plain = fakeVault();
  await syncCalendarWindow(client as never, calVault(plain), base);
  const meeting = plain.rec.creates.find((c) => c.tags?.includes("meeting"))!;
  assert.deepEqual(meeting.links, [{ target: "p-alex", relationship: "attended-by" }]);
  assert.equal(plain.rec.creates.filter((c) => c.tags?.includes("person")).length, 0, "an ambiguous name was skipped before too");
  assert.equal(listCandidates("primary").candidates.length, 0, "…silently");

  const queued = fakeVault();
  const sink = new IngestReviewSink({ vaultId: "primary", origin: "ingest:calendar", relationship: "attended-by" });
  await syncCalendarWindow(client as never, calVault(queued), { ...base, reviewSink: sink });
  const m2 = queued.rec.creates.find((c) => c.tags?.includes("meeting"))!;
  assert.deepEqual(m2.links, meeting.links, "linking is identical");
  const q = listCandidates("primary").candidates;
  assert.equal(q.length, 1);
  assert.deepEqual({ rel: q[0]!.relationship, reason: q[0]!.reason, origin: q[0]!.origin, cands: q[0]!.candidateIds }, { rel: "attended-by", reason: "ambiguous-name", origin: "ingest:calendar", cands: ["p-drew1", "p-drew2"] });
});
