/**
 * Live calendar actions via the `gog` CLI (Arch v2 WP1.5): RSVP and create.
 *
 * Same `google` credential (`{account}`) and the same injectable `GogRunner` as
 * the calendar ingest (worker/calendar.ts). GOTCHA: real gog reads its OAuth
 * token from the macOS login keychain, which works under pm2 (a GUI-session
 * launchd job) but NOT from a plain ssh / agent shell — never try these from one;
 * tests always inject a fake runner.
 *
 * argv (gog v0.25 — `gog calendar respond|create|update|delete --help`):
 *   rsvp:   calendar respond primary <eventId> --status=<accepted|declined|tentative> --account=<a> --json --no-input
 *   create: calendar create primary --summary=… --from=<RFC3339> --to=<RFC3339>
 *           [--attendees=a,b] [--location=…] [--description=…] [--send-updates=all|none]
 *           --account=<a> --json --no-input
 *   update: calendar update primary <eventId> [--summary=…] [--from=… --to=…] [--location=…]
 *           [--description=…] [--attendees=a,b] --send-updates=all|none --account=<a> --json --no-input
 *           (an empty --location= / --description= clears it; --attendees REPLACES the list)
 *   delete: calendar delete primary <eventId> --send-updates=all|none --force --account=<a> --json --no-input
 *           (--force: gog otherwise asks for confirmation, and --no-input turns that into a failure)
 * Every value is passed as ONE `--flag=value` element (execFile, no shell), so a
 * value can never be read as another flag; ids are additionally allowlisted.
 */
import { defaultGogRunner, type GogRunner } from "../worker/gmail";
import { ActionInputError, ActionTransportError, validateAddress } from "./email";

export const RSVP_RESPONSES = ["accepted", "declined", "tentative"] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];

// Google event ids are base32hex; recurring instances add `_<timestamp>`; imported
// ones may carry `@google.com`. Never a leading "-".
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,1023}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_SPAN_MS = 31 * 24 * 3_600_000;

export const CAL_LIMITS = { maxTitle: 500, maxLocation: 1000, maxDescription: 8000, maxAttendees: 50 } as const;

const noCtl = (field: string, v: string) => {
  // eslint-disable-next-line no-control-regex
  if (/[\0\r\n]/.test(v) && field !== "description") throw new ActionInputError(`${field}: line breaks are not allowed`);
  if (v.includes("\0")) throw new ActionInputError(`${field}: invalid characters`);
};

export function validateEventId(v: unknown): string {
  if (typeof v !== "string" || !EVENT_ID_RE.test(v)) throw new ActionInputError("eventId: not a valid calendar event id");
  return v;
}

export function rsvpArgs(account: string, eventId: string, response: string): string[] {
  if (!(RSVP_RESPONSES as readonly string[]).includes(response)) throw new ActionInputError("response: must be accepted, declined or tentative");
  return ["calendar", "respond", "primary", validateEventId(eventId), `--status=${response}`, `--account=${account}`, "--json", "--no-input"];
}

export interface CreateInput {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string;
  description?: string;
  notify: boolean;
}

export function validateCreateInput(b: Record<string, unknown>): CreateInput {
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) throw new ActionInputError("title: required");
  noCtl("title", title);
  if (title.length > CAL_LIMITS.maxTitle) throw new ActionInputError("title: too long");
  const start = typeof b.start === "string" ? b.start.trim() : "";
  const end = typeof b.end === "string" ? b.end.trim() : "";
  if (!RFC3339_RE.test(start) || Number.isNaN(Date.parse(start))) throw new ActionInputError("start: an RFC 3339 date-time with offset is required");
  if (!RFC3339_RE.test(end) || Number.isNaN(Date.parse(end))) throw new ActionInputError("end: an RFC 3339 date-time with offset is required");
  const span = Date.parse(end) - Date.parse(start);
  if (span <= 0) throw new ActionInputError("end: must be after start");
  if (span > MAX_SPAN_MS) throw new ActionInputError("end: an event may span at most 31 days");
  const raw = b.attendees === undefined || b.attendees === null ? [] : Array.isArray(b.attendees) ? b.attendees : [b.attendees];
  if (raw.length > CAL_LIMITS.maxAttendees) throw new ActionInputError(`attendees: at most ${CAL_LIMITS.maxAttendees}`);
  const attendees = [...new Set(raw.map((a, i) => validateAddress(`attendees[${i}]`, a)))];
  const out: CreateInput = { title, start, end, attendees, notify: b.notify !== false };
  if (b.location !== undefined && b.location !== null && b.location !== "") {
    if (typeof b.location !== "string") throw new ActionInputError("location: must be a string");
    noCtl("location", b.location);
    if (b.location.length > CAL_LIMITS.maxLocation) throw new ActionInputError("location: too long");
    out.location = b.location;
  }
  if (b.description !== undefined && b.description !== null && b.description !== "") {
    if (typeof b.description !== "string") throw new ActionInputError("description: must be a string");
    noCtl("description", b.description);
    if (b.description.length > CAL_LIMITS.maxDescription) throw new ActionInputError("description: too long");
    out.description = b.description;
  }
  return out;
}

export function createArgs(account: string, c: CreateInput): string[] {
  const args = ["calendar", "create", "primary", `--summary=${c.title}`, `--from=${c.start}`, `--to=${c.end}`];
  if (c.attendees.length) args.push(`--attendees=${c.attendees.join(",")}`);
  if (c.location) args.push(`--location=${c.location}`);
  if (c.description) args.push(`--description=${c.description}`);
  if (c.attendees.length) args.push(`--send-updates=${c.notify ? "all" : "none"}`);
  args.push(`--account=${account}`, "--json", "--no-input");
  return args;
}

export interface UpdateInput {
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  /** "" clears it. */
  location?: string;
  /** "" clears it. */
  description?: string;
  /** Replaces the whole guest list when present. */
  attendees?: string[];
  notify: boolean;
}

const optText = (b: Record<string, unknown>, k: "location" | "description", max: number): string | undefined => {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ActionInputError(`${k}: must be a string`);
  noCtl(k, v);
  if (v.length > max) throw new ActionInputError(`${k}: too long`);
  return v;
};

/** Validate an edit: the event id plus at least one field. start/end go together. */
export function validateUpdateInput(b: Record<string, unknown>): UpdateInput {
  if (b.notify !== undefined && typeof b.notify !== "boolean") throw new ActionInputError("notify: true or false");
  const out: UpdateInput = { eventId: validateEventId(b.eventId), notify: b.notify !== false };
  if (b.title !== undefined && b.title !== null) {
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) throw new ActionInputError("title: may not be empty");
    noCtl("title", title);
    if (title.length > CAL_LIMITS.maxTitle) throw new ActionInputError("title: too long");
    out.title = title;
  }
  const hasStart = b.start !== undefined && b.start !== null;
  const hasEnd = b.end !== undefined && b.end !== null;
  if (hasStart !== hasEnd) throw new ActionInputError("start and end: send both or neither");
  if (hasStart) {
    const start = typeof b.start === "string" ? b.start.trim() : "";
    const end = typeof b.end === "string" ? b.end.trim() : "";
    if (!RFC3339_RE.test(start) || Number.isNaN(Date.parse(start))) throw new ActionInputError("start: an RFC 3339 date-time with offset is required");
    if (!RFC3339_RE.test(end) || Number.isNaN(Date.parse(end))) throw new ActionInputError("end: an RFC 3339 date-time with offset is required");
    const span = Date.parse(end) - Date.parse(start);
    if (span <= 0) throw new ActionInputError("end: must be after start");
    if (span > MAX_SPAN_MS) throw new ActionInputError("end: an event may span at most 31 days");
    out.start = start;
    out.end = end;
  }
  const loc = optText(b, "location", CAL_LIMITS.maxLocation);
  if (loc !== undefined) out.location = loc;
  const desc = optText(b, "description", CAL_LIMITS.maxDescription);
  if (desc !== undefined) out.description = desc;
  if (b.attendees !== undefined && b.attendees !== null) {
    if (!Array.isArray(b.attendees)) throw new ActionInputError("attendees: must be a list of addresses");
    if (b.attendees.length > CAL_LIMITS.maxAttendees) throw new ActionInputError(`attendees: at most ${CAL_LIMITS.maxAttendees}`);
    out.attendees = [...new Set(b.attendees.map((a, i) => validateAddress(`attendees[${i}]`, a)))];
  }
  if (out.title === undefined && out.start === undefined && out.location === undefined && out.description === undefined && out.attendees === undefined) {
    throw new ActionInputError("nothing to update: send at least one of title, start+end, location, description, attendees");
  }
  return out;
}

// ── recurring-event scope (security review H1) ──────────────────────────────
//
// gog v0.25 `calendar update|delete` default to `--scope=all` — the WHOLE series
// when the id is a recurring master, and gog may resolve an instance to its
// series. So every update/delete first READS the event (`gog calendar event`)
// and decides the scope explicitly; the argv always carries `--scope=…`:
//   - an INSTANCE (`recurringEventId` set) → `--scope=single
//     --original-start=<its originalStartTime.dateTime>` (strict RFC 3339, and it
//     must agree with an `_YYYYMMDDTHHMMSSZ` id suffix when there is one). An
//     all-day instance (date-only original start) is refused: gog wants RFC 3339;
//   - a recurring SERIES MASTER (`recurrence` non-empty) → refused (409
//     `recurring_series`, nothing sent) unless the client sent `scope: "all"`
//     (the UI's distinct "ALL occurrences" confirmation) → `--scope=all`;
//   - a plain, non-recurring event → `--scope=all` (= that one event; gog's
//     `single` needs an original start, which a non-recurring event has none of).
// `scope: "all"` on anything but a series master is a 400.

export type CalendarScope = { scope: "single"; originalStart: string } | { scope: "all" };

export class ScopeRefusal extends Error {
  constructor(
    readonly code: "recurring_series" | "unsupported_instance" | "event_mismatch",
    message: string,
  ) {
    super(message);
  }
}

const INSTANCE_SUFFIX_RE = /_(\d{8})(T\d{6}Z)?$/;
const RFC3339_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** `gog calendar event primary <id>` — read-only, used to decide the scope. */
export function eventGetArgs(account: string, eventId: string): string[] {
  return ["calendar", "event", "primary", validateEventId(eventId), `--account=${account}`, "--json", "--no-input"];
}

/** Decide the scope from the fetched event (pure; see the block comment above). */
export function resolveScope(eventId: string, ev: Record<string, unknown>, requested: "all" | undefined): CalendarScope {
  if (typeof ev.id === "string" && ev.id !== eventId) throw new ScopeRefusal("event_mismatch", "gog returned a different event than the one requested");
  const recurringEventId = typeof ev.recurringEventId === "string" && ev.recurringEventId ? ev.recurringEventId : null;
  const recurrence = Array.isArray(ev.recurrence) && ev.recurrence.length > 0;
  const suffix = INSTANCE_SUFFIX_RE.exec(eventId);
  if (recurringEventId) {
    if (requested === "all") throw new ActionInputError('scope: "all" is only accepted for a recurring series id, not one occurrence');
    const ost = (ev.originalStartTime ?? {}) as Record<string, unknown>;
    const dt = typeof ost.dateTime === "string" ? ost.dateTime : null;
    if (!dt) throw new ScopeRefusal("unsupported_instance", "All-day recurring occurrences can't be changed from Prism yet — edit this one in Google Calendar.");
    if (!RFC3339_STRICT.test(dt) || Number.isNaN(Date.parse(dt))) throw new ScopeRefusal("event_mismatch", "the occurrence has no valid original start time");
    if (suffix?.[2]) {
      const fromId = `${suffix[1]!.slice(0, 4)}-${suffix[1]!.slice(4, 6)}-${suffix[1]!.slice(6, 8)}T${suffix[2].slice(1, 3)}:${suffix[2].slice(3, 5)}:${suffix[2].slice(5, 7)}Z`;
      if (Date.parse(fromId) !== Date.parse(dt)) throw new ScopeRefusal("event_mismatch", "the occurrence id and its original start time disagree");
    }
    return { scope: "single", originalStart: dt };
  }
  if (suffix) throw new ScopeRefusal("event_mismatch", "that id looks like one occurrence, but Google does not report it as part of a series");
  if (recurrence) {
    if (requested !== "all") {
      throw new ScopeRefusal("recurring_series", "This is a recurring series. Changing it affects ALL occurrences — confirm that explicitly, or pick one occurrence.");
    }
    return { scope: "all" };
  }
  if (requested === "all") throw new ActionInputError('scope: "all" is only accepted for a recurring series');
  return { scope: "all" };
}

const scopeArgs = (s: CalendarScope): string[] => (s.scope === "single" ? ["--scope=single", `--original-start=${s.originalStart}`] : ["--scope=all"]);

export function updateArgs(account: string, u: UpdateInput, scope: CalendarScope): string[] {
  const args = ["calendar", "update", "primary", validateEventId(u.eventId), ...scopeArgs(scope)];
  if (u.title !== undefined) args.push(`--summary=${u.title}`);
  if (u.start !== undefined && u.end !== undefined) args.push(`--from=${u.start}`, `--to=${u.end}`);
  if (u.location !== undefined) args.push(`--location=${u.location}`);
  if (u.description !== undefined) args.push(`--description=${u.description}`);
  if (u.attendees !== undefined) args.push(`--attendees=${u.attendees.join(",")}`);
  args.push(`--send-updates=${u.notify ? "all" : "none"}`, `--account=${account}`, "--json", "--no-input");
  return args;
}

export function deleteArgs(account: string, eventId: string, notify: boolean, scope: CalendarScope): string[] {
  return ["calendar", "delete", "primary", validateEventId(eventId), ...scopeArgs(scope), `--send-updates=${notify ? "all" : "none"}`, "--force", `--account=${account}`, "--json", "--no-input"];
}

/** `scope` from a request body: absent, or exactly "all". */
export function validateScopeField(v: unknown): "all" | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "all") return "all";
  throw new ActionInputError('scope: only "all" (every occurrence of a recurring series) may be sent');
}

/** The event object out of gog's JSON (`{event: {...}}` or the bare event), or null. */
export function parseEvent(stdout: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const ev = (j && typeof j.event === "object" && j.event ? j.event : j) as Record<string, unknown>;
    return ev && typeof ev.id === "string" ? ev : null;
  } catch {
    return null;
  }
}

/**
 * Google / gog refusals of an update or delete that provably changed nothing
 * upstream (the event is gone, you may not edit it, gog's own flag validation).
 * Returns a code + friendly detail, or null for anything unrecognised (stays
 * outcome-unknown: the key is kept, never a blind retry).
 */
export function classifyCalendarWriteRefusal(message: string): { code: "event_not_found" | "not_editable" | "rejected"; status: 404 | 409; detail: string } | null {
  if (/\b(404|410)\b|not ?found|has been deleted|resource has been removed/i.test(message))
    return { code: "event_not_found", status: 404, detail: "That event no longer exists in Google Calendar (it may already be deleted)." };
  if (/\b403\b|forbidden|insufficient permission|writer access|requiredAccessLevel|not the organizer|cannot (modify|change|edit)/i.test(message))
    return { code: "not_editable", status: 409, detail: "Google Calendar does not let this account change that event (you are probably not its organizer)." };
  if (/no (updates|changes|fields) (provided|specified)|invalid (time|date|rfc ?3339)|must be (after|before)/i.test(message))
    return { code: "rejected", status: 409, detail: "gog refused the change before contacting Google." };
  return null;
}

/** Pull the created event's id/link out of gog's JSON (tolerant of envelope shapes). */
export function parseCreated(stdout: string): { eventId: string | null; htmlLink: string | null } {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const ev = (j.event && typeof j.event === "object" ? j.event : j) as Record<string, unknown>;
    const id = typeof ev.id === "string" ? ev.id : null;
    const link = typeof ev.htmlLink === "string" && /^https:\/\//.test(ev.htmlLink) ? ev.htmlLink : null;
    return { eventId: id, htmlLink: link };
  } catch {
    return { eventId: null, htmlLink: null };
  }
}

/**
 * gog refuses some RSVPs BEFORE calling Google (nothing changed upstream). These
 * are not failures to retry: they mean the action does not apply to this event.
 * Returns a friendly detail, or null for anything unrecognised (stays outcome-unknown).
 */
export function classifyRsvpRefusal(message: string): string | null {
  if (/cannot respond to your own event|you are the organizer/i.test(message))
    return "You organize this event, so there is no invitation to respond to.";
  if (/event has no attendees/i.test(message)) return "This event has no guests, so there is no invitation to respond to.";
  if (/not (an )?(attendee|invited)|you are not (a )?(guest|attendee)/i.test(message))
    return "You are not listed as a guest on this event, so there is no invitation to respond to.";
  return null;
}

let testRunner: GogRunner | null = null;
/** Inject a fake gog (tests). `null` restores the real binary. */
export function setActionsGogRunnerForTests(run: GogRunner | null): void {
  testRunner = run;
}

/**
 * A failed gog run. `stderr` is what gog itself printed — the ONLY text refusal
 * classification may read (security review H2): Node's execFile `err.message`
 * starts with `Command failed: <full argv>`, so a title like "Fix the 404 page"
 * would otherwise look like a Google 404. `stderr` is null when the outcome is
 * unknowable (killed / signalled / timed out / no stderr captured), and then
 * nothing is ever classified as "nothing was sent". The message never holds argv.
 */
export class GogError extends ActionTransportError {
  constructor(
    message: string,
    sent: false | "unknown",
    readonly stderr: string | null,
  ) {
    super(message, sent);
  }
}

const asText = (v: unknown): string | null => (typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : null);

/** Map a GogRunner rejection (an execFile error, or a test fake) to a GogError. */
export function gogFailure(e: unknown): GogError {
  const x = (e ?? {}) as { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
  // Missing binary: execFile's spawn error carries code === "ENOENT" (a string;
  // a normal non-zero exit carries a NUMBER code). Nothing was sent.
  if (x.code === "ENOENT") return new GogError("gog failed: the gog binary was not found", false, null);
  const aborted = x.killed === true || (typeof x.signal === "string" && x.signal !== "") || x.code === "ETIMEDOUT" || x.code === "ABORT_ERR";
  if (aborted) return new GogError("gog failed: killed or timed out (outcome unknown)", "unknown", null);
  const stderr = asText(x.stderr);
  const exit = typeof x.code === "number" ? ` (exit ${x.code})` : "";
  const shown = stderr ? `: ${stderr.replace(/\s+/g, " ").trim().slice(0, 300)}` : "";
  return new GogError(`gog failed${exit}${shown}`, "unknown", stderr && stderr.trim() ? stderr : null);
}

/** Run gog. A spawn/exit failure of a WRITE command is outcome-unknown (it may have
 *  reached Google) unless gog's own stderr later proves otherwise (classifiers). */
export async function runGog(args: string[]): Promise<string> {
  const run = testRunner ?? defaultGogRunner();
  try {
    return await run(args);
  } catch (e) {
    throw gogFailure(e);
  }
}
