/**
 * Notes the events channel just said changed. Their next read must be FRESH: the
 * gateway reuses an owner read for a few seconds, and "this note changed" must
 * never be answered with the copy from before the change (review H3).
 * A mark is spent by the read that takes it, or expires after a minute.
 */
const marks = new Map<string, number>();
const TTL_MS = 60_000;

export function markFreshRead(noteId: string, now = Date.now()): void {
  if (marks.size > 500) for (const [id, at] of marks) if (now - at > TTL_MS) marks.delete(id);
  marks.set(noteId, now);
}

/** True once per mark. */
export function takeFreshRead(noteId: string, now = Date.now()): boolean {
  const at = marks.get(noteId);
  if (at === undefined) return false;
  marks.delete(noteId);
  return now - at <= TTL_MS;
}
