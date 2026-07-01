/**
 * Fathom transcript ingester (Phase 3) — summary/transcript parsing, note shape,
 * and dedup-by-source_id, with a fake client + fake vault (no API). Live API path
 * is exercised by scripts/verify-fathom-ingest.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSummary,
  parseTranscript,
  fathomNote,
  ingestFathom,
  recordingIdOf,
  type FathomMeeting,
} from "../src/worker/fathom";
import type { IngestVault } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

test("parseSummary tolerates the several Fathom response shapes", () => {
  assert.equal(parseSummary({ markdown: "# A" }), "# A");
  assert.equal(parseSummary({ summary: { markdown_formatted: "B" } }), "B");
  assert.equal(parseSummary({ summary: { markdown: "C" } }), "C");
  assert.equal(parseSummary({ content: "D" }), "D");
  assert.equal(parseSummary(null), "");
  assert.equal(parseSummary({ nope: 1 }), "");
});

test("parseTranscript formats segments as **speaker**: text", () => {
  const t = parseTranscript({ transcript: [{ speaker_display_name: "Alice", text: "hi" }, { speaker: "Bob", text: "yo" }, { text: "" }] });
  assert.equal(t, "**Alice**: hi\n\n**Bob**: yo");
  assert.equal(parseTranscript({ items: [{ speaker: "X", text: "hey" }] }), "**X**: hey");
  assert.equal(parseTranscript(null), "");
});

test("recordingIdOf handles number or string ids and falls back to id", () => {
  assert.equal(recordingIdOf({ recording_id: 123 }), "123");
  assert.equal(recordingIdOf({ recording_id: "abc" }), "abc");
  assert.equal(recordingIdOf({ id: 55 }), "55");
  assert.equal(recordingIdOf({}), "");
});

test("fathomNote matches the desktop note shape", () => {
  const m: FathomMeeting = { recording_id: "r1", title: "Weekly Sync", scheduled_start_time: "2026-06-01T10:00:00Z", share_url: "https://f/r1", calendar_invitees: [{ name: "Alice" }, { email: "bob@x" }] };
  const n = fathomNote(m, "the summary", "**Alice**: hi");
  assert.deepEqual(n.tags, ["transcript", "fathom"]);
  assert.equal(n.path, "vault/_inbox/transcripts/fathom/2026-06-01-weekly-sync");
  assert.equal(n.metadata.source, "fathom");
  assert.equal(n.metadata.source_id, "r1");
  assert.deepEqual(n.metadata.attendees, ["Alice", "bob@x"]);
  assert.match(n.content, /## Summary\n\nthe summary/);
  assert.match(n.content, /## Transcript\n\n\*\*Alice\*\*: hi/);
  assert.match(n.content, /recording_id: "r1"/);
});

function fakeVault(seed: Note[] = []) {
  const creates: Array<{ metadata?: Record<string, unknown> }> = [];
  const vault: IngestVault = {
    async listNotes() {
      return seed;
    },
    async createNote(p) {
      creates.push(p);
      return { id: `n${creates.length}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
    },
    async updateNote(id) {
      return { id, content: "", path: null, metadata: null, tags: null, createdAt: "", updatedAt: "" };
    },
  };
  return { vault, creates };
}

const client = (meetings: FathomMeeting[]) => ({
  listMeetings: async () => meetings,
  summary: async (_id: string) => "sum",
  transcript: async (_id: string) => "**A**: t",
});

test("ingestFathom creates a note for a new recording", async () => {
  const fv = fakeVault([]);
  const res = await ingestFathom(client([{ recording_id: "r1", title: "M" }]), fv.vault);
  assert.equal(res.created, 1);
  assert.equal(res.skipped, 0);
  assert.equal(fv.creates[0]!.metadata?.source_id, "r1");
});

test("ingestFathom SKIPS a recording already ingested (dedup by source_id)", async () => {
  const existing: Note = { id: "e1", content: "", path: null, metadata: { source_id: "r1" }, tags: ["transcript"], createdAt: "", updatedAt: "" };
  const fv = fakeVault([existing]);
  const res = await ingestFathom(client([{ recording_id: "r1", title: "M" }]), fv.vault);
  assert.equal(res.created, 0);
  assert.equal(res.skipped, 1);
});

test("ingestFathom skips a recording with no summary AND no transcript", async () => {
  const fv = fakeVault([]);
  const empty = { listMeetings: async () => [{ recording_id: "r9" }], summary: async () => "", transcript: async () => "" };
  const res = await ingestFathom(empty, fv.vault);
  assert.equal(res.created, 0);
  assert.equal(res.skipped, 1);
});
