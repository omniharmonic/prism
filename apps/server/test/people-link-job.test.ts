/**
 * The people-linking backfill job (src/people-link-job.ts) and its owner-only
 * routes. An in-memory vault with real two-sided links; synthetic people only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLinkInput, NoteLink } from "../src/parachute";
import { config } from "../src/config";
import { db, setMembership } from "../src/db";
import { adminApi } from "../src/routes/admin";
import { enqueueCandidate, listCandidates, openCandidateCounts } from "../src/identity-store";
import { PHASES, _resetLinkJob, addressList, cancelLinkJob, lastLinkJobOutcome, linkJobStatus, startLinkJob, type LinkJob, type LinkJobOptions, type LinkJobVault, type Phase } from "../src/people-link-job";
import { _resetPeopleCache } from "../src/people-cache";
import { _resetPeopleLock, acquirePeopleLock } from "../src/people-lock";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";

type Seed = Partial<Note> & { id: string; byteSize?: number };
type Stored = Note & { byteSize?: number };

class MemVault implements LinkJobVault {
  notes = new Map<string, Stored>();
  edges: Array<NoteLink & { metadata?: Record<string, unknown> }> = [];
  lists: Array<Record<string, unknown>> = [];
  patches: Array<{ id: string; add: NoteLinkInput[]; remove: NoteLinkInput[]; metadata?: Record<string, unknown>; ifUpdatedAt?: string }> = [];
  conflictOn = new Set<string>();
  tooLarge = new Set<string>();
  failAll: number | null = null;
  hang = false;
  gate: Promise<void> | null = null;
  private clock = 0;
  private stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++this.clock)).toISOString();
  put(n: Seed, links: Array<[string, string, string]> = []): void {
    this.notes.set(n.id, { content: "", path: null, metadata: {}, createdAt: "", updatedAt: "2026-01-01T00:00:00.000Z", tags: [], ...n });
    for (const [s, t, r] of links) this.edges.push({ sourceId: s, targetId: t, relationship: r });
  }
  linksOf(id: string): NoteLink[] {
    return this.edges.filter((e) => e.sourceId === id || e.targetId === id).map((e) => ({ ...e }));
  }
  out(id: string, rel?: string): string[] {
    return this.edges.filter((e) => e.sourceId === id && (!rel || e.relationship === rel)).map((e) => `${e.relationship}->${e.targetId}`).sort();
  }
  graph(): string[] {
    return this.edges.map((e) => `${e.sourceId}|${e.relationship}|${e.targetId}`).sort();
  }
  async listNotes(opts: { tags?: string[]; includeLinks?: boolean; includeMetadata?: string[] }): Promise<Note[]> {
    this.lists.push({ ...opts });
    return [...this.notes.values()]
      .filter((n) => (opts.tags ?? []).every((t) => (n.tags ?? []).includes(t)))
      .map((n) => {
        const md = opts.includeMetadata ? Object.fromEntries(Object.entries(n.metadata ?? {}).filter(([k]) => opts.includeMetadata!.includes(k))) : n.metadata;
        return structuredClone({ ...n, content: "", metadata: md, ...(opts.includeLinks ? { links: this.linksOf(n.id) } : {}) });
      });
  }
  async updateNote(id: string, p: { links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] }; metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note> {
    if (this.hang) await new Promise(() => {});
    if (this.gate) await this.gate;
    const n = this.notes.get(id);
    if (!n) throw Object.assign(new Error("not found"), { status: 404 });
    if (this.failAll) throw Object.assign(new Error(`PATCH: ${this.failAll}`), { status: this.failAll });
    if (this.tooLarge.has(id)) throw Object.assign(new Error("too large"), { status: 413 });
    if (!p.ifUpdatedAt) throw new Error("TEST: a write without if_updated_at would be a force write");
    if (this.conflictOn.has(id) || p.ifUpdatedAt !== n.updatedAt) throw Object.assign(new Error("conflict"), { status: 409 });
    this.patches.push({ id, add: p.links?.add ?? [], remove: p.links?.remove ?? [], metadata: p.metadata, ifUpdatedAt: p.ifUpdatedAt });
    for (const r of p.links?.remove ?? []) this.edges = this.edges.filter((e) => !(e.sourceId === id && e.targetId === r.target && e.relationship === r.relationship));
    for (const a of p.links?.add ?? []) if (!this.edges.some((e) => e.sourceId === id && e.targetId === a.target && e.relationship === a.relationship)) this.edges.push({ sourceId: id, targetId: a.target, relationship: a.relationship });
    if (p.metadata) n.metadata = { ...(n.metadata ?? {}), ...p.metadata };
    n.updatedAt = this.stamp();
    return { ...n };
  }
}

const OWNER = { emails: ["owner@example.test"], aliases: ["Ozzy"], matrixId: "@owner:h.test" };
const person = (id: string, name: string, md: Record<string, unknown> = {}, tags: string[] = []): Seed => ({ id, path: `vault/people/${name}`, tags: ["person", ...tags], metadata: { name, ...md } });

function seed(v: MemVault): void {
  v.put(person("p-owner", "Owner Person", { email: "owner@example.test", channels: { matrix: "@telegram_5559999:h.test" } }));
  v.put(person("p-alex", "Alex Example", { email: "alex@example.test" }));
  v.put(person("p-blake", "Blake Example", { channels: { matrix: "@telegram_5550001:h.test" } }));
  v.put(person("p-casey", "Casey Example"));
  v.put(person("p-drew1", "Drew Twin"));
  v.put({ ...person("p-drew2", "Drew Twin"), path: "vault/people/drew-twin" });
  v.put(person("p-eli", "Eli Stone", { email: "eli@example.test" }));
  v.put(person("p-fin", "Fin Moss"));
  v.put(person("bot", "Notetaker", { email: "notetaker@bots.test" }, ["bot"]));
  // A merged stub that still carries Alex's address and four links (one of them
  // with a REVERSED twin on the canonical side — M1).
  v.put(person("s-alex", "alex-example-test", { email: "alex@example.test", merged_into: "vault/people/Alex Example", status: "merged_into_canonical" }, ["merged-stub"]), [
    ["e-old", "s-alex", "email-from"],
    ["s-alex", "org-1", "member-of"],
    ["org-1", "p-alex", "member-of"],
    ["d-1", "s-alex", "wikilink"],
  ]);
  // Broken tombstones: one sharing an address with ONE live person, one whose
  // name equals one live person's, one that matches nobody.
  v.put({ ...person("s-eli", "eli-old", { email: "eli@example.test" }, ["merged-stub"]) }, [["e-eli", "s-eli", "email-from"]]);
  v.put({ ...person("s-fin", "Fin Moss", { status: "merged_into_canonical" }), path: "vault/people/fin-moss-old" });
  v.put(person("s-lost", "lost-thing", { merged_into: "vault/people/Nobody Here" }, ["merged-stub"]));
  // A stub merged INTO AN ORGANIZATION on purpose — it shares an address with a live person (H-1).
  v.put(person("p-gus", "Gus Reed", { email: "gus@example.test" }));
  v.put(person("s-org", "gus-at-org", { email: "gus@example.test", merged_into: "vault/organizations/Org One" }, ["merged-stub"]), [["k-org", "s-org", "assigned-to"]]);
  v.put({ id: "k-org", path: "vault/tasks/k-org", tags: ["task"] });
  // A role mailbox that a person note claims (M-3).
  v.put(person("p-acme", "Acme Team", { email: "team@acme.test" }));
  v.put({ id: "org-1", path: "vault/organizations/Org One", tags: ["organization"] });
  v.put({ id: "d-1", path: "vault/notes/Doc", tags: [] });

  const email = (id: string, md: Record<string, unknown>, links: Array<[string, string, string]> = []) => v.put({ id, path: `vault/messages/email/${id}`, tags: ["email"], metadata: { labels: ["INBOX"], ...md } }, links);
  email("e-old", { from: "Alex <alex@example.test>", to: "owner@example.test" });
  email("e-eli", { from: "Eli <eli@example.test>", to: "owner@example.test" });
  email("e1", { from: "Alex Example <alex@example.test>", to: "Owner <owner@example.test>" });
  email("e2", { from: "Service <noreply@service.test>", to: "owner@example.test" });
  email("e3", { from: "Alex Example <alex@example.test>", to: "owner@example.test, list@lists.test", labels: ["INBOX", "BULK"] });
  email("e3b", { from: "Casey Example <casey@lists.test>", to: "owner@example.test", labels: ["INBOX", "PROMOTIONS"] });
  email("e4", { from: "Owner <owner@example.test>", to: "Casey Example <casey@example.test>, Alex <alex@example.test>" });
  email("e5", { from: "Drew Twin <drew@example.test>", to: "owner@example.test" });
  email("e6", { from: "Alex Example <alex@example.test>", to: "owner@example.test" }, [["e6", "p-alex", "email-from"]]);
  email("e7", { from: "Help Desk <support@vendor.test>", to: "owner@example.test, Alex <alex@example.test>" });
  email("e8", { from: "Fathom <notetaker@bots.test>", to: "owner@example.test" });
  email("e9", { from: "Acme Team <team@acme.test>", to: "owner@example.test, info@acme.test" });

  v.put({ id: "m1", path: "vault/meetings/2026-01-01/sync", tags: ["meeting"], metadata: { attendees: ["owner@example.test", "Blake Example", "Unknown Person", "room@resource.calendar.google.com"], attendeeEmails: ["owner@example.test"] } });
  v.put({ id: "t1", path: "vault/_inbox/transcripts/t1", tags: ["transcript"], metadata: { attendees: ["Owner Person", "Alex Example", "Guest"] } });

  v.put({ id: "th1", path: "vault/messages/telegram/blake", tags: ["message-thread"], metadata: { participants: ["Blake Example (Telegram)", "Owner Person"], matrixRoomId: "!r1:h.test" } });
  v.put({ id: "th2", path: "vault/messages/telegram/b2", tags: ["message-thread"], metadata: { participants: ["B"], participantIds: ["@telegram_5550001:h.test", "@owner:h.test", "@telegram_5559999:h.test", "@telegrambot:h.test"], matrixRoomId: "!r2:h.test" } });
  v.put({ id: "th3", path: "vault/messages/telegram/huge", tags: ["message-thread"], metadata: { participants: Array.from({ length: 60 }, (_, i) => `Member Number${i}`), matrixRoomId: "!r3:h.test" } });
  v.put({ id: "th4", path: "vault/messages/telegram/group", tags: ["message-thread"], metadata: { participants: ["Alex Example", ...Array.from({ length: 9 }, (_, i) => `Guest Person${i}`)], matrixRoomId: "!r4:h.test" } });
  v.put({ id: "th5", path: "vault/messages/telegram/casey", tags: ["message-thread"], metadata: { participants: [], matrixRoomId: "!r5:h.test" } });
  v.put({ id: "th6", path: "vault/messages/telegram/names", tags: ["message-thread"], metadata: { participants: ["Casey Example", "Owner Person"] } });

  v.put({ id: "proj-1", path: "vault/projects/proj-one", tags: ["project"], metadata: { name: "Project One" } });
  v.put({ id: "k1", path: "vault/tasks/k1", tags: ["task"], metadata: { assigned: "Ozzy", project: "proj-one" } });
  v.put({ id: "k2", path: "vault/tasks/k2", tags: ["task"], metadata: { assigned: "Alex Example, Casey Example", project: "Unknown" } });
  v.put({ id: "k3", path: "vault/tasks/k3", tags: ["task"], metadata: { assigned: "Drew", project: "Second Project" } });
  v.put({ id: "proj-2", path: "vault/projects/p2/index", tags: ["project"], metadata: { title: "Second Project" } });
  v.put({ id: "k4", path: "vault/tasks/k4", tags: ["task"], metadata: { assigned: "[[vault/people/Blake Example]]", project: "[[vault/projects/proj-one]]" } });

  v.put({ id: "n1", path: "vault/meetings/n1", tags: ["meeting"] }, [
    ["n1", "p-casey", "attendee"],
    ["p-casey", "n1", "attended"],
  ]);
  // Synonyms that must be left exactly as they are.
  v.put({ id: "dual", path: "vault/projects/dual", tags: ["task", "project"] }, [["dual", "p-alex", "owner"]]);
  v.edges.push({ sourceId: "p-alex", targetId: "e1", relationship: "to" });
}

const members = async (roomId: string): Promise<Record<string, string> | null> =>
  roomId === "!r1:h.test"
    ? { "@telegram_5550001:h.test": "Blake Example", "@owner:h.test": "Owner" }
    : roomId === "!r5:h.test"
      ? { "@telegram_5550002:h.test": "Casey Example", "@owner:h.test": "Owner" }
      : null;
const opts = (o: Partial<LinkJobOptions> = {}): LinkJobOptions => ({ dryRun: true, owner: OWNER, paceMs: 0, members, limits: { memberPaceMs: 0 }, ...o });
const runJob = async (v: LinkJobVault, o: Partial<LinkJobOptions> = {}): Promise<LinkJob> => {
  const { done } = startLinkJob(v, "primary", opts(o));
  await done;
  return linkJobStatus()!;
};
const PLANNED = ["scanned", "wouldLink", "wouldUnlink", "notesToWrite", "alreadyLinked", "byEvidence", "queued", "queuedByReason", "skipped", "extra"] as const;
const planned = (j: LinkJob, p: Phase) => Object.fromEntries(PLANNED.map((k) => [k, j.report[p][k]]));

beforeEach(() => {
  _resetLinkJob();
  _resetPeopleLock();
  _resetPeopleCache();
  resetDb();
});

test("phase order and address parsing", () => {
  assert.deepEqual([...PHASES], ["owner", "tombstones", "repoint", "emails", "meetings", "threads", "tasks", "normalize"]);
  assert.deepEqual(addressList('"Last, First" <a@x.test>, b@y.test, Not An Address'), [
    { name: "Last, First", email: "a@x.test" },
    { name: "", email: "b@y.test" },
  ]);
});

test("a dry run plans exactly what a write run then writes; runs converge to zero writes", async () => {
  for (const allowNameLinks of [false, true]) {
    _resetLinkJob();
    resetDb();
    const v = new MemVault();
    seed(v);
    for (let round = 0; round < 2; round++) {
      const before = v.patches.length;
      const dry = await runJob(v, { allowNameLinks });
      assert.equal(dry.status, "done");
      assert.equal(v.patches.length, before, "a dry run never writes");
      assert.equal(listCandidates("primary").candidates.length, 0, "nothing is queued unless asked");
      const wet = await runJob(v, { dryRun: false, allowNameLinks });
      assert.equal(wet.status, "done", wet.error ?? "");
      for (const p of wet.phases) {
        assert.deepEqual(planned(wet, p), planned(dry, p), `round ${round}, phase ${p} planned the same (allowNameLinks=${allowNameLinks})`);
        const r = wet.report[p];
        assert.equal(r.linked, r.wouldLink, `${p}: every planned link was written`);
        assert.equal(r.unlinked, r.wouldUnlink, `${p}: every planned removal was written`);
        assert.equal(r.notesWritten, r.notesToWrite, p);
        assert.equal(r.conflicts + r.errors + r.deferred, 0, p);
        assert.equal(Object.values(r.byEvidence).reduce((a, b) => a + (b ?? 0), 0), p === "tombstones" ? (r.extra.repaired ?? 0) : p === "normalize" ? 0 : r.wouldLink, `${p}: every planned link has an evidence kind`);
      }
      assert.ok(v.patches.every((x) => x.ifUpdatedAt), "every write is a CAS write");
      assert.ok(wet.writes >= v.patches.length - before);
    }
    // Round 1 repaired a tombstone; round 2 moved its links. A third run has nothing to do.
    const n = v.patches.length;
    const again = await runJob(v, { dryRun: false, allowNameLinks });
    assert.equal(v.patches.length, n, "converged: zero writes");
    for (const p of again.phases) assert.equal(again.report[p].wouldLink + again.report[p].wouldUnlink + again.report[p].notesToWrite, 0, p);
    assert.equal(lastLinkJobOutcome("primary")?.status, "done");
  }
});

test("default run: only strong keys link; names go to review; what each phase does", async () => {
  const v = new MemVault();
  seed(v);
  const j = await runJob(v, { dryRun: false, enqueue: true });
  assert.equal(j.ownerPersonKnown, true);

  // owner: the configured alias is appended to the owner's note (and nothing else touched).
  assert.deepEqual(v.notes.get("p-owner")!.metadata!.aliases, ["Ozzy"]);
  assert.equal(v.notes.get("p-owner")!.metadata!.email, "owner@example.test");
  assert.equal(j.report.owner.extra.identitiesAdded, 1);

  // tombstones: a DANGLING stub is repaired only on a strong key, to the note ID;
  // a name match is a review item (H-2); a stub merged into an organization is not broken (H-1).
  assert.equal(v.notes.get("s-eli")!.metadata!.merged_into, "p-eli");
  assert.equal(v.notes.get("s-fin")!.metadata!.merged_into, undefined, "a name is never an automatic repair");
  assert.equal(v.notes.get("s-lost")!.metadata!.merged_into, "vault/people/Nobody Here", "never guessed");
  assert.equal(v.notes.get("s-org")!.metadata!.merged_into, "vault/organizations/Org One", "merged into an organization on purpose: left exactly as it is");
  assert.deepEqual(j.report.tombstones.byEvidence, { email: 1 });
  assert.deepEqual(j.report.tombstones.queuedByReason, { "tombstone-unresolved": 2 });
  assert.deepEqual(j.report.tombstones.extra, { resolvable: 1, repaired: 1, leftTargetNotAPerson: 1 });
  assert.equal(j.report.tombstones.skipped["target-not-a-live-person"], 1);

  // repoint: inbound + outbound move, direction preserved (M1). A stub repaired in
  // THIS run is not repointed until a later run; the organization's stub never is.
  assert.deepEqual(v.out("e-old"), ["email-from->p-alex"]);
  assert.deepEqual(v.out("e-eli"), ["email-from->s-eli"]);
  assert.deepEqual(v.out("k-org"), ["assigned-to->s-org"], "never moved onto the person who happens to share its address");
  assert.equal(j.report.repoint.skipped["repaired-this-run"], 1);
  assert.deepEqual(v.out("s-alex"), []);
  assert.deepEqual(v.out("p-alex").filter((x) => x.startsWith("member-of")), ["member-of->org-1"], "org-1 → p-alex did NOT count as p-alex → org-1");
  assert.deepEqual(v.out("org-1"), ["member-of->p-alex"], "the reversed link is untouched");
  assert.deepEqual(v.out("d-1"), ["references->p-alex", "wikilink->s-alex"], "a vault-managed wikilink stays; the canonical gets a references link");

  // emails: exact address only — even on bulk mail; a name is a review item.
  assert.deepEqual(v.out("e1"), ["email-from->p-alex"]);
  assert.deepEqual(v.out("e2"), [], "noreply sender nobody claims");
  assert.deepEqual(v.out("e3"), ["email-from->p-alex"], "BULK, but the address is exactly one live person's (owner decision)");
  assert.deepEqual(v.out("e3b"), [], "bulk mail never links (or queues) by display name");
  assert.deepEqual(v.out("e4"), ["email-to->p-alex"], "Casey has no address on file: a name does not link mail");
  assert.deepEqual(v.out("e5"), []);
  assert.deepEqual(v.out("e7"), ["email-to->p-alex"]);
  assert.deepEqual(v.out("e8"), [], "an address held by a bot-tagged note is claimed: never linked");
  assert.ok(!v.edges.some((e) => e.targetId === "p-owner" && (e.sourceId.startsWith("e") || e.sourceId.startsWith("th"))), "the owner is never linked to their own mail or threads");
  assert.deepEqual(v.out("e9"), [], "M-3: team@ is a role mailbox — never a person, even though a person note holds the address");
  assert.deepEqual(j.report.emails.byEvidence, { email: 4 });
  assert.equal(j.report.emails.skipped["role-sender"], 2);
  assert.equal(j.report.emails.skipped["role-recipient"], 1);
  assert.equal(j.report.emails.skipped["role-address-claimed"], 1);
  assert.deepEqual(j.report.emails.sample.role, ["e9"]);
  assert.equal(j.report.emails.extra.bulkLinked, 1, "bulk-labelled links are counted apart…");
  assert.deepEqual(j.report.emails.sample.bulk, ["e3"], "…and sampled, to inspect before a write run");
  assert.equal(j.report.emails.skipped["bulk-label"], 1);
  assert.equal(j.report.emails.skipped["claimed-by-non-person"], 1, "e8");
  assert.equal(j.report.emails.alreadyLinked, 2, "e6, and e-old (repointed by the phase before)");
  assert.deepEqual(j.report.emails.queuedByReason, { "name-only": 1, "ambiguous-name": 1, "ambiguous-key": 1 }, "e-eli: the address is also held by a stub repaired THIS run");

  // meetings: the owner by address / configured full name; other names are review items.
  assert.deepEqual(v.out("m1"), ["attended-by->p-owner"]);
  assert.deepEqual(v.out("t1"), ["attended-by->p-owner"]);
  assert.equal(j.report.meetings.skipped["role-attendee"], 1);
  assert.deepEqual(j.report.meetings.byEvidence, { email: 1, "owner-full-name": 1 });
  assert.deepEqual(j.report.meetings.queuedByReason, { "name-only": 2 });

  // threads: by Matrix id (stored, or looked up and written back in the SAME write).
  assert.deepEqual(v.out("th1"), ["messages-with->p-blake"]);
  assert.deepEqual(v.out("th2"), ["messages-with->p-blake"]);
  assert.deepEqual(v.out("th3"), [], "60 members: skipped");
  assert.deepEqual(v.out("th4"), [], "the lookup could not answer: the thread waits, it does not fall back to names");
  assert.deepEqual(v.out("th5"), [], "an unknown puppet + a matching name is a review item, never a link");
  assert.deepEqual(v.out("th6"), [], "names only");
  const th1 = v.patches.filter((p) => p.id === "th1");
  assert.equal(th1.length, 1, "ONE write for the link and the ids");
  assert.deepEqual(th1[0]!.metadata, { participantIds: ["@telegram_5550001:h.test", "@owner:h.test"] });
  assert.deepEqual(th1[0]!.add, [{ target: "p-blake", relationship: "messages-with" }]);
  assert.deepEqual(v.notes.get("th5")!.metadata!.participantIds, ["@telegram_5550002:h.test", "@owner:h.test"], "ids are kept even when nobody links");
  assert.deepEqual(j.report.threads.byEvidence, { telegram: 2 });
  assert.equal(j.report.threads.extra.idsBackfilled, 2);
  assert.equal(j.report.threads.skipped["large-group"], 1);
  assert.equal(j.report.threads.skipped["lookup-failed"], 1);
  assert.equal(j.report.threads.skipped["group-names-only"], undefined);
  assert.deepEqual(j.report.threads.queuedByReason, { "name-only": 2 }, "th5's counterpart and th6's (a room with no Matrix id at all) — not th4's ten names");
  assert.equal(j.memberLookups, 3, "th1, th4, th5 — never the 60-member room, never a room with stored ids");

  // tasks: the owner by configured alias; other names are review items; a wikilink is exact.
  assert.deepEqual(v.out("k1"), ["assigned-to->p-owner", "belongs-to->proj-1"]);
  assert.deepEqual(v.out("k2"), []);
  assert.deepEqual(v.out("k3"), ["belongs-to->proj-2"], "a project is found by its `title` (its name), not only its path");
  assert.deepEqual(v.out("k4"), ["assigned-to->p-blake", "belongs-to->proj-1"]);
  assert.deepEqual(j.report.tasks.byEvidence, { "owner-alias": 1, wikilink: 1, project: 3 });
  assert.equal(j.report.tasks.skipped["project-unknown"], 1);

  // normalize: only unambiguous synonyms; the rest reported, untouched.
  assert.deepEqual(v.out("n1"), ["attended-by->p-casey"]);
  assert.deepEqual(v.out("p-casey"), []);
  assert.deepEqual(j.report.normalize.byName, { attendee: 1, attended: 1 });
  assert.deepEqual(v.out("dual"), ["owner->p-alex"], "a note with two kinds: `owner` is not guessed to be assigned-to");
  assert.ok(v.out("p-alex").includes("to->e1"), "person --to--> email is never flipped into email-to");
  assert.deepEqual(j.report.normalize.untouched, { owner: 1, to: 1 });

  const queued = listCandidates("primary", { limit: 200 }).candidates;
  assert.ok(queued.some((c) => c.sourceNoteId === "e5" && c.reason === "ambiguous-name" && c.candidateIds.join() === "p-drew1,p-drew2"));
  assert.ok(queued.some((c) => c.sourceNoteId === "s-lost" && c.reason === "tombstone-unresolved" && c.relationship === "merged-into"));
  for (const p of j.phases) for (const id of [...j.report[p].sample.link, ...j.report[p].sample.review]) assert.ok(v.notes.has(id), "samples are note ids");
});

test("allowNameLinks: names link for meetings and tasks ONLY — never for mail or chat", async () => {
  const v = new MemVault();
  seed(v);
  const j = await runJob(v, { dryRun: false, allowNameLinks: true });
  assert.equal(j.allowNameLinks, true);
  assert.deepEqual(v.out("m1"), ["attended-by->p-blake", "attended-by->p-owner"]);
  assert.deepEqual(v.out("t1"), ["attended-by->p-alex", "attended-by->p-owner"], "the generic attendee 'Guest' is ignored");
  assert.deepEqual(v.out("k2"), ["assigned-to->p-alex", "assigned-to->p-casey"]);
  assert.deepEqual(j.report.meetings.byEvidence, { email: 1, "owner-full-name": 1, "full-name": 2 });
  assert.deepEqual(j.report.tasks.byEvidence, { "owner-alias": 1, "full-name": 2, wikilink: 1, project: 3 });
  // Sender-controlled display names still never link.
  assert.deepEqual(v.out("e4"), ["email-to->p-alex"]);
  assert.deepEqual(v.out("th5"), []);
  assert.deepEqual(v.out("th6"), []);
  assert.deepEqual(j.report.threads.byEvidence, { telegram: 2 });
  assert.equal(j.report.emails.byEvidence["full-name"], undefined);
});

test("lean listings only; ONE whole-vault listing shared by owner / repoint / normalize, none when they are not selected", async () => {
  const v = new MemVault();
  seed(v);
  await runJob(v);
  for (const l of v.lists) {
    assert.ok(Array.isArray(l.includeMetadata) && (l.includeMetadata as string[]).length > 0, "include_metadata always narrowed");
    assert.ok(!("includeContent" in l), "content never requested");
  }
  const whole = v.lists.filter((l) => !l.tags);
  assert.equal(whole.length, 1, "one whole-vault lean listing per run");
  assert.deepEqual(whole[0]!.includeMetadata, ["type"]);
  assert.equal(v.lists.filter((l) => (l.tags as string[] | undefined)?.includes("person")).length, 1, "people are listed once");

  const w = new MemVault();
  seed(w);
  await runJob(w, { phases: ["emails", "meetings", "threads", "tasks"] });
  assert.equal(w.lists.filter((l) => !l.tags).length, 0, "per-tag phases never list the whole vault");
});

test("a 409 is counted, never forced; the removal behind a failed addition waits", async () => {
  const v = new MemVault();
  seed(v);
  v.conflictOn.add("e1");
  v.conflictOn.add("p-alex"); // the canonical side of the stub's outbound member-of
  const j = await runJob(v, { dryRun: false, phases: ["repoint", "emails"] });
  assert.equal(j.report.emails.conflicts, 1);
  assert.deepEqual(v.out("e1"), []);
  assert.equal(j.report.repoint.conflicts, 1);
  assert.deepEqual(v.out("s-alex"), ["member-of->org-1"], "the stub keeps its link until the canonical has it");
  assert.equal(j.report.repoint.deferred, 1);
  v.conflictOn.clear();
  const again = await runJob(v, { dryRun: false, phases: ["repoint", "emails"] });
  assert.equal(again.report.repoint.conflicts + again.report.emails.conflicts, 0);
  assert.deepEqual(v.out("s-alex"), []);
  assert.deepEqual(v.out("e1"), ["email-from->p-alex"]);
});

test("M2: a note with no version is skipped and counted — never force-written", async () => {
  const v = new MemVault();
  seed(v);
  v.notes.get("e1")!.updatedAt = null;
  const j = await runJob(v, { dryRun: false, phases: ["emails"] });
  assert.equal(j.report.emails.skipped["no-stamp"], 1);
  assert.deepEqual(v.out("e1"), []);
  assert.ok(!v.patches.some((p) => p.id === "e1"));
  assert.equal(j.status, "done");
});

test("M3: a failing vault ABORTS the run as an error (health failure), a hung call times out", async () => {
  const v = new MemVault();
  seed(v);
  v.failAll = 500;
  let ended: LinkJob | null = null;
  const j = await runJob(v, { dryRun: false, phases: ["emails", "tasks"], maxConsecutiveErrors: 3, onEnd: (x) => (ended = x) });
  assert.equal(j.status, "error");
  assert.match(j.error ?? "", /aborted after [34] consecutive failed writes \(last: vault HTTP 500\)/);
  assert.ok(j.report.emails.errors >= 3 && j.report.emails.errors <= 4, "stopped at the breaker (one more may be in flight)");
  assert.equal(j.report.tasks.status, "pending", "later phases never ran");
  assert.equal(ended!.status, "error");
  const outcome = lastLinkJobOutcome("primary")!;
  assert.deepEqual({ status: outcome.status, failStreak: outcome.failStreak }, { status: "error", failStreak: 1 });

  // 409s are not failures of the vault: they never trip the breaker.
  const c = new MemVault();
  seed(c);
  for (const id of c.notes.keys()) c.conflictOn.add(id);
  assert.equal((await runJob(c, { dryRun: false, phases: ["emails"], maxConsecutiveErrors: 2 })).status, "done");

  // A call that never returns is abandoned, counted, and ends the run.
  const h = new MemVault();
  seed(h);
  h.hang = true;
  const t = await runJob(h, { dryRun: false, phases: ["emails"], maxConsecutiveErrors: 2, callTimeoutMs: 15, concurrency: 1 });
  assert.equal(t.status, "error");
});

test("M6: a note open in the collab editor is written and the reconciler is told its content did not change", async () => {
  const v = new MemVault();
  seed(v);
  const marks: Array<[string, number, number]> = [];
  const j = await runJob(v, { dryRun: false, phases: ["emails"], live: { isLive: (id) => id === "e1", markReconciled: (id, p, n) => void marks.push([id, p, n]) } });
  assert.deepEqual(v.out("e1"), ["email-from->p-alex"]);
  assert.equal(j.liveNotes, 1);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]![0], "e1");
  assert.equal(marks[0]![1], Date.parse("2026-01-01T00:00:00.000Z"), "prev = the version the write replaced");
  assert.equal(marks[0]![2], Date.parse(v.notes.get("e1")!.updatedAt!));
});

test("the write cap is hard; capped runs converge to the same graph as one full run", async () => {
  const v = new MemVault();
  seed(v);
  const j = await runJob(v, { dryRun: false, maxWrites: 2 });
  assert.equal(v.patches.length, 2);
  assert.ok(j.capped);
  assert.ok(j.phases.reduce((n, p) => n + j.report[p].deferred, 0) > 0);
  let runs = 0;
  while ((await runJob(v, { dryRun: false, maxWrites: 5 })).writes > 0) assert.ok(++runs < 40, "capped runs make progress");
  const full = new MemVault();
  seed(full);
  while ((await runJob(full, { dryRun: false })).writes > 0) assert.ok(++runs < 60);
  assert.deepEqual(v.graph(), full.graph());
});

test("cancel stops between writes; the job, merges and resolves are mutually exclusive", async () => {
  const v = new MemVault();
  seed(v);
  let release!: () => void;
  v.gate = new Promise<void>((r) => (release = r));
  const { done } = startLinkJob(v, "primary", opts({ dryRun: false, concurrency: 1 }));
  assert.equal(acquirePeopleLock("people-merge"), null, "the lock is held while the job runs");
  for (let i = 0; i < 100 && !(linkJobStatus()!.writes > 0); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cancelLinkJob());
  release();
  await done;
  assert.equal(linkJobStatus()!.status, "cancelled");
  assert.equal(v.patches.length, 1, "the in-flight write finishes, nothing after it starts");
  const free = acquirePeopleLock("people-merge");
  assert.ok(free, "released when the job ends");
  assert.throws(() => startLinkJob(v, "primary", opts()), /in progress/);
  free!();
});

test("oversize notes: skipped from the listing's byteSize, counted on a 413", async () => {
  const v = new MemVault();
  seed(v);
  v.notes.get("e1")!.byteSize = 2_500_000;
  v.notes.get("th2")!.byteSize = 2_500_000;
  v.tooLarge.add("e7");
  const j = await runJob(v, { dryRun: false, phases: ["emails", "threads"] });
  assert.equal(j.report.emails.skipped.oversize, 1);
  assert.equal(j.report.emails.oversize, 1);
  assert.equal(j.report.threads.skipped.oversize, 1, "a links/metadata-only PATCH on an oversize thread is skipped too");
  assert.deepEqual(v.out("e1"), []);
  assert.deepEqual(v.out("th2"), []);
});

test("group rooms link at most GROUP_LINK_CAP strong-key members", async () => {
  const v = new MemVault();
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    v.put(person(`p${i}`, `Member Person${i}`, { channels: { matrix: `@telegram_77700${i}:h.test` } }));
    ids.push(`@telegram_77700${i}:h.test`);
  }
  v.put({ id: "g", path: "vault/messages/telegram/g", tags: ["message-thread"], metadata: { participantIds: ids, matrixRoomId: "!g:h.test" } });
  const j = await runJob(v, { dryRun: false, phases: ["threads"], limits: { groupLinkCap: 2, memberPaceMs: 0 } });
  assert.equal(v.out("g").length, 2);
  assert.equal(j.report.threads.skipped["group-link-cap"], 1);
});

test("an identity the owner dismissed never links; a queued one is refreshed, not duplicated", async () => {
  const v = new MemVault();
  seed(v);
  enqueueCandidate({ vaultId: "primary", sourceNoteId: "e1", relationship: "email-from", key: { kind: "email", value: "alex@example.test" }, candidateIds: ["p-alex"], reason: "ambiguous-key", origin: "test" });
  db.prepare("UPDATE identity_candidates SET status = 'dismissed'").run();
  await runJob(v, { dryRun: false, phases: ["emails"] });
  assert.deepEqual(v.out("e1"), [], "dismissed for this note");
  assert.deepEqual(v.out("e4"), ["email-to->p-alex"], "other notes are unaffected");
  const n = listCandidates("primary").candidates.length;
  await runJob(v, { dryRun: false, phases: ["emails"] });
  assert.equal(listCandidates("primary").candidates.length, n);
});

test("owner phase: unresolved owner does nothing; its tombstones' links come home; the owner is never linked to threads or mail by a resolved match", async () => {
  const none = new MemVault();
  seed(none);
  none.notes.delete("p-owner");
  const j = await runJob(none, { dryRun: false, phases: ["owner", "tasks", "meetings"] });
  assert.equal(j.ownerPersonKnown, false);
  assert.equal(j.report.owner.skipped["owner-unresolved"], 1);
  assert.deepEqual(none.out("k1"), ["belongs-to->proj-1"]);
  assert.equal(j.report.tasks.skipped["owner-unresolved"], 1);

  const v = new MemVault();
  seed(v);
  v.put(person("s-owner", "owner-old", { merged_into: "p-owner", channels: { matrix: "@telegram_5558888:h.test" } }, ["merged-stub"]), [["k9", "s-owner", "assigned-to"]]);
  v.put({ id: "k9", path: "vault/tasks/k9", tags: ["task"] });
  v.put({ id: "th9", path: "vault/messages/telegram/o", tags: ["message-thread"], metadata: { participantIds: ["@telegram_5558888:h.test", "@telegram_5550001:h.test"] } });
  // The owner under a nickname that is only an ALIAS on their note: not a link, and not a review row either.
  v.notes.get("p-owner")!.metadata!.aliases = ["Oz The Great"];
  v.put({ id: "th10", path: "vault/messages/telegram/nick", tags: ["message-thread"], metadata: { participants: ["Oz The Great", "Blake Example"] } });
  v.put({ id: "e9", path: "vault/messages/email/e9", tags: ["email"], metadata: { from: "Somebody <alias@owner.test>", to: "alex@example.test", labels: [] } });
  v.notes.get("p-owner")!.metadata!.emails = ["alias@owner.test"];
  const o = await runJob(v, { dryRun: false, owner: { ...OWNER, emails: ["owner@example.test", "second@owner.test"], person: "vault/people/Owner Person" } });
  assert.deepEqual(v.out("k9"), ["assigned-to->p-owner"], "the owner's tombstone gave its link back");
  assert.equal(o.report.owner.extra.ownerTombstones, 1);
  assert.deepEqual(v.notes.get("p-owner")!.metadata!.channels, { matrix: "@telegram_5559999:h.test", email: ["second@owner.test"] }, "the complete channels object, appended to");
  assert.deepEqual(v.out("th9"), ["messages-with->p-blake"], "a puppet id inherited from the owner's stub never links the owner");
  assert.deepEqual(o.report.threads.queuedByReason, { "name-only": 3 }, "th5, th6 and th10's counterparts — never a row asking whether a nickname is the owner");
  assert.ok((o.report.threads.skipped.owner ?? 0) >= 1);
  assert.deepEqual(v.out("e9"), ["email-to->p-alex"]);
  assert.ok(!v.edges.some((e) => e.targetId === "p-owner" && ["th9", "e9"].includes(e.sourceId)));
});

test("H-1/H-2: only a DANGLING stub is repaired, only on a strong key, keeping the old pointer; a non-person target is never touched or repointed — in any run", async () => {
  const v = new MemVault();
  v.put(person("p-live", "Robin Vale", { email: "robin@example.test" }));
  v.put({ id: "org", path: "vault/organizations/Vale Co", tags: ["organization"] });
  v.put({ id: "proj", path: "vault/projects/vale", tags: ["project"] });
  v.put(person("p-bot", "Vale Bot", { email: "bot@example.test" }, ["bot"]));
  // Deliberately merged into an organization, a project (by id) and a non-human person note.
  v.put(person("s1", "robin-org", { email: "robin@example.test", merged_into: "vault/organizations/Vale Co" }, ["merged-stub"]), [["t1", "s1", "assigned-to"]]);
  v.put(person("s2", "robin-proj", { email: "robin@example.test", merged_into: "proj" }, ["merged-stub"]));
  v.put(person("s3", "robin-bot", { email: "robin@example.test", merged_into: "vault/people/Vale Bot" }, ["merged-stub"]));
  // Dangling: the target is nowhere in the vault. One shares a strong key with ONE live person, one only a name.
  v.put(person("s4", "robin-gone", { channels: { matrix: "@telegram_7770001:h.test" }, merged_into: "vault/people/Deleted Long Ago" }, ["merged-stub"]), [["t2", "s4", "assigned-to"]]);
  v.put({ ...person("s5", "Robin Vale", { status: "merged_into_canonical" }), path: "vault/people/robin-vale-old" });
  v.put(person("p-tg", "Tee Gee", { channels: { matrix: "@telegram_7770001:h.test" } }));
  v.put({ id: "t1", path: "vault/tasks/t1", tags: ["task"] });
  v.put({ id: "t2", path: "vault/tasks/t2", tags: ["task"] });

  const j = await runJob(v, { dryRun: false, phases: ["tombstones", "repoint"], enqueue: true });
  for (const [id, was] of [["s1", "vault/organizations/Vale Co"], ["s2", "proj"], ["s3", "vault/people/Vale Bot"]] as const) {
    assert.equal(v.notes.get(id)!.metadata!.merged_into, was, `${id}: not dangling, not rewritten`);
    assert.equal(v.notes.get(id)!.metadata!.prism_merged_into_prev, undefined);
  }
  assert.equal(j.report.tombstones.extra.leftTargetNotAPerson, 3);
  assert.deepEqual({ merged_into: v.notes.get("s4")!.metadata!.merged_into, prev: v.notes.get("s4")!.metadata!.prism_merged_into_prev }, { merged_into: "p-tg", prev: "vault/people/Deleted Long Ago" }, "repaired to the note ID; the previous value is kept");
  assert.deepEqual(j.report.tombstones.byEvidence, { telegram: 1 });
  assert.equal(v.notes.get("s5")!.metadata!.merged_into, undefined, "a full-name match is a review item, never a repair");
  const rows = listCandidates("primary").candidates;
  assert.deepEqual(rows.map((r) => `${r.sourceNoteId}:${r.reason}:${r.candidateIds.join()}`), ["s5:tombstone-unresolved:p-live"]);
  assert.deepEqual(v.out("t1"), ["assigned-to->s1"]);
  assert.deepEqual(v.out("t2"), ["assigned-to->s4"], "a stub repaired in THIS run is not repointed in it");
  assert.equal(j.report.repoint.skipped["repaired-this-run"], 1);

  // A later run moves the repaired stub's links — and still never the organization's.
  const later = await runJob(v, { dryRun: false, phases: ["tombstones", "repoint"] });
  assert.deepEqual(v.out("t2"), ["assigned-to->p-tg"]);
  assert.deepEqual(v.out("t1"), ["assigned-to->s1"]);
  assert.equal(later.report.tombstones.extra.repaired, undefined);
  assert.equal(later.report.repoint.skipped["no-canonical"], 4, "s1, s2, s3 and the name-only s5");
});

test("M-3: excludeBulkLinks keeps bulk-labelled mail unlinked", async () => {
  const v = new MemVault();
  seed(v);
  const j = await runJob(v, { dryRun: false, phases: ["emails"], excludeBulkLinks: true });
  assert.deepEqual(v.out("e3"), []);
  assert.equal(j.report.emails.extra.bulkLinked, undefined);
  assert.equal(j.report.emails.skipped["bulk-label"], 2);
});

test("M-4: nothing is queued unless asked; a capped run queues only inside its write window; the queue is bounded; a landed link closes its row", async () => {
  const v = new MemVault();
  for (let i = 0; i < 12; i++) {
    v.put(person(`p${i}`, `Person Number${i}`, { email: `p${i}@example.test` }));
    v.put(person(`q${i}`, `Named Only${i}`));
    v.put({ id: `m${String(i).padStart(2, "0")}`, path: `vault/meetings/m${i}`, tags: ["meeting"], metadata: { attendees: [`p${i}@example.test`, `Named Only${i}`] } });
  }
  const dry = await runJob(v, { phases: ["meetings"] });
  assert.equal(dry.report.meetings.queued, 12);
  assert.equal(openCandidateCounts("primary").total, 0, "a dry run inserts nothing");
  const silent = new MemVault();
  for (const [k, n] of v.notes) silent.notes.set(k, structuredClone(n));
  await runJob(silent, { dryRun: false, phases: ["meetings"] });
  assert.equal(openCandidateCounts("primary").total, 0, "a WRITE run inserts nothing either unless enqueue: true");

  // Capped at 3 writes: only the reviews of the notes it reached are queued.
  const capped = await runJob(v, { dryRun: false, phases: ["meetings"], maxWrites: 3, enqueue: true });
  assert.equal(capped.report.meetings.notesWritten, 3);
  assert.equal(capped.report.meetings.queued, 3, "not the whole phase");
  assert.equal(capped.report.meetings.extra.reviewsBeyondWindow, 9);
  assert.equal(openCandidateCounts("primary").total, 3);

  // A bounded queue: past PEOPLE_QUEUE_MAX_OPEN nothing is inserted, and it is counted.
  const prev = config.peopleQueueMaxOpen;
  (config as { peopleQueueMaxOpen: number }).peopleQueueMaxOpen = 5;
  try {
    const full = await runJob(v, { dryRun: false, phases: ["meetings"], enqueue: true });
    assert.equal(openCandidateCounts("primary").total, 5);
    assert.equal(full.report.meetings.skipped["queue-full"], 7);
  } finally {
    (config as { peopleQueueMaxOpen: number }).peopleQueueMaxOpen = prev;
  }

  // The reviewed name later links (allowNameLinks): its open row closes itself.
  const before = listCandidates("primary").candidates.length;
  await runJob(v, { dryRun: false, phases: ["meetings"], allowNameLinks: true });
  assert.equal(listCandidates("primary").candidates.length, 0, `${before} open rows answered by the links that landed`);
  const closed = listCandidates("primary", { status: "resolved" }).candidates;
  assert.equal(closed.length, before);
  assert.ok(closed.every((c) => c.decidedBy === "linked-by-job" && c.resolvedPersonId?.startsWith("q")));
});

test("M-4/M-5: the member lookup never falls back to names — budget, failures, a breaker, and the REAL member count", async () => {
  const mk = () => {
    const v = new MemVault();
    v.put(person("p-blake", "Blake Example", { channels: { matrix: "@telegram_5550001:h.test" } }));
    for (let i = 0; i < 6; i++) v.put({ id: `t${i}`, path: `vault/messages/telegram/t${i}`, tags: ["message-thread"], metadata: { participants: ["Blake Example"], matrixRoomId: `!room${i}:h.test` } });
    return v;
  };
  const ok = async () => ({ "@telegram_5550001:h.test": "Blake Example" });

  // Budget spent: the rest wait for the next run (no name review rows, no links).
  const b = mk();
  const budget = await runJob(b, { dryRun: false, phases: ["threads"], members: ok, limits: { memberLookups: 2, memberPaceMs: 0 }, enqueue: true });
  assert.equal(budget.memberLookups, 2);
  assert.equal(budget.report.threads.skipped["lookup-budget"], 4);
  assert.equal(budget.report.threads.queued, 0, "no fallback to display names");
  assert.equal(b.edges.length, 2);

  // The homeserver keeps failing: after 3 in a row the lookup stage ends; the phase carries on.
  let calls = 0;
  const f = mk();
  f.notes.get("t5")!.metadata!.participantIds = ["@telegram_5550001:h.test"];
  const failing = await runJob(f, { dryRun: false, phases: ["threads"], members: async () => { calls++; throw Object.assign(new Error("429"), { status: 429 }); }, memberFailures: 3 });
  assert.equal(calls, 3, "the homeserver is left alone after the breaker");
  assert.equal(failing.status, "done");
  assert.deepEqual({ failed: failing.report.threads.skipped["lookup-failed"], unavailable: failing.report.threads.skipped["lookup-unavailable"], breaker: failing.report.threads.extra.lookupBreaker }, { failed: 3, unavailable: 2, breaker: 1 });
  assert.deepEqual(f.out("t5"), ["messages-with->p-blake"], "a thread with stored ids still links");
  assert.equal(failing.report.threads.queued, 0);

  // A room whose REAL membership is over the limit gets neither links nor participantIds.
  const g = mk();
  const big = Object.fromEntries([["@telegram_5550001:h.test", "Blake Example"], ...Array.from({ length: 60 }, (_, i) => [`@telegram_66600${String(i).padStart(2, "0")}:h.test`, `M ${i}`])]);
  const gated = await runJob(g, { dryRun: false, phases: ["threads"], members: async (room) => (room === "!room0:h.test" ? big : null) });
  assert.equal(gated.report.threads.skipped["large-group"], 1);
  assert.equal(g.patches.length, 0);
  assert.equal(g.notes.get("t0")!.metadata!.participantIds, undefined);
});

test("collab race: a note opened in the editor WHILE it was being written is still reconciled", async () => {
  const v = new MemVault();
  seed(v);
  let asked = 0;
  const marks: string[] = [];
  await runJob(v, { dryRun: false, phases: ["emails"], concurrency: 1, live: { isLive: (id) => id === "e1" && ++asked > 1, markReconciled: (id) => void marks.push(id) } });
  assert.deepEqual(marks, ["e1"], "not live before the write, live after it");
});

test("a note written in both waves counts as ONE note to write", async () => {
  const v = new MemVault();
  v.put(person("p", "Pat Lane"));
  v.put({ id: "m", path: "vault/meetings/m", tags: ["meeting"] }, [["p", "m", "attended"]]);
  v.put({ id: "o", path: "vault/organizations/O", tags: ["organization"] }, [["o", "p", "has-member"], ["p", "o", "member"]]);
  // `p` gets an addition (member-of → o, from o's reversed has-member) in wave 1 AND removals that wait on other notes in wave 2.
  const j = await runJob(v, { dryRun: false, phases: ["normalize"] });
  assert.equal(j.report.normalize.notesToWrite, new Set(v.patches.map((x) => x.id)).size);
  assert.equal(j.report.normalize.notesWritten, j.report.normalize.notesToWrite);
  assert.ok(v.patches.filter((x) => x.id === "p").length === 2, "two PATCHes on the same note");
  assert.equal(j.writes, v.patches.length);
});

// ── route ────────────────────────────────────────────────────────────────────

let fv: FakeVault | null = null;
afterEach(() => fv?.restore());
const J = { "content-type": "application/json" };
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const post = (p: string, h: Record<string, string>, body: unknown = {}) => adminApi.request(p, { method: "POST", headers: h, body: JSON.stringify(body) });
const waitJob = async () => {
  for (let i = 0; i < 200; i++) {
    const s = (await (await adminApi.request("/people/link", { headers: owner() })).json()) as { job: LinkJob };
    if (s.job.status !== "running") return s.job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not end");
};

test("route: owner only, CSRF, dry run by default, validated options, one job at a time, audited write runs", async () => {
  fv = installFakeVault();
  fv.put({ id: "p1", path: "vault/people/Alex Example", tags: ["person"], metadata: { name: "Alex Example", email: "alex@example.test" } });
  fv.put({ id: "e1", path: "vault/messages/email/e1", tags: ["email"], metadata: { from: "Alex Example <alex@example.test>", labels: [] } });
  setMembership("primary", "admin@example.test", "admin", null);
  setMembership("primary", "member@example.test", "member", null);
  setMembership("primary", "coowner@example.test", "owner", null);
  for (const h of [
    J,
    { ...J, authorization: `Capability ${makeCapability("note", "e1", "edit")}` },
    { ...J, cookie: sessionCookie(makeSession("guest@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("member@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("admin@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("coowner@example.test")) },
  ]) {
    assert.equal((await post("/people/link", h, { dryRun: false })).status, 403);
    assert.equal((await adminApi.request("/people/link", { headers: h })).status, 403);
    assert.equal((await post("/people/link/cancel", h)).status, 403);
    assert.equal((await adminApi.request("/people/owner", { headers: h })).status, 403);
    assert.equal((await adminApi.request("/people/owner", { method: "PUT", headers: h, body: JSON.stringify({ person: "p1" }) })).status, 403);
  }
  assert.equal((await post("/people/link", { ...owner(), "content-type": "text/plain" })).status, 415);
  assert.equal((await post("/people/link", { ...owner(), "sec-fetch-site": "cross-site" })).status, 403);
  for (const bad of [{ dryRun: "no" }, { phases: [] }, { phases: ["everything"] }, { maxWrites: 0 }, { maxWrites: 1.5 }, { maxWrites: 10_000_000 }, { useMatrixMembers: "yes" }, { allowNameLinks: 1 }, { excludeBulkLinks: "x" }, { enqueue: 1 }])
    assert.equal((await post("/people/link", owner(), bad)).status, 400, JSON.stringify(bad));
  assert.equal((await post("/people/link", owner(), { useMatrixMembers: true })).status, 409, "explicitly asked for, but no stored Matrix credential");
  assert.equal(fv.calls.length, 0, "nothing reached the vault");

  const r = await post("/people/link", owner(), { phases: ["emails"] });
  assert.equal(r.status, 202);
  const { job } = (await r.json()) as { job: LinkJob };
  assert.equal(job.dryRun, true, "dry run by default");
  assert.equal(job.allowNameLinks, false, "names never link by default");
  assert.equal(job.maxWrites, 0);
  assert.equal((await post("/people/link", owner(), {})).status, 409, "one job at a time");
  const done = await waitJob();
  assert.equal(done.report.emails.wouldLink, 1);
  assert.deepEqual(done.report.emails.byEvidence, { email: 1 });
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.ok(fv.calls.every((c) => !c.search.includes("include_content")), "lean listings over HTTP too");
  assert.equal((db.prepare("SELECT count(*) n FROM action_audit").get() as { n: number }).n, 0, "a dry run is not audited");

  const w = await post("/people/link", owner(), { dryRun: false, phases: ["emails"] });
  assert.equal(((await w.json()) as { job: LinkJob }).job.maxWrites, config.peopleLinkMaxWrites, "a write run is capped by default");
  const wd = await waitJob();
  assert.equal(wd.report.emails.linked, 1);
  const patch = fv.calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(patch.body, { links: { add: [{ target: "p1", relationship: "email-from" }] }, if_updated_at: "2026-01-01T00:00:00.000Z" });
  const row = db.prepare("SELECT action, status, target FROM action_audit").get() as { action: string; status: string; target: string };
  assert.equal(row.action, "admin.people-link");
  assert.equal(row.status, "ok");
  assert.ok(!row.target.includes("vault/") && !row.target.includes("alex") && !row.target.includes("p1"), "counts only");
});

test("route: a failing vault ends the job `error` and the audit row says failed", async () => {
  fv = installFakeVault();
  fv.put({ id: "p1", path: "vault/people/Alex Example", tags: ["person"], metadata: { name: "Alex Example", email: "alex@example.test" } });
  for (let i = 0; i < 8; i++) fv.put({ id: `e${i}`, path: `vault/messages/email/e${i}`, tags: ["email"], metadata: { from: "Alex Example <alex@example.test>", labels: [] } });
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => ((init?.method ?? "GET") === "PATCH" ? new Response("boom", { status: 500 }) : real(input as string, init))) as typeof fetch;
  try {
    assert.equal((await post("/people/link", owner(), { dryRun: false, phases: ["emails"] })).status, 202);
    const j = await waitJob();
    assert.equal(j.status, "error");
    const row = db.prepare("SELECT status FROM action_audit WHERE action = 'admin.people-link'").get() as { status: string };
    assert.equal(row.status, "failed");
  } finally {
    globalThis.fetch = real;
  }
});

test("owner route: set / get / clear the owner person per vault; only a live person note is accepted", async () => {
  fv = installFakeVault();
  fv.put({ id: "me", path: "vault/people/Owner Person", tags: ["person"], metadata: { name: "Owner Person" } });
  fv.put({ id: "old", path: "vault/people/owner-old", tags: ["person", "merged-stub"], metadata: { merged_into: "vault/people/Owner Person" } });
  fv.put({ id: "doc", path: "vault/notes/doc", tags: [] });
  const put = (body: unknown) => adminApi.request("/people/owner", { method: "PUT", headers: owner(), body: JSON.stringify(body) });
  const get = async () => (await (await adminApi.request("/people/owner", { headers: owner() })).json()) as { configured: { person: string | null; source: string; emails: string[]; aliases: string[] }; ownerPersonKnown: boolean; resolved: { personId: string } | null };
  assert.deepEqual({ ...(await get()).configured, known: (await get()).ownerPersonKnown }, { person: null, emails: [], aliases: [], source: "env", known: false });
  for (const bad of [{}, { person: "" }, { person: "me", emails: ["not-an-address"] }, { person: "me", aliases: ["a@b.test"] }, { person: "me", emails: "x" }]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await put({ person: "nope" })).status, 404);
  assert.equal((await put({ person: "doc" })).status, 404, "not a person");
  assert.equal((await put({ person: "old" })).status, 409, "a merged stub cannot be the owner");
  assert.equal((await adminApi.request("/people/owner", { method: "PUT", headers: { ...owner(), "sec-fetch-site": "cross-site" }, body: "{}" })).status, 403);

  assert.equal((await put({ person: "vault/people/Owner Person", emails: ["Second@Owner.test"], aliases: ["Ozzy"] })).status, 200);
  const set = await get();
  assert.deepEqual(set.configured, { person: "me", emails: ["second@owner.test"], aliases: ["Ozzy"], source: "settings" });
  assert.equal(set.ownerPersonKnown, true);
  assert.equal(set.resolved!.personId, "me");
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, 0, "configuring the owner writes nothing to the vault");

  assert.equal((await adminApi.request("/people/owner", { method: "DELETE", headers: owner() })).status, 200);
  assert.equal((await get()).configured.source, "env");
});
