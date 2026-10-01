/**
 * Live calendar actions via the `gog` CLI (Arch v2 WP1.5): RSVP and create.
 *
 * Same `google` credential (`{account}`) and the same injectable `GogRunner` as
 * the calendar ingest (worker/calendar.ts). GOTCHA: real gog reads its OAuth
 * token from the macOS login keychain, which works under pm2 (a GUI-session
 * launchd job) but NOT from a plain ssh / agent shell — never try these from one;
 * tests always inject a fake runner.
 *
 * argv (gog v0.25 — `gog calendar respond --help` / `create --help`):
 *   rsvp:   calendar respond primary <eventId> --status=<accepted|declined|tentative> --account=<a> --json --no-input
 *   create: calendar create primary --summary=… --from=<RFC3339> --to=<RFC3339>
 *           [--attendees=a,b] [--location=…] [--description=…] [--send-updates=all|none]
 *           --account=<a> --json --no-input
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

/** Run gog. A spawn/exit failure of a WRITE command is outcome-unknown (it may have reached Google). */
export async function runGog(args: string[]): Promise<string> {
  const run = testRunner ?? defaultGogRunner();
  try {
    return await run(args);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/\s+/g, " ");
    const notFound = /ENOENT|not found/i.test(msg) && !/event/i.test(msg);
    throw new ActionTransportError(`gog failed: ${msg.slice(0, 300)}`, notFound ? false : "unknown");
  }
}
