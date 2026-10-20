import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db";
import { vaultClient } from "../src/parachute";
import { resetDb, installFakeVault, type FakeVault } from "./helpers";
import { pruneDecisions } from "../src/transcript-links-store";
import {
  decideTranscriptLink,
  setTranscriptLinkTimeoutForTests,
  setTranscriptLinkVaultForTests,
  transcriptLinkGate,
  TranscriptLinkError,
  type LinkAuthorize,
  type ManualDecision,
} from "../src/transcript-links";
import { buildMeetingNote, syncCalendarWindow, type CalEvent, type CalendarPassOptions, type CalendarVault } from "../src/worker/calendar";

let fv: FakeVault;
const OWNER = "user:owner@test.local";
const allow: LinkAuthorize = () => {};

const meta = (id: string) => fv.notes.get(id)!.metadata ?? {};
const typed = (id: string) => (fv.notes.get(id)!.links ?? []).filter((l) => l.relationship === "has-transcript").map((l) => l.targetId).sort();
const stamp = (id: string) => fv.notes.get(id)!.updatedAt!;
const journal = () => db.prepare("SELECT transcript_id, action, state, actor, revision, step FROM transcript_link_decisions ORDER BY created_at, rowid").all() as Array<{ transcript_id: string; action: string; state: string; actor: string; revision: number; step: number }>;
const decisionCount = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
const patches = (id: string) => fv.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/notes/${id}`));
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof TranscriptLinkError ? e.code : `other:${String(e)}`));

function meeting(id: string, eventId: string | null, extra: Record<string, unknown> = {}) {
  return fv.put({
    id,
    path: `vault/meetings/2026-10-05/${id}`,
    tags: ["meeting", "team"],
    content: `BODY ${id}`,
    metadata: { title: "Roadmap review", date: "2026-10-05", attendees: ["Ada Example"], keep: id, ...(eventId ? { calendarEventId: eventId } : {}), ...extra },
  });
}
function transcript(id: string, extra: Record<string, unknown> = {}) {
  return fv.put({
    id,
    path: `vault/transcripts/${id}`,
    tags: ["transcript", "team"],
    content: `BODY ${id}`,
    metadata: { title: "Roadmap review", date: "2026-10-05", attendees: ["Ada Example"], keep: id, ...extra },
  });
}

const decide = (over: Partial<ManualDecision> = {}) => {
  const meetingId = over.meetingId ?? "M";
  const transcriptId = over.transcriptId ?? "T1";
  return decideTranscriptLink({
    vaultId: "primary",
    meetingId,
    transcriptId,
    action: "link",
    reason: "same call",
    meetingUpdatedAt: over.meetingUpdatedAt ?? stamp(meetingId),
    transcriptUpdatedAt: over.transcriptUpdatedAt ?? stamp(transcriptId),
    expectedRevision: 0,
    requestId: "r1",
    actor: OWNER,
    authorize: allow,
    ...over,
  });
};

/** Fault + interleaving injection around the real (fake-vault) client. */
function faults() {
  const f = {
    failBefore: new Set<string>(),
    failAfter: new Set<string>(),
    hold: new Map<string, Promise<void>>(),
    writes: [] as string[],
    onWrite: null as null | ((id: string) => void),
  };
  setTranscriptLinkVaultForTests((v) => ({
    getNote: (id, o) => v.getNote(id, o),
    updateNote: async (id, p) => {
      f.onWrite?.(id);
      const gate = f.hold.get(id);
      if (gate) {
        f.hold.delete(id);
        await gate;
      }
      if (f.failBefore.delete(id)) throw new Error("network down");
      const r = await v.updateNote(id, p);
      f.writes.push(id);
      if (f.failAfter.delete(id)) throw new Error("acknowledgement lost");
      return r;
    },
  }));
  return f;
}

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  meeting("M", "ev-m");
  transcript("T1");
  transcript("T2");
});
afterEach(() => {
  setTranscriptLinkTimeoutForTests(null);
  setTranscriptLinkVaultForTests(null);
  fv.restore();
});

// ── manual decisions ─────────────────────────────────────────────────────────

test("manual link writes plural, singular, typed link and the backpointer; nothing else changes", async () => {
  assert.deepEqual(await decide(), { status: "applied", revision: 1 });
  assert.deepEqual(meta("M").transcriptNoteIds, ["T1"]);
  assert.equal(meta("M").transcriptNoteId, "T1");
  assert.equal(meta("M").transcriptLinkOrigin, "manual");
  assert.deepEqual(typed("M"), ["T1"]);
  assert.equal(meta("T1").meetingNoteId, "M");
  for (const id of ["M", "T1"]) {
    assert.equal(meta(id).keep, id, "unrelated metadata survives");
    assert.equal(fv.notes.get(id)!.content, `BODY ${id}`);
  }
  assert.deepEqual(fv.notes.get("M")!.tags, ["meeting", "team"]);
  assert.ok(fv.calls.filter((c) => c.method === "PATCH").every((c) => typeof (c.body as { if_updated_at?: string }).if_updated_at === "string" && !(c.body as { force?: boolean }).force), "every write is a CAS, never force");
  assert.ok(fv.calls.every((c) => c.method !== "DELETE"));
  assert.deepEqual(journal(), [{ transcript_id: "T1", action: "link", state: "applied", actor: OWNER, revision: 1, step: 3 }]);
});

test("two recordings both link to one meeting: plural holds both, singular keeps the first, both typed links", async () => {
  await decide();
  assert.equal(await code(decide({ transcriptId: "T2" })), "request_reused", "a request id is one decision, even across transcripts");
  assert.deepEqual(await decide({ transcriptId: "T2", requestId: "r2" }), { status: "applied", revision: 1 });
  assert.deepEqual(meta("M").transcriptNoteIds, ["T1", "T2"]);
  assert.equal(meta("M").transcriptNoteId, "T1");
  assert.deepEqual(typed("M"), ["T1", "T2"]);
  assert.equal(meta("T1").meetingNoteId, "M");
  assert.equal(meta("T2").meetingNoteId, "M");
});

test("a legacy singular link is carried into the plural list when a second recording is added", async () => {
  fv.notes.get("M")!.metadata = { ...meta("M"), transcriptNoteId: "T1" };
  fv.notes.get("T1")!.metadata = { ...meta("T1"), meetingNoteId: "M" };
  await decide({ transcriptId: "T2" });
  assert.deepEqual(meta("M").transcriptNoteIds, ["T1", "T2"]);
  assert.equal(meta("M").transcriptNoteId, "T1");
});

test("stale expectedRevision, meetingUpdatedAt or transcriptUpdatedAt → stale, and nothing is journaled or written", async () => {
  assert.equal(await code(decide({ expectedRevision: 1 })), "stale");
  assert.equal(await code(decide({ meetingUpdatedAt: "2020-01-01T00:00:00.000Z" })), "stale");
  assert.equal(await code(decide({ transcriptUpdatedAt: "2020-01-01T00:00:00.000Z" })), "stale");
  assert.equal(await code(decide({ action: "unlink" })), "stale", "unlinking a pair that is not linked");
  assert.deepEqual(journal(), []);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM transcript_link_state").get() as { n: number }).n, 0);
});

test("lost acknowledgement: the write lands, the reply is lost → pending; the identical retry returns applied with no duplicate write", async () => {
  const f = faults();
  f.failAfter.add("M");
  const body = { meetingUpdatedAt: stamp("M"), transcriptUpdatedAt: stamp("T1") };
  assert.deepEqual(await decide(body), { status: "pending", revision: 1 });
  assert.deepEqual(meta("M").transcriptNoteIds, ["T1"], "the meeting write did land");
  assert.equal(meta("T1").meetingNoteId, undefined);
  assert.equal(journal()[0]!.state, "pending");
  // Byte-identical retry: its meetingUpdatedAt is stale by now and must not be re-compared.
  assert.deepEqual(await decide(body), { status: "applied", revision: 1 });
  assert.equal(patches("M").length, 1, "the meeting is not written a second time");
  assert.equal(patches("T1").length, 1);
  assert.equal(meta("T1").meetingNoteId, "M");
  assert.deepEqual(journal().map((r) => r.state), ["applied"]);
  // And once applied, a further replay is a pure receipt.
  const before = fv.calls.length;
  assert.deepEqual(await decide(body), { status: "applied", revision: 1 });
  assert.equal(fv.calls.length, before, "an applied replay touches no note");
});

test("three-note move repairs after a partial failure; the same request id with a different body is refused", async () => {
  meeting("A", "ev-a");
  await decide({ meetingId: "A", requestId: "first" });
  await decide({ meetingId: "A", transcriptId: "T2", requestId: "second" });
  assert.equal(meta("A").transcriptNoteId, "T1");

  const f = faults();
  f.failBefore.add("T1");
  const body = { requestId: "move", expectedRevision: 1, meetingUpdatedAt: stamp("M"), transcriptUpdatedAt: stamp("T1") };
  assert.deepEqual(await decide(body), { status: "pending", revision: 2 });
  assert.deepEqual(meta("M").transcriptNoteIds, ["T1"], "new meeting written first");
  assert.equal(meta("T1").meetingNoteId, "A", "transcript not yet repointed");
  assert.deepEqual(meta("A").transcriptNoteIds, ["T1", "T2"], "old meeting untouched so far");
  assert.equal(journal().at(-1)!.step, 1);

  assert.equal(await code(decide({ ...body, reason: "a different reason" })), "request_reused");
  assert.equal(await code(decide({ ...body, action: "unlink" })), "request_reused");

  assert.deepEqual(await decide(body), { status: "applied", revision: 2 });
  assert.equal(meta("T1").meetingNoteId, "M");
  assert.deepEqual(meta("A").transcriptNoteIds, ["T2"]);
  assert.equal(meta("A").transcriptNoteId, "T2", "legacy singular re-pointed at the remaining recording");
  assert.deepEqual(typed("A"), ["T2"]);
  assert.deepEqual(typed("M"), ["T1"]);
  assert.equal(meta("T2").meetingNoteId, "A");
  assert.equal(patches("M").length, 1, "the already-written meeting is skipped on repair");
  assert.ok(fv.notes.has("T1") && fv.notes.has("A"), "nothing is deleted");
});

test("unlink clears both directions, never deletes the transcript, and a CAS conflict is retried once", async () => {
  await decide();
  fv.conflictOnNextWrite = true; // the transcript write 409s once, then succeeds on the re-read
  assert.deepEqual(await decide({ action: "unlink", requestId: "u1", expectedRevision: 1 }), { status: "applied", revision: 2 });
  assert.equal(meta("T1").meetingNoteId, undefined);
  assert.equal(meta("M").transcriptNoteId, undefined);
  assert.equal(meta("M").transcriptNoteIds, undefined);
  assert.equal(meta("M").transcriptLinkOrigin, undefined);
  assert.deepEqual(typed("M"), []);
  assert.ok(fv.notes.has("T1"));
  assert.equal(fv.notes.get("T1")!.content, "BODY T1");
  assert.equal(meta("M").keep, "M");
});

test("a pending decision is superseded by a newer one; its original retry is then refused", async () => {
  const f = faults();
  f.failBefore.add("M");
  const first = { meetingUpdatedAt: stamp("M"), transcriptUpdatedAt: stamp("T1") };
  assert.equal((await decide(first)).status, "pending");
  meeting("M2", "ev-m2");
  assert.deepEqual(await decide({ meetingId: "M2", requestId: "r2", actor: "user:other@test.local", expectedRevision: 1 }), { status: "applied", revision: 2 });
  assert.equal(await code(decide(first)), "superseded");
  assert.equal(meta("T1").meetingNoteId, "M2");
  assert.equal(meta("M").transcriptNoteIds, undefined);
});

test("authorization is re-checked before every write: revoked after journaling → refused, row stays pending, then repairable", async () => {
  let revoked = false;
  const f = faults();
  f.onWrite = (id) => {
    if (id === "M") revoked = true; // the grant disappears while the first write is in flight
  };
  const authorize: LinkAuthorize = (_note, need) => {
    if (revoked && need === "edit") throw new TranscriptLinkError("forbidden");
  };
  const body = { authorize, meetingUpdatedAt: stamp("M"), transcriptUpdatedAt: stamp("T1") };
  assert.equal(await code(decide(body)), "forbidden");
  assert.equal(meta("T1").meetingNoteId, undefined, "the transcript was never written");
  assert.equal(journal()[0]!.state, "pending");
  assert.equal(await code(decide(body)), "forbidden", "a retry while still revoked is refused too");
  revoked = false;
  f.onWrite = null;
  assert.deepEqual(await decide(body), { status: "applied", revision: 1 });
});

// ── the worker gate ──────────────────────────────────────────────────────────

const gate = () => transcriptLinkGate("primary");
const auto = (transcriptId = "T1", meetingId = "M", eventId = "ev-m") => gate().autoLink({ transcriptId, meetingId, eventId, evidence: ["calendar-event-id"] });

test("worker and manual decisions on one transcript are serialized, and overrides are re-checked inside the lock", async () => {
  const f = faults();
  let release!: () => void;
  f.hold.set("M", new Promise<void>((r) => (release = r)));
  // The worker journals revision 1 and stalls inside its first note write…
  const worker = auto();
  await new Promise((r) => setTimeout(r, 10));
  // …while a reviewer, looking at the pre-worker state, submits an unlink.
  let settled = false;
  const manual = code(decide({ action: "unlink", requestId: "u1", expectedRevision: 1 })).finally(() => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, "the manual decision waits for the worker's critical section");
  assert.equal(meta("T1").meetingNoteId, undefined);
  release();
  assert.equal(await worker, "applied");
  assert.equal(await manual, "stale", "re-checked inside the lock against the worker's writes — never interleaved");
  assert.equal(meta("T1").meetingNoteId, "M");

  // The reverse order: a manual move is in flight, the worker queues behind it.
  meeting("M2", "ev-m2");
  let release2!: () => void;
  f.hold.set("M2", new Promise<void>((r) => (release2 = r)));
  const move = decide({ meetingId: "M2", requestId: "mv", expectedRevision: 1 });
  await new Promise((r) => setTimeout(r, 10));
  const late = auto("T1", "M", "ev-m");
  release2();
  assert.deepEqual(await move, { status: "applied", revision: 2 });
  assert.equal(await late, "skipped", "the worker sees the manual decision and never moves the transcript back");
  assert.equal(meta("T1").meetingNoteId, "M2");
  assert.deepEqual(typed("M"), []);
});

test("the worker never moves a transcript and never overrides a manual decision", async () => {
  fv.notes.get("T2")!.metadata = { ...meta("T2"), meetingNoteId: "elsewhere" };
  assert.equal(await auto("T2"), "skipped");
  await decide();
  assert.equal((await decide({ action: "unlink", requestId: "u", expectedRevision: 1 })).status, "applied");
  assert.equal(await auto("T1"), "skipped");
  assert.equal(gate().suppressed("T1", "M", null), true);
  assert.equal(gate().suppressed("T1", "other-note", "ev-m"), true, "the same calendar event is suppressed too");
  assert.equal(gate().suppressed("T2", "M", "ev-m"), false);
  assert.equal(meta("T1").meetingNoteId, undefined);
  assert.deepEqual(journal().filter((r) => r.actor === "worker"), []);
  // The unlink bars only that pair/event: a different meeting may still take it…
  meeting("M2", "ev-m2");
  assert.equal(await auto("T1", "M2", "ev-m2"), "applied");
  assert.equal(meta("T1").meetingNoteId, "M2");
  // …and a MANUAL link is never moved by the worker.
  assert.equal((await decide({ transcriptId: "T2", requestId: "keep" })).status, "applied");
  assert.equal(await auto("T2", "M2", "ev-m2"), "skipped");
  assert.equal(meta("T2").meetingNoteId, "M");
});

test("a half-written automatic link stays pending and the worker sweep completes it", async () => {
  const f = faults();
  f.failBefore.add("T1");
  assert.equal(await auto(), "pending");
  assert.equal(meta("M").transcriptLinkOrigin, "calendar-match-v1");
  assert.equal(meta("T1").meetingNoteId, undefined);
  assert.equal(await auto(), "skipped", "not journaled twice");
  assert.deepEqual(await gate().sweep(), { applied: 1, pending: 0, abandoned: 0, cleaned: 0 });
  assert.equal(meta("T1").meetingNoteId, "M");
  assert.deepEqual(journal().map((r) => [r.actor, r.state]), [["worker", "applied"]]);
  assert.deepEqual(await gate().sweep(), { applied: 0, pending: 0, abandoned: 0, cleaned: 0 });
});

test("ids are canonical: a path alias the vault would resolve, or a malformed id, is not_found and keys nothing", async () => {
  fv.put({ id: "T9", path: "alias-t9", tags: ["transcript", "team"], metadata: { title: "Roadmap review", date: "2026-10-05" } });
  fv.put({ id: "M9", path: "alias-m9", tags: ["meeting", "team"], metadata: { title: "Roadmap review", calendarEventId: "ev-9", date: "2026-10-05" } });
  assert.equal((await vaultClient("primary").getNote("ALIAS-T9")).id, "T9", "the fake vault resolves by path like the real one");
  const stamps = { meetingUpdatedAt: stamp("M"), transcriptUpdatedAt: stamp("T9") };
  assert.equal(await code(decide({ transcriptId: "alias-t9", ...stamps })), "not_found");
  assert.equal(await code(decide({ meetingId: "alias-m9", meetingUpdatedAt: stamp("M9"), transcriptUpdatedAt: stamp("T1") })), "not_found");
  const before = fv.calls.length;
  for (const bad of ["..", ".", "a/b", "vault/transcripts/T1", "x\u0000y", "", "a".repeat(200)]) {
    assert.equal(await code(decide({ transcriptId: bad, ...stamps })), "not_found", JSON.stringify(bad));
    assert.equal(await code(decide({ meetingId: bad, ...stamps })), "not_found", JSON.stringify(bad));
    assert.equal(await gate().autoLink({ transcriptId: bad, meetingId: "M", eventId: "ev-m", evidence: [] }), "skipped");
  }
  assert.equal(fv.calls.length, before, "a malformed id never reaches the vault");
  assert.deepEqual(journal(), []);
  assert.equal((db.prepare("SELECT count(*) n FROM transcript_link_state").get() as { n: number }).n, 0);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0);
  // An alias planted in editable metadata is treated as dangling, never followed.
  fv.notes.get("T9")!.metadata = { ...meta("T9"), meetingNoteId: "alias-m9" };
  assert.equal((await decide({ transcriptId: "T9", meetingUpdatedAt: stamp("M"), transcriptUpdatedAt: stamp("T9") })).status, "applied");
  assert.equal(meta("T9").meetingNoteId, "M");
  assert.equal(patches("M9").length, 0);
});

test("two transcripts linking to one meeting at the same time: CAS contention on the meeting loses nothing", async () => {
  let waiting: (() => void) | null = null;
  let arrived = 0;
  setTranscriptLinkVaultForTests((v) => ({
    getNote: (id, o) => v.getNote(id, o),
    updateNote: async (id, p) => {
      // Both decisions have read the SAME meeting revision before either writes.
      if (id === "M" && ++arrived <= 2) {
        if (arrived === 1) await new Promise<void>((r) => (waiting = r));
        else waiting?.();
      }
      return v.updateNote(id, p);
    },
  }));
  const [a, b] = await Promise.all([decide(), decide({ transcriptId: "T2", requestId: "r2" })]);
  assert.deepEqual([a.status, b.status], ["applied", "applied"]);
  assert.deepEqual([...(meta("M").transcriptNoteIds as string[])].sort(), ["T1", "T2"]);
  assert.deepEqual(typed("M"), ["T1", "T2"]);
  assert.equal(patches("M").length, 3, "one of the two meeting writes hit a 409 and was retried on a fresh read");
  assert.equal(meta("T1").meetingNoteId, "M");
  assert.equal(meta("T2").meetingNoteId, "M");
});

test("a superseded move's unfinished detach is carried into the superseding decision", async () => {
  meeting("O", "ev-o");
  await decide({ meetingId: "O", requestId: "first" });
  const f = faults();
  f.failBefore.add("O");
  assert.deepEqual(await decide({ requestId: "move", expectedRevision: 1 }), { status: "pending", revision: 2 });
  assert.equal(meta("T1").meetingNoteId, "M");
  assert.deepEqual(meta("O").transcriptNoteIds, ["T1"], "the old meeting still claims the transcript");
  // Another editor now unlinks it from M, superseding the stranded move.
  assert.deepEqual(await decide({ action: "unlink", requestId: "un", expectedRevision: 2, actor: "user:other@test.local" }), { status: "applied", revision: 3 });
  assert.equal(meta("O").transcriptNoteIds, undefined, "the stranded claim on the OLD meeting is repaired too");
  assert.equal(meta("O").transcriptNoteId, undefined);
  assert.deepEqual(typed("O"), []);
  assert.equal(meta("M").transcriptNoteIds, undefined);
  assert.equal(meta("T1").meetingNoteId, undefined);
  assert.equal((db.prepare("SELECT count(*) n FROM transcript_link_cleanups").get() as { n: number }).n, 0);
});

test("…and when the superseding actor may not edit that meeting it is left, undisclosed, for the worker sweep", async () => {
  meeting("O", "ev-o");
  await decide({ meetingId: "O", requestId: "first" });
  const f = faults();
  f.failBefore.add("O");
  assert.equal((await decide({ requestId: "move", expectedRevision: 1 })).status, "pending");
  setTranscriptLinkVaultForTests(null);
  const noAccessToO: LinkAuthorize = (note) => {
    if (note.id === "O") throw new TranscriptLinkError("not_found");
  };
  assert.deepEqual(
    await decide({ action: "unlink", requestId: "un", expectedRevision: 2, actor: "user:other@test.local", authorize: noAccessToO }),
    { status: "applied", revision: 3 },
    "no error: nothing about the unviewable meeting is disclosed",
  );
  assert.deepEqual(meta("O").transcriptNoteIds, ["T1"]);
  assert.equal(patches("O").length, 1, "the actor never wrote a meeting they cannot edit");
  assert.deepEqual(await gate().sweep(), { applied: 0, pending: 0, abandoned: 0, cleaned: 1 });
  assert.equal(meta("O").transcriptNoteIds, undefined);
  assert.deepEqual(typed("O"), []);
  assert.equal(meta("O").keep, "O");
  assert.deepEqual(await gate().sweep(), { applied: 0, pending: 0, abandoned: 0, cleaned: 0 });
  // A cleanup is dropped, not executed, if a later decision wants that meeting again.
  f.failBefore.clear();
});

test("sweep abandons a worker decision whose note is gone: no endless retry, and the transcript is not blocked", async () => {
  const f = faults();
  f.failBefore.add("T1");
  assert.equal(await auto(), "pending");
  fv.notes.delete("M");
  const written = fv.calls.filter((c) => c.method === "PATCH").length;
  // `cleaned` counts owed detaches RESOLVED; the meeting is gone, so there was nothing to write.
  assert.deepEqual(await gate().sweep(), { applied: 0, pending: 0, abandoned: 1, cleaned: 1 });
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, written);
  assert.equal(gate().state("T1"), null, "the automatic state no longer blocks autoLink");
  assert.deepEqual(journal().map((r) => r.state), ["superseded"]);
  const calls = fv.calls.length;
  assert.deepEqual(await gate().sweep(), { applied: 0, pending: 0, abandoned: 0, cleaned: 0 });
  assert.equal(fv.calls.length, calls, "nothing is retried");
  meeting("M2", "ev-m2");
  assert.equal(await auto("T1", "M2", "ev-m2"), "applied");
});

test("sweep never overwrites a backpointer edited outside the journal: it abandons and withdraws its own half", async () => {
  const f = faults();
  f.failBefore.add("T1");
  assert.equal(await auto(), "pending");
  assert.deepEqual(meta("M").transcriptNoteIds, ["T1"]);
  meeting("X", "ev-x");
  fv.notes.get("T1")!.metadata = { ...meta("T1"), meetingNoteId: "X" }; // e.g. the legacy desktop
  assert.deepEqual(await gate().sweep(), { applied: 0, pending: 0, abandoned: 1, cleaned: 1 });
  assert.equal(meta("T1").meetingNoteId, "X", "the outside edit wins");
  assert.equal(patches("T1").length, 0);
  assert.equal(meta("M").transcriptNoteIds, undefined, "the worker's half-written claim is withdrawn");
  assert.equal(gate().state("T1"), null);
});

test("a hung vault call under the lock is bounded: the decision stays pending and the transcript's lock is released", async () => {
  setTranscriptLinkTimeoutForTests(40);
  setTranscriptLinkVaultForTests((v) => ({
    getNote: (id, o) => v.getNote(id, o),
    updateNote: (id, p) => (id === "M" ? new Promise<never>(() => {}) : v.updateNote(id, p)),
  }));
  const started = Date.now();
  assert.deepEqual(await decide(), { status: "pending", revision: 1 });
  // (No duration is asserted: the dependency here NEVER answers, so finishing at all is the proof that the deadline ended it — and a wall-clock bound fails on a busy machine without anything being wrong.)
  assert.equal(journal()[0]!.state, "pending");
  // The worker is not stuck behind it.
  const worker = await Promise.race([auto(), new Promise<string>((r) => setTimeout(() => r("blocked"), 1000))]);
  assert.equal(worker, "skipped");
  setTranscriptLinkVaultForTests(null);
  assert.deepEqual(await decide(), { status: "applied", revision: 1 });
});

test("the per-pass snapshot answers exactly like the per-call lookups", async () => {
  await decide();
  await decide({ transcriptId: "T2", requestId: "r2" });
  await decide({ transcriptId: "T2", action: "unlink", requestId: "u2", expectedRevision: 1 });
  const g = gate();
  const snap = g.snapshot();
  for (const t of ["T1", "T2", "unknown"]) {
    assert.deepEqual(snap.state(t), g.state(t));
    for (const [m, e] of [["M", null], ["other", "ev-m"], ["other", "ev-zzz"], [null, null]] as const) assert.equal(snap.suppressed(t, m, e), g.suppressed(t, m, e), `${t}/${m}/${e}`);
  }
  assert.deepEqual(snap.linkedTo("M"), g.linkedTo("M"));
  assert.deepEqual(snap.linkedTo("M"), ["T1"]);
  assert.deepEqual(snap.state("T2"), { meetingId: null, origin: "manual" });
});

test("journal pruning removes only old finished decisions; state, suppressions and pending rows stay", async () => {
  await decide();
  await decide({ action: "unlink", requestId: "u1", expectedRevision: 1 });
  const f = faults();
  f.failBefore.add("M");
  assert.equal((await decide({ transcriptId: "T2", requestId: "p1" })).status, "pending");
  const old = Date.now() - 100 * 86_400_000;
  db.prepare("UPDATE transcript_link_decisions SET created_at=?, applied_at=CASE WHEN applied_at IS NULL THEN NULL ELSE ? END").run(old, old);
  assert.equal(pruneDecisions(90 * 86_400_000), 2);
  assert.deepEqual(journal().map((r) => [r.transcript_id, r.state]), [["T2", "pending"]]);
  assert.equal(gate().state("T1")!.meetingId, null);
  assert.equal(decisionCount("transcript_link_state"), 2);
  assert.equal(gate().suppressed("T1", "M", null), true);
  assert.equal(pruneDecisions(90 * 86_400_000), 0);
});

// ── calendar pass through the gate ───────────────────────────────────────────

const ev = (over: CalEvent = {}): CalEvent => ({ id: "ev-m", summary: "Roadmap review", start: { dateTime: "2026-10-05T10:00:00Z" }, end: { dateTime: "2026-10-05T11:00:00Z" }, attendees: [], ...over });
const passOpts = (over: Partial<CalendarPassOptions> = {}): CalendarPassOptions => ({ from: "2026-10-01", to: "2026-10-31", max: 250, shadow: false, deleteMode: "log", source: "worker", links: gate(), ...over });
const pass = (events: CalEvent[], over: Partial<CalendarPassOptions> = {}) =>
  syncCalendarWindow({ listEventsRange: async () => ({ events }) }, vaultClient("primary") as unknown as CalendarVault, passOpts(over));
/** Seed the meeting exactly as the ingest would have written it. */
function synced(id: string, event: CalEvent, extra: Record<string, unknown> = {}, content?: string) {
  const m = buildMeetingNote(event);
  return fv.put({ id, path: m.path, tags: ["meeting"], content: content ?? m.content, metadata: { ...m.metadata, ...extra } });
}
function fresh() {
  fv.notes.clear();
}

test("pass: two recordings carrying the exact event id are BOTH linked (plural, singular, typed link, backpointers)", async () => {
  fresh();
  synced("M", ev());
  transcript("R1", { calendarEventId: "ev-m", title: "x" });
  transcript("R2", { calendarEventId: "ev-m", title: "y" });
  transcript("OTHER", { calendarEventId: "ev-other" });
  const r = await pass([ev()]);
  assert.equal(r.transcriptLinks, 2);
  assert.deepEqual(meta("M").transcriptNoteIds, ["R1", "R2"]);
  assert.equal(meta("M").transcriptNoteId, "R1");
  assert.deepEqual(typed("M"), ["R1", "R2"]);
  assert.equal(meta("R1").meetingNoteId, "M");
  assert.equal(meta("R2").meetingNoteId, "M");
  assert.equal(meta("OTHER").meetingNoteId, undefined);
  const again = await pass([ev()]);
  assert.equal(again.transcriptLinks, 0, "idempotent: a second pass links nothing new");
  assert.equal(patches("R1").length, 1);
});

test("pass: a recurring occurrence only takes its own recording; a timezone-offset start still matches; cancelled events take nothing", async () => {
  fresh();
  const monday = ev({ id: "series_20261005T160000Z", recurringEventId: "series", originalStartTime: { dateTime: "2026-10-05T10:00:00-06:00" }, start: { dateTime: "2026-10-05T10:00:00-06:00", timeZone: "America/Denver" } });
  const tuesday = ev({ id: "series_20261006T160000Z", recurringEventId: "series", originalStartTime: { dateTime: "2026-10-06T10:00:00-06:00" }, start: { dateTime: "2026-10-06T10:00:00-06:00", timeZone: "America/Denver" }, summary: "Roadmap review" });
  const cancelled = ev({ id: "ev-cancelled", summary: "Budget chat", status: "cancelled", start: { dateTime: "2026-10-07T10:00:00Z" } });
  const planning = ev({ id: "ev-planning", summary: "Quarterly planning workshop", start: { dateTime: "2026-10-08T09:00:00-06:00", timeZone: "America/Denver" } });
  synced("MON", monday);
  synced("TUE", tuesday);
  synced("CAN", cancelled);
  synced("PLAN", planning);
  transcript("R-MON", { calendarEventId: "series_20261005T160000Z" });
  transcript("R-TUE", { calendarEventId: "series_20261006T160000Z", date: "2026-10-06" });
  transcript("R-CAN", { calendarEventId: "ev-cancelled", title: "Budget chat", date: "2026-10-07" });
  // Recorded 15:05Z = 09:05 Denver: same instant family, different offset notation.
  transcript("R-TZ", { title: "Quarterly planning workshop", date: "2026-10-08", start: "2026-10-08T15:05:00Z", attendees: [] });
  await pass([monday, tuesday, cancelled, planning]);
  assert.equal(meta("R-MON").meetingNoteId, "MON");
  assert.equal(meta("R-TUE").meetingNoteId, "TUE");
  assert.deepEqual(meta("MON").transcriptNoteIds, ["R-MON"]);
  assert.deepEqual(meta("TUE").transcriptNoteIds, ["R-TUE"]);
  assert.equal(meta("R-CAN").meetingNoteId, undefined, "a cancelled event is excluded even on an exact id");
  assert.equal(meta("CAN").transcriptNoteIds, undefined);
  assert.equal(meta("R-TZ").meetingNoteId, "PLAN");
  assert.deepEqual(meta("PLAN").transcriptLinkEvidence, ["same-date", "start-within-15m", "title-words:3"]);
});

test("pass: equal fuzzy candidates are ambiguous — a blocked intent, nothing linked, nothing journaled", async () => {
  fresh();
  synced("M", ev({ attendees: [{ displayName: "Ada Example", email: "ada@example.test" }] }));
  fv.put({ id: "ada", path: "vault/people/ada-example", tags: ["person"], metadata: { name: "Ada Example", email: "ada@example.test" } });
  transcript("one");
  transcript("two");
  const r = await pass([ev({ attendees: [{ displayName: "Ada Example", email: "ada@example.test" }] })]);
  assert.equal(r.transcriptLinks, 0);
  assert.ok(r.intents.some((i) => i.action === "link-transcript" && i.effect === "blocked" && i.reason?.includes("Ambiguous") && i.candidates?.length === 2));
  assert.equal(meta("M").transcriptNoteId, undefined);
  assert.equal(meta("one").meetingNoteId, undefined);
  assert.deepEqual(journal(), []);
});

test("pass: a manual unlink survives the following worker pass, and so does a manual link", async () => {
  fresh();
  synced("M", ev());
  synced("M2", ev({ id: "ev-m2", summary: "Hiring debrief", start: { dateTime: "2026-10-06T10:00:00Z" } }));
  transcript("R1", { calendarEventId: "ev-m" });
  transcript("R2", { calendarEventId: "ev-m" });
  await pass([ev()]);
  assert.equal(meta("R1").meetingNoteId, "M");
  // Reviewer: R1 is not this meeting; R2 actually belongs to the hiring debrief.
  assert.equal((await decide({ transcriptId: "R1", action: "unlink", requestId: "u1", expectedRevision: 1 })).status, "applied");
  assert.equal((await decide({ transcriptId: "R2", meetingId: "M2", requestId: "mv", expectedRevision: 1 })).status, "applied");
  const events = [ev(), ev({ id: "ev-m2", summary: "Hiring debrief", start: { dateTime: "2026-10-06T10:00:00Z" } })];
  for (let i = 0; i < 2; i++) {
    const r = await pass(events);
    assert.equal(r.transcriptLinks, 0);
    assert.equal(meta("R1").meetingNoteId, undefined, "the worker does not relink a manually unlinked recording");
    assert.equal(meta("R2").meetingNoteId, "M2", "the worker does not pull a manually moved recording back");
    assert.equal(meta("M").transcriptNoteIds, undefined);
    assert.deepEqual(typed("M"), []);
    assert.deepEqual(meta("M2").transcriptNoteIds, ["R2"]);
  }
});

test("pass: a half-written legacy pair is completed only when the matcher agrees; editable metadata alone is no authority", async () => {
  fresh();
  synced("M", ev(), { transcriptNoteId: "HALF", transcriptLinkOrigin: "calendar-match-v1" });
  transcript("HALF", { calendarEventId: "ev-m" });
  synced("N", ev({ id: "ev-n", summary: "Unrelated standup", start: { dateTime: "2026-10-09T10:00:00Z" } }), { transcriptNoteId: "FOREIGN" });
  transcript("FOREIGN", { title: "Something else entirely", date: "2026-03-01", attendees: [] });
  await pass([ev(), ev({ id: "ev-n", summary: "Unrelated standup", start: { dateTime: "2026-10-09T10:00:00Z" } })]);
  assert.equal(meta("HALF").meetingNoteId, "M");
  assert.deepEqual(meta("M").transcriptNoteIds, ["HALF"]);
  assert.equal(meta("FOREIGN").meetingNoteId, undefined, "a meeting's own claim never writes an unrelated transcript");
  assert.equal(patches("FOREIGN").length, 0);
});

test("retention: a template-only meeting with ANY transcript link form is never deleted", async () => {
  fresh();
  const gone = (id: string) => ev({ id: `gone-${id}`, summary: `Gone ${id}` });
  synced("singular", gone("singular"), { transcriptNoteId: "t" });
  synced("plural", gone("plural"), { transcriptNoteIds: ["t"] });
  const typedOnly = synced("typed", gone("typed"));
  typedOnly.links = [{ sourceId: "typed", targetId: "t", relationship: "has-transcript" }];
  synced("backpointer", gone("backpointer"));
  transcript("bp", { meetingNoteId: "backpointer" });
  synced("journal", gone("journal"));
  transcript("j");
  db.prepare("INSERT INTO transcript_link_state VALUES ('primary', ?, 'j', 1, 'journal', 'manual', 0)").run(JSON.stringify(["http://vault.test", "default"]));
  synced("bare", gone("bare"));

  const listsBefore = fv.calls.filter((c) => c.method === "GET" && c.search.includes("tag=transcript")).length;
  const r = await pass([], { deleteMode: "delete" });
  assert.equal(fv.calls.filter((c) => c.method === "GET" && c.search.includes("tag=transcript")).length - listsBefore, 1, "reconcile reuses the pass's one transcript listing");
  assert.equal(r.reconcile.deleted, 1);
  assert.equal(r.reconcile.cancelled, 5);
  assert.equal(fv.notes.has("bare"), false, "control: a template-only meeting with no link at all is deleted");
  for (const id of ["singular", "plural", "typed", "backpointer", "journal"]) {
    assert.ok(fv.notes.has(id), `${id} kept`);
    assert.equal(meta(id).event_status, "cancelled");
  }
});
