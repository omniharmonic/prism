/**
 * Fireflies transcript ingester + self-cleaner (Phase 3) — note shape, the
 * ingest/delete decision loop (delay-one-cycle), budget + per-run caps, and the
 * un-deletable skip-set, all with a fake client + fake vault (no live API). The
 * live path is exercised by the on-demand /api/integrations/fireflies/sync route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateOf,
  attendeesOf,
  sentencesToText,
  firefliesNote,
  ingestAndCleanupFireflies,
  isRateLimited,
  isIngestConfirmed,
  isSupersededByConfirmedNote,
  transcriptBodyLength,
  FirefliesError,
  type FirefliesTranscript,
  type FirefliesDetail,
  type FirefliesBudget,
  type FirefliesVault,
} from "../src/worker/fireflies";
import type { Note } from "../src/parachute";

/** The email owning the API key in these tests. */
const ME = "me@example.com";

/** A vault note as the ingester writes it. `body` fills the ## Transcript section. */
function noteWith(opts: { id?: string; sourceId?: string; source?: string; body?: string; summaryOnly?: boolean }): Note {
  const body = opts.body ?? "x".repeat(500);
  const content = opts.summaryOnly
    ? `---\nsource: fireflies\n---\n\n## Summary\n\nsome summary\n`
    : `---\nsource: fireflies\n---\n\n## Summary\n\ns\n\n## Transcript\n\n${body}\n`;
  return {
    id: opts.id ?? "note1",
    content,
    path: null,
    metadata: { source: opts.source ?? "fireflies", source_id: opts.sourceId ?? "t1" },
    tags: ["transcript", "fireflies"],
    createdAt: "",
    updatedAt: "",
  };
}

// ── pure map/parse ──

test("dateOf formats epoch-ms as UTC YYYY-MM-DD", () => {
  assert.equal(dateOf({ id: "x", date: Date.UTC(2026, 5, 24, 20, 44) }), "2026-06-24");
  assert.equal(dateOf({ id: "x" }), "");
});

test("attendeesOf prefers displayName, falls back to email, drops empties", () => {
  assert.deepEqual(
    attendeesOf({ id: "x", meeting_attendees: [{ displayName: "Alice" }, { email: "bob@x" }, { displayName: "", email: "" }] }),
    ["Alice", "bob@x"],
  );
  assert.deepEqual(attendeesOf({ id: "x" }), []);
});

test("sentencesToText formats **speaker**: text and skips empties", () => {
  const d: FirefliesDetail = { sentences: [{ speaker_name: "Alice", text: "hi" }, { text: "" }, { text: "yo" }] };
  assert.equal(sentencesToText(d), "**Alice**: hi\n\n**Speaker**: yo");
  assert.equal(sentencesToText({}), "");
});

test("firefliesNote matches the desktop note shape", () => {
  const t: FirefliesTranscript = {
    id: "01ABC",
    title: "Parachute Team Meet",
    date: Date.UTC(2026, 6, 1),
    transcript_url: "https://app.fireflies.ai/view/01ABC",
    meeting_attendees: [{ displayName: "Alice" }, { email: "bob@x" }],
  };
  const n = firefliesNote(t, { summary: { overview: "the summary" }, sentences: [{ speaker_name: "Alice", text: "hi" }] });
  assert.ok(n);
  assert.deepEqual(n!.tags, ["transcript", "fireflies"]);
  assert.equal(n!.path, "vault/_inbox/transcripts/fireflies/2026-07-01-parachute-team-meet");
  assert.equal(n!.metadata.source, "fireflies");
  assert.equal(n!.metadata.source_id, "01ABC");
  assert.deepEqual(n!.metadata.attendees, ["Alice", "bob@x"]);
  assert.match(n!.content, /## Summary\n\nthe summary/);
  assert.match(n!.content, /## Transcript\n\n\*\*Alice\*\*: hi/);
  assert.match(n!.content, /transcript_id: "01ABC"/);
});

test("firefliesNote returns null when there's no summary AND no transcript", () => {
  assert.equal(firefliesNote({ id: "x", date: 0 }, {}), null);
});

test("isRateLimited recognizes 429 and the GraphQL phrasing", () => {
  assert.equal(isRateLimited(new FirefliesError("http 429", 429)), true);
  assert.equal(isRateLimited(new Error("Too many requests, retry after 00:00 UTC")), true);
  assert.equal(isRateLimited(new Error("not authorized")), false);
});

// ── loop ──

function fakeVault(seed: Note[] = []) {
  const creates: Array<{ metadata?: Record<string, unknown> }> = [];
  const updates = new Map<string, Record<string, unknown>>();
  const byId = new Map(seed.map((n) => [n.id, n]));
  const vault: FirefliesVault = {
    async listNotes() {
      return seed;
    },
    async getNote(id) {
      const n = byId.get(id);
      if (!n) throw new Error("not found");
      return n;
    },
    async createNote(p) {
      creates.push(p);
      const n: Note = { id: `n${creates.length}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
      byId.set(n.id, n);
      return n;
    },
    async updateNote(id, p) {
      updates.set(id, { ...(updates.get(id) ?? {}), ...(p.metadata ?? {}) });
      return { id, content: "", path: null, metadata: null, tags: null, createdAt: "", updatedAt: "" };
    },
  };
  return { vault, creates, updates };
}

const noSleep = async () => {};
const bigBudget = (): FirefliesBudget => {
  let spent = 0;
  return { remaining: () => 1000 - spent, spend: (n) => (spent += n) };
};
const detailFor = (): FirefliesDetail => ({ summary: { overview: "sum" }, sentences: [{ speaker_name: "A", text: "t" }] });

/** Fake client recording delete calls; getTranscript returns a real detail. */
function fakeClient(list: FirefliesTranscript[], opts: { denyDelete?: Set<string>; empty?: Set<string> } = {}) {
  const deleted: string[] = [];
  const fetched: string[] = [];
  const uploaded: string[] = [];
  return {
    deleted,
    fetched,
    uploaded,
    client: {
      listTranscripts: async () => list,
      getTranscript: async (id: string) => {
        fetched.push(id);
        return opts.empty?.has(id) ? ({} as FirefliesDetail) : detailFor();
      },
      deleteTranscript: async (id: string) => {
        if (opts.denyDelete?.has(id)) throw new FirefliesError("not authorized to delete", 200);
        deleted.push(id);
      },
      uploadAudio: async (_url: string, _title: string, ref?: string) => {
        uploaded.push(ref ?? "");
        return true;
      },
    },
  };
}

// ── the delete safety gate (the ironclad part) ──

test("transcriptBodyLength measures only the ## Transcript section", () => {
  assert.equal(transcriptBodyLength("## Summary\n\nhello there"), 0);
  assert.equal(transcriptBodyLength("## Summary\n\ns\n\n## Transcript\n\nabc def"), 7);
  assert.equal(transcriptBodyLength("## Transcript\n\n   \n  "), 0);
});

test("isIngestConfirmed requires source=fireflies, exact id, and a real body", () => {
  const good = noteWith({ sourceId: "t1" });
  assert.equal(isIngestConfirmed(good, "t1"), true);

  // missing note
  assert.equal(isIngestConfirmed(null, "t1"), false);
  // id mismatch
  assert.equal(isIngestConfirmed(good, "OTHER"), false);
  // wrong source (cross-source id collision)
  assert.equal(isIngestConfirmed(noteWith({ sourceId: "t1", source: "fathom" }), "t1"), false);
  // summary-only → body never copied → MUST NOT authorize a delete
  assert.equal(isIngestConfirmed(noteWith({ sourceId: "t1", summaryOnly: true }), "t1"), false);
  // body too short, and no recorded source size to compare against
  assert.equal(isIngestConfirmed(noteWith({ sourceId: "t1", body: "tiny" }), "t1"), false);
});

test("body sufficiency is judged against the SOURCE's verbatim size, not a blanket floor", () => {
  // A genuinely short meeting (152 chars of speech) that we captured IN FULL is
  // deletable — a hard 200-char floor would strand it on Fireflies forever.
  const short = noteWith({ sourceId: "t1", body: "x".repeat(152) });
  short.metadata!.fireflies_verbatim_chars = 152;
  assert.equal(isIngestConfirmed(short, "t1"), true);

  // A truncated copy (source had 5000, we hold 152) is NOT confirmed.
  const truncated = noteWith({ sourceId: "t1", body: "x".repeat(152) });
  truncated.metadata!.fireflies_verbatim_chars = 5000;
  assert.equal(isIngestConfirmed(truncated, "t1"), false);

  // Source had zero verbatim → nothing was ingested → never delete, whatever the body.
  const empty = noteWith({ sourceId: "t1", body: "x".repeat(999) });
  empty.metadata!.fireflies_verbatim_chars = 0;
  assert.equal(isIngestConfirmed(empty, "t1"), false);

  // Legacy note from the old cleanup agent: verbatim_chars is a ROUNDED estimate
  // (53500) slightly above the real body (52118). Must still confirm.
  const legacy = noteWith({ sourceId: "t1", body: "x".repeat(52118) });
  legacy.metadata!.fireflies_verbatim_chars = 53500;
  assert.equal(isIngestConfirmed(legacy, "t1"), true);
});

test("transcriptBodyLength matches the verbatim string we wrote (multi-line, not collapsed)", () => {
  const transcript = "**A**: hello\n\n**B**: hi there";
  const n = firefliesNote({ id: "t1", date: 0 }, { sentences: [{ speaker_name: "A", text: "hello" }, { speaker_name: "B", text: "hi there" }] })!;
  assert.equal(n.metadata.fireflies_verbatim_chars, transcript.length);
  // The note it produced must confirm against its own recorded size.
  const asNote: Note = { id: "x", content: n.content, path: null, metadata: n.metadata, tags: null, createdAt: "", updatedAt: "" };
  assert.equal(transcriptBodyLength(n.content), transcript.length);
  assert.equal(isIngestConfirmed(asNote, "t1"), true, "our own ingest must satisfy our own delete gate");
});

test("a path_conflict retries with a unique path and never aborts the run", async () => {
  const fv = fakeVault([]);
  let attempts = 0;
  const orig = fv.vault.createNote.bind(fv.vault);
  fv.vault.createNote = async (p) => {
    attempts++;
    if (attempts === 1) throw new Error('POST /notes: 409 path_conflict');
    return orig(p);
  };
  const fc = fakeClient([{ id: "t1", title: "Dup", date: 0 }, { id: "t2", title: "Next", date: 0 }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget: bigBudget(), sleep: noSleep });
  assert.equal(res.created, 2, "conflict retried, and the second transcript still ingested");
});

test("firefliesNote records the source's verbatim length for the delete gate", () => {
  const n = firefliesNote(
    { id: "t1", title: "M", date: 0 },
    { summary: { overview: "s" }, sentences: [{ speaker_name: "A", text: "hello" }] },
  );
  assert.equal(n!.metadata.fireflies_verbatim_chars, "**A**: hello".length);
});

test("SUMMARY-ONLY note never authorizes a delete (data-loss guard)", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1", summaryOnly: true })]);
  const fc = fakeClient([{ id: "t1", title: "M", date: 0 }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget: bigBudget(), sleep: noSleep, deleteEnabled: true });
  assert.deepEqual(fc.deleted, [], "must NOT delete a transcript whose body isn't in the vault");
  assert.equal(res.deleted, 0);
  assert.equal(res.unverified, 1);
});

test("a note from ANOTHER source with a colliding source_id never authorizes a delete", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1", source: "fathom" })]);
  const fc = fakeClient([{ id: "t1", title: "M", date: 0 }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget: bigBudget(), sleep: noSleep, deleteEnabled: true });
  assert.deepEqual(fc.deleted, []);
  // Not a fireflies note → treated as new → safely ingested instead.
  assert.equal(res.created, 1);
});

test("deleteEnabled defaults to FALSE — a confirmed transcript is only a dry-run would-delete", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1" })]);
  const fc = fakeClient([{ id: "t1", title: "M", date: 0, host_email: ME }]);
  const budget = bigBudget();
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget, sleep: noSleep, ownerEmail: ME });
  assert.deepEqual(fc.deleted, [], "dry run must not call the API");
  assert.equal(res.wouldDelete, 1);
  assert.equal(res.deleted, 0);
  assert.equal(budget.remaining(), 999, "dry run spends no budget beyond the list call");
});

// ── loop ──

test("NEW transcript is ingested but NOT deleted this run (delay one cycle)", async () => {
  const fv = fakeVault([]);
  const fc = fakeClient([{ id: "t1", title: "M", date: 0 }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget: bigBudget(), sleep: noSleep, deleteEnabled: true });
  assert.equal(res.created, 1);
  assert.equal(res.deleted, 0);
  assert.deepEqual(fc.deleted, [], "a freshly ingested transcript is never deleted in the same run");
  assert.equal(fv.creates[0]!.metadata?.source_id, "t1");
});

test("confirmed already-in-vault transcript IS deleted (and not re-ingested)", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1" })]);
  const fc = fakeClient([{ id: "t1", title: "M", date: 0, host_email: ME }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: ME });
  assert.equal(res.created, 0);
  assert.equal(res.deleted, 1);
  assert.deepEqual(fc.deleted, ["t1"]);
  assert.equal(fc.fetched.length, 0); // no detail fetch for an already-ingested one
});

test("delete API failure → skip-set, not retried, counted skipped", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1" })]);
  const fc = fakeClient([{ id: "t1", date: 0, host_email: ME }], { denyDelete: new Set(["t1"]) });
  const skipSet = new Set<string>();
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget: bigBudget(), sleep: noSleep, skipSet, deleteEnabled: true, ownerEmail: ME });
  assert.equal(res.deleted, 0);
  assert.equal(res.skipped, 1);
  assert.ok(skipSet.has("t1"));

  // Second pass: it's in the skip-set → no delete attempt at all.
  const fc2 = fakeClient([{ id: "t1", date: 0, host_email: ME }], { denyDelete: new Set(["t1"]) });
  const budget = bigBudget();
  await ingestAndCleanupFireflies(fc2.client, fv.vault, { budget, sleep: noSleep, skipSet, deleteEnabled: true, ownerEmail: ME });
  assert.deepEqual(fc2.deleted, []);
  // Only the list call was spent (no per-item delete attempt).
  assert.equal(budget.remaining(), 999);
});

test("daily budget hard-caps total Fireflies calls", async () => {
  const fv = fakeVault([]);
  const list: FirefliesTranscript[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, date: 0 }));
  const fc = fakeClient(list);
  // budget 3 = 1 list + 2 detail fetches, then stop.
  let spent = 0;
  const budget: FirefliesBudget = { remaining: () => 3 - spent, spend: (n) => (spent += n) };
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget, sleep: noSleep, deleteEnabled: true });
  assert.equal(res.created, 2);
  assert.equal(fc.fetched.length, 2);
});

test("maxNewPerRun caps ingests; maxDeletePerRun caps deletes", async () => {
  // 4 new + 4 already-ingested (all confirmed) in one list.
  const newOnes: FirefliesTranscript[] = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, date: 0, host_email: ME }));
  const oldOnes: FirefliesTranscript[] = Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, date: 0, host_email: ME }));
  const seed: Note[] = oldOnes.map((t, i) => noteWith({ id: `e${i}`, sourceId: t.id }));
  const fv = fakeVault(seed);
  const fc = fakeClient([...newOnes, ...oldOnes]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(),
    sleep: noSleep,
    deleteEnabled: true,
    ownerEmail: ME,
    maxNewPerRun: 2,
    maxDeletePerRun: 3,
  });
  assert.equal(res.created, 2);
  assert.equal(res.deleted, 3);
});

test("rate-limit on the list call ends the run quietly (no throw)", async () => {
  const fv = fakeVault([]);
  const client = {
    listTranscripts: async () => {
      throw new FirefliesError("too many requests", 429);
    },
    getTranscript: async () => detailFor(),
    deleteTranscript: async () => {},
  };
  const res = await ingestAndCleanupFireflies(client, fv.vault, { budget: bigBudget(), sleep: noSleep });
  assert.deepEqual(res, { created: 0, deleted: 0, wouldDelete: 0, unverified: 0, notOwner: 0, falseDeletes: 0, recovered: 0, skipped: 0 });
});

// ── ownership + false-delete self-healing (the bug that wedged the old pruner) ──

test("a meeting owned by SOMEONE ELSE is never deleted (deleteTranscript silently no-ops)", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1" })]);
  const fc = fakeClient([{ id: "t1", title: "Their Meeting", date: 0, organizer_email: "aaron@other.org" }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: ME,
  });
  assert.deepEqual(fc.deleted, [], "must never call deleteTranscript on a meeting we don't own");
  assert.equal(res.notOwner, 1);
  assert.equal(res.deleted, 0);
});

test("a DRY RUN reports someone else's meeting as not-owner, never as would-delete", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1" })]);
  const fc = fakeClient([{ id: "t1", title: "Theirs", date: 0, organizer_email: "aaron@other.org" }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, ownerEmail: ME, // deleteEnabled omitted → dry run
  });
  assert.equal(res.notOwner, 1);
  assert.equal(res.wouldDelete, 0, "a dry run must not promise a delete that could never happen");
  assert.equal(fv.updates.size, 0, "a dry run writes nothing");
});

test("a meeting you DO own, confirmed in vault, is deleted and marked", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1" })]);
  const fc = fakeClient([{ id: "t1", title: "Mine", date: 0, host_email: ME }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: ME,
  });
  assert.deepEqual(fc.deleted, ["t1"]);
  assert.equal(res.deleted, 1);
  assert.equal(fv.updates.get("e1")?.fireflies_delete_status, "deleted");
});

test("unknown owner email fails CLOSED — no deletes attempted", async () => {
  const fv = fakeVault([noteWith({ id: "e1", sourceId: "t1" })]);
  const fc = fakeClient([{ id: "t1", title: "Mine", date: 0, host_email: ME }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: "",
  });
  assert.deepEqual(fc.deleted, [], "cannot establish identity → never delete");
  assert.equal(res.notOwner, 1);
});

test("FALSE DELETE self-heals: note says deleted but transcript is still live → relabel blocked", async () => {
  const stale = noteWith({ id: "e1", sourceId: "t1" });
  stale.metadata!.fireflies_delete_status = "deleted";
  stale.metadata!.fireflies_deleted_at = "2026-07-09T01:01:43Z";
  const fv = fakeVault([stale]);
  const fc = fakeClient([{ id: "t1", title: "Zombie", date: 0, host_email: ME }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: ME,
  });
  assert.equal(res.falseDeletes, 1);
  assert.deepEqual(fc.deleted, [], "do not blindly re-delete; record the truth first");
  const m = fv.updates.get("e1")!;
  assert.equal(m.fireflies_delete_status, "blocked");
  assert.equal(m.fireflies_deleted_at, null);
  assert.match(String(m.fireflies_block_reason), /still listed/);
});

// ── recovery of empty transcripts (never deletion) ──

test("an EMPTY transcript with audio is RECOVERED (audio re-submitted), never deleted", async () => {
  const fv = fakeVault([]);
  const fc = fakeClient([{ id: "t1", title: "Empty", date: 0, host_email: ME, audio_url: "https://cdn/a.mp3" }], { empty: new Set(["t1"]) });
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: ME, recoverEmptySources: true,
  });
  assert.equal(res.recovered, 1);
  assert.deepEqual(fc.uploaded, ["reprocess-t1"]);
  assert.deepEqual(fc.deleted, [], "an un-ingested recording is never deleted — it is recovered");
  // A stub was written, recording zero verbatim so the delete gate stays closed.
  assert.equal(fv.creates[0]!.metadata?.fireflies_verbatim_chars, 0);
  assert.equal(fv.creates[0]!.metadata?.fireflies_status, "empty-source-recovered");
});

test("recovery happens ONCE — the stub makes the next run take the (refusing) delete path", async () => {
  const stub: Note = {
    id: "s1", content: "---\n---\n\n## Summary\n\nempty\n", path: null,
    metadata: { source: "fireflies", source_id: "t1", fireflies_verbatim_chars: 0, fireflies_status: "empty-source-recovered" },
    tags: ["transcript", "fireflies"], createdAt: "", updatedAt: "",
  };
  const fv = fakeVault([stub]);
  const fc = fakeClient([{ id: "t1", title: "Empty", date: 0, host_email: ME, audio_url: "https://cdn/a.mp3" }], { empty: new Set(["t1"]) });
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: ME, recoverEmptySources: true,
  });
  assert.deepEqual(fc.uploaded, [], "must not re-upload a recording we already recovered");
  assert.deepEqual(fc.deleted, [], "zero verbatim → gate stays closed");
  assert.equal(res.unverified, 1);
});

test("recovery is skipped for a meeting we don't own, and when disabled", async () => {
  const theirs = fakeClient([{ id: "t1", title: "Theirs", date: 0, organizer_email: "x@y.z", audio_url: "https://cdn/a.mp3" }], { empty: new Set(["t1"]) });
  const r1 = await ingestAndCleanupFireflies(theirs.client, fakeVault([]).vault, {
    budget: bigBudget(), sleep: noSleep, ownerEmail: ME, recoverEmptySources: true,
  });
  assert.deepEqual(theirs.uploaded, []);
  assert.equal(r1.recovered, 0);

  const off = fakeClient([{ id: "t2", title: "Mine", date: 0, host_email: ME, audio_url: "https://cdn/a.mp3" }], { empty: new Set(["t2"]) });
  const r2 = await ingestAndCleanupFireflies(off.client, fakeVault([]).vault, {
    budget: bigBudget(), sleep: noSleep, ownerEmail: ME, recoverEmptySources: false,
  });
  assert.deepEqual(off.uploaded, []);
  assert.equal(r2.recovered, 0);
});

test("an empty original is deleted ONLY once its recovered replacement is confirmed stored", async () => {
  const replacement = noteWith({ id: "rep", sourceId: "t2" }); // full body, passes the gate
  const stub: Note = {
    id: "s1", content: "---\n---\n\n## Summary\n\nempty\n", path: null,
    metadata: { source: "fireflies", source_id: "t1", fireflies_verbatim_chars: 0, fireflies_status: "empty-source-recovered", fireflies_superseded_by_note: "rep" },
    tags: ["transcript", "fireflies"], createdAt: "", updatedAt: "",
  };
  const fv = fakeVault([stub, replacement]);
  const fc = fakeClient([{ id: "t1", title: "Empty", date: 0, host_email: ME, audio_url: "https://cdn/a.mp3" }], { empty: new Set(["t1"]) });
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, {
    budget: bigBudget(), sleep: noSleep, deleteEnabled: true, ownerEmail: ME, recoverEmptySources: true,
  });
  assert.deepEqual(fc.deleted, ["t1"], "content was recovered and confirmed → the empty original may go");
  assert.equal(res.deleted, 1);
  assert.deepEqual(fc.uploaded, [], "already recovered — never re-upload");
});

test("supersede fails CLOSED at every broken link", async () => {
  const mkStub = (meta: Record<string, unknown>): Note => ({
    id: "s1", content: "x", path: null,
    metadata: { source: "fireflies", source_id: "t1", fireflies_verbatim_chars: 0, ...meta },
    tags: [], createdAt: "", updatedAt: "",
  });
  const good = noteWith({ id: "rep", sourceId: "t2" });
  const vault = fakeVault([good]).vault;

  // not a stub
  assert.equal(await isSupersededByConfirmedNote(noteWith({ id: "n", sourceId: "t1" }), vault), false);
  // stub with no replacement named
  assert.equal(await isSupersededByConfirmedNote(mkStub({ fireflies_status: "empty-source-recovered" }), vault), false);
  // stub naming a note that doesn't exist
  assert.equal(await isSupersededByConfirmedNote(mkStub({ fireflies_status: "empty-source-recovered", fireflies_superseded_by_note: "ghost" }), vault), false);
  // stub naming a real, confirmed replacement → authorized
  assert.equal(await isSupersededByConfirmedNote(mkStub({ fireflies_status: "empty-source-recovered", fireflies_superseded_by_note: "rep" }), vault), true);

  // replacement exists but is itself summary-only → NOT confirmed → keep original
  const weak = noteWith({ id: "weak", sourceId: "t3", summaryOnly: true });
  const v2 = fakeVault([weak]).vault;
  assert.equal(await isSupersededByConfirmedNote(mkStub({ fireflies_status: "empty-source-recovered", fireflies_superseded_by_note: "weak" }), v2), false);
});

test("an unreadable vault note never authorizes a delete", async () => {
  // listNotes advertises a candidate note id that getNote can't read.
  const ghost = noteWith({ id: "missing", sourceId: "t1" });
  const fv = fakeVault([ghost]);
  fv.vault.getNote = async () => {
    throw new Error("vault unavailable");
  };
  const fc = fakeClient([{ id: "t1", date: 0 }]);
  const res = await ingestAndCleanupFireflies(fc.client, fv.vault, { budget: bigBudget(), sleep: noSleep, deleteEnabled: true });
  assert.deepEqual(fc.deleted, [], "unreadable proof → no delete");
  assert.equal(res.unverified, 1);
});
