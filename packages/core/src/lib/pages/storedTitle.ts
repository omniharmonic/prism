/**
 * The stored title of a page (`metadata.title`) after a rename — NP-DB-20. Pure (types, the
 * path helpers and the client seam only): the server's tests read it too.
 */
import { VaultRequestError, type VaultClient } from "../../data/VaultClient";
import type { Note } from "../types";
import { isContainerPath, leafName, withoutExtension } from "./model";

/** A page's FILE name without its (known) extension — what a rename changes. */
const fileTitle = (path: string | null | undefined): string => (path ? withoutExtension(leafName(path)) : "");

/**
 * NP-DB-20: a page may carry a stored title (`metadata.title` — rows made in a database view
 * did, hand-made and imported notes do, e.g. "Plan: Q4/2026" at `…/Plan- Q4-2026`). Every list
 * that shows the page (a database view's rows, the tree's title, search) prefers it over the
 * file name, so after a RENAME those would keep the old name. After a rename the stored title
 * is therefore made to say what was TYPED, and nothing typed is lost:
 *  - the new file name says the typed title exactly → no stored title (an existing one — a copy
 *    of the old name, or a title of its own that this rename replaces — is removed);
 *  - the new file name cannot hold it (a `/`, an ending the server strips…) → the typed title
 *    is stored.
 * Compare-and-set on the value read just before the move (a title someone changed meanwhile is
 * left alone). A move that is not a rename (nothing typed) changes nothing. Best effort: without edit access the
 * stored title stays as it was.
 */
export async function syncStoredTitle(client: VaultClient, before: Note | null | undefined, newPath: string, typed?: string): Promise<"unchanged" | "written" | "failed"> {
  if (!before) return "unchanged";
  // A container-named page (`<folder>/PROJECT`) is not named by its file: its stored title is its
  // own (written by `renamePageFromTitle`) and no move or rename of the file may touch it.
  if (isContainerPath(before.path)) return "unchanged";
  // The FILE names are compared — never the name a page is shown by (`pageTitle` answers with the
  // folder for a container-named note).
  const leaf = fileTitle(newPath);
  // Nothing was typed (a plain move — to another parent, a resumed move): the stored title is
  // left alone, whatever the new path is. Only a RENAME, which carries the typed name, writes it.
  if (typed === undefined) return "unchanged";
  const stored = typeof before.metadata?.title === "string" && before.metadata.title.trim() ? before.metadata.title : null;
  const title = typed.trim();
  const next = title && title !== leaf ? title : null;
  if (next === stored) return "unchanged";
  try {
    try {
      if (!client.updateProperties) throw new VaultRequestError(501, "no properties route");
      // Compare-and-set on what was read — `null` = "no stored title" (the route reads absent as null).
      // (The RAW value read — a blank or odd stored title must compare equal to itself.)
      await client.updateProperties(before.id, { title: next }, { title: before.metadata?.title ?? null });
    } catch (e) {
      // A shell or an older server without the properties route: an ordinary metadata write.
      if (!(e instanceof VaultRequestError && [404, 405, 501].includes(e.status))) throw e;
      await client.updateNote(before.id, { metadata: { title: next }, ...(before.updatedAt && fileTitle(before.path) === leaf ? { ifUpdatedAt: before.updatedAt } : {}) });
    }
    return "written";
  } catch (e) {
    // Someone set another title meanwhile: theirs stands.
    return e instanceof Error && e.name === "PropertyConflictError" ? "unchanged" : "failed";
  }
}
