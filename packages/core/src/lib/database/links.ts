/**
 * Wikilink text helpers — PURE and dependency-free (shared by `schema.ts` and
 * `structured.ts`; `schema.ts` re-exports them, so importers are unchanged).
 */

/** `[[vault/people/Ada Lovelace]]` → `Ada Lovelace`. */
export function linkLabel(v: string): string {
  const t = v.trim();
  const inner = t.length >= 4 && t.startsWith("[[") && t.endsWith("]]") ? t.slice(2, -2) : t;
  const alias = inner.split("|")[1];
  if (alias) return alias.trim();
  // A project note at `vault/projects/<slug>/PROJECT` is named by its folder, not "PROJECT".
  const parts = inner.split("/").filter(Boolean);
  const leaf = (parts.pop() ?? inner).replace(/\.[^.]+$/, "");
  return GENERIC_LEAF.test(leaf) && parts.length ? parts[parts.length - 1]! : leaf;
}
/** File names that name a FOLDER's note rather than themselves (PROJECT.md, index, README). */
export const GENERIC_LEAF = /^(project|index|readme)$/i;
/** `[[path]]` → `path`; plain strings pass through. */
export const linkTarget = (v: string): string => {
  const t = v.trim();
  return (t.length >= 4 && t.startsWith("[[") && t.endsWith("]]") ? t.slice(2, -2) : t).split("|")[0]!.trim();
};
export const asWikilink = (path: string): string => `[[${path}]]`;
