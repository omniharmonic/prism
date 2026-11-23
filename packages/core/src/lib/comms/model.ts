/**
 * Comms behaviour for Prism's Messages screens, pure (no React): the transcript grouping rule, the
 * query string of a thread listing, and when a failed read means "fall back to the vault notes".
 * Prism keeps its own look (DECISIONS D19); these are the behaviours shared with the Comms app.
 */
import type { CommsMessage, CommsThreadQuery } from "./types";

/** Comms design/tokens.json `transcript.timeHeaderGapMinutes`: a new run after MORE than this much quiet. */
export const TIME_GAP_MS = 60 * 60_000;

export interface MessageRun {
  /** Stable key: the first message's id. */
  key: string;
  messages: CommsMessage[];
  isSelf: boolean;
  /** A new calendar day starts with this run (draw the day separator above it). */
  newDay: boolean;
  /** The run starts after more than 60 minutes of quiet on the same day (draw a time header above it). */
  afterGap: boolean;
}

const at = (m: CommsMessage): number => {
  const t = Date.parse(m.sentAt);
  return Number.isFinite(t) ? t : 0;
};
const dayOf = (t: number): string => (t ? new Date(t).toDateString() : "unknown");

/**
 * The Comms app's rule (CommsKit TranscriptLayout.rows): consecutive messages form ONE run when
 * they share the sender, the direction (yours or theirs) and the local day, with at most 60 minutes
 * between them (exactly 60:00 still joins). System notices and unsent (redacted) messages never
 * join a run and break the one around them. Input is oldest first (the API's order).
 */
export function groupRuns(messages: readonly CommsMessage[]): MessageRun[] {
  const runs: MessageRun[] = [];
  let prevAt = 0;
  for (const m of messages) {
    const t = at(m);
    const last = runs.at(-1);
    const prior = last?.messages.at(-1);
    const newDay = !prior || dayOf(prevAt) !== dayOf(t);
    const afterGap = !!prior && !newDay && t > 0 && prevAt > 0 && t - prevAt > TIME_GAP_MS;
    const joins =
      !!prior && !prior.system && !m.system && !prior.redacted && !m.redacted && !newDay && !afterGap &&
      prior.sender.id === m.sender.id && prior.sender.isSelf === m.sender.isSelf && t >= prevAt;
    if (joins) last!.messages.push(m);
    else runs.push({ key: m.id, messages: [m], isSelf: m.sender.isSelf, newDay, afterGap });
    prevAt = t || prevAt;
  }
  return runs;
}

/** `GET /api/comms/threads` query string for a listing (repeatable params kept comma-separated). */
export function threadQueryString(q: CommsThreadQuery): string {
  const sp = new URLSearchParams();
  if (q.folder) sp.set("folder", q.folder);
  if (q.statuses?.length) sp.set("status", q.statuses.join(","));
  if (q.attention) sp.set("attention", "true");
  if (q.networks?.length) sp.set("network", q.networks.join(","));
  if (q.unread) sp.set("unread", "true");
  if (q.person) sp.set("person", q.person);
  if (q.note) sp.set("note", q.note);
  const text = q.q?.trim();
  if (text) sp.set("q", text.slice(0, 200));
  if (q.cursor) sp.set("cursor", q.cursor);
  if (q.limit) sp.set("limit", String(q.limit));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * A listing that failed with one of these means Comms is not available to this viewer here —
 * flag off (404 comms_disabled), not the server owner (403), another vault (409) — so Messages
 * shows the vault notes exactly as before. Any other failure (network, 5xx, 429) is an error the
 * person can retry, never a silent switch of data source.
 */
export function commsUnavailable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 404 || status === 409;
}

/**
 * No answer at all (offline, connection reset, server restarting — the error carries no HTTP
 * status) or a 5xx: Comms is momentarily unreachable, while the vault notes may still come from
 * the device's offline read cache. Messages then shows the vault view with a notice (never an
 * empty error screen); a 429 or another 4xx is not transient in that sense.
 */
export function commsTransient(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500;
}

/** A message's send time in epoch ms, 0 when the server sent none or a bad one. */
export function sentAtMs(m: CommsMessage): number {
  return at(m);
}

const POLL_MAX_MS = 5 * 60_000;
/** Poll at `base`, doubling after each failed read up to 5 min (tanstack also pauses it while the page is hidden). */
export const backoff = (base: number | false, failures: number): number | false =>
  base === false ? false : failures > 0 ? Math.min(base * 2 ** failures, POLL_MAX_MS) : base;
