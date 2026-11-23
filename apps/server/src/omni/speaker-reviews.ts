/**
 * Speaker reviews ("Confirm speakers", contract 2026-11-22): after a meeting, omni-meet names the
 * speakers it is sure of and posts ONE review per meeting asking the owner about the rest. The owner
 * answers per row (confirm the guess, name someone else, or skip); omni-meet reads the answers back
 * through the hook and applies them to Minutes. Nothing here talks to Minutes or sends anything.
 *
 *   omni_speaker_reviews — one row per (owner, meeting_key): rows / candidates / answers as JSON.
 *   omni_speaker_clips   — the short audio clip (AAC in an MP4 container) per asked row, ≤ 600 KB.
 *
 * Reviews older than 30 days are pruned with their clips.
 */
import { db } from "../db";
import { newId } from "./store";

db.exec(`
CREATE TABLE IF NOT EXISTS omni_speaker_reviews (
 id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, meeting_key TEXT NOT NULL, title TEXT NOT NULL,
 held_at INTEGER NOT NULL, status TEXT NOT NULL, rows TEXT NOT NULL, candidates TEXT NOT NULL,
 answers TEXT NOT NULL DEFAULT '{}', closed_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(owner_email, meeting_key)
);
CREATE INDEX IF NOT EXISTS omni_speaker_reviews_created ON omni_speaker_reviews(owner_email, created_at);
CREATE TABLE IF NOT EXISTS omni_speaker_clips (
 review_id TEXT NOT NULL, row_id TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL,
 PRIMARY KEY(review_id, row_id)
);
`);

export const SPEAKER_STATUSES = ["open", "done", "expired"] as const;
export type SpeakerReviewStatus = (typeof SPEAKER_STATUSES)[number];
export type SpeakerChoice = "confirm" | "other" | "skip";

export const MAX_ROWS = 40;
export const MAX_CANDIDATES = 30;
export const MAX_CLIP_BYTES = 600 * 1024;
/** A full review: 40 rows each with a 600 KB clip in base64, plus the rest. Loopback + service token only. */
export const MAX_REVIEW_BODY = MAX_ROWS * Math.ceil((MAX_CLIP_BYTES * 4) / 3 + 1024) + 256 * 1024;
const DAY_MS = 86_400_000;
/** Answers are taken while a review is open and for 7 days after it was posted (corrections). */
export const ANSWER_WINDOW_MS = 7 * DAY_MS;
/** A done review stays in the app's list this long (the owner sees what was named and can correct it). */
export const DONE_VISIBLE_MS = DAY_MS;
export const PRUNE_AFTER_MS = 30 * DAY_MS;

export const ROW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const REVIEW_ID_RE = /^sr_[a-f0-9]{24}$/;
const MEETING_KEY_RE = /^[A-Za-z0-9._:@\/+=-]{1,200}$/;
const EMAIL_RE = /^[^\s@<>()\[\],;:"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTROL_RE = /[\p{Cc}\p{Cf}]/u;

export interface SpeakerGuess { name: string; email?: string }
export interface SpeakerRow {
  id: string; label: string; seconds: number; kind: "auto" | "ask"; confidence: "high" | "medium" | "low";
  guess: SpeakerGuess | null; reasons: string[]; quote: string | null; hasClip: boolean;
}
export interface SpeakerCandidate { name: string; email?: string }
export interface SpeakerAnswer { choice: SpeakerChoice; name: string | null; email: string | null; at: string }
export interface SpeakerClipInput { mime: "audio/mp4"; bytes: Buffer; durationS: number }
export interface SpeakerReviewInput {
  meetingKey: string; title: string; heldAt: number; status: "open" | "done";
  rows: SpeakerRow[]; clips: Map<string, SpeakerClipInput>; candidates: SpeakerCandidate[];
}
export interface SpeakerReview {
  id: string; owner: string; meetingKey: string; title: string; heldAt: number; status: SpeakerReviewStatus;
  rows: SpeakerRow[]; candidates: SpeakerCandidate[]; answers: Record<string, SpeakerAnswer>;
  closedAt: number | null; createdAt: number; updatedAt: number;
}

export class SpeakerReviewError extends Error {
  constructor(public code: string, public status: 400 | 404 | 409 = 400, public detail?: string) { super(code); }
}
const invalid = (detail: string): never => { throw new SpeakerReviewError("bad_request", 400, detail); };

// ── validation ──────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A trimmed single-line string of 1..max characters (code points), no control or format characters. */
function text(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") return invalid(`${field}: a string`);
  const s = v.trim();
  if (!s || Array.from(s).length > max || CONTROL_RE.test(s)) return invalid(`${field}: 1–${max} characters, one line`);
  return s;
}
export function validEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v);
}
function optionalEmail(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!validEmail(v)) return invalid(`${field}: an email address`);
  return v;
}
function person(v: unknown, field: string): SpeakerGuess {
  if (!isObj(v)) return invalid(`${field}: {name, email?}`);
  const email = optionalEmail(v.email, `${field}.email`);
  return { name: text(v.name, 120, `${field}.name`), ...(email ? { email } : {}) };
}
/** The clip: AAC in an MP4 container (`ftyp` box first), 1 byte .. 600 KB once decoded. */
function clip(v: unknown, field: string): SpeakerClipInput {
  if (!isObj(v)) return invalid(`${field}: {mime, base64, durationS}`);
  if (v.mime !== "audio/mp4") return invalid(`${field}.mime: audio/mp4`);
  const b64 = v.base64;
  if (typeof b64 !== "string" || !b64 || b64.length % 4 !== 0 || b64.length > Math.ceil(MAX_CLIP_BYTES / 3) * 4 || !BASE64_RE.test(b64)) {
    return invalid(`${field}.base64: standard base64 of at most ${MAX_CLIP_BYTES} bytes`);
  }
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length || bytes.length > MAX_CLIP_BYTES) return invalid(`${field}.base64: at most ${MAX_CLIP_BYTES} bytes`);
  if (bytes.length < 12 || bytes.toString("latin1", 4, 8) !== "ftyp") return invalid(`${field}.base64: an MP4 (m4a) file`);
  const d = v.durationS;
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0 || d > 60) return invalid(`${field}.durationS: seconds, 0–60`);
  return { mime: "audio/mp4", bytes, durationS: d };
}
function row(v: unknown, i: number, clips: Map<string, SpeakerClipInput>): SpeakerRow {
  const f = `rows[${i}]`;
  if (!isObj(v)) return invalid(`${f}: an object`);
  if (typeof v.id !== "string" || !ROW_ID_RE.test(v.id)) return invalid(`${f}.id: 1–64 of [A-Za-z0-9_-]`);
  const id = v.id;
  const label = text(v.label, 80, `${f}.label`);
  const s = v.seconds;
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 86_400) return invalid(`${f}.seconds: 0–86400`);
  if (v.kind !== "auto" && v.kind !== "ask") return invalid(`${f}.kind: auto|ask`);
  if (v.confidence !== "high" && v.confidence !== "medium" && v.confidence !== "low") return invalid(`${f}.confidence: high|medium|low`);
  const guess = v.guess === null || v.guess === undefined ? null : person(v.guess, `${f}.guess`);
  if (v.kind === "auto" && (!guess || v.confidence !== "high")) return invalid(`${f}: an auto row is named (guess) with confidence high`);
  if (v.kind === "ask" && v.confidence === "high") return invalid(`${f}.confidence: an ask row is medium or low`);
  const reasons = v.reasons ?? [];
  if (!Array.isArray(reasons) || reasons.length > 3) return invalid(`${f}.reasons: at most 3`);
  const rs = reasons.map((r, j) => text(r, 200, `${f}.reasons[${j}]`));
  const quote = v.quote === null || v.quote === undefined || v.quote === "" ? null : text(v.quote, 200, `${f}.quote`);
  const c = v.clip === undefined || v.clip === null ? null : clip(v.clip, `${f}.clip`);
  if (v.hasClip !== undefined && typeof v.hasClip !== "boolean") return invalid(`${f}.hasClip: boolean`);
  if (v.hasClip === true && !c) return invalid(`${f}.hasClip: true needs a clip`);
  if (c) clips.set(id, c);
  return { id, label, seconds: Math.round(s), kind: v.kind, confidence: v.confidence, guess, reasons: rs, quote, hasClip: !!c };
}

/** The hook body → a review input, or SpeakerReviewError(bad_request) naming the first bad field. */
export function parseSpeakerReview(b: Record<string, unknown>): SpeakerReviewInput {
  if (typeof b.meetingKey !== "string" || !MEETING_KEY_RE.test(b.meetingKey)) return invalid("meetingKey: 1–200 of [A-Za-z0-9._:@/+=-]");
  const title = text(b.title, 200, "title");
  const heldAt = typeof b.heldAt === "string" && b.heldAt.length <= 40 ? Date.parse(b.heldAt) : NaN;
  if (!Number.isFinite(heldAt)) return invalid("heldAt: an ISO 8601 date-time");
  if (b.status !== undefined && b.status !== "open" && b.status !== "done") return invalid("status: open|done");
  if (!Array.isArray(b.rows) || b.rows.length > MAX_ROWS) return invalid(`rows: an array of at most ${MAX_ROWS}`);
  const clips = new Map<string, SpeakerClipInput>();
  const ids = new Set<string>();
  const rows = b.rows.map((r, i) => {
    const parsed = row(r, i, clips);
    if (ids.has(parsed.id)) return invalid(`rows[${i}].id: duplicate`);
    ids.add(parsed.id);
    return parsed;
  });
  const cands = b.candidates ?? [];
  if (!Array.isArray(cands) || cands.length > MAX_CANDIDATES) return invalid(`candidates: an array of at most ${MAX_CANDIDATES}`);
  const candidates = cands.map((c, i) => person(c, `candidates[${i}]`));
  return { meetingKey: b.meetingKey, title, heldAt, status: (b.status as "open" | "done" | undefined) ?? "open", rows, clips, candidates };
}

// ── store ───────────────────────────────────────────────────────────────────

type Raw = {
  id: string; owner_email: string; meeting_key: string; title: string; held_at: number; status: string; rows: string;
  candidates: string; answers: string; closed_at: number | null; created_at: number; updated_at: number;
};
const toReview = (r: Raw): SpeakerReview => ({
  id: r.id, owner: r.owner_email, meetingKey: r.meeting_key, title: r.title, heldAt: r.held_at, status: r.status as SpeakerReviewStatus,
  rows: JSON.parse(r.rows) as SpeakerRow[], candidates: JSON.parse(r.candidates) as SpeakerCandidate[],
  answers: JSON.parse(r.answers) as Record<string, SpeakerAnswer>, closedAt: r.closed_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

const q = {
  byId: db.prepare("SELECT * FROM omni_speaker_reviews WHERE owner_email = ? AND id = ?"),
  byKey: db.prepare("SELECT * FROM omni_speaker_reviews WHERE owner_email = ? AND meeting_key = ?"),
  ins: db.prepare(`INSERT INTO omni_speaker_reviews (id, owner_email, meeting_key, title, held_at, status, rows, candidates, answers, closed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`),
  replace: db.prepare(`UPDATE omni_speaker_reviews SET title = ?, held_at = ?, status = ?, rows = ?, candidates = ?, answers = '{}', closed_at = ?,
    created_at = ?, updated_at = ? WHERE id = ?`),
  setAnswers: db.prepare("UPDATE omni_speaker_reviews SET answers = ?, updated_at = ? WHERE id = ?"),
  close: db.prepare("UPDATE omni_speaker_reviews SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?"),
  list: db.prepare("SELECT * FROM omni_speaker_reviews WHERE owner_email = ? AND (status = 'open' OR (status = 'done' AND closed_at > ?)) ORDER BY created_at DESC, id DESC LIMIT 100"),
  delClips: db.prepare("DELETE FROM omni_speaker_clips WHERE review_id = ?"),
  insClip: db.prepare("INSERT INTO omni_speaker_clips (review_id, row_id, mime, bytes) VALUES (?, ?, ?, ?)"),
  clip: db.prepare("SELECT mime, bytes FROM omni_speaker_clips WHERE review_id = ? AND row_id = ?"),
  oldIds: db.prepare("SELECT id FROM omni_speaker_reviews WHERE created_at < ?"),
  delReview: db.prepare("DELETE FROM omni_speaker_reviews WHERE id = ?"),
};

export const askRows = (r: Pick<SpeakerReview, "rows">): SpeakerRow[] => r.rows.filter((x) => x.kind === "ask");
export const pendingCount = (r: Pick<SpeakerReview, "rows" | "answers">): number => askRows(r).filter((x) => !r.answers[x.id]).length;

export function getSpeakerReview(owner: string, id: string): SpeakerReview | null {
  if (!REVIEW_ID_RE.test(id)) return null;
  const r = q.byId.get(owner, id) as Raw | undefined;
  return r ? toReview(r) : null;
}

/**
 * Create, or replace the meeting's earlier review while nobody has answered it (same id, clips replaced).
 * A review with answers is never overwritten: 409 `review_answered`.
 */
export const saveSpeakerReview = db.transaction((owner: string, input: SpeakerReviewInput, now: number = Date.now()): { review: SpeakerReview; created: boolean; previous: SpeakerReview | null } => {
  const prior = q.byKey.get(owner, input.meetingKey) as Raw | undefined;
  const previous = prior ? toReview(prior) : null;
  if (previous && Object.keys(previous.answers).length) throw new SpeakerReviewError("review_answered", 409, "this meeting's review already has answers");
  const closedAt = input.status === "done" ? now : null;
  const rows = JSON.stringify(input.rows), candidates = JSON.stringify(input.candidates);
  let id: string;
  if (previous) {
    id = previous.id;
    q.replace.run(input.title, input.heldAt, input.status, rows, candidates, closedAt, now, now, id);
    q.delClips.run(id);
  } else {
    id = newId("sr");
    q.ins.run(id, owner, input.meetingKey, input.title, input.heldAt, input.status, rows, candidates, closedAt, now, now);
  }
  for (const [rowId, c] of input.clips) q.insClip.run(id, rowId, c.mime, c.bytes);
  return { review: getSpeakerReview(owner, id)!, created: !previous, previous };
});

/** Open reviews, plus done ones closed in the last 24 h (`status: "open"` → open only). Newest first. */
export function listSpeakerReviews(owner: string, which: "open" | "all", now: number = Date.now()): SpeakerReview[] {
  const all = (q.list.all(owner, now - DONE_VISIBLE_MS) as Raw[]).map(toReview);
  return which === "open" ? all.filter((r) => r.status === "open") : all;
}

export function speakerClip(owner: string, reviewId: string, rowId: string): { mime: string; bytes: Buffer } | null {
  if (!ROW_ID_RE.test(rowId) || !getSpeakerReview(owner, reviewId)) return null;
  return (q.clip.get(reviewId, rowId) as { mime: string; bytes: Buffer } | undefined) ?? null;
}

/** Record (or replace) the owner's answer for one row. */
export function answerSpeakerRow(owner: string, id: string, a: { rowId: unknown; choice: unknown; name?: unknown; email?: unknown }, now: number = Date.now()): SpeakerReview {
  const review = getSpeakerReview(owner, id);
  if (!review) throw new SpeakerReviewError("not_found", 404);
  if (typeof a.rowId !== "string" || !ROW_ID_RE.test(a.rowId)) return invalid("rowId: a row id");
  const row = review.rows.find((r) => r.id === a.rowId);
  if (!row) throw new SpeakerReviewError("not_found", 404, "no such row");
  if (review.status !== "open" && now > review.createdAt + ANSWER_WINDOW_MS) throw new SpeakerReviewError("answer_window_closed", 409, "answers are taken for 7 days");
  let answer: SpeakerAnswer;
  const at = new Date(now).toISOString();
  if (a.choice === "confirm") {
    if (!row.guess) throw new SpeakerReviewError("bad_request", 400, "confirm: this row has no guess");
    answer = { choice: "confirm", name: row.guess.name, email: row.guess.email ?? null, at };
  } else if (a.choice === "other") {
    const name = text(a.name, 120, "name");
    answer = { choice: "other", name, email: optionalEmail(a.email, "email") ?? null, at };
  } else if (a.choice === "skip") {
    answer = { choice: "skip", name: null, email: null, at };
  } else return invalid("choice: confirm|other|skip");
  const answers = { ...review.answers, [row.id]: answer };
  q.setAnswers.run(JSON.stringify(answers), now, review.id);
  return getSpeakerReview(owner, review.id)!;
}

export function closeSpeakerReview(owner: string, id: string, status: unknown, now: number = Date.now()): SpeakerReview {
  if (status !== "done" && status !== "expired") return invalid("status: done|expired");
  const review = getSpeakerReview(owner, id);
  if (!review) throw new SpeakerReviewError("not_found", 404);
  q.close.run(status, review.closedAt ?? now, now, review.id);
  return getSpeakerReview(owner, review.id)!;
}

/** Delete reviews (and their clips) posted more than 30 days ago. Returns how many went. */
export const pruneSpeakerReviews = db.transaction((now: number = Date.now()): number => {
  const ids = (q.oldIds.all(now - PRUNE_AFTER_MS) as Array<{ id: string }>).map((r) => r.id);
  for (const id of ids) {
    q.delClips.run(id);
    q.delReview.run(id);
  }
  return ids.length;
});

/** The wire shape (contract § Review shape). Never carries clip bytes. */
export function speakerReviewView(r: SpeakerReview): Record<string, unknown> {
  return {
    id: r.id, meetingKey: r.meetingKey, title: r.title, heldAt: new Date(r.heldAt).toISOString(), status: r.status,
    createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString(),
    rows: r.rows, candidates: r.candidates, answers: r.answers, pending: pendingCount(r),
  };
}

export function resetSpeakerReviewsForTests(): void {
  db.exec("DELETE FROM omni_speaker_reviews; DELETE FROM omni_speaker_clips;");
}
