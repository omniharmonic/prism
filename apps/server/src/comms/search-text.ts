// The normalised text Comms search matches against (comms_conversations.search_text): the title and
// the last-message preview, case- and diacritic-folded ("José" → "jose"), so a plain LIKE on one
// narrow column answers `GET /threads?q=` and the recipients search. No imports: db.ts uses it to
// backfill rows made before the column existed.

const MAX_SEARCH_CHARS = 2_000;

/** Case- and diacritic-folded, whitespace-collapsed. Used for both the stored text and the query. */
export function foldSearch(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The stored search text of a conversation. */
export function searchTextOf(title: string, previewText: string | null | undefined): string {
  return foldSearch(`${title}\n${previewText ?? ""}`).slice(0, MAX_SEARCH_CHARS);
}

/** A LIKE pattern (ESCAPE '\') matching `q` anywhere, or null when q folds to nothing. */
export function likePattern(q: string): string | null {
  const f = foldSearch(q);
  return f ? `%${f.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
}
