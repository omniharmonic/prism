/**
 * "This pass did no work" — the signal that keeps a no-op from reading as a success.
 *
 * Every ingester is called on every 60 s tick and returns early when it has nothing
 * to do this tick: no credential, a disabled interval, a slot already claimed, the
 * wrong local hour (Fireflies), a pass already running (the index sweep). Those
 * early returns used to be recorded as successful runs, so `/acl/workers` showed
 * the last TICK as `lastSuccessAt` for every source — the same moment for all of
 * them, a vault with no credential included — and, worse, every skipped tick reset
 * the failure streak: Fireflies runs four times a day, so its 56 skipped ticks in
 * between kept a source that failed EVERY real run at streak 1, reading `ok`.
 *
 * An ingester now returns `passSkipped(vaultId, source)` from each early exit. The
 * scheduler takes the marker after the call and records nothing for that tick:
 * neither a success nor a failure. Only a pass that actually ran reports an outcome.
 *
 * Its own module (not health.ts) because calendar.ts / proton.ts mark skips too, and
 * health.ts imports both of them.
 */
const skipped = new Set<string>();
const key = (vaultId: string, source: string) => `${vaultId}:${source}`;

/** Mark this (vault, source) pass as having done nothing. Returns 0 so an early exit reads `return passSkipped(…)`. */
export function passSkipped(vaultId: string, source: string): 0 {
  skipped.add(key(vaultId, source));
  return 0;
}

/** True (once) when the last pass of this (vault, source) marked itself skipped. Clears the mark. */
export function takePassSkipped(vaultId: string, source: string): boolean {
  return skipped.delete(key(vaultId, source));
}

/** Tests. */
export function resetPassSkips(): void {
  skipped.clear();
}
