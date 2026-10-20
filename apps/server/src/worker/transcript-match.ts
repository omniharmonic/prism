import type { Note } from "../parachute";
import type { MeetingNote } from "./calendar";

const text = (v: unknown): string => typeof v === "string" ? v : "";
const normalized = (v: string) => v.normalize("NFKC").trim().toLowerCase();
const name = (v: string) => normalized(v).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const stop = new Set(["meeting", "call", "sync", "the", "and", "with", "for", "notes"]);
const words = (v: string) => new Set(name(v).split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)));
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
const instant = (v: unknown) => typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const day = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v ? Date.parse(v) : null;

export type TranscriptCandidate = { noteId: string; score: number; evidence: string[] };
export type TranscriptMatch = { status: "matched" | "ambiguous" | "none"; candidates: TranscriptCandidate[] };

/** Explicit occurrence identity wins; fuzzy evidence never overrides a conflicting ID. */
export function score(meeting: MeetingNote, transcript: Note): TranscriptCandidate | null {
  const md = transcript.metadata ?? {};
  if (meeting.metadata.event_status === "cancelled") return null;
  const eventId = text(md.calendarEventId);
  if (eventId) return eventId === meeting.eventId ? { noteId: transcript.id, score: 100, evidence: ["calendar-event-id"] } : null;
  const a = day(meeting.date), b = day(text(md.date));
  if (a === null || b === null || Math.abs(a - b) > 86_400_000) return null;
  const evidence: string[] = [];
  let value = 0;
  if (a === b) { value += 3; evidence.push("same-date"); }
  const start = instant(meeting.metadata.start), recorded = instant(md.start);
  if (start !== null && recorded !== null) {
    const minutes = Math.abs(start - recorded) / 60_000;
    if (minutes > 360) return null;
    if (minutes <= 60) { value += minutes <= 15 ? 6 : 3; evidence.push(minutes <= 15 ? "start-within-15m" : "start-within-1h"); }
  }
  const title = words(meeting.title), transcriptTitle = words(text(md.title));
  const shared = [...title].filter((word) => transcriptTitle.has(word)).length;
  if (shared) { value += Math.min(shared * 2, 6); evidence.push(`title-words:${shared}`); }
  const emails = new Set([...strings(md.attendeeEmails), ...strings(md.attendees).filter((v) => v.includes("@"))].map(normalized));
  const meetingEmails = new Set(meeting.attendees.flatMap((a) => a.email ? [normalized(a.email)] : []));
  const emailMatches = [...meetingEmails].filter((email) => emails.has(email)).length;
  if (emailMatches) { value += Math.min(emailMatches * 4, 8); evidence.push(`exact-emails:${emailMatches}`); }
  const names = new Set(strings(md.attendees).filter((v) => !v.includes("@")).map(name).filter(Boolean));
  const meetingNames = new Set(meeting.attendees.filter((a) => !a.name.includes("@")).map((a) => name(a.name)).filter(Boolean));
  const nameMatches = [...meetingNames].filter((n) => names.has(n)).length;
  if (nameMatches) { value += Math.min(nameMatches * 2, 4); evidence.push(`exact-names:${nameMatches}`); }
  // Time/date alone do not identify a conversation.
  if (!shared && !emailMatches && !nameMatches) return null;
  return { noteId: transcript.id, score: value, evidence };
}

/** Fuzzy candidates must reach this before they are considered at all. */
export const MIN_FUZZY_SCORE = 6;

/**
 * A transcript that may not be auto-linked. The default only knows the legacy
 * singular backpointer; the worker passes one that also sees plural/typed-link
 * claims, the decision journal and manual-unlink suppressions.
 */
export type Unavailable = (transcript: Note) => boolean;
const backpointed: Unavailable = (t) => !!text(t.metadata?.meetingNoteId);

function fuzzy(meeting: MeetingNote, available: Note[], peers: MeetingNote[]): TranscriptMatch {
  const candidates = available.flatMap((t) => { const candidate = score(meeting, t); return candidate && candidate.score >= MIN_FUZZY_SCORE ? [candidate] : []; })
    .sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId));
  const best = candidates[0];
  if (!best) return { status: "none", candidates: [] };
  if (candidates[1] && best.score - candidates[1].score < 3) return { status: "ambiguous", candidates };
  const recording = available.find((t) => t.id === best.noteId)!;
  if (peers.some((other) => other.eventId !== meeting.eventId && (score(other, recording)?.score ?? -Infinity) > best.score - 3)) {
    return { status: "ambiguous", candidates };
  }
  return { status: "matched", candidates };
}

/** Require a margin in BOTH directions: recording→event as well as event→recording. */
export function matchTranscript(meeting: MeetingNote, transcripts: Note[], peers: MeetingNote[], isUnavailable: Unavailable = backpointed): TranscriptMatch {
  return fuzzy(meeting, transcripts.filter((t) => !isUnavailable(t)), peers);
}

export type TranscriptMatches = {
  /** Every available recording carrying this occurrence's exact event id — all of them link. */
  exact: TranscriptCandidate[];
  /** The single-winner fuzzy result; only attempted for a meeting with no recording at all. */
  fuzzy: TranscriptMatch;
};

/**
 * Multiple recordings per event. Exact occurrence identity is not a contest:
 * two recordings of the same occurrence both belong to it. Fuzzy evidence stays
 * single-winner with a margin in both directions, and is skipped as soon as the
 * meeting has any recording (existing or exact), so a guess never piles on.
 */
export function matchTranscripts(
  meeting: MeetingNote,
  transcripts: Note[],
  peers: MeetingNote[],
  opts: { isUnavailable?: Unavailable; hasRecording?: boolean } = {},
): TranscriptMatches {
  const none: TranscriptMatch = { status: "none", candidates: [] };
  if (meeting.metadata.event_status === "cancelled") return { exact: [], fuzzy: none };
  const available = transcripts.filter((t) => !(opts.isUnavailable ?? backpointed)(t));
  const exact = available
    .filter((t) => !!meeting.eventId && text(t.metadata?.calendarEventId) === meeting.eventId)
    .map((t) => ({ noteId: t.id, score: 100, evidence: ["calendar-event-id"] }))
    .sort((a, b) => a.noteId.localeCompare(b.noteId));
  if (exact.length || opts.hasRecording) return { exact, fuzzy: none };
  return { exact, fuzzy: fuzzy(meeting, available.filter((t) => !text(t.metadata?.calendarEventId)), peers) };
}

/** The matcher's view of a stored meeting note (as the calendar pass derives its peers). */
export function meetingFromNote(note: Note): MeetingNote {
  const md = note.metadata ?? {};
  const names = strings(md.attendees);
  const emails = strings(md.attendeeEmails);
  return {
    eventId: text(md.calendarEventId),
    title: text(md.title),
    date: text(md.date) || text(md.start).slice(0, 10),
    path: note.path ?? "",
    content: "",
    metadata: md,
    attendees: [...names.map((name) => ({ name, email: name.includes("@") ? name : null })), ...emails.map((email) => ({ name: email, email }))],
  };
}
