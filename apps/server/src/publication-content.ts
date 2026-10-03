/** Publication membership shared by the public reader and owner preview. */
import { TRASH_TAG } from "@prism/core/pages";
import { vaultClient, type Note } from "./parachute";
import type { Actor } from "./auth/actor";
import {
  grantsForResource,
  excludedNoteIds,
  publicationVaultId,
  type Publication,
} from "./db";
import { effectiveCaps, type NoteRef } from "./permissions";
import { pathInPrefix, pathPublicationIncludes } from "./paths";

// Includes `visibility` so a PRIVATE note carrying a published tag is excluded
// from the public set: effectiveCaps returns nothing for a private note unless the
// anon actor holds an explicit per-note grant (it never does). Without this a
// private note could leak onto a public wiki via a shared tag.
const ref = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  visibility:
    n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});

/**
 * Synthetic anon actor for a publication. Its grants are ONLY the "anyone"
 * grant(s) (subject_type='anyone', resource_type='tag', resource=tag,
 * level='view') the owner created at publish time. We deliberately FILTER OUT
 * any user-/link-/peer-scoped grants that also happen to sit on the same tag —
 * an anonymous visitor must never inherit a specific person's higher (edit/own)
 * grant. (Defense-in-depth: today every /api/p route only needs `view`, but this
 * keeps the anon actor from ever computing a level above what `anyone` allows.)
 */
export function publicationActor(pub: Publication): Actor {
  const vaultId = publicationVaultId(pub);
  return {
    kind: "anon",
    role: "guest",
    // The publication's OWN vault (stamped at publish time; 'primary' for
    // pre-multi-vault rows) — its grants are looked up in that vault only, so a
    // publication of tag T in vault A never picks up grants on tag T in vault B.
    vaultId,
    grants: grantsForResource(pub.resource_type, pub.resource, vaultId).filter(
      (g) => g.subject_type === "anyone",
    ),
  };
}

/**
 * The public read gate: the anon actor holds the `view` CAP on the note (no role
 * floor, no subject). Caps, not the level ladder: an `anyone` grant carrying an
 * explicit cap list without `view` (e.g. ["create"]) projects to level "view"
 * (permissions.ts levelForCaps) yet confers no read — a ladder check would leak
 * it onto the public site. For the level-only grant publish creates, caps are
 * exactly the level's expansion, so this is identical to the old check.
 */
export const canPublicView = (grants: Actor["grants"], note: Note): boolean =>
  // A trashed page leaves its public site too (restoring brings it back).
  !(note.tags ?? []).includes(TRASH_TAG) && effectiveCaps(grants, ref(note), null).has("view");

/** The vault client bound to the publication's own vault — EVERY vault read on
 *  the public path goes through this, never the primary singleton. */
export const pubVault = (pub: Publication) =>
  vaultClient(publicationVaultId(pub));

/**
 * The note set this publication exposes.
 *
 * - `tag` pubs: notes under the publication's tag, filtered to
 *   the `view` cap (canPublicView) against the anon actor's grants. Mirrors
 *   `visibleNotes` in api.ts — tag scoping only narrows; effectiveCaps is the
 *   authoritative guard.
 * - `path` pubs: notes whose `path` is inside the publication's prefix. The
 *   path-membership predicate (evaluated on the vault's OWN `path` field) is the
 *   directory guard, with explicit private notes excluded — grants/caps play no
 *   part. We fetch all notes and filter in-process because Parachute's `?path=`
 *   is an exact match, not a prefix filter; publish.ts must guarantee prefix
 *   membership itself regardless.
 */
export async function publicationNotes(
  pub: Publication,
  includeContent: boolean,
): Promise<Note[]> {
  const { candidates } = await publicationInventory(pub, includeContent);
  const excluded = new Set(excludedNoteIds(pub));
  return candidates.filter((n) => !excluded.has(n.id));
}

/** A short display title derived from a note's content. Handles BOTH shapes the
 *  vault stores: markdown (first non-empty line, leading `#` stripped) AND
 *  TipTap HTML — which is often a SINGLE LINE with no `\n`, so a naive
 *  split("\n")[0] returns the ENTIRE document. Always strip tags and cap the
 *  length so the title can never become the whole note body. */
export function deriveTitle(content: string | null | undefined): string {
  const c = (content ?? "").trim();
  if (!c) return "Untitled";
  // HTML body: prefer the first heading's text; else strip all tags.
  if (/^<|<[a-z][^>]*>/i.test(c)) {
    const h = c.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const text = (h?.[1] ?? c)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 120) || "Untitled";
  }
  // Markdown / plain text: first non-empty line, leading markdown markers off.
  for (const raw of c.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    return (
      line
        .replace(/^#+\s*/, "")
        .trim()
        .slice(0, 120) || "Untitled"
    );
  }
  return "Untitled";
}

/** Title for the nav list, where content isn't fetched (cheap). Prefer the
 *  content heading when present, else the note's path basename (sans extension),
 *  else "Untitled". */
export function navTitle(note: Note): string {
  if (note.content && note.content.trim()) return deriveTitle(note.content);
  const base = (note.path ?? "").split("/").pop() ?? "";
  const cleaned = base
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return cleaned || "Untitled";
}

/** Never turn the owner's broader vault access into preview access. The preview
 * is the public membership projection, including saved exclusions as candidates
 * so the owner can restore them, but never private note names or content. */
export async function publicationInventory(
  pub: Publication,
  includeContent = false,
) {
  const notes = await pubVault(pub).listNotes(
    pub.resource_type === "path"
      ? { includeContent }
      : { tags: [pub.resource], includeContent },
  );
  const inScope = notes.filter((n) =>
    pub.resource_type === "path"
      ? pathInPrefix(n.path, pub.resource)
      : (n.tags ?? []).includes(pub.resource),
  );
  const actor = publicationActor(pub);
  const candidates = inScope.filter((n) =>
    pub.resource_type === "path"
      ? pathPublicationIncludes(n, pub.resource)
      : canPublicView(actor.grants, n),
  );
  return {
    candidates,
    privateExcludedCount: inScope.filter(
      (n) => n.metadata?.prism_visibility === "private",
    ).length,
  };
}
