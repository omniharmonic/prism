import { useSyncExternalStore } from "react";

/**
 * Is the server invalidation channel (WP7.2) currently connected? Polling
 * queries read this to relax to a slow safety-net interval while events cover
 * them, and to snap back to their normal cadence the moment the channel is down
 * (or was never available: desktop, older server, access denied).
 */
let live = false;
const subs = new Set<() => void>();

export function setEventChannelLive(v: boolean): void {
  if (live === v) return;
  live = v;
  for (const s of [...subs]) s();
}
export const isEventChannelLive = () => live;
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};

/** Fallback poll cadence while the channel is live (events are the primary path). */
export const LIVE_FALLBACK_MS = 5 * 60_000;

/**
 * `refetchInterval` for a query that used to poll every `ms`: the original cadence
 * while the channel is down, `LIVE_FALLBACK_MS` (5 min) while it is up.
 */
export function useLivePollMs(ms: number, fallbackMs: number = LIVE_FALLBACK_MS): number {
  const isLive = useSyncExternalStore(subscribe, () => live, () => false);
  return isLive ? Math.max(ms, fallbackMs) : ms;
}
