import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "../src/parachute";
import { buildMeetingNote } from "../src/worker/calendar";
import { matchTranscript, matchTranscripts, meetingFromNote, score } from "../src/worker/transcript-match";

const meeting = (id = "event-a", start = "2026-10-05T10:00:00Z", title = "Roadmap review") => buildMeetingNote({ id, summary: title, start: { dateTime: start }, attendees: [{ displayName: "Ada Example", email: "ada@example.test" }] });
const transcript = (id: string, metadata: Record<string, unknown> = {}): Note => ({ id, path: id, content: "", tags: ["transcript"], metadata: { date: "2026-10-05", title: "Roadmap review", attendees: ["Ada Example"], ...metadata }, createdAt: "", updatedAt: "" });

test("a nearer recording wins regardless of incoming list order", () => {
  const m = meeting();
  const distant = transcript("distant", { start: "2026-10-05T13:00:00Z" });
  const close = transcript("close", { start: "2026-10-05T10:03:00Z" });
  for (const list of [[distant, close], [close, distant]]) {
    const match = matchTranscript(m, list, [m]);
    assert.equal(match.status, "matched");
    assert.equal(match.candidates[0]!.noteId, "close");
    assert.ok(match.candidates[0]!.evidence.includes("start-within-15m"));
  }
});

test("equal recordings or equal competing events require review", () => {
  const m = meeting();
  assert.equal(matchTranscript(m, [transcript("one"), transcript("two")], [m]).status, "ambiguous");
  assert.equal(matchTranscript(m, [transcript("one")], [m, meeting("event-b")]).status, "ambiguous");
});

test("a recording cannot be claimed by the first event when another occurrence is closer", () => {
  const first = meeting("first", "2026-10-05T08:00:00Z"), second = meeting("second");
  const recording = transcript("recording", { start: "2026-10-05T10:02:00Z" });
  assert.equal(matchTranscript(first, [recording], [first, second]).status, "ambiguous");
  assert.equal(matchTranscript(second, [recording], [first, second]).status, "matched");
});

test("exact occurrence IDs beat fuzzy titles and conflicting IDs never fuzzy-match", () => {
  const m = meeting();
  const exact = transcript("exact", { calendarEventId: m.eventId, title: "Different title", date: "2026-10-04" });
  const wrong = transcript("wrong", { calendarEventId: "event-b", start: "2026-10-05T10:00:00Z" });
  const result = matchTranscript(m, [wrong, exact], [m, meeting("event-b")]);
  assert.equal(result.status, "matched"); assert.equal(result.candidates[0]!.noteId, "exact");
  assert.equal(matchTranscript(m, [wrong], [m]).status, "none");
});

test("email domains and whole names matter; repeated words/attendees cannot inflate confidence", () => {
  const m = meeting("one", "2026-10-05T10:00:00Z", "Call");
  assert.equal(matchTranscript(m, [transcript("wrong-domain", { title: "Call", attendees: ["ada@different.test"] })], [m]).status, "none");
  assert.equal(matchTranscript(m, [transcript("partial-name", { title: "Call", attendees: ["Ada", "Ada", "Ada"] })], [m]).status, "none");
  assert.equal(matchTranscript(m, [transcript("exact-email", { title: "Call", attendees: [], attendeeEmails: ["ADA@example.test"] })], [m]).status, "matched");
});

test("claimed recordings, invalid dates and cancelled occurrences are not reassigned", () => {
  const m = meeting();
  assert.equal(matchTranscript(m, [transcript("claimed", { meetingNoteId: "manual-choice" })], [m]).status, "none");
  assert.equal(matchTranscript(m, [transcript("bad-date", { date: "2026-02-30" })], [m]).status, "none");
  m.metadata.event_status = "cancelled";
  assert.equal(matchTranscript(m, [transcript("cancelled", { calendarEventId: m.eventId })], [m]).status, "none");
});

test("recurring occurrence identity, timezone and participant emails survive ingestion", () => {
  const m = buildMeetingNote({ id: "series_20261005", recurringEventId: "series", originalStartTime: { dateTime: "2026-10-05T10:00:00-06:00" }, start: { dateTime: "2026-10-05T11:00:00-06:00", timeZone: "America/Denver" }, attendees: [{ displayName: "Ada", email: "ADA@example.test" }] });
  assert.equal(m.metadata.calendarSeriesId, "series");
  assert.equal(m.metadata.occurrenceStart, "2026-10-05T10:00:00-06:00");
  assert.equal(m.metadata.timeZone, "America/Denver");
  assert.deepEqual(m.metadata.attendeeEmails, ["ada@example.test"]);
});

// ── multiple recordings per event (matchTranscripts) ─────────────────────────

test("every recording carrying the exact occurrence id links; the legacy single matcher still calls two of them ambiguous", () => {
  const m = meeting();
  const a = transcript("rec-a", { calendarEventId: m.eventId, title: "Part one" });
  const b = transcript("rec-b", { calendarEventId: m.eventId, title: "Part two", date: "2026-10-06" });
  const fuzzyOnly = transcript("fuzzy");
  const r = matchTranscripts(m, [fuzzyOnly, b, a], [m]);
  assert.deepEqual(r.exact.map((c) => c.noteId), ["rec-a", "rec-b"]);
  assert.ok(r.exact.every((c) => c.score === 100 && c.evidence[0] === "calendar-event-id"));
  assert.equal(r.fuzzy.status, "none", "a guess never piles onto exact recordings");
  assert.equal(matchTranscript(m, [a, b], [m]).status, "ambiguous");
});

test("recurring occurrences keep their own recordings; a sibling occurrence's id never matches", () => {
  const monday = buildMeetingNote({ id: "series_20261005T160000Z", recurringEventId: "series", summary: "Standup", start: { dateTime: "2026-10-05T10:00:00-06:00" } });
  const tuesday = buildMeetingNote({ id: "series_20261006T160000Z", recurringEventId: "series", summary: "Standup", start: { dateTime: "2026-10-06T10:00:00-06:00" } });
  const recs = [
    transcript("mon", { calendarEventId: "series_20261005T160000Z", title: "Standup" }),
    transcript("tue", { calendarEventId: "series_20261006T160000Z", title: "Standup", date: "2026-10-06" }),
    transcript("series-master", { calendarEventId: "series", title: "Standup" }),
  ];
  assert.deepEqual(matchTranscripts(monday, recs, [monday, tuesday]).exact.map((c) => c.noteId), ["mon"]);
  assert.deepEqual(matchTranscripts(tuesday, recs, [monday, tuesday]).exact.map((c) => c.noteId), ["tue"]);
  assert.equal(matchTranscripts(monday, [recs[1]!, recs[2]!], [monday, tuesday]).fuzzy.status, "none", "a conflicting id is never a fuzzy candidate");
});

test("fuzzy matching compares instants, not offset notation, and stays single-winner", () => {
  const m = buildMeetingNote({ id: "tz", summary: "Roadmap review", start: { dateTime: "2026-10-05T10:00:00-06:00", timeZone: "America/Denver" }, attendees: [{ displayName: "Ada Example", email: "ada@example.test" }] });
  const utc = transcript("utc", { start: "2026-10-05T16:04:00Z" });
  const r = matchTranscripts(m, [utc], [m]);
  assert.equal(r.fuzzy.status, "matched");
  assert.ok(r.fuzzy.candidates[0]!.evidence.includes("start-within-15m"));
  const tie = matchTranscripts(m, [utc, transcript("utc-2", { start: "2026-10-05T16:06:00Z" })], [m]);
  assert.deepEqual(tie.exact, []);
  assert.equal(tie.fuzzy.status, "ambiguous");
  assert.equal(tie.fuzzy.candidates.length, 2);
});

test("cancelled occurrences, existing recordings and unavailable transcripts are excluded", () => {
  const m = meeting();
  const exact = transcript("exact", { calendarEventId: m.eventId });
  const loose = transcript("loose");
  assert.equal(matchTranscripts(m, [loose], [m], { hasRecording: true }).fuzzy.status, "none");
  assert.deepEqual(matchTranscripts(m, [exact], [m], { hasRecording: true }).exact.map((c) => c.noteId), ["exact"], "a further exact recording still links");
  const journaled = new Set(["exact", "loose"]);
  const blocked = matchTranscripts(m, [exact, loose], [m], { isUnavailable: (t) => journaled.has(t.id) });
  assert.deepEqual(blocked.exact, []);
  assert.equal(blocked.fuzzy.status, "none");
  assert.equal(matchTranscript(m, [loose], [m], () => true).status, "none");
  m.metadata.event_status = "cancelled";
  assert.deepEqual(matchTranscripts(m, [exact, loose], [m]), { exact: [], fuzzy: { status: "none", candidates: [] } });
});

test("a stored meeting note scores exactly like the event it was built from; a hand-made meeting never exact-matches", () => {
  const built = buildMeetingNote({ id: "event-a", summary: "Roadmap review", start: { dateTime: "2026-10-05T10:00:00Z" }, attendees: [{ displayName: "Ada Example", email: "ada@example.test" }] });
  const stored = meetingFromNote({ id: "note", path: built.path, content: "", tags: ["meeting"], metadata: built.metadata, createdAt: "", updatedAt: "" });
  for (const t of [transcript("a", { start: "2026-10-05T10:03:00Z" }), transcript("b", { calendarEventId: "event-a" }), transcript("c", { attendeeEmails: ["ada@example.test"] })]) {
    assert.deepEqual(score(stored, t), score(built, t));
  }
  const handMade = meetingFromNote({ id: "hm", path: "notes/hm", content: "", tags: ["meeting"], metadata: { title: "Roadmap review", date: "2026-10-05" }, createdAt: "", updatedAt: "" });
  assert.equal(handMade.eventId, "");
  assert.deepEqual(matchTranscripts(handMade, [transcript("no-id")], [handMade]).exact, []);
});
