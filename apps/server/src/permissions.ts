/**
 * Permission model. Access is computed per (subject, note): a subject is a
 * signed-in user (email), a capability link, or "anyone with the link". The
 * effective level is the MAX over all grants that match the note directly
 * (resource=note:<id>) or via one of its tags (resource=tag:<name>), plus the
 * owner override. This layer is pure; the store (db) supplies the grants.
 */
import type { Grant } from "./db";

export type Level = "view" | "comment" | "suggest" | "edit" | "own";

/** Ordered weakest → strongest. */
export const LEVELS: readonly Level[] = ["view", "comment", "suggest", "edit", "own"] as const;

export const levelRank = (l: Level): number => LEVELS.indexOf(l);

/** Does `have` meet or exceed `need`? */
export const atLeast = (have: Level | null, need: Level): boolean =>
  have != null && levelRank(have) >= levelRank(need);

export const maxLevel = (a: Level | null, b: Level | null): Level | null => {
  if (a == null) return b;
  if (b == null) return a;
  return levelRank(a) >= levelRank(b) ? a : b;
};

export interface NoteRef {
  id: string;
  tags: string[];
  /**
   * Shared-space ids this note belongs to (via its `space_note_key` in
   * `federated_notes`). Lets a `resource_type='space'` grant — held by a peer —
   * match notes inside that space. Optional: omitted for the non-federated path.
   */
  spaceIds?: string[];
}

/**
 * Effective level for a set of grants against a note. `isOwner` short-circuits
 * to "own". Grants are matched by note id, by any tag the note carries, or by
 * any shared space the note belongs to (peer/space grants).
 */
export function effectiveLevel(grants: Grant[], note: NoteRef, isOwner: boolean): Level | null {
  if (isOwner) return "own";
  const tagSet = new Set(note.tags);
  const spaceSet = new Set(note.spaceIds ?? []);
  let level: Level | null = null;
  for (const g of grants) {
    const matches =
      (g.resource_type === "note" && g.resource === note.id) ||
      (g.resource_type === "tag" && tagSet.has(g.resource)) ||
      (g.resource_type === "space" && spaceSet.has(g.resource));
    if (matches) level = maxLevel(level, g.level);
  }
  return level;
}

/** The set of tags a subject's grants reference (used to bound vault queries). */
export function grantedTags(grants: Grant[]): string[] {
  return [...new Set(grants.filter((g) => g.resource_type === "tag").map((g) => g.resource))];
}
