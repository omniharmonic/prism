import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "../src/parachute";
import { buildMeetingNote } from "../src/worker/calendar";
import { matchTranscript } from "../src/worker/transcript-match";

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
