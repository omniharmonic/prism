/**
 * The SCHEDULED people-link run (src/worker/people-link-schedule.ts): the owner's
 * backfill job on a slow cadence, strong keys only, capped, off by default and a
 * dry run until told otherwise. An in-memory vault; synthetic people only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLink, NoteLinkInput } from "../src/parachute";
import { config } from "../src/config";
import { getWorkerCursor, setWorkerCursor } from "../src/db";
import { listActionAudit } from "../src/actions/store";
import { listCandidates } from "../src/identity-store";
import { _resetLinkJob, lastLinkJobOutcome, linkJobStatus, startLinkJob, type LinkJobOptions, type LinkJobVault } from "../src/people-link-job";
import { _resetPeopleCache } from "../src/people-cache";
import { _resetPeopleLock, acquirePeopleLock } from "../src/people-lock";
import { getSourceHealth, resetSourceHealth } from "../src/worker/health";
import {
  SCHEDULE_SAFE_PHASES,
  _resetPeopleLinkSchedule,
  lastPeopleLinkSchedule,
  peopleLinkScheduleBusySkips,
  peopleLinkScheduleDue,
  runPeopleLinkScheduleOnce,
  schedulePhases,
  type PeopleLinkScheduleDeps,
} from "../src/worker/people-link-schedule";
import { resetDb } from "./helpers";

type Stored = Note;

class MemVault implements LinkJobVault {
  notes = new Map<string, Stored>();
  edges: NoteLink[] = [];
  lists: Array<Record<string, unknown>> = [];
  patches: Array<{ id: string; add: NoteLinkInput[]; remove: NoteLinkInput[]; metadata?: Record<string, unknown>; ifUpdatedAt?: string }> = [];
  failLists = false;
  gate: Promise<void> | null = null;
  private clock = 0;
  put(n: Partial<Note> & { id: string }): void {
    this.notes.set(n.id, { content: "", path: null, metadata: {}, createdAt: "", updatedAt: "2026-01-01T00:00:00.000Z", tags: [], ...n } as Stored);
  }
  out(id: string): string[] {
    return this.edges.filter((e) => e.sourceId === id).map((e) => `${e.relationship}->${e.targetId}`).sort();
  }
  async listNotes(opts: { tags?: string[]; includeLinks?: boolean; includeMetadata?: string[] }): Promise<Note[]> {
    this.lists.push({ ...opts });
    if (this.failLists) throw new Error("vault down");
    return [...this.notes.values()]
      .filter((n) => (opts.tags ?? []).every((t) => (n.tags ?? []).includes(t)))
      .map((n) => {
        const md = opts.includeMetadata ? Object.fromEntries(Object.entries(n.metadata ?? {}).filter(([k]) => opts.includeMetadata!.includes(k))) : n.metadata;
        return structuredClone({ ...n, content: "", metadata: md, ...(opts.includeLinks ? { links: this.edges.filter((e) => e.sourceId === n.id || e.targetId === n.id) } : {}) });
      });
  }
  async updateNote(id: string, p: { links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] }; metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note> {
    if (this.gate) await this.gate;
    const n = this.notes.get(id);
    if (!n) throw Object.assign(new Error("not found"), { status: 404 });
    if (!p.ifUpdatedAt) throw new Error("TEST: a write without if_updated_at would be a force write");
    if (p.ifUpdatedAt !== n.updatedAt) throw Object.assign(new Error("conflict"), { status: 409 });
    this.patches.push({ id, add: p.links?.add ?? [], remove: p.links?.remove ?? [], metadata: p.metadata, ifUpdatedAt: p.ifUpdatedAt });
    for (const a of p.links?.add ?? []) this.edges.push({ sourceId: id, targetId: a.target, relationship: a.relationship });
    if (p.metadata) n.metadata = { ...(n.metadata ?? {}), ...p.metadata };
    n.updatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, ++this.clock)).toISOString();
    return { ...n };
  }
}

const OWNER = { emails: ["owner@example.test"], aliases: ["Ozzy"] };
const person = (id: string, name: string, md: Record<string, unknown> = {}, tags: string[] = []) => ({ id, path: `vault/people/${name}`, tags: ["person", ...tags], metadata: { name, ...md } });

/** Records that arrived BEFORE the person notes existed: nothing is linked yet. */
function seed(v: MemVault, emails = 3): void {
  v.put(person("p-owner", "Owner Person", { email: "owner@example.test" }));
  v.put(person("p-alex", "Alex Example", { email: "alex@example.test" }));
  v.put(person("p-blake", "Blake Example", { channels: { matrix: "@telegram_5550001:h.test" } }));
  v.put(person("p-casey", "Casey Example"));
  // A merged stub with a link of its own: the scheduled run must never move it.
  v.put(person("s-alex", "alex-old", { merged_into: "p-alex", status: "merged_into_canonical" }, ["merged-stub"]));
  v.put({ id: "old-doc", path: "vault/notes/old-doc", tags: [] });
  v.edges.push({ sourceId: "old-doc", targetId: "s-alex", relationship: "mentions" });
  // A long-tail relationship name the `normalize` phase would rewrite.
  v.put({ id: "n1", path: "vault/meetings/n1", tags: ["meeting"] });
  v.edges.push({ sourceId: "n1", targetId: "p-casey", relationship: "attendee" });

  for (let i = 0; i < emails; i++) v.put({ id: `e${i}`, path: `vault/messages/email/e${i}`, tags: ["email"], metadata: { labels: ["INBOX"], from: "Alex Example <alex@example.test>", to: "owner@example.test" } });
  // A display name alone never links mail.
  v.put({ id: "e-name", path: "vault/messages/email/e-name", tags: ["email"], metadata: { labels: ["INBOX"], from: "Casey Example <casey@elsewhere.test>", to: "owner@example.test" } });
  v.put({ id: "m1", path: "vault/meetings/2026-01-01/sync", tags: ["meeting"], metadata: { attendees: ["alex@example.test", "Casey Example"] } });
  v.put({ id: "th1", path: "vault/messages/telegram/blake", tags: ["message-thread"], metadata: { participants: ["Blake Example"], participantIds: ["@telegram_5550001:h.test"], matrixRoomId: "!r1:h.test" } });
  // No stored ids: without the (off) membership lookup this thread is not linked by name.
  v.put({ id: "th2", path: "vault/messages/telegram/casey", tags: ["message-thread"], metadata: { participants: ["Casey Example"], matrixRoomId: "!r2:h.test" } });
  v.put({ id: "proj-1", path: "vault/projects/proj-one/PROJECT", tags: ["project"], metadata: { name: "Project One" } });
  v.put({ id: "k1", path: "vault/tasks/k1", tags: ["task"], metadata: { assigned: "alex@example.test", project: "Project One" } });
  v.put({ id: "k2", path: "vault/tasks/k2", tags: ["task"], metadata: { assigned: "Casey Example" } });
}

const deps = (v: LinkJobVault, o: Partial<PeopleLinkScheduleDeps> = {}): PeopleLinkScheduleDeps => ({
  vault: v,
  job: { paceMs: 0, owner: OWNER, people: () => v.listNotes({ tags: ["person"], includeLinks: true }), limits: { memberPaceMs: 0 } },
  ...o,
});
const audit = () => listActionAudit({ action: ["worker.people-link-schedule"] });
const WEEK = 7 * 86_400_000;

const saved = {
  enabled: config.peopleLinkScheduleEnabled,
  ms: config.peopleLinkScheduleMs,
  dry: config.peopleLinkScheduleDryRun,
  max: config.peopleLinkScheduleMaxWrites,
  phases: config.peopleLinkSchedulePhases,
  lookups: config.peopleLinkScheduleMatrixLookups,
};

beforeEach(() => {
  _resetLinkJob();
  _resetPeopleLock();
  _resetPeopleCache();
  _resetPeopleLinkSchedule();
  resetSourceHealth();
  resetDb();
});
afterEach(() => {
  config.peopleLinkScheduleEnabled = saved.enabled;
  config.peopleLinkScheduleMs = saved.ms;
  config.peopleLinkScheduleDryRun = saved.dry;
  config.peopleLinkScheduleMaxWrites = saved.max;
  config.peopleLinkSchedulePhases = saved.phases;
  config.peopleLinkScheduleMatrixLookups = saved.lookups;
});

test("the defaults: off, weekly, a dry run, 200 writes, the four additive phases, no Matrix lookups", () => {
  assert.deepEqual(
    [saved.enabled, saved.ms, saved.dry, saved.max, saved.lookups],
    [false, WEEK, true, 200, false],
  );
  assert.deepEqual(schedulePhases(saved.phases), ["emails", "meetings", "threads", "tasks"]);
  assert.deepEqual([...SCHEDULE_SAFE_PHASES], ["emails", "meetings", "threads", "tasks"]);
});

test("off by default: nothing is read, written, persisted or audited", async () => {
  const v = new MemVault();
  seed(v);
  assert.equal(peopleLinkScheduleDue(), false);
  assert.deepEqual(await runPeopleLinkScheduleOnce("primary", deps(v)), { ran: false, reason: "disabled" });
  assert.equal(v.lists.length + v.patches.length, 0, "the vault was not touched");
  assert.equal(lastPeopleLinkSchedule(), null);
  assert.equal(lastLinkJobOutcome("primary"), null);
  assert.equal(audit().length, 0);
  // An interval of 0 is off too, whatever ENABLED says.
  config.peopleLinkScheduleEnabled = true;
  config.peopleLinkScheduleMs = 0;
  assert.equal(peopleLinkScheduleDue(), false);
  assert.deepEqual(await runPeopleLinkScheduleOnce("primary", deps(v)), { ran: false, reason: "disabled" });
  assert.equal(v.lists.length, 0);
});

test("enabled alone is a DRY RUN: it plans and records counts, and writes nothing", async () => {
  config.peopleLinkScheduleEnabled = true;
  const v = new MemVault();
  seed(v);
  const edgesBefore = JSON.stringify(v.edges);
  const res = await runPeopleLinkScheduleOnce("primary", deps(v));
  assert.equal(res.ran, true);
  const job = res.ran ? res.job : null!;
  assert.deepEqual([job.status, job.dryRun, job.scheduled, job.allowNameLinks, job.phases], ["done", true, true, false, ["emails", "meetings", "threads", "tasks"]]);
  assert.equal(v.patches.length, 0, "a dry run never writes to the vault");
  assert.equal(JSON.stringify(v.edges), edgesBefore);
  assert.equal(listCandidates("primary").candidates.length, 0, "the review queue is not filled");
  assert.ok(job.report.emails.wouldLink >= 3 && job.report.meetings.wouldLink === 1 && job.report.threads.wouldLink === 1 && job.report.tasks.wouldLink === 2);
  // Lean listings only: never content, never the whole-vault listing.
  assert.ok(v.lists.every((l) => !("includeContent" in l) && Array.isArray(l.tags) && (l.tags as string[]).length === 1), "one lean per-tag listing each");

  // The job's own outcome (the `people-link` health source) …
  const out = lastLinkJobOutcome("primary")!;
  assert.deepEqual([out.dryRun, out.status, out.writes, out.linked, out.scheduled, out.wouldLink], [true, "done", 0, 0, true, 7]);
  // … and ONE audit row, counts only.
  const rows = audit();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.via, rows[0]!.origin, rows[0]!.status, rows[0]!.vaultId], ["worker", "agent", "ok", "primary"]);
  const target = rows[0]!.target as Record<string, unknown>;
  assert.deepEqual([target.dryRun, target.scheduled, target.writes, target.allowNameLinks], [true, true, 0, false]);
  assert.equal((target.emails as { wouldLink: number }).wouldLink, job.report.emails.wouldLink);
  const text = JSON.stringify(target);
  for (const secret of ["example.test", "Alex", "p-alex", "e0", "vault/"]) assert.ok(!text.includes(secret), `the audit row holds counts only (found ${secret})`);
});

test("due / not due survives a restart; an errored or interrupted run comes back after a day", async () => {
  config.peopleLinkScheduleEnabled = true;
  const v = new MemVault();
  seed(v);
  const t0 = Date.UTC(2026, 9, 8, 12);
  assert.equal(peopleLinkScheduleDue("primary", t0), true, "never ran → due");
  assert.equal((await runPeopleLinkScheduleOnce("primary", deps(v, { now: () => t0 }))).ran, true);
  assert.equal(lastPeopleLinkSchedule()!.status, "done");

  // "Restart": every in-process flag is gone; only the database remains.
  _resetPeopleLinkSchedule();
  _resetLinkJob();
  _resetPeopleLock();
  const lists = v.lists.length;
  assert.equal(peopleLinkScheduleDue("primary", t0 + 60_000), false);
  assert.equal(peopleLinkScheduleDue("primary", t0 + WEEK - 1), false);
  assert.deepEqual(await runPeopleLinkScheduleOnce("primary", deps(v, { now: () => t0 + WEEK - 1 })), { ran: false, reason: "not-due" });
  assert.equal(v.lists.length, lists, "not due → the vault is not read");
  assert.equal(audit().length, 1);
  assert.equal(peopleLinkScheduleDue("primary", t0 + WEEK), true);
  assert.equal((await runPeopleLinkScheduleOnce("primary", deps(v, { now: () => t0 + WEEK }))).ran, true);
  assert.equal(audit().length, 2);
  assert.equal(Date.parse(lastPeopleLinkSchedule()!.at), t0 + WEEK);

  // The process died mid-run: the claimed slot is still "running". No run on every boot.
  setWorkerCursor("primary", "people-link-schedule", JSON.stringify({ at: new Date(t0).toISOString(), jobId: "x", status: "running", dryRun: true }));
  assert.equal(peopleLinkScheduleDue("primary", t0 + 3_600_000), false);
  assert.equal(peopleLinkScheduleDue("primary", t0 + 86_400_000), true);

  // A run that ends in an error is tried again after a day, not after a week — and never throws.
  _resetLinkJob();
  v.failLists = true;
  const t1 = t0 + 86_400_000;
  const res = await runPeopleLinkScheduleOnce("primary", deps(v, { now: () => t1 }));
  assert.ok(res.ran && res.job.status === "error");
  assert.equal(lastPeopleLinkSchedule()!.status, "error");
  assert.equal(audit()[0]!.status, "failed");
  assert.equal(lastLinkJobOutcome("primary")!.failStreak, 1);
  assert.equal(peopleLinkScheduleDue("primary", t1 + 3_600_000), false);
  assert.equal(peopleLinkScheduleDue("primary", t1 + 86_400_000), true);
});

test("a write run: strong keys only, compare-and-set, additive, and inside the cap", async () => {
  config.peopleLinkScheduleEnabled = true;
  config.peopleLinkScheduleDryRun = false;
  const v = new MemVault();
  seed(v);
  const t0 = Date.UTC(2026, 9, 8, 12);
  // `deps.job` cannot loosen the safety settings.
  const loose = { ...deps(v, { now: () => t0 }).job, allowNameLinks: true, enqueue: true, dryRun: true, phases: ["owner", "repoint", "normalize"], maxWrites: 0 } as unknown as PeopleLinkScheduleDeps["job"];
  const res = await runPeopleLinkScheduleOnce("primary", { vault: v, now: () => t0, job: loose });
  const job = res.ran ? res.job : null!;
  assert.deepEqual([job.status, job.dryRun, job.allowNameLinks, job.maxWrites, job.maxWritesPerPhase, job.capped], ["done", false, false, 200, 50, false]);
  assert.deepEqual(job.phases, ["emails", "meetings", "threads", "tasks"]);

  assert.deepEqual(v.out("e0"), ["email-from->p-alex"]);
  assert.deepEqual(v.out("e-name"), [], "a sender's display name never links");
  assert.deepEqual(v.out("m1"), ["attended-by->p-alex"], "the attendee named only by name is not linked");
  assert.deepEqual(v.out("th1"), ["messages-with->p-blake"]);
  assert.deepEqual(v.out("th2"), [], "no stored ids and no lookup → not linked by display name");
  assert.deepEqual(v.out("k1"), ["assigned-to->p-alex", "belongs-to->proj-1"]);
  assert.deepEqual(v.out("k2"), [], "an assignee named only by name is not linked");
  // Additive only: nothing removed, no metadata rewritten, no person note written.
  assert.ok(v.patches.every((p) => p.ifUpdatedAt && p.remove.length === 0 && p.metadata === undefined && !p.id.startsWith("p-") && !p.id.startsWith("s-")));
  assert.deepEqual(v.out("old-doc"), ["mentions->s-alex"], "repoint did not run: the stub keeps its link");
  assert.deepEqual(v.out("n1"), ["attendee->p-casey"], "normalize did not run");
  assert.equal(listCandidates("primary").candidates.length, 0, "enqueue stays off");
  assert.equal(job.writes, v.patches.length);
  assert.deepEqual([lastLinkJobOutcome("primary")!.writes, lastLinkJobOutcome("primary")!.linked], [6, 7]);
  assert.equal((audit()[0]!.target as { writes: number }).writes, 6);

  // The next run finds nothing left to do.
  _resetLinkJob();
  const again = await runPeopleLinkScheduleOnce("primary", deps(v, { now: () => t0 + WEEK }));
  assert.ok(again.ran && again.job.writes === 0 && again.job.status === "done");
});

test("the cap is hard, and is shared between the phases so a mail backlog cannot starve the rest", async () => {
  config.peopleLinkScheduleEnabled = true;
  config.peopleLinkScheduleDryRun = false;
  config.peopleLinkScheduleMaxWrites = 4;
  const v = new MemVault();
  seed(v, 30);
  const res = await runPeopleLinkScheduleOnce("primary", deps(v));
  const job = res.ran ? res.job : null!;
  assert.deepEqual([job.maxWrites, job.maxWritesPerPhase, job.capped], [4, 1, true]);
  assert.ok(v.patches.length <= 4, `wrote ${v.patches.length} notes with a cap of 4`);
  assert.deepEqual(job.phases.map((p) => job.report[p].notesWritten), [1, 1, 1, 1], "each phase got its share");
  assert.equal(job.report.emails.deferred, 29, "the rest waits for a later run");
  assert.equal(lastLinkJobOutcome("primary")!.capped, true);

  // A dry run with the same cap plans the same window (and still writes nothing).
  _resetLinkJob();
  resetDb();
  config.peopleLinkScheduleDryRun = true;
  const v2 = new MemVault();
  seed(v2, 30);
  const dry = await runPeopleLinkScheduleOnce("primary", deps(v2));
  assert.ok(dry.ran && dry.job.capped && dry.job.report.emails.deferred === 29);
  assert.equal(v2.patches.length, 0);

  // A nonsense cap never means "no cap".
  _resetLinkJob();
  resetDb();
  config.peopleLinkScheduleDryRun = false;
  config.peopleLinkScheduleMaxWrites = 0;
  const v3 = new MemVault();
  seed(v3, 30);
  const z = await runPeopleLinkScheduleOnce("primary", deps(v3));
  assert.ok(z.ran && z.job.maxWrites === 1 && v3.patches.length <= 1);
});

test("busy: a merge / review / manual job holds the lock → this tick is skipped and the next one runs", async () => {
  config.peopleLinkScheduleEnabled = true;
  config.peopleLinkScheduleDryRun = false;
  const v = new MemVault();
  seed(v);
  const release = acquirePeopleLock("people-merge")!;
  assert.deepEqual(await runPeopleLinkScheduleOnce("primary", deps(v)), { ran: false, reason: "busy", detail: "people-merge" });
  assert.equal(v.lists.length + v.patches.length, 0, "busy → the vault is not touched");
  assert.equal(lastPeopleLinkSchedule(), null, "the slot is not used up");
  assert.equal(audit().length, 0);
  assert.equal(peopleLinkScheduleBusySkips(), 1);
  assert.equal(peopleLinkScheduleDue(), true, "still due → the next tick tries again");
  release();

  // A job the owner started by hand is running.
  let open!: () => void;
  v.gate = new Promise<void>((r) => (open = r));
  const manual = startLinkJob(v, "primary", { dryRun: false, phases: ["emails"], maxWrites: 1, owner: OWNER, paceMs: 0, people: () => v.listNotes({ tags: ["person"], includeLinks: true }) } as LinkJobOptions);
  const skipped = await runPeopleLinkScheduleOnce("primary", deps(v));
  assert.deepEqual([skipped.ran, !skipped.ran && skipped.reason], [false, "busy"]);
  assert.equal(linkJobStatus()!.scheduled, false, "the manual job was not replaced");
  open();
  v.gate = null;
  await manual.done;

  // And while a scheduled run is going, a second visit does not start another.
  const first = runPeopleLinkScheduleOnce("primary", deps(v));
  assert.deepEqual(await runPeopleLinkScheduleOnce("primary", deps(v)), { ran: false, reason: "in-flight" });
  const done = await first;
  assert.ok(done.ran && done.job.status === "done");
  assert.equal(peopleLinkScheduleBusySkips(), 0, "the count restarts with a run");
  assert.equal(audit().length, 1, "one audit row per scheduled run");
});

test("PEOPLE_LINK_SCHEDULE_PHASES can only narrow the run; the manual-only phases are ignored", async () => {
  config.peopleLinkScheduleEnabled = true;
  assert.deepEqual(schedulePhases("owner, tombstones, repoint, normalize, Emails ,bogus"), ["emails"]);
  assert.deepEqual(schedulePhases("tasks,emails"), ["emails", "tasks"], "always in the job's own order");
  config.peopleLinkSchedulePhases = "owner,tombstones,repoint,normalize";
  const v = new MemVault();
  seed(v);
  assert.deepEqual(await runPeopleLinkScheduleOnce("primary", deps(v)), { ran: false, reason: "no-phases" });
  assert.equal(v.lists.length + v.patches.length, 0);
  assert.equal(getWorkerCursor("primary", "people-link-schedule"), null);
});

test("health: with the schedule on, `people-link` is always listed, says what is next, and goes stale after two missed runs", async () => {
  const find = async (now?: number) => (await getSourceHealth({ list: async () => [], ...(now ? { now } : {}) })).find((h) => h.name === "people-link");
  assert.equal(await find(), undefined, "schedule off and nothing ever ran → not listed (as before)");
  config.peopleLinkScheduleEnabled = true;
  let h = (await find())!;
  assert.deepEqual([h.status, h.staleAfterMs, h.detail!.scheduleEnabled, h.detail!.scheduleDryRun, h.detail!.scheduleLastStatus], ["ok", 2 * WEEK, true, true, null]);
  const v = new MemVault();
  seed(v);
  await runPeopleLinkScheduleOnce("primary", deps(v));
  h = (await find())!;
  assert.deepEqual([h.status, h.detail!.lastJobScheduled, h.detail!.lastJobDryRun, h.detail!.lastJobWouldLink, h.detail!.lastJobWrites, h.detail!.scheduleLastStatus], ["ok", true, true, 7, 0, "done"]);
  assert.ok(Date.parse(String(h.detail!.scheduleNextAt)) > Date.now() + WEEK - 60_000);
  assert.equal((await find(Date.now() + 2 * WEEK + 60_000))!.status, "stale");
});
