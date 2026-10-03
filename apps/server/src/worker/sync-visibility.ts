/**
 * Which notes a folder / database sync may send OUT (parity B security review
 * M1). A config acts for the account that created it (`created_by`), so it may
 * only export notes that account can view — through the SAME `effectiveCaps`
 * the gateway uses. Private notes (`prism_visibility: "private"`) are skipped
 * unless that account is their creator: not even the server owner's configs
 * export someone else's private page to GitHub or Notion.
 */
import { grantsForUser } from "../db";
import { effectiveCaps, type NoteRef } from "../permissions";
import { roleFloor, workspaceRole } from "../roles";
import type { Note } from "../parachute";

/** Metadata keys the visibility check reads (request them on lean lists). */
export const VISIBILITY_META_KEYS = ["prism_creator", "prism_visibility"] as const;

const ref = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});

export function viewableBy(email: string, vaultId: string): (n: Note) => boolean {
  const who = (email ?? "").toLowerCase();
  const role = workspaceRole(who, vaultId);
  const grants = grantsForUser(who, vaultId);
  return (n) => {
    // A trashed page is never exported (GitHub folder / Notion DB sync, review H1).
    if ((n.tags ?? []).includes("prism-trashed")) return false;
    const r = ref(n);
    if (r.visibility === "private" && (r.creator ?? "").toLowerCase() !== who) return false;
    return effectiveCaps(grants, r, roleFloor(role), who).has("view");
  };
}
