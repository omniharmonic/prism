/**
 * One writer at a time for the identity layer: the backfill job, a merge, and a
 * review-queue resolve / dismiss all edit the same person notes and links, so
 * they are mutually exclusive (a second caller gets 409 `busy`).
 */
let holder: string | null = null;

/** Take the lock; returns the release function, or null when someone holds it. */
export function acquirePeopleLock(name: string): (() => void) | null {
  if (holder) return null;
  holder = name;
  let released = false;
  return () => {
    if (!released && holder === name) holder = null;
    released = true;
  };
}

export const peopleLockHolder = (): string | null => holder;

/** Test-only reset. */
export function _resetPeopleLock(): void {
  holder = null;
}
