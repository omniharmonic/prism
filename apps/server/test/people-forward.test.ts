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
import { ForwardLinker } from "../src/people-forward";
import { listCandidates } from "../src/identity-store";
import { fathomNote, ingestFathom, type FathomMeeting } from "../src/worker/fathom";
import { ClickUpClient, ingestClickUp, type ClickUpVault } from "../src/worker/clickup";
import { ingestMatrix, type IngestVault, type RoomBatch } from "../src/worker/matrix";
import { syncProton, type ImapSource, type ProtonVault } from "../src/worker/proton";
import { resetDb } from "./helpers";

beforeEach(() => resetDb());

const note = (id: string, path: string, tags: string[], metadata: Record<string, unknown> = {}): Note => ({ id, path, tags, metadata, content: "", createdAt: "", updatedAt: `u-${id}` });
const PEOPLE = [
  note("p-owner", "vault/people/Owner Person", ["person"], { name: "Owner Person", email: "owner@example.test", aliases: ["Ozzy"] }),
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

test("ForwardLinker.email: sender + direct recipients; never the owner, a role address or bulk mail; ONE lean people listing", async () => {
  const { vault, rec } = fakeVault();
  const f = linker(vault);
  const a = await f.email({ from: "Alex Example <alex@example.test>", to: "Owner <owner@example.test>, Casey Example <casey@example.test>, billing@vendor.test" }, { sender: true, recipients: true });
  assert.deepEqual(targets(a.links), ["email-from->p-alex", "email-to->p-casey"]);
  assert.deepEqual((await f.email({ from: "Alex Example <alex@example.test>" }, { sender: false, recipients: true })).links, [], "sender not requested");
  assert.deepEqual((await f.email({ from: "noreply@service.test", to: "owner@example.test" }, { sender: true, recipients: true })).links, []);
  assert.deepEqual((await f.email({ from: "Alex Example <alex@example.test>", labels: ["INBOX", "BULK"] }, { sender: true, recipients: true })).links, []);
  assert.deepEqual((await f.email({ from: "Owner <owner@example.test>", to: "alex@example.test" }, { sender: true, recipients: true })).links, [{ target: "p-alex", relationship: "email-to" }]);
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

test("ForwardLinker.attendees / task: owner by configuration, name rule, exact unique project", async () => {
  const { vault } = fakeVault();
  const f = linker(vault);
  assert.deepEqual(targets((await f.attendees(["Ozzy", "Blake Example", "Somebody Else", "12345"], ["alex@example.test", "room@resource.calendar.google.com"])).links), ["attended-by->p-alex", "attended-by->p-blake", "attended-by->p-owner"]);
  const t = await f.task({ assignees: [{ name: "Owner Person", email: "owner@example.test" }, { name: "Casey Example" }, { name: "Drew" }], project: "Project One" });
  assert.deepEqual(targets(t.links), ["assigned-to->p-casey", "assigned-to->p-owner", "belongs-to->proj-1"]);
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
const TASK = { id: "abc123", name: "Ship it", status: { status: "open" }, date_updated: "1755000000000", url: "https://app.clickup.test/t/abc123", assignees: [{ id: 7, username: "Casey Example", email: "casey@example.test" }], list: { name: "Project One" } };

test("ClickUp: on = assigned-to / belongs-to ride in the task's create and in a later update", async () => {
  const v = fakeVault();
  const client = new ClickUpClient("pk_test_x", clickupFetch([TASK]));
  await ingestClickUp(client, v.vault as unknown as ClickUpVault, { credential: { apiKey: "pk_test_x" }, sinceMs: null, sleep: async () => {}, forward: linker(v.vault) });
  assert.equal(v.rec.creates.length, 1);
  assert.deepEqual(targets(v.rec.creates[0]!.links ?? []), ["assigned-to->p-casey", "belongs-to->proj-1"]);
  assert.equal(v.rec.updates.length, 0);

  // The same task, changed upstream → ONE update carrying links.add.
  const client2 = new ClickUpClient("pk_test_x", clickupFetch([{ ...TASK, date_updated: "1755000009999" }]));
  await ingestClickUp(client2, v.vault as unknown as ClickUpVault, { credential: { apiKey: "pk_test_x" }, sinceMs: 1, sleep: async () => {}, forward: linker(v.vault) });
  assert.equal(v.rec.updates.length, 1);
  assert.deepEqual(targets(v.rec.updates[0]!.links?.add ?? []), ["assigned-to->p-casey", "belongs-to->proj-1"]);

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
