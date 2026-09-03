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

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities (P1). The `Level` ladder above answers "how much" in one number;
// a CAP answers "may you do this one thing". Every level maps onto a fixed set
// of caps (`expandLevel`), so a grant that carries no explicit caps behaves
// EXACTLY as it did before — the ladder is now a shorthand for a cap set, not a
// separate system. Grants may instead carry an explicit `caps` list, which lets
// access be composed (e.g. "may add notes here but not edit the existing ones").
//
// Semantics:
//   view/comment/suggest/edit — what the matching ladder levels have always meant
//   create   — add NEW notes within the scope (today implied by `edit`)
//   organize — change a note's tags/path (move / retag) within the scope
//   delete   — delete notes in the scope beyond your own creations
//   share    — manage OTHER subjects' grants within the scope
//              (DEFINED here in P1; the /acl surface does not enforce it yet — P2.)
// ─────────────────────────────────────────────────────────────────────────────

export const CAPS = [
  "view",
  "comment",
  "suggest",
  "edit",
  "create",
  "organize",
  "delete",
  "share",
] as const;

export type Cap = (typeof CAPS)[number];

export const isCap = (x: unknown): x is Cap =>
  typeof x === "string" && (CAPS as readonly string[]).includes(x);

/**
 * Level → caps. Backward compatible by construction: `edit` is what allows
 * creating today, and `own` is the everything level. The sets are NESTED
 * (view ⊂ comment ⊂ suggest ⊂ edit ⊂ own), which is what makes "union of
 * expansions" and "expansion of the max level" the same thing — the property
 * that keeps `effectiveCaps` and `effectiveLevel` in agreement for cap-less
 * grants.
 */
const LEVEL_CAPS: Readonly<Record<Level, ReadonlySet<Cap>>> = {
  view: new Set<Cap>(["view"]),
  comment: new Set<Cap>(["view", "comment"]),
  suggest: new Set<Cap>(["view", "comment", "suggest"]),
  edit: new Set<Cap>(["view", "comment", "suggest", "edit", "create"]),
  own: new Set<Cap>(CAPS),
};

/** The caps a level confers. The returned set is shared — never mutate it. */
export const expandLevel = (l: Level): ReadonlySet<Cap> => LEVEL_CAPS[l];

/**
 * The ladder projection of a cap set: the HIGHEST level whose full expansion is
 * contained in `caps`. Used to keep a caps-carrying grant's `level` column
 * coherent (db.upsertGrant), so every level-based consumer that has not been
 * taught caps yet sees a never-INFLATED view of it.
 *
 * A cap set that lacks `view` cannot contain ANY level's expansion (every level
 * includes view), i.e. it conveys no read access. The ladder has no value for
 * "nothing", so we return its weakest value, "view" — the caps set stays
 * authoritative for anything that asks `effectiveCaps`. (Known P1 gap: a
 * consumer still reading only `level` — collab's authorizeConnection — would
 * treat such a degenerate grant as read-only. The gateway does not: its read
 * checks go through the caps.)
 */
export function levelForCaps(caps: Iterable<Cap>): Level {
  const set = caps instanceof Set ? (caps as Set<Cap>) : new Set(caps);
  let best: Level = "view";
  for (const l of LEVELS) {
    let contained = true;
    for (const c of expandLevel(l)) {
      if (!set.has(c)) {
        contained = false;
        break;
      }
    }
    if (contained) best = l;
  }
  return best;
}

/** The caps a single grant confers: its explicit list, else its level's expansion. */
const grantCaps = (g: Grant): Iterable<Cap> =>
  g.caps && g.caps.length ? g.caps : expandLevel(g.level);

/**
 * The caps analogue of `effectiveLevel`: the UNION of the caps every matching
 * grant confers, plus the caps the role floor confers. Matching and the
 * private-note semantics are identical to `effectiveLevel` — for a private note
 * the creator gets everything and everyone else unions ONLY note-id grants (no
 * tag/space/vault grant, no role floor).
 *
 * For grants that carry no explicit caps this is exactly
 * `expandLevel(effectiveLevel(...))`, so routing a check through caps instead of
 * the ladder changes nothing for existing grants.
 */
export function effectiveCaps(
  grants: Grant[],
  note: NoteRef,
  floor: Level | null,
  subject?: string | null,
): Set<Cap> {
  const out = new Set<Cap>();
  if (note.visibility === "private") {
    if (subject && note.creator && subject === note.creator) return new Set<Cap>(CAPS);
    for (const g of grants) {
      if (g.resource_type === "note" && g.resource === note.id) for (const c of grantCaps(g)) out.add(c);
    }
    return out;
  }
  if (floor != null) for (const c of expandLevel(floor)) out.add(c);
  const tagSet = new Set(note.tags);
  const spaceSet = new Set(note.spaceIds ?? []);
  for (const g of grants) {
    const matches =
      (g.resource_type === "note" && g.resource === note.id) ||
      (g.resource_type === "tag" && tagSet.has(g.resource)) ||
      (g.resource_type === "space" && spaceSet.has(g.resource)) ||
      g.resource_type === "vault";
    if (matches) for (const c of grantCaps(g)) out.add(c);
  }
  return out;
}
