/**
 * Path-prefix helpers for path-scoped publications (publish-by-directory).
 *
 * A path publication exposes every note whose `path` lives under a directory
 * prefix. The prefix is normalized once at publish time and stored verbatim;
 * the membership predicate (`pathInPrefix`) is then the SINGLE authoritative,
 * read-only, view-level guard for the public read path — it is evaluated on the
 * vault's own `path` field, never on a (spoofable) client query. Keep the two
 * functions here the only definition of "in this publication" so the manifest,
 * the graph, and the single-note route can never drift apart.
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
 * authoritative, leak-proof predicate for path publications.
 */
export function pathInPrefix(notePath: string | null | undefined, prefix: string): boolean {
  if (!notePath) return false;
  return notePath === prefix || notePath.startsWith(`${prefix}/`);
}
