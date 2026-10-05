/**
 * The page icon write rule (NP-PG-01).
 *
 * `metadata.icon` is drawn on every surface that lists the page: as text (an emoji),
 * as a built-in glyph, or as an <img src> — the page's OWN uploaded image. The tree
 * projection only checks the SHAPE (`@prism/core/page-icon`); who owns the attachment
 * is decided here, on write, where one SQLite lookup answers it:
 *
 *   an image icon must be a live image attachment of THIS note, in this vault.
 *
 * So a page never points its icon at another page's file (which would load only for
 * the readers who can also view that other page, and would dangle when it is purged).
 * A value that is not an icon at all is refused too. `null` (remove) and restating
 * the stored value always pass.
 */
import { parsePageIcon } from "@prism/core/page-icon";
import { getAttachment } from "./attachments";

export interface IconRefusal { status: 400 | 403; error: "invalid_request" | "forbidden"; reason: string }

export function iconWriteRefusal(vaultId: string, noteId: string, value: unknown, current: unknown): IconRefusal | null {
  if (value === null || value === undefined || value === current) return null;
  const icon = parsePageIcon(value);
  if (!icon) return { status: 400, error: "invalid_request", reason: "That is not a page icon." };
  if (icon.kind !== "image") return null;
  const row = getAttachment(icon.attachmentId);
  // One answer for "no such file", "another page's file", "another vault's" and "not an image".
  if (!row || row.vault_id !== vaultId || row.note_id !== noteId || !row.mime.toLowerCase().startsWith("image/")) {
    return { status: 403, error: "forbidden", reason: "A page icon image must be an image uploaded to this page." };
  }
  return null;
}

/**
 * A NEW note owns no files yet, so its icon cannot be checked for ownership: an icon is kept
 * when it has an icon's shape (a duplicate / a page made from a template arrives with the
 * source's image, and `POST /notes/:id/attachments/copy` then gives the copy its own file);
 * anything else is dropped rather than failing the create.
 */
export const iconForCreate = (value: unknown): string | undefined => (parsePageIcon(value) ? (value as string) : undefined);
