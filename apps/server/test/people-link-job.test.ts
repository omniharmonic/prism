/**
 * The people-linking backfill job (src/people-link-job.ts) and its owner-only
 * route. An in-memory vault with real two-sided links; synthetic people only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLinkInput, NoteLink } from "../src/parachute";
import { config } from "../src/config";
import { db, setMembership } from "../src/db";
import { adminApi } from "../src/routes/admin";
import { enqueueCandidate, listCandidates, openCandidateCounts } from "../src/identity-store";
import { _resetLinkJob, addressList, cancelLinkJob, lastLinkJobOutcome, linkJobStatus, startLinkJob, type LinkJob, type LinkJobOptions, type LinkJobVault, type Phase } from "../src/people-link-job";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";

type Seed = Partial<Note> & { id: string; byteSize?: number };

class MemVault implements LinkJobVault {
  notes = new Map<string, Note & { byteSize?: number }>();
  edges: NoteLink[] = [];
  lists: Array<Record<string, unknown>> = [];
  patches: Array<{ id: string; add: NoteLinkInput[]; remove: NoteLinkInput[]; ifUpdatedAt?: string }> = [];
  conflictOn = new Set<string>();
  tooLarge = new Set<string>();
  gate: Promise<void> | null = null;
  private clock = 0;
  put(n: Seed, links: Array<[string, string, string]> = []): void {
    this.notes.set(n.id, { content: "", path: null, metadata: {}, createdAt: "", updatedAt: `v0-${n.id}`, tags: [], ...n });
    for (const [s, t, r] of links) this.edges.push({ sourceId: s, targetId: t, relationship: r });
  }
  linksOf(id: string): NoteLink[] {
    return this.edges.filter((e) => e.sourceId === id || e.targetId === id).map((e) => ({ ...e }));
  }
  out(id: string, rel?: string): string[] {
    return this.edges.filter((e) => e.sourceId === id && (!rel || e.relationship === rel)).map((e) => `${e.relationship}->${e.targetId}`).sort();
  }
  async listNotes(opts: { tags?: string[]; includeLinks?: boolean; includeMetadata?: string[] }): Promise<Note[]> {
    this.lists.push({ ...opts });
    return [...this.notes.values()]
      .filter((n) => (opts.tags ?? []).every((t) => (n.tags ?? []).includes(t)))
      .map((n) => {
        const md = opts.includeMetadata ? Object.fromEntries(Object.entries(n.metadata ?? {}).filter(([k]) => opts.includeMetadata!.includes(k))) : n.metadata;
        return { ...n, content: "", metadata: md, ...(opts.includeLinks ? { links: this.linksOf(n.id) } : {}) };
      });
  }
  async updateNote(id: string, p: { links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] }; ifUpdatedAt?: string }): Promise<Note> {
    if (this.gate) await this.gate;
    const n = this.notes.get(id);
    if (!n) throw Object.assign(new Error("not found"), { status: 404 });
    if (this.tooLarge.has(id)) throw Object.assign(new Error("too large"), { status: 413 });
    if (this.conflictOn.has(id) || (p.ifUpdatedAt && p.ifUpdatedAt !== n.updatedAt)) throw Object.assign(new Error("conflict"), { status: 409 });
    this.patches.push({ id, add: p.links?.add ?? [], remove: p.links?.remove ?? [], ifUpdatedAt: p.ifUpdatedAt });
    for (const r of p.links?.remove ?? []) this.edges = this.edges.filter((e) => !(e.sourceId === id && e.targetId === r.target && e.relationship === r.relationship));
    for (const a of p.links?.add ?? []) if (!this.edges.some((e) => e.sourceId === id && e.targetId === a.target && e.relationship === a.relationship)) this.edges.push({ sourceId: id, targetId: a.target, relationship: a.relationship });
    n.updatedAt = `v${++this.clock}-${id}`;
    return { ...n };
  }
}

const OWNER = { emails: ["owner@example.test"], aliases: ["Ozzy"], matrixId: "@owner:h.test" };
const person = (id: string, name: string, md: Record<string, unknown> = {}, tags: string[] = []): Seed => ({ id, path: `vault/people/${name}`, tags: ["person", ...tags], metadata: { name, ...md } });

function seed(v: MemVault): void {
  v.put(person("p-owner", "Owner Person", { email: "owner@example.test" }));
  v.put(person("p-alex", "Alex Example", { email: "alex@example.test" }));
  v.put(person("p-blake", "Blake Example", { channels: { matrix: "@telegram_5550001:h.test" } }));
  v.put(person("p-casey", "Casey Example"));
  v.put(person("p-drew1", "Drew Twin"));
  v.put(person("p-drew2", "Drew Twin", {}, []), []);
  v.notes.get("p-drew2")!.path = "vault/people/drew-twin";
  // A merged stub that still carries Alex's address and three links.
  v.put({ ...person("s-alex", "alex-example-test", { email: "alex@example.test", merged_into: "vault/people/Alex Example", status: "merged_into_canonical" }, ["merged-stub"]) }, [
    ["e-old", "s-alex", "email-from"],
    ["s-alex", "org-1", "member-of"],
    ["d-1", "s-alex", "wikilink"],
  ]);
  v.put({ id: "org-1", path: "vault/organizations/Org One", tags: ["organization"] });
  v.put({ id: "d-1", path: "vault/notes/Doc", tags: [] });

  const email = (id: string, md: Record<string, unknown>, links: Array<[string, string, string]> = []) => v.put({ id, path: `vault/messages/email/${id}`, tags: ["email"], metadata: { labels: ["INBOX"], ...md } }, links);
  email("e-old", { from: "Alex <alex@example.test>", to: "owner@example.test" });
  email("e1", { from: "Alex Example <alex@example.test>", to: "Owner <owner@example.test>" });
  email("e2", { from: "Service <noreply@service.test>", to: "owner@example.test" });
  email("e3", { from: "Alex Example <alex@example.test>", to: "owner@example.test", labels: ["INBOX", "BULK"] });
  email("e4", { from: "Owner <owner@example.test>", to: "Casey Example <casey@example.test>, Alex <alex@example.test>" });
  email("e5", { from: "Drew Twin <drew@example.test>", to: "owner@example.test" });
  email("e6", { from: "Alex Example <alex@example.test>", to: "owner@example.test" }, [["e6", "p-alex", "email-from"]]);
  email("e7", { from: "Help Desk <support@vendor.test>", to: "owner@example.test, Alex <alex@example.test>" });

  v.put({ id: "m1", path: "vault/meetings/2026-01-01/sync", tags: ["meeting"], metadata: { attendees: ["owner@example.test", "Blake Example", "Unknown Person", "room@resource.calendar.google.com"], attendeeEmails: ["owner@example.test"] } });
  v.put({ id: "t1", path: "vault/_inbox/transcripts/t1", tags: ["transcript"], metadata: { attendees: ["Ozzy", "Alex Example"] } });

  v.put({ id: "th1", path: "vault/messages/telegram/blake", tags: ["message-thread"], metadata: { participants: ["Blake Example (Telegram)", "Owner Person"], matrixRoomId: "!r1:h.test" } });
  v.put({ id: "th2", path: "vault/messages/telegram/b2", tags: ["message-thread"], metadata: { participants: ["B"], participantIds: ["@telegram_5550001:h.test", "@owner:h.test", "@telegrambot:h.test"], matrixRoomId: "!r2:h.test" } });
  v.put({ id: "th3", path: "vault/messages/telegram/huge", tags: ["message-thread"], metadata: { participants: Array.from({ length: 60 }, (_, i) => `Member Number${i}`), matrixRoomId: "!r3:h.test" } });
  v.put({ id: "th4", path: "vault/messages/telegram/group", tags: ["message-thread"], metadata: { participants: ["Alex Example", ...Array.from({ length: 9 }, (_, i) => `Guest Person${i}`)], matrixRoomId: "!r4:h.test" } });
  v.put({ id: "th5", path: "vault/messages/telegram/casey", tags: ["message-thread"], metadata: { participants: [], matrixRoomId: "!r5:h.test" } });

  v.put({ id: "proj-1", path: "vault/projects/proj-one", tags: ["project"], metadata: { name: "Project One" } });
  v.put({ id: "k1", path: "vault/tasks/k1", tags: ["task"], metadata: { assigned: "Ozzy", project: "proj-one" } });
  v.put({ id: "k2", path: "vault/tasks/k2", tags: ["task"], metadata: { assigned: "Alex Example, Casey Example", project: "Unknown" } });
  v.put({ id: "k3", path: "vault/tasks/k3", tags: ["task"], metadata: { assigned: "Drew" } });
  v.put({ id: "k4", path: "vault/tasks/k4", tags: ["task"], metadata: { assigned: "[[vault/people/Blake Example]]", project: "[[vault/projects/proj-one]]" } });

  v.put({ id: "n1", path: "vault/meetings/n1", tags: ["meeting"] }, [
    ["n1", "p-casey", "attendee"],
    ["p-casey", "n1", "attended"],
  ]);
}

const members = async (roomId: string) => (roomId === "!r5:h.test" ? { "@telegram_5550002:h.test": "Casey Example", "@owner:h.test": "Owner" } : null);
const opts = (o: Partial<LinkJobOptions> = {}): LinkJobOptions => ({ dryRun: true, owner: OWNER, paceMs: 0, members, limits: { memberPaceMs: 0 }, ...o });
const runJob = async (v: MemVault, o: Partial<LinkJobOptions> = {}): Promise<LinkJob> => {
  const { done } = startLinkJob(v, "primary", opts(o));
  await done;
  return linkJobStatus()!;
};
const PLANNED = ["scanned", "wouldLink", "wouldUnlink", "notesToWrite", "alreadyLinked", "queued", "skipped"] as const;
const planned = (j: LinkJob, p: Phase) => Object.fromEntries(PLANNED.map((k) => [k, j.report[p][k]]));

beforeEach(() => {
  _resetLinkJob();
  resetDb();
});

test("addressList parses display names, quoted commas and bare addresses", () => {
  assert.deepEqual(addressList('"Last, First" <a@x.test>, b@y.test, Not An Address'), [
    { name: "Last, First", email: "a@x.test" },
    { name: "", email: "b@y.test" },
  ]);
});

test("a dry run plans exactly what a write run then writes; the second write run is a no-op", async () => {
  const v = new MemVault();
  seed(v);
  const dry = await runJob(v);
  assert.equal(dry.status, "done");
  assert.equal(v.patches.length, 0, "a dry run never writes");
  assert.equal(listCandidates("primary").candidates.length, 0, "a dry run does not fill the queue by default");

  const wet = await runJob(v, { dryRun: false });
  assert.equal(wet.status, "done");
  for (const p of wet.phases) {
    assert.deepEqual(planned(wet, p), planned(dry, p), `phase ${p} planned the same`);
    const r = wet.report[p];
    assert.equal(r.linked, r.wouldLink, `${p}: every planned link was written`);
    assert.equal(r.unlinked, r.wouldUnlink, `${p}: every planned removal was written`);
    assert.equal(r.notesWritten, r.notesToWrite, p);
    assert.equal(r.conflicts + r.errors + r.deferred, 0, p);
  }
  assert.equal(wet.writes, v.patches.length);
  assert.ok(v.patches.every((x) => x.ifUpdatedAt), "every write is a CAS write");
  assert.equal(openCandidateCounts("primary").total, wet.phases.reduce((n, p) => n + wet.report[p].queued, 0));

  const before = v.patches.length;
  const again = await runJob(v, { dryRun: false });
  assert.equal(v.patches.length, before, "re-running converges: zero writes");
  for (const p of again.phases) assert.equal(again.report[p].wouldLink + again.report[p].wouldUnlink, 0, p);
  assert.equal(lastLinkJobOutcome("primary")?.status, "done");
});

test("what each phase links (and refuses to link)", async () => {
  const v = new MemVault();
  seed(v);
  const j = await runJob(v, { dryRun: false });

  // repoint: the stub's inbound + outbound links move to the canonical person.
  assert.deepEqual(v.out("e-old"), ["email-from->p-alex"]);
  assert.deepEqual(v.out("s-alex"), []);
  assert.deepEqual(v.out("p-alex"), ["member-of->org-1"]);
  assert.deepEqual(v.out("d-1"), ["references->p-alex", "wikilink->s-alex"], "a vault-managed wikilink stays; the canonical gets a references link");
  assert.equal(j.report.repoint.skipped["stub-to-canonical"] ?? 0, 0);

  // emails: sender + direct recipients; never the owner, a role sender, or bulk mail.
  assert.deepEqual(v.out("e1"), ["email-from->p-alex"]);
  assert.deepEqual(v.out("e2"), [], "noreply sender");
  assert.deepEqual(v.out("e3"), [], "BULK label");
  assert.deepEqual(v.out("e4"), ["email-to->p-alex", "email-to->p-casey"], "owner-sent: recipients only (casey by name — no address on file to contradict)");
  assert.deepEqual(v.out("e5"), [], "a shared name is a review item");
  assert.deepEqual(v.out("e7"), ["email-to->p-alex"], "a support@ sender is never a person; its human recipient is");
  assert.ok(!v.edges.some((e) => e.targetId === "p-owner" && e.sourceId.startsWith("e")), "the owner is never linked to their own mail");
  assert.equal(j.report.emails.skipped["role-sender"], 2);
  assert.equal(j.report.emails.skipped["bulk-label"], 1);
  assert.equal(j.report.emails.alreadyLinked, 2, "e6, and e-old (repointed by the phase before)");

  // meetings: owner linked (calendar convention), name rule, resources refused.
  assert.deepEqual(v.out("m1"), ["attended-by->p-blake", "attended-by->p-owner"]);
  assert.equal(j.report.meetings.skipped["role-attendee"], 1);
  assert.deepEqual(v.out("t1"), ["attended-by->p-alex", "attended-by->p-owner"], "the owner alias comes from configuration");

  // threads: names in a DM, ids when stored, membership lookup, owner + bots skipped, groups bounded.
  assert.deepEqual(v.out("th1"), ["messages-with->p-blake"]);
  assert.deepEqual(v.out("th2"), ["messages-with->p-blake"]);
  assert.deepEqual(v.out("th3"), [], "60 members: skipped");
  assert.deepEqual(v.out("th4"), [], "10 name-only participants: names are not trusted in a group");
  assert.deepEqual(v.out("th5"), ["messages-with->p-casey"], "membership lookup");
  assert.equal(j.report.threads.skipped["large-group"], 1);
  assert.equal(j.report.threads.skipped["group-names-only"], 1);
  assert.equal(j.memberLookups, 3, "only rooms without stored ids are looked up (th1, th4, th5; the 60-member room is never asked)");

  // tasks: owner alias, CSV assignees, wikilink assignee, project by slug and by link.
  assert.deepEqual(v.out("k1"), ["assigned-to->p-owner", "belongs-to->proj-1"]);
  assert.deepEqual(v.out("k2"), ["assigned-to->p-alex", "assigned-to->p-casey"]);
  assert.deepEqual(v.out("k3"), [], "a single token that is not an owner alias");
  assert.deepEqual(v.out("k4"), ["assigned-to->p-blake", "belongs-to->proj-1"]);
  assert.equal(j.report.tasks.skipped["project-unknown"], 1);

  // normalize: synonym → canonical on the right note, the synonym removed.
  assert.deepEqual(v.out("n1"), ["attended-by->p-casey"]);
  assert.deepEqual(v.out("p-casey"), []);
  assert.deepEqual(j.report.normalize.byName, { attendee: 1, attended: 1 });

  // The review queue holds the shared name, with both candidates; ids only in samples.
  const queued = listCandidates("primary").candidates;
  assert.ok(queued.some((c) => c.sourceNoteId === "e5" && c.reason === "ambiguous-name" && c.candidateIds.join() === "p-drew1,p-drew2"));
  for (const p of j.phases) for (const id of [...j.report[p].sample.link, ...j.report[p].sample.review]) assert.ok(v.notes.has(id), "samples are note ids");
});

test("lean listings only: metadata limited per phase, never content", async () => {
  const v = new MemVault();
  seed(v);
  await runJob(v);
  assert.ok(v.lists.length >= 7);
  for (const l of v.lists) {
    assert.ok(Array.isArray(l.includeMetadata) && (l.includeMetadata as string[]).length > 0, "include_metadata always narrowed");
    assert.ok(!("includeContent" in l), "content never requested");
    assert.ok(!(l.includeMetadata as string[]).includes("content"));
  }
  const wholeVault = v.lists.filter((l) => !l.tags);
  assert.equal(wholeVault.length, 2, "repoint and normalize each take one whole-vault lean listing");
  for (const l of wholeVault) assert.deepEqual(l.includeMetadata, ["type"]);
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
  assert.deepEqual(v.out("p-alex"), ["member-of->org-1"]);
  assert.deepEqual(v.out("e1"), ["email-from->p-alex"]);
});

test("the write cap is hard; the rest is deferred to the next run", async () => {
  const v = new MemVault();
  seed(v);
  const j = await runJob(v, { dryRun: false, maxWrites: 2 });
  assert.equal(v.patches.length, 2);
  assert.equal(j.writes, 2);
  assert.ok(j.capped);
  assert.ok(j.phases.reduce((n, p) => n + j.report[p].deferred, 0) > 0);
  // A capped dry run reports the same cap without writing.
  const fresh = new MemVault();
  seed(fresh);
  const dryCapped = await runJob(fresh, { dryRun: true, maxWrites: 2 });
  assert.equal(dryCapped.writes, 2);
  assert.ok(dryCapped.capped);
  assert.equal(fresh.patches.length, 0);
  let runs = 0;
  while ((await runJob(v, { dryRun: false, maxWrites: 5 })).capped) assert.ok(++runs < 20, "capped runs make progress");
  const last = await runJob(v, { dryRun: false, maxWrites: 5 });
  assert.equal(last.writes, 0, "repeated capped runs converge");
  const full = new MemVault();
  seed(full);
  await runJob(full, { dryRun: false });
  assert.deepEqual([...v.edges].map((e) => `${e.sourceId}|${e.relationship}|${e.targetId}`).sort(), [...full.edges].map((e) => `${e.sourceId}|${e.relationship}|${e.targetId}`).sort(), "capped runs end in the same graph as one full run");
});

test("cancel stops between writes", async () => {
  const v = new MemVault();
  seed(v);
  let release!: () => void;
  v.gate = new Promise<void>((r) => (release = r));
  const { done } = startLinkJob(v, "primary", opts({ dryRun: false, concurrency: 1 }));
  for (let i = 0; i < 100 && !(linkJobStatus()!.writes > 0); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cancelLinkJob());
  release();
  await done;
  const j = linkJobStatus()!;
  assert.equal(j.status, "cancelled");
  assert.equal(v.patches.length, 1, "the in-flight write finishes, nothing after it starts");
  assert.equal(cancelLinkJob(), false);
});

test("oversize notes: skipped from the listing's byteSize, counted on a 413", async () => {
  const v = new MemVault();
  seed(v);
  v.notes.get("e1")!.byteSize = 2_500_000;
  v.tooLarge.add("e4");
  const j = await runJob(v, { dryRun: false, phases: ["emails"] });
  assert.equal(j.report.emails.skipped.oversize, 1);
  assert.equal(j.report.emails.oversize, 1);
  assert.deepEqual(v.out("e1"), []);
  assert.deepEqual(v.out("e4"), []);
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
  assert.deepEqual(v.out("e4"), ["email-to->p-alex", "email-to->p-casey"], "other notes are unaffected");
  const n = listCandidates("primary").candidates.length;
  await runJob(v, { dryRun: false, phases: ["emails"] });
  assert.equal(listCandidates("primary").candidates.length, n);
});

test("without an owner person, owner aliases never link to anyone", async () => {
  const v = new MemVault();
  seed(v);
  v.notes.delete("p-owner");
  const j = await runJob(v, { dryRun: false, phases: ["tasks", "meetings"] });
  assert.equal(j.ownerPersonKnown, false);
  assert.deepEqual(v.out("k1"), ["belongs-to->proj-1"]);
  assert.equal(j.report.tasks.skipped["owner-unresolved"], 1);
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
  setMembership("primary", "coowner@example.test", "owner", null);
  for (const h of [
    J,
    { ...J, authorization: `Capability ${makeCapability("note", "e1", "edit")}` },
    { ...J, cookie: sessionCookie(makeSession("guest@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("admin@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("coowner@example.test")) },
  ]) {
    assert.equal((await post("/people/link", h, { dryRun: false })).status, 403);
    assert.equal((await adminApi.request("/people/link", { headers: h })).status, 403);
    assert.equal((await post("/people/link/cancel", h)).status, 403);
  }
  assert.equal((await post("/people/link", { ...owner(), "content-type": "text/plain" })).status, 415);
  assert.equal((await post("/people/link", { ...owner(), "sec-fetch-site": "cross-site" })).status, 403);
  for (const bad of [{ dryRun: "no" }, { phases: [] }, { phases: ["everything"] }, { maxWrites: 0 }, { maxWrites: 1.5 }, { maxWrites: 10_000_000 }, { useMatrixMembers: "yes" }])
    assert.equal((await post("/people/link", owner(), bad)).status, 400, JSON.stringify(bad));
  assert.equal((await post("/people/link", owner(), { useMatrixMembers: true })).status, 409, "no stored Matrix credential");
  assert.equal(fv.calls.length, 0, "nothing reached the vault");

  const r = await post("/people/link", owner(), { phases: ["emails"] });
  assert.equal(r.status, 202);
  const { job } = (await r.json()) as { job: LinkJob };
  assert.equal(job.dryRun, true, "dry run by default");
  assert.equal(job.maxWrites, 0);
  assert.equal((await post("/people/link", owner(), {})).status, 409, "one job at a time");
  const done = await waitJob();
  assert.equal(done.report.emails.wouldLink, 1);
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
