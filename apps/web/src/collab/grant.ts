import type { CollabSharing } from "@prism/core";
import { getConnection } from "../config";

const collabHost = () => import.meta.env.VITE_COLLAB_HOST as string | undefined;

/**
 * Mint a collab grant for a note from the hardened Worker, using the vault
 * token. The Worker verifies the token against the vault before signing a
 * capability scoped to this note's room — so only people with vault access can
 * create share links.
 */
export async function mintGrant(noteId: string, token: string): Promise<string> {
  const host = collabHost();
  if (!host) throw new Error("Collab host not configured");
  const res = await fetch(`https://${host}/grant`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ noteId }),
  });
  if (!res.ok) throw new Error(`Could not mint collab grant: ${res.status}`);
  return (await res.json()).grant as string;
}

/** Web implementation of the CollabSharing seam consumed by the core ShareButton. */
export const webCollabSharing: CollabSharing = {
  async createShareLink(noteId: string): Promise<string> {
    const grant = await mintGrant(noteId, getConnection().token);
    return `${location.origin}/collab/${encodeURIComponent(noteId)}?t=${encodeURIComponent(grant)}`;
  },
};
