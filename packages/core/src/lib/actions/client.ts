/**
 * Live actions seam (Arch v2 WP1.5): the UI's way to act AS the owner toward the
 * outside world — email via Proton Bridge, calendar via gog, Matrix — through
 * the Prism Server's `/api/actions/*` (server-owner only, flag-gated, audited,
 * idempotent; docs/live-actions.md).
 *
 * Injected like VaultClient / AgentClient: the web shell provides an HTTP client
 * (PWA cookie or native bearer, via its `serverFetch`); the desktop provides
 * none and keeps its Tauri commands. Components call `useLiveActions()` and fall
 * back to the Tauri path when it returns null.
 *
 * Every SENDING call carries an `Idempotency-Key`: one fresh key per user
 * action, reused only by this client's own automatic retry of a network failure
 * (so a lost response can never send twice). Pass `idempotencyKey` to control
 * it (e.g. keep one key across a user's "retry" of an outcome-unknown failure).
 */

export interface LiveActionsStatus {
  email: { enabled: boolean; configured: boolean };
  calendar: { enabled: boolean; configured: boolean };
  matrix: { enabled: boolean; configured: boolean; agentRooms: number };
}

export class LiveActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    /** For upstream failures: false = nothing was sent (safe to retry); "unknown" = it may have been. */
    readonly sent?: false | "unknown",
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface EmailSendParams {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}
export interface EmailReplyParams {
  /** The stored email note being replied to. */
  noteId: string;
  /** The recipient address(es) the UI SHOWED the user; the server refuses
   *  (409 `target_changed`) if it would send anywhere else. */
  expectTo: string[];
  body: string;
  html?: string;
  cc?: string[];
}
export interface EmailTarget {
  noteId?: string;
  messageId?: string;
  mailbox?: string;
}
export interface CalendarCreateParams {
  title: string;
  /** RFC 3339 with offset. */
  start: string;
  end: string;
  attendees?: string[];
  location?: string;
  description?: string;
  /** Email invitations to attendees (default true). */
  notify?: boolean;
}
export type RsvpResponse = "accepted" | "declined" | "tentative";
/** Edit a Google-synced event. Omitted fields are left as they are. */
export interface CalendarUpdateParams {
  eventId: string;
  title?: string;
  /** RFC 3339 with offset; send start and end together. */
  start?: string;
  end?: string;
  /** "" clears it. */
  location?: string;
  /** "" clears it. */
  description?: string;
  /** Replaces the whole guest list. */
  attendees?: string[];
  /** Email guests about the change (default true). */
  notify?: boolean;
  /** ONLY for a recurring SERIES id: change every occurrence (the UI's explicit
   *  "ALL occurrences" confirmation). An occurrence id is always changed alone. */
  scope?: "all";
}
/** How the server mirrored the change onto the event's meeting note. */
export interface CalendarNoteReflection {
  noteId: string | null;
  outcome: "updated" | "cancelled" | "unchanged" | "no-note" | "conflict" | "failed" | "deferred";
}

type Opts = { idempotencyKey?: string };

export interface LiveActionsClient {
  status(): Promise<LiveActionsStatus>;
  emailSend(p: EmailSendParams, o?: Opts): Promise<{ messageId: string; accepted: number; rejected: number }>;
  emailReply(p: EmailReplyParams, o?: Opts): Promise<{ messageId: string; inReplyTo: string }>;
  emailArchive(t: EmailTarget): Promise<{ archived: boolean }>;
  emailMarkRead(t: EmailTarget, read: boolean): Promise<{ read: boolean }>;
  calendarRsvp(eventId: string, response: RsvpResponse): Promise<{ eventId: string; response: RsvpResponse }>;
  calendarCreate(p: CalendarCreateParams, o?: Opts): Promise<{ eventId: string | null; htmlLink: string | null }>;
  calendarUpdate(p: CalendarUpdateParams, o?: Opts): Promise<{ eventId: string; htmlLink: string | null; note: CalendarNoteReflection }>;
  /** Deletes the event in Google Calendar; its meeting note is soft-cancelled (kept). */
  calendarDelete(eventId: string, o?: Opts & { notify?: boolean; scope?: "all" }): Promise<{ eventId: string; deleted: true; note: CalendarNoteReflection }>;
  matrixSend(roomId: string, body: string, o?: Opts): Promise<{ roomId: string; eventId: string }>;
  matrixReact(roomId: string, eventId: string, key: string): Promise<{ roomId: string; eventId: string }>;
  /** Cache scope (e.g. the active vault) for query keys. */
  scope?: () => string;
}

export type ActionsFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface HttpLiveActionsOptions {
  fetch: ActionsFetch;
  headers?: () => Record<string, string>;
  base?: string;
  scope?: () => string;
}

const newKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export function createHttpLiveActionsClient(opts: HttpLiveActionsOptions): LiveActionsClient {
  const base = (opts.base ?? "/api/actions").replace(/\/+$/, "");

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<T> {
    const scope = opts.scope?.();
    const assertScope = () => { if (scope !== opts.scope?.()) throw new Error("Workspace changed. Check the original conversation before retrying this action."); };
    const headers: Record<string, string> = { ...(opts.headers?.() ?? {}) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    let resp: Response;
    try {
      resp = await opts.fetch(`${base}${path}`, init);
    } catch (e) {
      // Network failure: the request may or may not have arrived. Retry ONCE
      // with the SAME key — the server replays the first outcome if it did.
      if (!key) throw e;
      assertScope();
      resp = await opts.fetch(`${base}${path}`, init);
    }
    const j = (await resp.json().catch((error) => { if (resp.ok) throw error; return null; })) as Record<string, unknown> | null;
    assertScope();
    if (!resp.ok) {
      const sent = j?.sent === false ? false : j?.sent === "unknown" ? "unknown" : undefined;
      throw new LiveActionError(resp.status, typeof j?.error === "string" ? j.error : `http_${resp.status}`, typeof j?.detail === "string" ? j.detail : undefined, sent);
    }
    return (j ?? {}) as T;
  }

  return {
    status: () => call("GET", "/"),
    emailSend: (p, o = {}) => call("POST", "/email/send", p, o.idempotencyKey ?? newKey()),
    emailReply: (p, o = {}) => call("POST", "/email/reply", p, o.idempotencyKey ?? newKey()),
    emailArchive: (t) => call("POST", "/email/archive", t, newKey()),
    emailMarkRead: (t, read) => call("POST", "/email/mark-read", { ...t, read }, newKey()),
    calendarRsvp: (eventId, response) => call("POST", "/calendar/rsvp", { eventId, response }, newKey()),
    calendarCreate: (p, o = {}) => call("POST", "/calendar/create", p, o.idempotencyKey ?? newKey()),
    calendarUpdate: (p, o = {}) => call("POST", "/calendar/update", p, o.idempotencyKey ?? newKey()),
    calendarDelete: (eventId, o = {}) =>
      call("POST", "/calendar/delete", { eventId, ...(o.notify === false ? { notify: false } : {}), ...(o.scope === "all" ? { scope: "all" } : {}) }, o.idempotencyKey ?? newKey()),
    matrixSend: (roomId, body, o = {}) => call("POST", "/matrix/send", { roomId, body }, o.idempotencyKey ?? newKey()),
    matrixReact: (roomId, eventId, key) => call("POST", "/matrix/react", { roomId, eventId, key }, newKey()),
    scope: opts.scope,
  };
}

/** Human-readable copy for a failed action (for toasts / inline errors). */
export function liveActionErrorText(e: unknown): string {
  if (!(e instanceof LiveActionError)) return "Could not reach the server.";
  switch (e.code) {
    case "actions_disabled":
      return "This action is turned off on the server.";
    case "not_configured":
      return "The server has no credential for this service yet.";
    case "rate_limited":
      return "Too many actions in a short time — try again in a bit.";
    case "target_changed":
      return "The recipients changed since this was shown — reload and check before sending.";
    case "ambiguous":
      return "Several messages match — nothing was changed.";
    case "room_not_joined":
      return "You are not in that room.";
    case "forbidden":
      return "Only the server owner can do this.";
    case "upstream_failed":
      return e.sent === "unknown" ? "The service did not confirm — it may have gone through. Check before retrying." : "The service could not be reached. Nothing was sent.";
    case "rsvp_not_applicable":
      return e.detail ?? "There is no invitation to respond to on this event.";
    case "event_not_found":
      return e.detail ?? "That event no longer exists in Google Calendar.";
    case "recurring_series":
      return e.detail ?? "This is a recurring series: confirm that ALL occurrences should change.";
    case "unsupported_instance":
    case "event_mismatch":
      return e.detail ?? "Prism can't safely change this occurrence — use Google Calendar.";
    case "not_editable":
      return e.detail ?? "Google Calendar does not let this account change that event.";
    case "bad_request":
      return e.detail ?? "That request was not valid.";
    default:
      return e.detail ?? "The action failed.";
  }
}
