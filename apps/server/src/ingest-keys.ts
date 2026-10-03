/**
 * Metadata keys the ingesters, the skill scheduler and the people merge MATCH notes
 * by. A non-admin who could set one would hijack that matching (a member-made task
 * with a ClickUp `source_id` becomes "the" ClickUp task; a `merged_into` pointer
 * redirects a person; `runner`/`skillName` steer the scheduler), so every non-admin
 * metadata write — gateway create / PATCH, `POST /api/properties/:id` and the batch —
 * goes through {@link ingestKeyChanged}. Restating the stored value is allowed (an
 * editor round-trips the whole metadata object).
 *
 * `source` itself is an ordinary property people use ("web", "book"…), so only the
 * VALUES an ingester keys on are reserved ({@link INGEST_SOURCES}).
 */
export const INGEST_KEYS: ReadonlySet<string> = new Set([
  "source_id", "sourceId", "calendarEventId", "messageId", "threadId", "matrixRoomId",
  "skillName", "runner", "lastRun", "executionMode",
  "merged_into", "mergedInto", "superseded_by", "prism_merge_history", "prism_merged_from", "prism_merged_into_prev",
]);

/** `metadata.source` values an ingester recognises its own notes by. */
export const INGEST_SOURCES: ReadonlySet<string> = new Set(["clickup", "fireflies", "fathom", "proton-bridge", "github", "gmail", "matrix", "calendar", "notion"]);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Would writing `value` to `key` change an ingest-matching key (given the stored value)? */
export function ingestKeyChanged(key: string, value: unknown, current: unknown): boolean {
  if (INGEST_KEYS.has(key)) return !same(value, current);
  if (key === "source") return typeof value === "string" && INGEST_SOURCES.has(value.trim().toLowerCase()) && !same(value, current);
  return false;
}
