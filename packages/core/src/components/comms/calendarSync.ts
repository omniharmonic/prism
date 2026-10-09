/**
 * When the Calendar asks for a Google → vault range sync (the desktop's Tauri command, or the
 * server's `POST /api/calendar/sync`, which shells out to `gog` and takes seconds).
 *
 * The meeting notes are already in the vault — the server ingests UTC today−3d … today+31d every
 * five minutes — so a sync is a background top-up, never something the list waits for:
 *  - on open: the range on screen, at most once per {@link CALENDAR_SYNC_THROTTLE_MS};
 *  - moving between days/weeks inside the ingested window: never;
 *  - moving to a range the ingest does not cover (months ahead, the past): once per window, after
 *    the navigation settles;
 *  - the refresh button: always (it joins a sync already in flight for that range).
 */
export const CALENDAR_SYNC_THROTTLE_MS = 5 * 60_000;
/** How long a navigation must rest before an uncovered range is synced. */
export const CALENDAR_SYNC_SETTLE_MS = 700;

type Attempt = { from: string; to: string; at: number };
const attempts = new Map<string, Attempt[]>();
const inFlight = new Map<string, Promise<unknown>>();

/** The days the server's own ingest keeps current, one day inside its real window on each side. */
export function ingestCoversRange(from: Date, to: Date, now = new Date()): boolean {
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
  return from.getTime() >= day(-2) && to.getTime() < day(31);
}

/** Was a sync covering `from…to` (YYYY-MM-DD) started for this vault inside the throttle window? */
export function calendarSyncIsFresh(scope: string, from: string, to: string, now = Date.now()): boolean {
  return (attempts.get(scope) ?? []).some((a) => now - a.at < CALENDAR_SYNC_THROTTLE_MS && a.from <= from && a.to >= to);
}

/**
 * Start (or join) the sync of one range. Returns null when the throttle says there is nothing to
 * do. A failed attempt counts too: the automatic paths do not retry a failing `gog` on every tap.
 */
export function startCalendarSync<T>(scope: string, from: string, to: string, force: boolean, run: () => Promise<T>, now = Date.now()): Promise<T> | null {
  const key = `${scope}\n${from}\n${to}`;
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  if (!force && calendarSyncIsFresh(scope, from, to, now)) return null;
  attempts.set(scope, [...(attempts.get(scope) ?? []).filter((a) => now - a.at < CALENDAR_SYNC_THROTTLE_MS), { from, to, at: now }]);
  const job = run().finally(() => { inFlight.delete(key); });
  inFlight.set(key, job);
  return job;
}

/** Did the sync change any meeting note? (`synced` alone also counts the unchanged ones.) */
export function calendarSyncChanged(result: Record<string, unknown>): boolean {
  const n = (k: string) => (typeof result[k] === "number" ? (result[k] as number) : 0);
  if (typeof result.created === "number" || typeof result.updated === "number") return n("created") + n("updated") + n("deleted") + n("cancelled") > 0;
  return n("synced") > 0;
}
