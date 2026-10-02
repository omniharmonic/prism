/**
 * Path-prefix helpers for path-scoped publications (publish-by-directory).
 *
 * Path membership narrows the publication's set. Private visibility and explicit
 * publication exclusions remain independent guards. Use pathPublicationIncludes
 * for public folder membership, then apply the publication's excluded IDs.
 */

/**
 * Normalize a user-supplied path prefix, or return null if it is unusable.
 * Trims, strips leading slashes, collapses internal `//`, drops a trailing
 * slash, and REJECTS any `.`/`..` segment (path traversal) or empty result.
 */
export function normalizePathPrefix(input: string): string | null {
  const collapsed = input
    .trim()
    .replace(/^\/+/, "") // strip leading slashes
    .replace(/\/{2,}/g, "/") // collapse internal //
    .replace(/\/+$/, ""); // drop trailing slash
  if (!collapsed) return null;
  const segments = collapsed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return collapsed;
}

/**
 * Membership test: is `notePath` inside the publication's `prefix`? True iff the
 * path equals the prefix or starts with `prefix + "/"`. So prefix `a/b` matches
 * `a/b` and `a/b/x` but NOT the sibling `a/bc`. Use this everywhere — it is the
 * directory-membership predicate; it does not grant public access by itself.
 */
export function pathInPrefix(notePath: string | null | undefined, prefix: string): boolean {
  if (!notePath) return false;
  return notePath === prefix || notePath.startsWith(`${prefix}/`);
}

/** A published folder never overrides a note's explicit private visibility. */
export function pathPublicationIncludes(
  note: { path?: string | null; metadata?: Record<string, unknown> | null },
  prefix: string,
): boolean {
  return note.metadata?.prism_visibility !== "private" && pathInPrefix(note.path, prefix);
}
