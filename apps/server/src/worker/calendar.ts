/**
 * Google Calendar → vault ingest, server-side (Architecture v2 WP1.3). The port of
 * the desktop's `services/calendar_sync.rs` (+ the `gog` calendar client and the
 * `calendar_sync_range` command), so meeting notes keep flowing with no desktop.
 *
 * 🔒 THIS INGESTER DELETES NOTES. Three independent gates keep that deliberate:
 *   - CALENDAR_SYNC_ENABLED (default false): the worker never runs it otherwise;
 *   - CALENDAR_SHADOW=true: fetch + diff + record intents, and write NOTHING —
 *     not a meeting note, not a person, not a transcript link. Wins over ENABLED;
 *   - CALENDAR_DELETE_MODE = log (default) | archive | delete: what a live pass
 *     does with a note whose event vanished from Google (see `reconcile`).
 * Every intended action (create / update / delete / cancel / archive / person /
 * transcript link) is persisted, last CALENDAR_INTENTS_KEEP, for the overseer to
 * compare against what the desktop actually did (GET /acl/workers/calendar/intents).
 *
 * CONVERGENCE CONTRACT — ~800 desktop-written meeting notes exist and the web
 * Calendar, transcript linking and briefings read them, so the shape is the
 * desktop's exactly:
 *   - `gog calendar list --from <from> --to <to> --max <N> --account <A> --json`;
 *   - worker window: UTC today−3d … today+31d, max 250, every 5 min; the range
 *     route: caller's from/to, max 100 (both as the desktop);
 *   - path `vault/meetings/<start[0..10] | "unknown">/<rust-sanitized summary>`, tag `meeting`;
 *   - metadata { type, title, calendarEventId, date, start, end, attendees,
 *     location, meetLink, htmlLink, event_status } — PATCH merges, so keys other
 *     writers added (transcriptNoteId, status…) survive;
 *   - content template only on CREATE (an existing note's body is never touched);
 *   - each attendee → person note (worker/people.ts), linked `attended-by`;
 *   - transcript links retain `has-transcript` + transcriptNoteId/meetingNoteId;
 *     matching now requires a unique ranked choice in both directions;
 *   - reconcile: a calendar-synced note in the window whose event id is absent
 *     from the response is hard-deleted when template-only, else soft-cancelled
 *     (`event_status: "cancelled"`); skipped entirely when the response looks
 *     truncated (events.length >= max — calendar_sync.rs:309-315).
 *
 * What changed vs the desktop (every change writes less or deletes less):
 *   - an existing note whose metadata AND attendee links are unchanged is NOT
 *     rewritten (the desktop PATCHed every event every 5 min; on vault ≥0.7.9
 *     each PATCH is a history version);
 *   - person links ride in the note write (`links`), lookup is the people index;
 *   - creates use `if_exists: "ignore"` — never a 409, and a note that appeared at
 *     the path behind our back is only adopted when it is the SAME event;
 *   - path fallback never steals a note that belongs to ANOTHER event in this same
 *     response (two same-titled events on one day: the desktop flip-flopped one
 *     note between them every pass; the server leaves it with its owner);
 *   - each attendee is paired with their OWN email (the desktop zipped two lists
 *     that misalign when an attendee has no email);
 *   - transcript auto-link also skips a meeting that already has `transcriptNoteId`;
 *   - reconcile ALSO stands down when the response has an unrecognised shape or a
 *     `nextPageToken`, and (archive/delete) when one pass would remove more than
 *     CALENDAR_MAX_ORPHANS_PER_PASS notes — those intents are recorded as blocked.
 */
import type { IfExists, Note, NoteLinkInput } from "../parachute";
import { vaultClient } from "../parachute";
import { config, type CalendarDeleteMode, type VaultEntry } from "../config";
import { getWorkerCursor, setWorkerCursor } from "../db";
import { getSecret } from "../secrets";
import { PeopleIndex, creationRefusal, rustSanitizePath, type PeopleVault } from "./people";
import { defaultGogRunner, type GogRunner } from "./gmail";
import { matchTranscript } from "./transcript-match";

export type { CalendarDeleteMode };

// ── gog ──────────────────────────────────────────────────────────────────────

export class CalendarClient {
  constructor(
    private account: string,
    private run: GogRunner = defaultGogRunner(),
  ) {}

  /** clients/google.rs calendar_list_events_range — identical argv. */
  async listEventsRange(from: string, to: string, max: number): Promise<unknown> {
    const out = await this.run(["calendar", "list", "--from", from, "--to", to, "--max", String(max), "--account", this.account, "--json"]);
    try {
      return JSON.parse(out.trim());
    } catch (e) {
      throw new Error(`gog calendar list: unparseable output (${(e as Error).message})`);
    }
  }
}

// ── pure ports of calendar_sync.rs ───────────────────────────────────────────

export type CalEvent = Record<string, unknown>;

/**
 * gog returns a bare array or `{events|items: [...]}`. `recognized` is false when
 * neither shape is present — the desktop treated that as "zero events" and would
 * then reconcile-delete the whole window; the server refuses to reconcile on it.
 */
export function extractEvents(data: unknown): { events: CalEvent[]; recognized: boolean; nextPageToken: string | null } {
  if (Array.isArray(data)) return { events: data as CalEvent[], recognized: true, nextPageToken: null };
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const arr = Array.isArray(d.events) ? d.events : Array.isArray(d.items) ? d.items : null;
  const tok = typeof d.nextPageToken === "string" && d.nextPageToken ? d.nextPageToken : null;
  return { events: (arr ?? []) as CalEvent[], recognized: arr !== null, nextPageToken: tok };
}

const has = (o: unknown, k: string): boolean => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** serde `a.get(x).or(a.get(y)).and_then(as_str)`: a PRESENT first key wins even when it is not a string. */
const firstKeyStr = (o: unknown, a: string, b: string): string | null => {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  return asStr(has(r, a) ? r[a] : r[b]);
};

export interface MeetingAttendee {
  name: string;
  email: string | null;
}

export interface MeetingNote {
  eventId: string;
  title: string;
  date: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  attendees: MeetingAttendee[];
}

/** The note the desktop writes for an event (sync_single_event). Throws on a missing id. */
export function buildMeetingNote(event: CalEvent): MeetingNote {
  const eventId = asStr(event.id);
  if (!eventId) throw new Error("Event missing id");
  const summary = asStr(event.summary) ?? "Untitled Event";
  const description = asStr(event.description) ?? "";
  const location = asStr(event.location);
  const start = firstKeyStr(event.start, "dateTime", "date") ?? "";
  const end = firstKeyStr(event.end, "dateTime", "date") ?? "";

  const rawAtt = Array.isArray(event.attendees) ? (event.attendees as unknown[]) : [];
  const attendees: MeetingAttendee[] = [];
  for (const a of rawAtt) {
    const name = firstKeyStr(a, "displayName", "email");
    if (name === null) continue;
    attendees.push({ name, email: asStr((a as Record<string, unknown>).email) });
  }
  const names = attendees.map((a) => a.name);

  let meetUrl = asStr(event.hangoutLink);
  if (meetUrl === null) {
    const eps = (event.conferenceData as { entryPoints?: unknown } | undefined)?.entryPoints;
    if (Array.isArray(eps) && eps.length) meetUrl = asStr((eps[0] as Record<string, unknown> | null)?.uri);
  }
  const htmlLink = asStr(event.htmlLink);
  const status = asStr(event.status) ?? "confirmed";

  const date = start.length >= 10 ? start.slice(0, 10) : "unknown";
  const path = `vault/meetings/${date}/${rustSanitizePath(summary)}`;
  const metadata: Record<string, unknown> = {
    type: "meeting",
    title: summary,
    calendarEventId: eventId,
    date,
    start,
    end,
    attendees: names,
    attendeeEmails: attendees.flatMap((a) => a.email ? [a.email.trim().toLowerCase()] : []),
    calendarProvider: "google",
    ...(asStr(event.recurringEventId) ? { calendarSeriesId: event.recurringEventId } : {}),
    ...(firstKeyStr(event.originalStartTime, "dateTime", "date") ? { occurrenceStart: firstKeyStr(event.originalStartTime, "dateTime", "date") } : {}),
    ...(asStr((event.start as Record<string, unknown> | undefined)?.timeZone) ? { timeZone: (event.start as Record<string, unknown>).timeZone } : {}),
    location,
    meetLink: meetUrl,
    htmlLink,
    // The meeting schema's `status` is the processing state; Google's lifecycle
    // lives in `event_status` (see calendar_sync.rs).
    event_status: status,
  };

  let content = `# ${summary}\n\n`;
  content += `**Date:** ${date}\n`;
  content += `**Time:** ${start} — ${end}\n`;
  if (location !== null) content += `**Location:** ${location}\n`;
  if (meetUrl !== null) content += `**Meet:** ${meetUrl}\n`;
  if (names.length) content += `**Attendees:** ${names.join(", ")}\n`;
  if (description) content += `\n---\n\n${description}\n`;
  content += "\n---\n\n## Meeting Notes\n\n";

  return { eventId, title: summary, date, path, content, metadata, attendees };
}

const isAlnum = (c: string): boolean => /^[\p{Alphabetic}\p{N}]$/u.test(c);

/** Keep only alphanumerics outside `<…>` tags (calendar_sync.rs strip_markup). */
export function stripMarkup(s: string): string {
  let out = "";
  let inTag = false;
  for (const c of s) {
    if (c === "<") inTag = true;
    else if (c === ">") inTag = false;
    else if (inTag) continue;
    else if (isAlnum(c)) out += c;
  }
  return out;
}

/** True only when nothing but the template sits under the LAST "Meeting Notes"
 *  marker; no marker → false (can't tell → never delete). */
export function isTemplateOnly(content: string): boolean {
  const i = content.lastIndexOf("Meeting Notes");
  if (i < 0) return false;
  return stripMarkup(content.slice(i + "Meeting Notes".length)) === "";
}

export function normalizeAttendee(name: string): string {
  const s = name.trim().toLowerCase();
  const at = s.indexOf("@");
  if (at >= 0) return s.slice(0, at).replace(/[._-]/g, " ");
  return Array.from(s)
    .map((c) => (isAlnum(c) || c === " " ? c : " "))
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

const SKIP_WORDS = ["meeting", "call", "sync", "the", "and", "with", "for", "a", "an", "of", "in", "on", "at", "to"];
export function significantWords(title: string): string[] {
  const words: string[] = [];
  let cur = "";
  for (const c of title.toLowerCase()) {
    if (isAlnum(c)) cur += c;
    else {
      words.push(cur);
      cur = "";
    }
  }
  words.push(cur);
  return words.filter((w) => Buffer.byteLength(w, "utf8") > 2 && !SKIP_WORDS.includes(w));
}

/** chrono `NaiveDate::parse_from_str(s, "%Y-%m-%d")` → days since epoch (null if invalid). */
function parseDay(s: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

/** The background window: UTC today−3d … today+31d, as YYYY-MM-DD (sync_upcoming). */
export function syncWindow(now: number = Date.now()): { from: string; to: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(now - 3 * 86_400_000), to: day(now + 31 * 86_400_000) };
}

/** A note's day for window scoping: metadata.date, else start[0..10]. */
function noteDay(md: Record<string, unknown>): string {
  const d = asStr(md.date);
  if (d !== null) return d;
  const s = asStr(md.start);
  if (s !== null) return s.length >= 10 ? s.slice(0, 10) : s;
  return "";
}

// ── intents ──────────────────────────────────────────────────────────────────

export type IntentAction =
  | "create"
  | "update"
  | "unarchive"
  | "delete"
  | "cancel"
  | "person-create"
  | "link-transcript"
  | "skip-collision";

/**
 * What happened to an intent: `shadow` (shadow mode — nothing written), `logged`
 * (delete mode log — nothing written), `applied`, `archived` (a desktop delete
 * turned into an archive), `blocked` (a reconcile brake stood down), `failed`.
 */
export type IntentEffect = "shadow" | "logged" | "applied" | "archived" | "blocked" | "failed";

export interface CalendarIntent {
  at: string;
  source: "worker" | "range";
  mode: "shadow" | "live";
  deleteMode: CalendarDeleteMode;
  window: string;
  action: IntentAction;
  effect: IntentEffect;
  noteId?: string;
  path?: string | null;
  eventId?: string;
  date?: string;
  reason?: string;
  candidates?: Array<{ noteId: string; score: number; evidence: string[] }>;
}

export const ARCHIVED_TAG = "calendar-archived";
export const ATTENDED_BY = "attended-by";
export const HAS_TRANSCRIPT = "has-transcript";

// ── the pass ─────────────────────────────────────────────────────────────────

export interface CalendarVault extends PeopleVault {
  listNotes(opts: { tags?: string[]; includeLinks?: boolean }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
  createNote(p: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    links?: NoteLinkInput[];
    ifExists?: IfExists;
  }): Promise<Note & { existed?: boolean }>;
  updateNote(
    id: string,
    p: { metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[] }; tags?: { add?: string[]; remove?: string[] } },
  ): Promise<Note>;
  deleteNote(id: string): Promise<void>;
}

export interface CalendarPassOptions {
  from: string;
  to: string;
  max: number;
  shadow: boolean;
  deleteMode: CalendarDeleteMode;
  source: "worker" | "range";
  /** 0 disables the mass-orphan brake. */
  maxOrphans?: number;
  now?: number;
  log?: (line: string) => void;
}

export interface CalendarPassResult {
  window: { from: string; to: string };
  mode: "shadow" | "live";
  deleteMode: CalendarDeleteMode;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  peopleCreated: number;
  transcriptLinks: number;
  reconcile: {
    skipped: string | null;
    orphans: number;
    deleted: number;
    cancelled: number;
    archived: number;
    logged: number;
    blocked: number;
  };
  intents: CalendarIntent[];
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const linked = (n: Note, otherId: string, rel: string): boolean =>
  Array.isArray(n.links) &&
  n.links.some((l) => l.relationship === rel && ((l.sourceId === n.id && l.targetId === otherId) || (l.targetId === n.id && l.sourceId === otherId)));

const hasRel = (n: Note, rel: string): boolean => Array.isArray(n.links) && n.links.some((l) => l.relationship === rel && (l.sourceId === n.id || l.targetId === n.id));

/**
 * One pass over a window: fetch → upsert one note per event → link attendees and
 * transcripts → reconcile vanished events. Throws only when the fetch or the
 * meeting listing fails (so nothing is reconciled on a bad read); one bad event
 * is counted in `failed` and never aborts the pass.
 */
export async function syncCalendarWindow(
  client: Pick<CalendarClient, "listEventsRange">,
  vault: CalendarVault,
  opts: CalendarPassOptions,
): Promise<CalendarPassResult> {
  const mode = opts.shadow ? "shadow" : "live";
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const res: CalendarPassResult = {
    window: { from: opts.from, to: opts.to },
    mode,
    deleteMode: opts.deleteMode,
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    peopleCreated: 0,
    transcriptLinks: 0,
    reconcile: { skipped: null, orphans: 0, deleted: 0, cancelled: 0, archived: 0, logged: 0, blocked: 0 },
    intents: [],
  };
  const intent = (i: Omit<CalendarIntent, "at" | "source" | "mode" | "deleteMode" | "window">) =>
    res.intents.push({ at, source: opts.source, mode, deleteMode: opts.deleteMode, window: `${opts.from}..${opts.to}`, ...i });
  const log = opts.log ?? (() => {});

  const raw = await client.listEventsRange(opts.from, opts.to, opts.max);
  const { events, recognized, nextPageToken } = extractEvents(raw);
  res.fetched = events.length;

  // Every meeting note, lean + links, ONCE (the desktop re-listed per event).
  const meetings = await vault.listNotes({ tags: ["meeting"], includeLinks: true });
  const byEvent = new Map<string, Note>();
  const byPath = new Map<string, Note>();
  const index = (n: Note) => {
    const eid = asStr(n.metadata?.calendarEventId);
    if (eid && !byEvent.has(eid)) byEvent.set(eid, n);
    if (n.path && !byPath.has(n.path)) byPath.set(n.path, n);
  };
  meetings.forEach(index);
  const batchIds = new Set(events.map((e) => asStr(e.id)).filter((x): x is string => !!x));

  let people: PeopleIndex | null = null;
  const proposedPeople = new Set<string>();
  let transcripts: Note[] | null = null;
  const loadTranscripts = async () => (transcripts ??= await vault.listNotes({ tags: ["transcript"] }));

  /** Attendees → person ids. Shadow never creates; it records the intent instead. */
  async function attendeeIds(m: MeetingNote): Promise<string[]> {
    const ids: string[] = [];
    for (const a of m.attendees) {
      if (creationRefusal(a.name, a.email)) continue;
      people ??= await PeopleIndex.load(vault);
      if (opts.shadow) {
        const hit = await people.findOrCreate(vault, a.name, { email: a.email, allowCreate: false });
        if (hit) ids.push(hit.id);
        else if (!proposedPeople.has(a.name)) {
          proposedPeople.add(a.name);
          intent({ action: "person-create", effect: "shadow", eventId: m.eventId, path: `vault/people/${rustSanitizePath(a.name)}`, reason: "attendee has no person note" });
        }
        continue;
      }
      const hit = await people.findOrCreate(vault, a.name, { email: a.email }).catch((e) => {
        log(`person for event ${m.eventId} failed: ${String(e)}`);
        return null;
      });
      if (hit) {
        ids.push(hit.id);
        if (hit.created) res.peopleCreated++;
      }
    }
    return [...new Set(ids)];
  }

  const peerMeetings = events.flatMap((event) => { try { return [buildMeetingNote(event)]; } catch { return []; } });
  const seenEvents = new Set(peerMeetings.map((m) => m.eventId));
  for (const note of meetings) {
    const md = note.metadata ?? {}, eventId = asStr(md.calendarEventId);
    if (!eventId || seenEvents.has(eventId)) continue;
    seenEvents.add(eventId);
    const names = Array.isArray(md.attendees) ? md.attendees.filter((v): v is string => typeof v === "string") : [];
    const emails = Array.isArray(md.attendeeEmails) ? md.attendeeEmails.filter((v): v is string => typeof v === "string") : [];
    peerMeetings.push({ eventId, title: asStr(md.title) ?? "", date: asStr(md.date) ?? "", path: note.path ?? "", content: "", metadata: md,
      attendees: [...names.map((name) => ({ name, email: name.includes("@") ? name : null })), ...emails.map((email) => ({ name: email, email }))] });
  }

  /** Ranked occurrence matching. Existing manual/legacy links are never reassigned. */
  async function linkTranscript(note: Note | null, noteId: string | null, m: MeetingNote): Promise<void> {
    const existing = asStr(note?.metadata?.transcriptNoteId);
    if (note && (hasRel(note, HAS_TRANSCRIPT) || existing)) {
      // Repair only links this matcher created, including a prior half-written pair.
      if (!existing || !noteId || note.metadata?.transcriptLinkOrigin !== "calendar-match-v1") return;
      const transcript = (await loadTranscripts()).find((t) => t.id === existing);
      if (!transcript || transcript.metadata?.meetingNoteId === noteId) return;
      if (asStr(transcript.metadata?.meetingNoteId)) {
        intent({ action: "link-transcript", effect: "blocked", noteId, eventId: m.eventId, reason: "Transcript was linked elsewhere; manual review required" });
        return;
      }
      if (opts.shadow) { intent({ action: "link-transcript", effect: "shadow", noteId, eventId: m.eventId, reason: "Repair incomplete transcript backlink" }); return; }
      try {
        await vault.updateNote(transcript.id, { metadata: { meetingNoteId: noteId } });
        transcript.metadata = { ...transcript.metadata, meetingNoteId: noteId };
        intent({ action: "link-transcript", effect: "applied", noteId, eventId: m.eventId, reason: "Repaired incomplete transcript backlink" });
      } catch (e) { intent({ action: "link-transcript", effect: "failed", noteId, eventId: m.eventId, reason: String(e) }); }
      return;
    }
    const list = await loadTranscripts();
    if (!list.length) return;
    const match = matchTranscript(m, list, peerMeetings);
    if (match.status === "none") return;
    if (match.status === "ambiguous") {
      intent({ action: "link-transcript", effect: "blocked", noteId: noteId ?? undefined, eventId: m.eventId, reason: "Ambiguous transcript/event candidates; manual review required", candidates: match.candidates.slice(0, 5) });
      return;
    }
    const best = match.candidates[0]!;
    if (best.score < 100 && (!recognized || nextPageToken || events.length >= opts.max)) {
      intent({ action: "link-transcript", effect: "blocked", noteId: noteId ?? undefined, eventId: m.eventId, reason: "Calendar response is incomplete; fuzzy transcript matching deferred" });
      return;
    }
    const t = list.find((t) => t.id === best.noteId)!;
    const md = t.metadata ?? {};
    const claim = () => (t.metadata = { ...md, meetingNoteId: noteId ?? `(new:${m.eventId})` });
    if (opts.shadow || !noteId) {
      intent({ action: "link-transcript", effect: "shadow", noteId: noteId ?? undefined, path: m.path, eventId: m.eventId, reason: `transcript ${t.id} (${best.evidence.join(", ")}; score ${best.score})` });
      claim();
      return;
    }
    try {
      await vault.updateNote(noteId, { metadata: { transcriptNoteId: t.id, transcriptLinkOrigin: "calendar-match-v1", transcriptLinkEvidence: best.evidence }, links: { add: [{ target: t.id, relationship: HAS_TRANSCRIPT }] } });
      if (note) note.metadata = { ...(note.metadata ?? {}), transcriptNoteId: t.id, transcriptLinkOrigin: "calendar-match-v1" };
      await vault.updateNote(t.id, { metadata: { meetingNoteId: noteId } });
      claim();
      res.transcriptLinks++;
      intent({ action: "link-transcript", effect: "applied", noteId, path: m.path, eventId: m.eventId, reason: `transcript ${t.id} (${best.evidence.join(", ")}; score ${best.score})` });
    } catch (e) {
      intent({ action: "link-transcript", effect: "failed", noteId, path: m.path, eventId: m.eventId, reason: String(e) });
    }
  }

  // ── upsert each event ──
  for (const ev of events) {
    let m: MeetingNote;
    try {
      m = buildMeetingNote(ev);
    } catch (e) {
      res.failed++;
      log(`event skipped: ${String(e)}`);
      continue;
    }
    try {
      let known = byEvent.get(m.eventId) ?? null;
      if (!known) {
        const atPath = byPath.get(m.path) ?? null;
        const owner = atPath ? asStr(atPath.metadata?.calendarEventId) : null;
        if (atPath && owner && owner !== m.eventId && batchIds.has(owner)) {
          // Another event in THIS response owns the note at our path (same title, same day).
          intent({ action: "skip-collision", effect: opts.shadow ? "shadow" : "logged", noteId: atPath.id, path: m.path, eventId: m.eventId, date: m.date, reason: `path held by event ${owner}` });
          res.unchanged++;
          continue;
        }
        known = atPath;
      }

      const personIds = await attendeeIds(m);
      const missingLinks: NoteLinkInput[] = personIds
        .filter((pid) => !known || !linked(known, pid, ATTENDED_BY))
        .map((pid) => ({ target: pid, relationship: ATTENDED_BY }));

      if (known) {
        const archived = (known.tags ?? []).includes(ARCHIVED_TAG);
        const md = known.metadata ?? {};
        const changedKeys = Object.keys(m.metadata).filter((k) => !sameJson(md[k], m.metadata[k]));
        if (!changedKeys.length && !missingLinks.length && !archived) {
          res.unchanged++;
        } else {
          const reason = [
            changedKeys.length ? `metadata: ${changedKeys.join(",")}` : "",
            missingLinks.length ? `+${missingLinks.length} attendee link(s)` : "",
            archived ? "event is back on the calendar" : "",
          ]
            .filter(Boolean)
            .join("; ");
          const action: IntentAction = archived ? "unarchive" : "update";
          if (opts.shadow) {
            intent({ action, effect: "shadow", noteId: known.id, path: known.path, eventId: m.eventId, date: m.date, reason });
          } else {
            const metadata = archived ? { ...m.metadata, archivedAt: null, archivedReason: null } : m.metadata;
            await vault.updateNote(known.id, {
              metadata,
              ...(missingLinks.length ? { links: { add: missingLinks } } : {}),
              ...(archived ? { tags: { remove: [ARCHIVED_TAG] } } : {}),
            });
            known.metadata = { ...md, ...m.metadata };
            if (archived) known.tags = (known.tags ?? []).filter((t) => t !== ARCHIVED_TAG);
            known.links = [...(known.links ?? []), ...missingLinks.map((l) => ({ sourceId: known!.id, targetId: l.target, relationship: l.relationship }))];
            intent({ action, effect: "applied", noteId: known.id, path: known.path, eventId: m.eventId, date: m.date, reason });
          }
          res.updated++;
        }
        byEvent.set(m.eventId, known);
        await linkTranscript(known, known.id, m);
        continue;
      }

      // ── create ──
      if (opts.shadow) {
        intent({ action: "create", effect: "shadow", path: m.path, eventId: m.eventId, date: m.date });
        res.created++;
        await linkTranscript(null, null, m);
        continue;
      }
      const note = await vault.createNote({
        content: m.content,
        path: m.path,
        metadata: m.metadata,
        tags: ["meeting"],
        ...(missingLinks.length ? { links: missingLinks } : {}),
        ifExists: "ignore", // never 409; a note found at the path is judged below, never overwritten blind
      });
      if (note.existed) {
        if (asStr(note.metadata?.calendarEventId) === m.eventId) {
          // Lost a race with the desktop for the same event: its note is ours to merge into.
          await vault.updateNote(note.id, { metadata: m.metadata, ...(missingLinks.length ? { links: { add: missingLinks } } : {}) });
          res.updated++;
          intent({ action: "update", effect: "applied", noteId: note.id, path: m.path, eventId: m.eventId, date: m.date, reason: "created concurrently by another writer" });
        } else {
          res.failed++;
          intent({ action: "skip-collision", effect: "failed", noteId: note.id, path: m.path, eventId: m.eventId, date: m.date, reason: "path held by a non-meeting or foreign note" });
          continue;
        }
      } else {
        res.created++;
        intent({ action: "create", effect: "applied", noteId: note.id, path: m.path, eventId: m.eventId, date: m.date });
      }
      const fresh: Note = {
        ...note,
        metadata: { ...(note.metadata ?? {}), ...m.metadata },
        tags: note.tags ?? ["meeting"],
        links: missingLinks.map((l) => ({ sourceId: note.id, targetId: l.target, relationship: l.relationship })),
      };
      meetings.push(fresh);
      index(fresh);
      byEvent.set(m.eventId, fresh);
      await linkTranscript(fresh, fresh.id, m);
    } catch (e) {
      res.failed++;
      log(`event ${m.eventId} failed: ${String(e)}`);
    }
  }

  await reconcile(vault, meetings, { events, recognized, nextPageToken }, opts, res, intent, log);
  return res;
}

/**
 * calendar_sync.rs reconcile_deletions, gated by mode. Decides EXACTLY as the
 * desktop (same guard, same scoping, same template-only test) and then:
 *   shadow        → record, write nothing;
 *   live + log    → record, write nothing;
 *   live + archive→ cancels applied as the desktop; deletes become an archive
 *                   (tag calendar-archived + event_status cancelled + archivedAt);
 *   live + delete → the desktop's behaviour.
 */
async function reconcile(
  vault: CalendarVault,
  meetings: Note[],
  fetched: { events: CalEvent[]; recognized: boolean; nextPageToken: string | null },
  opts: CalendarPassOptions,
  res: CalendarPassResult,
  intent: (i: Omit<CalendarIntent, "at" | "source" | "mode" | "deleteMode" | "window">) => void,
  log: (line: string) => void,
): Promise<void> {
  const { from, to, max } = opts;
  if (!fetched.recognized) res.reconcile.skipped = "unrecognised gog response shape";
  else if (fetched.events.length >= max) res.reconcile.skipped = `truncated: ${fetched.events.length} events == max ${max}`;
  else if (fetched.nextPageToken) res.reconcile.skipped = "truncated: response has a nextPageToken";
  if (res.reconcile.skipped) {
    log(`reconcile skipped for ${from}..${to} (${res.reconcile.skipped})`);
    return;
  }

  const seen = new Set(fetched.events.map((e) => asStr(e.id)).filter((x): x is string => !!x));
  const orphans: Array<{ note: Note; day: string; action: "delete" | "cancel"; why: string }> = [];
  for (const note of meetings) {
    const md = note.metadata;
    if (!md) continue;
    const eid = asStr(md.calendarEventId);
    if (!eid) continue; // hand-made meeting notes are never reconciled
    if (asStr(md.event_status) === "cancelled") continue;
    if ((note.tags ?? []).includes(ARCHIVED_TAG)) continue;
    const day = noteDay(md);
    if (!day || day < from || day > to) continue;
    if (seen.has(eid)) continue;

    const hasTranscript = !!asStr(md.transcriptNoteId);
    let templateOnly = false;
    if (!hasTranscript) {
      try {
        templateOnly = isTemplateOnly((await vault.getNote(note.id)).content ?? "");
      } catch {
        templateOnly = false; // can't confirm it's empty → never delete
      }
    }
    orphans.push({
      note,
      day,
      action: templateOnly ? "delete" : "cancel",
      why: templateOnly ? "event gone from Google; template-only note" : hasTranscript ? "event gone from Google; has transcript" : "event gone from Google; note has user content",
    });
  }
  res.reconcile.orphans = orphans.length;
  if (!orphans.length) return;

  const writes = !opts.shadow && opts.deleteMode !== "log";
  const brake = opts.maxOrphans ?? 0;
  const blocked = writes && brake > 0 && orphans.length > brake;
  if (blocked) log(`reconcile BLOCKED for ${from}..${to}: ${orphans.length} orphans > CALENDAR_MAX_ORPHANS_PER_PASS ${brake} — nothing removed`);

  for (const o of orphans) {
    const base = { noteId: o.note.id, path: o.note.path, eventId: asStr(o.note.metadata?.calendarEventId) ?? undefined, date: o.day };
    if (opts.shadow || opts.deleteMode === "log" || blocked) {
      const effect: IntentEffect = opts.shadow ? "shadow" : blocked ? "blocked" : "logged";
      intent({ action: o.action, effect, ...base, reason: o.why });
      if (effect === "blocked") res.reconcile.blocked++;
      else res.reconcile.logged++;
      log(`reconcile would ${o.action} ${o.note.id} ${o.note.path ?? ""} (${o.day}) — ${o.why} [${effect}]`);
      continue;
    }
    try {
      if (o.action === "cancel") {
        await vault.updateNote(o.note.id, { metadata: { event_status: "cancelled" } });
        o.note.metadata = { ...(o.note.metadata ?? {}), event_status: "cancelled" };
        res.reconcile.cancelled++;
        intent({ action: "cancel", effect: "applied", ...base, reason: o.why });
      } else if (opts.deleteMode === "archive") {
        const archivedAt = new Date(opts.now ?? Date.now()).toISOString();
        await vault.updateNote(o.note.id, {
          metadata: { event_status: "cancelled", archivedAt, archivedReason: "vanished-from-google-calendar" },
          tags: { add: [ARCHIVED_TAG] },
        });
        o.note.metadata = { ...(o.note.metadata ?? {}), event_status: "cancelled", archivedAt };
        o.note.tags = [...(o.note.tags ?? []), ARCHIVED_TAG];
        res.reconcile.archived++;
        intent({ action: "delete", effect: "archived", ...base, reason: o.why });
      } else {
        await vault.deleteNote(o.note.id);
        res.reconcile.deleted++;
        intent({ action: "delete", effect: "applied", ...base, reason: o.why });
      }
      log(`reconcile ${o.action === "delete" && opts.deleteMode === "archive" ? "archived" : o.action === "delete" ? "deleted" : "cancelled"} ${o.note.id} ${o.note.path ?? ""} (${o.day})`);
    } catch (e) {
      intent({ action: o.action, effect: "failed", ...base, reason: String(e) });
      log(`reconcile ${o.action} failed for ${o.note.id}: ${String(e)}`);
    }
  }
}

// ── modes, persistence, runners ──────────────────────────────────────────────

export type CalendarMode = "off" | "shadow" | "live";

/** Shadow wins over enabled: CALENDAR_SHADOW=true can never write. */
export function calendarMode(): CalendarMode {
  if (config.calendarShadow) return "shadow";
  return config.calendarSyncEnabled ? "live" : "off";
}

/** The health-registry name a pass reports under: `calendar` only when the server
 *  OWNS the source; a shadow run is its own source so the desktop inference stays. */
export const calendarSourceName = (): string => (calendarMode() === "shadow" ? "calendar-shadow" : "calendar");

const INTENTS_KEY = "calendar-intents";
const LAST_PASS_KEY = "calendar-last-pass";

export function readCalendarIntents(vaultId: string): CalendarIntent[] {
  try {
    const raw = getWorkerCursor(vaultId, INTENTS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as CalendarIntent[]) : [];
  } catch {
    return [];
  }
}

export function readCalendarLastPass(vaultId: string): unknown {
  try {
    const raw = getWorkerCursor(vaultId, LAST_PASS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistPass(vaultId: string, res: CalendarPassResult): void {
  const keep = Math.max(0, config.calendarIntentsKeep);
  if (res.intents.length && keep) {
    setWorkerCursor(vaultId, INTENTS_KEY, JSON.stringify([...readCalendarIntents(vaultId), ...res.intents].slice(-keep)));
  }
  const { intents, ...summary } = res;
  setWorkerCursor(vaultId, LAST_PASS_KEY, JSON.stringify({ at: new Date().toISOString(), ...summary, intentCount: intents.length }));
}

/** Serialize passes per vault: the worker tick and the range route must never
 *  reconcile the same notes concurrently. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(vaultId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(vaultId, next);
  try {
    return await next;
  } finally {
    if (locks.get(vaultId) === next) locks.delete(vaultId);
  }
}

function googleAccount(vaultId: string): string | null {
  const raw = getSecret(vaultId, config.ownerEmail, "google");
  if (!raw) return null;
  const { account } = JSON.parse(raw) as { account?: string };
  if (!account) throw new Error("google credential has no account");
  return account;
}

function summarize(tag: string, res: CalendarPassResult): string {
  const r = res.reconcile;
  return (
    `[calendar] ${tag} ${res.window.from}..${res.window.to} [${res.mode}${res.mode === "live" ? `/${res.deleteMode}` : ""}]: ` +
    `${res.fetched} events → +${res.created} ~${res.updated} =${res.unchanged}` +
    (res.failed ? ` !${res.failed} FAILED` : "") +
    (res.peopleCreated ? `, ${res.peopleCreated} people` : "") +
    (res.transcriptLinks ? `, ${res.transcriptLinks} transcript links` : "") +
    (r.skipped ? ` · reconcile skipped (${r.skipped})` : ` · orphans ${r.orphans}: -${r.deleted} deleted, ${r.cancelled} cancelled, ${r.archived} archived, ${r.logged} logged, ${r.blocked} blocked`)
  );
}

// ── live-action reflection (parity A) ────────────────────────────────────────

/** The vault surface `reflectLiveCalendarChange` uses. */
export interface ReflectVault {
  listNotes(opts: { tags?: string[]; includeMetadata?: string[] }): Promise<Note[]>;
  updateNote(id: string, p: { metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note>;
}

export type LiveCalendarChange =
  /** gog's updated event (preferred), else the fields the owner sent. */
  | { kind: "update"; event: CalEvent | null; fields: { title?: string; start?: string; end?: string; location?: string; attendees?: string[] } }
  | { kind: "delete" };

const REFLECT_LOCK_WAIT_MS = 5_000;

export interface ReflectResult {
  noteId: string | null;
  /** "deferred" = an ingest pass held the lock longer than the bounded wait. */
  outcome: "updated" | "cancelled" | "unchanged" | "no-note" | "conflict" | "failed" | "deferred";
}

/**
 * Mirror a live-action edit/delete (routes/actions.ts calendar/update|delete)
 * onto the event's meeting note right away, so the Calendar does not wait for the
 * next 5-min ingest pass. Uses the INGEST'S conventions exactly, so the next pass
 * sees nothing to change:
 *   - update → the metadata `buildMeetingNote` derives from gog's returned event
 *     (only the keys that differ are written; path and body are never touched —
 *     the ingest never moves or rewrites an existing note either). If gog's output
 *     had no event, the owner's own fields are mapped onto title/start/end/date/
 *     location/attendees;
 *   - delete → SOFT-CANCEL: `event_status: "cancelled"` (the ingest's reconcile
 *     leaves an already-cancelled note alone, and the Calendar hides it). Never a
 *     hard delete — the note may hold the owner's meeting notes.
 * Found by `metadata.calendarEventId` only (a hand-made note is never matched).
 * Every write carries `if_updated_at`; a conflict is reported, not retried (the
 * ingest converges it). Serialized with the ingest passes (same per-vault lock).
 * Best-effort: never throws.
 */
export async function reflectLiveCalendarChange(
  vault: ReflectVault,
  vaultId: string,
  eventId: string,
  change: LiveCalendarChange,
  opts: { lockWaitMs?: number } = {},
): Promise<ReflectResult> {
  // Bounded wait for a running ingest pass (security review L1): a long pass
  // must never hold the owner's HTTP response; the next pass converges the note.
  const deadline = Date.now() + (opts.lockWaitMs ?? REFLECT_LOCK_WAIT_MS);
  while (locks.has(vaultId)) {
    const left = deadline - Date.now();
    if (left <= 0) return { noteId: null, outcome: "deferred" };
    const prev = locks.get(vaultId)!;
    await Promise.race([prev.catch(() => {}), new Promise((r) => setTimeout(r, left))]);
  }
  // No await between the check above and withLock registering itself.
  return withLock(vaultId, async (): Promise<ReflectResult> => {
    let note: Note | undefined;
    try {
      const meetings = await vault.listNotes({ tags: ["meeting"] });
      note = meetings.find((n) => asStr(n.metadata?.calendarEventId) === eventId);
    } catch {
      return { noteId: null, outcome: "failed" };
    }
    if (!note) return { noteId: null, outcome: "no-note" };
    const md = note.metadata ?? {};
    let patch: Record<string, unknown>;
    if (change.kind === "delete") {
      if (asStr(md.event_status) === "cancelled") return { noteId: note.id, outcome: "unchanged" };
      patch = { event_status: "cancelled" };
    } else {
      let want: Record<string, unknown>;
      if (change.event && asStr(change.event.id) === eventId) {
        want = buildMeetingNote(change.event).metadata;
      } else {
        const f = change.fields;
        want = {};
        if (f.title !== undefined) want.title = f.title;
        if (f.start !== undefined) {
          want.start = f.start;
          want.date = f.start.slice(0, 10);
        }
        if (f.end !== undefined) want.end = f.end;
        if (f.location !== undefined) want.location = f.location === "" ? null : f.location;
        if (f.attendees !== undefined) want.attendees = f.attendees;
      }
      patch = {};
      for (const [k, v] of Object.entries(want)) if (!sameJson(md[k], v)) patch[k] = v;
      if (!Object.keys(patch).length) return { noteId: note.id, outcome: "unchanged" };
    }
    try {
      await vault.updateNote(note.id, { metadata: patch, ...(note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {}) });
      return { noteId: note.id, outcome: change.kind === "delete" ? "cancelled" : "updated" };
    } catch (e) {
      return { noteId: note.id, outcome: (e as { status?: number }).status === 409 ? "conflict" : "failed" };
    }
  });
}

let testRunner: GogRunner | null = null;
/** Tests only: make the route + worker use a fake gog. Never the real CLI in tests. */
export function setCalendarGogRunnerForTests(run: GogRunner | null): void {
  testRunner = run;
}

const loggedNoCred = new Set<string>();

/**
 * One background pass for a vault (worker tick). No-op when CALENDAR_SYNC_ENABLED
 * and CALENDAR_SHADOW are both off, or the vault has no `google` credential.
 * Throttled to one pass per CALENDAR_INTERVAL_MS slot; `force` bypasses that.
 * Throws when gog or the meeting listing fails, or every event failed, so the
 * health registry sees it.
 */
export async function runCalendarOnce(
  entry: VaultEntry,
  opts: { force?: boolean; run?: GogRunner; now?: number } = {},
): Promise<number> {
  const mode = calendarMode();
  if (mode === "off") return 0;
  const account = googleAccount(entry.id);
  if (!account) {
    if (!loggedNoCred.has(entry.id)) {
      loggedNoCred.add(entry.id);
      console.log(`[calendar] ${entry.id}: no google credential — calendar ingest idle`);
    }
    return 0;
  }
  if (config.calendarIntervalMs <= 0 && !opts.force) return 0;
  const now = opts.now ?? Date.now();
  const slot = Math.floor(now / Math.max(1, config.calendarIntervalMs));
  if (!opts.force) {
    if (getWorkerCursor(entry.id, "calendar-slot") === String(slot)) return 0;
    setWorkerCursor(entry.id, "calendar-slot", String(slot)); // claim up front
  }
  const { from, to } = syncWindow(now);
  const client = new CalendarClient(account, opts.run ?? testRunner ?? defaultGogRunner());
  const res = await withLock(entry.id, () =>
    syncCalendarWindow(client, vaultClient(entry.id) as unknown as CalendarVault, {
      from,
      to,
      max: 250,
      shadow: mode === "shadow",
      deleteMode: config.calendarDeleteMode,
      source: "worker",
      maxOrphans: config.calendarMaxOrphansPerPass,
      now,
      log: (l) => console.log(`[calendar] ${entry.id}: ${l}`),
    }),
  );
  persistPass(entry.id, res);
  console.log(summarize(entry.id, res));
  if (res.failed && res.failed === res.fetched) throw new Error(`calendar: all ${res.failed} event(s) failed`);
  return res.created + res.updated;
}

/** Strict YYYY-MM-DD (also keeps anything flag-shaped out of gog's argv). */
export const isIsoDay = (s: string): boolean => parseDay(s) !== null && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The on-demand range sync (replaces the desktop's `calendar_sync_range`): the
 * caller's window, max 100, then reconcile that window — under the same modes.
 * Returns the desktop's response shape plus the server's counters.
 */
export async function runCalendarRange(
  vaultId: string,
  from: string,
  to: string,
  opts: { run?: GogRunner; now?: number } = {},
): Promise<Record<string, unknown>> {
  const mode = calendarMode();
  if (mode === "off") throw Object.assign(new Error("calendar sync is disabled on this server"), { code: "disabled" });
  const account = googleAccount(vaultId);
  if (!account) throw Object.assign(new Error("No Google account configured"), { code: "no_account" });
  const client = new CalendarClient(account, opts.run ?? testRunner ?? defaultGogRunner());
  const res = await withLock(vaultId, () =>
    syncCalendarWindow(client, vaultClient(vaultId) as unknown as CalendarVault, {
      from,
      to,
      max: 100,
      shadow: mode === "shadow",
      deleteMode: config.calendarDeleteMode,
      source: "range",
      maxOrphans: config.calendarMaxOrphansPerPass,
      now: opts.now,
      log: (l) => console.log(`[calendar] ${vaultId} range: ${l}`),
    }),
  );
  persistPass(vaultId, res);
  console.log(summarize(`${vaultId} range`, res));
  return {
    synced: res.created + res.updated + res.unchanged,
    errors: res.failed,
    deleted: res.reconcile.deleted,
    cancelled: res.reconcile.cancelled,
    total: res.fetched,
    from,
    to,
    mode: res.mode,
    deleteMode: res.deleteMode,
    created: res.created,
    updated: res.updated,
    unchanged: res.unchanged,
    archived: res.reconcile.archived,
    reconcile: res.reconcile,
    intents: res.intents.length,
  };
}

/**
 * For the overseer's shadow comparison: re-read every note a delete/cancel intent
 * named and report what is there NOW — `gone` (someone, i.e. the desktop, deleted
 * it), `cancelled`, `archived`, or `present`. Read-only. Most recent first.
 */
export async function verifyCalendarIntents(
  vaultId: string,
  intents: CalendarIntent[],
  vault: Pick<CalendarVault, "getNote"> = vaultClient(vaultId),
  limit = 100,
): Promise<Array<{ noteId: string; path: string | null | undefined; intended: IntentAction; effect: IntentEffect; at: string; now: "gone" | "cancelled" | "archived" | "present" | "unknown" }>> {
  const out: Awaited<ReturnType<typeof verifyCalendarIntents>> = [];
  const done = new Set<string>();
  for (const i of [...intents].reverse()) {
    if (out.length >= limit) break;
    if ((i.action !== "delete" && i.action !== "cancel") || !i.noteId || done.has(i.noteId)) continue;
    done.add(i.noteId);
    let now: "gone" | "cancelled" | "archived" | "present" | "unknown" = "unknown";
    try {
      const n = await vault.getNote(i.noteId);
      now = (n.tags ?? []).includes(ARCHIVED_TAG) ? "archived" : asStr(n.metadata?.event_status) === "cancelled" ? "cancelled" : "present";
    } catch (e) {
      now = (e as { status?: number }).status === 404 || /\b404\b/.test(String(e)) ? "gone" : "unknown";
    }
    out.push({ noteId: i.noteId, path: i.path, intended: i.action, effect: i.effect, at: i.at, now });
  }
  return out;
}
