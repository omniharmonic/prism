/**
 * Permission model. Access is computed per (subject, note): a subject is a
 * signed-in user (email), a capability link, or "anyone with the link". The
 * effective level is the MAX over all grants that match the note directly
 * (resource=note:<id>) or via one of its tags (resource=tag:<name>), raised by a
 * role-derived floor (owner/admin → "own"; see roles.ts). This layer is pure;
 * the store (db) supplies the grants, the caller supplies the floor.
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
  /** The note's creator (metadata.prism_creator) — used for private-to-creator. */
  creator?: string | null;
  /**
   * "private" → a Notion-style private page: only the creator and explicit
   * per-NOTE grants reach it; tag/space/vault grants AND the workspace role floor
   * are IGNORED, so a private note inside a shared folder/workspace stays hidden
   * until the creator shares that specific note. Default "workspace".
   */
  visibility?: "private" | "workspace";
}

/**
 * Effective level for a set of grants against a note. `floor` is the baseline
 * level the subject's workspace role confers (owner/admin → "own", member/guest
 * → null) — see roles.ts `roleFloor`. Grants then raise it: matched by note id,
 * by any tag the note carries, by a shared space the note belongs to, or by a
 * whole-workspace `vault` grant. Passing `null` floor means "grants only".
 *
 * `subject` (the actor's email / capability id) is consulted ONLY for private
 * notes, to grant their creator "own". Omitting it is fail-closed: a private
 * note then resolves purely on explicit per-note grants (no creator shortcut),
 * which can never LEAK — it only risks under-granting the creator.
 */
export function effectiveLevel(
  grants: Grant[],
  note: NoteRef,
  floor: Level | null,
  subject?: string | null,
): Level | null {
  // Private-to-creator: the creator gets "own"; everyone else needs an explicit
  // NOTE grant. Tag/space/vault grants and the role floor do NOT apply here — this
  // is the deny-by-construction path (a private note is invisible to the
  // workspace until its creator shares it). Admins do not override (by design).
  if (note.visibility === "private") {
    if (subject && note.creator && subject === note.creator) return "own";
    let lvl: Level | null = null;
    for (const g of grants) {
      if (g.resource_type === "note" && g.resource === note.id) lvl = maxLevel(lvl, g.level);
    }
    return lvl;
  }
  const tagSet = new Set(note.tags);
  const spaceSet = new Set(note.spaceIds ?? []);
  let level: Level | null = floor;
  for (const g of grants) {
    const matches =
      (g.resource_type === "note" && g.resource === note.id) ||
      (g.resource_type === "tag" && tagSet.has(g.resource)) ||
      (g.resource_type === "space" && spaceSet.has(g.resource)) ||
      g.resource_type === "vault"; // a whole-workspace grant matches every note in the vault
    if (matches) level = maxLevel(level, g.level);
  }
  return level;
}

/** The set of tags a subject's grants reference (used to bound vault queries). */
export function grantedTags(grants: Grant[]): string[] {
  return [...new Set(grants.filter((g) => g.resource_type === "tag").map((g) => g.resource))];
}
