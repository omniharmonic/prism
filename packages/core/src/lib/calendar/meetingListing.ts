/**
 * THE meeting listing: one query (`["calendar","meetings",scope]`) that the Calendar tool, Home,
 * the dashboard's Calendar widget, the sidebar's CalendarMini and the event page all read. Each
 * of them used to list the whole `meeting` tag on its own; now one request serves all of them and
 * each takes its window out of the shared list in memory.
 *
 * The last listing is also kept ON THIS DEVICE so a cold start shows events at once and refreshes
 * behind them. That copy follows the read-cache privacy rules (CLAUDE.md, "Offline pages"):
 *  - keyed by the signed-in account + vault (`scope`); with no scope — signed out, a share-link
 *    viewer, the legacy desktop — NOTHING is written or read;
 *  - bounded: only events near today ({@link MEETING_LISTING_DAYS_BACK} back …
 *    {@link MEETING_LISTING_DAYS_AHEAD} ahead), at most {@link MEETING_LISTING_MAX_EVENTS} events
 *    and {@link MEETING_LISTING_MAX_CHARS} characters, long descriptions left out, at most
 *    {@link MEETING_LISTING_MAX_SCOPES} account+vault copies, none older than
 *    {@link MEETING_LISTING_MAX_AGE_MS};
 *  - every fresh listing REPLACES it (an event deleted or no longer visible is gone from the
 *    device too), and a listing refused for access (401/403/404/410) removes it and hides it;
 *  - cleared at sign-out, account change and a signed-out `/auth/me` with the other device-local
 *    keys (the web host's `clearReadCache` lists {@link MEETING_LISTING_PREFIX}; this module also
 *    listens for `prism:signed-out`).
 * The device copy is never trusted to say a day is EMPTY: until the server has answered,
 * `load` stays "loading" (or "failed"), so no "No events" line is drawn from it.
 */
import { useMemo } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { isAccessUnavailable, type VaultClient } from "../../data/VaultClient";
import { useAgentChatStore } from "../agent/chatStore";
import { calendarApi, calendarDate, type CalendarEvent } from "../sync/client";

export const MEETING_LISTING_PREFIX = "prism:calendar-listing:";
export const MEETING_LISTING_MAX_AGE_MS = 7 * 86_400_000;
export const MEETING_LISTING_MAX_EVENTS = 400;
/** Characters of JSON (localStorage stores UTF-16: twice this in bytes). */
export const MEETING_LISTING_MAX_CHARS = 200_000;
export const MEETING_LISTING_DAYS_BACK = 31;
export const MEETING_LISTING_DAYS_AHEAD = 92;
/** A longer description is not kept on the device; it arrives with the fresh listing. */
export const MEETING_LISTING_MAX_DESCRIPTION = 2_000;
export const MEETING_LISTING_MAX_SCOPES = 4;

/** Fresh for a minute, kept in memory for half an hour after the last reader closed. */
export const MEETINGS_STALE_MS = 60_000;
export const MEETINGS_KEEP_MS = 30 * 60_000;
const ALL_FROM = "1900-01-01T00:00:00.000Z";
const ALL_TO = "2200-01-01T00:00:00.000Z";
const DAY_MS = 86_400_000;

/** "ready" = the vault answered; until then nothing may claim a day is empty. */
export type MeetingLoadState = "loading" | "ready" | "failed";

export const meetingListingKey = (scope: string | null): QueryKey => ["calendar", "meetings", scope];
const storageKey = (scope: string) => MEETING_LISTING_PREFIX + scope;

type Stored = { v: 1; at: number; events: CalendarEvent[] };

/** Scopes whose listing on screen is still the device copy (no answer from the server yet). */
const seeded = new Set<string>();
/** Scopes whose device copy was refused by the server (access gone): hidden, not shown as stale. */
const refused = new Set<string>();

const startMs = (e: CalendarEvent): number => { const raw = e.start?.dateTime ?? e.start?.date; return raw ? calendarDate(raw).getTime() : NaN; };
const endMs = (e: CalendarEvent): number => { const raw = e.end?.dateTime ?? e.end?.date ?? e.start?.dateTime ?? e.start?.date; return raw ? calendarDate(raw).getTime() : NaN; };

/** The events that overlap `from … to` (the same test the per-window listings used). */
export function meetingsBetween<T extends CalendarEvent>(events: readonly T[], from: Date | number, to: Date | number): T[] {
  const fromMs = +from, toMs = +to;
  return events.filter((e) => {
    const start = startMs(e), end = endMs(e);
    if (Number.isNaN(start)) return false;
    return !((end > start ? end <= fromMs : start < fromMs) || start > toMs);
  });
}

/** The events of the local day `now` is in. */
export function meetingsToday<T extends CalendarEvent>(events: readonly T[], now = new Date()): T[] {
  return meetingsBetween(events, new Date(now.getFullYear(), now.getMonth(), now.getDate()), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
}

/** What may be kept on the device out of a listing: near today, nearest first, inside the bounds. */
export function boundMeetingListing(events: readonly CalendarEvent[], now = Date.now()): CalendarEvent[] {
  const near = meetingsBetween(events, now - MEETING_LISTING_DAYS_BACK * DAY_MS, now + MEETING_LISTING_DAYS_AHEAD * DAY_MS)
    .map((e) => ({ e, distance: Math.abs(startMs(e) - now) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MEETING_LISTING_MAX_EVENTS);
  const kept: CalendarEvent[] = [];
  let chars = 64; // the envelope
  for (const { e } of near) {
    const lean = typeof e.description === "string" && e.description.length > MEETING_LISTING_MAX_DESCRIPTION ? { ...e, description: null } : e;
    const size = JSON.stringify(lean).length + 1;
    if (chars + size > MEETING_LISTING_MAX_CHARS) break;
    chars += size;
    kept.push(lean);
  }
  return kept;
}

function removeKey(key: string): void {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

function parse(raw: string | null, now: number): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored> | null;
    if (!value || value.v !== 1 || typeof value.at !== "number" || !Array.isArray(value.events)) return null;
    if (value.at > now || now - value.at > MEETING_LISTING_MAX_AGE_MS) return null;
    if (value.events.length > MEETING_LISTING_MAX_EVENTS) return null;
    return value as Stored;
  } catch { return null; }
}

/** This device's copy of the last listing for `scope`; an expired or unreadable one is deleted. */
export function readStoredMeetings(scope: string | null, now = Date.now()): { at: number; events: CalendarEvent[] } | null {
  if (!scope) return null;
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (raw === null) return null;
    const stored = parse(raw, now);
    if (!stored) { removeKey(storageKey(scope)); return null; }
    return { at: stored.at, events: stored.events };
  } catch { return null; }
}

/** Replace the device copy for `scope` with this (fresh) listing. Never throws. */
export function storeMeetings(scope: string | null, events: readonly CalendarEvent[], now = Date.now()): void {
  if (!scope) return;
  const key = storageKey(scope);
  try {
    localStorage.setItem(key, JSON.stringify({ v: 1, at: now, events: boundMeetingListing(events, now) } satisfies Stored));
  } catch {
    // Quota / private mode: an older copy must not outlive the listing that replaced it.
    removeKey(key);
  }
  sweepStoredMeetings(now, key);
}

/** Drop expired / unreadable copies and all but the newest {@link MEETING_LISTING_MAX_SCOPES}. */
function sweepStoredMeetings(now: number, current?: string): void {
  try {
    const live: { key: string; at: number }[] = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(MEETING_LISTING_PREFIX)) continue;
      const stored = parse(localStorage.getItem(key), now);
      if (stored) live.push({ key, at: key === current ? Infinity : stored.at }); else removeKey(key);
    }
    for (const { key } of live.sort((a, b) => b.at - a.at).slice(MEETING_LISTING_MAX_SCOPES)) removeKey(key);
  } catch { /* private mode */ }
}

export function forgetStoredMeetings(scope: string | null): void {
  if (scope) removeKey(storageKey(scope));
}

/** Every account's copy (sign-out, account change). */
export function clearStoredMeetings(): void {
  seeded.clear();
  refused.clear();
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(MEETING_LISTING_PREFIX)) localStorage.removeItem(key); } catch { /* private mode */ }
}
if (typeof window !== "undefined") window.addEventListener("prism:signed-out", clearStoredMeetings);

async function listMeetings(client: Pick<VaultClient, "listNotes" | "scope">, scope: string | null): Promise<CalendarEvent[]> {
  const audience = client.scope?.();
  let events: CalendarEvent[];
  try {
    events = await calendarApi.listEventsFromVault(ALL_FROM, ALL_TO, client);
  } catch (error) {
    // Access gone: the copy on this device goes with it (and is no longer drawn).
    if (scope && isAccessUnavailable(error)) { forgetStoredMeetings(scope); if (seeded.has(scope)) refused.add(scope); }
    throw error;
  }
  // The account or vault changed while the request was out: this answer belongs to nobody here.
  if (useAgentChatStore.getState().scope !== scope || client.scope?.() !== audience) throw new Error("Workspace changed before the calendar loaded.");
  if (scope) { seeded.delete(scope); refused.delete(scope); }
  storeMeetings(scope, events);
  return events;
}

export interface MeetingListing {
  events: CalendarEvent[];
  load: MeetingLoadState;
  /** The list on screen is this device's copy of an earlier listing; the fresh one is on its way (or failed). */
  fromDevice: boolean;
  isFetching: boolean;
  isError: boolean;
  queryKey: QueryKey;
}

const NONE: CalendarEvent[] = [];

/** Read the shared listing. `refetchInterval`: a surface that stays open (a widget) re-reads it that often. */
export function useMeetingListing(options: { refetchInterval?: number } = {}): MeetingListing {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const queryKey = useMemo(() => meetingListingKey(scope), [scope]);
  const query = useQuery({
    queryKey,
    queryFn: () => listMeetings(client, scope),
    // Only when the query is created (a cold start, or after it left memory): the device copy,
    // dated 0 so the server is always asked behind it.
    initialData: () => {
      const stored = readStoredMeetings(scope);
      if (scope) { if (stored) seeded.add(scope); else seeded.delete(scope); refused.delete(scope); }
      return stored?.events;
    },
    initialDataUpdatedAt: 0,
    retry: 1,
    staleTime: MEETINGS_STALE_MS,
    gcTime: MEETINGS_KEEP_MS,
    ...(options.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
  const hidden = !!scope && refused.has(scope);
  const data = hidden ? undefined : query.data;
  const fromDevice = data !== undefined && !!scope && seeded.has(scope);
  const events = useMemo(() => (Array.isArray(data) ? data : NONE), [data]);
  const load: MeetingLoadState = data !== undefined && !fromDevice ? "ready" : query.isError ? "failed" : "loading";
  return { events, load, fromDevice, isFetching: query.isFetching, isError: query.isError, queryKey };
}
