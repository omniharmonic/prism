/**
 * THE tag canonicalisation — one function, mirroring the vault exactly.
 *
 * The vault canonicalises every tag at its write and query chokepoints
 * (`stripTagHash`, @openparachute/vault core/src/tag-hierarchy.ts, 0.7.9):
 *
 *     tag.replace(/^[#\s]+/, "").trim()
 *
 * i.e. any LEADING run of `#` and whitespace is stripped (`#tag`, `##tag`, ` tag`,
 * `# tag`, `\t#tag`), then the tail is trimmed; a `#` mid-string (`c#`) stays; a tag
 * that collapses to "" is dropped by the vault. Nothing else: NO case folding (the
 * `tags.name` primary key is binary — `Agent-Skill` is a different tag from
 * `agent-skill` and is not listed by `tag=agent-skill`), no slug rules, no Unicode
 * normalisation. Hierarchy is NOT name-based either: `agent-skill/foo` is an
 * unrelated tag; a tag only inherits through `tags.parent_names`, which needs an
 * admin token to write.
 *
 * Prism's permission checks compare tag strings, so every tag that comes from a
 * request must pass through here BEFORE any check and before it is sent — otherwise
 * `"#agent-skill"` passes the checks as an unknown tag and is stored as `agent-skill`.
 */
export function canonicalTag(raw: string): string {
  return raw.replace(/^[#\s]+/, "").trim();
}

/** Canonical, de-duplicated, order-preserving. Empties are DROPPED (use `canonicalTagsStrict` to refuse them). */
export function canonicalTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const t = canonicalTag(r);
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** As `canonicalTags`, but null when any entry is not a string or canonicalises to "". */
export function canonicalTagsStrict(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || r.length > 200) return null;
    const t = canonicalTag(r);
    if (t === "") return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
