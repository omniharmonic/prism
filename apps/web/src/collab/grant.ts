import type { CollabSharing } from "@prism/core";

/**
 * Collab share-link minting. The old path (browser vault token → Cloudflare
 * Worker /grant) was retired in the security pivot: the browser no longer holds
 * a vault token, and the Worker was taken down. Real-time collab + capability
 * link minting are rebuilt server-side (Prism Server + Hocuspocus, plan phases
 * P2/P3). Until then this seam reports that sharing is unavailable rather than
 * silently producing a dead link.
 */
export const webCollabSharing: CollabSharing = {
  async createShareLink(): Promise<string> {
    throw new Error("Sharing is being rebuilt on the new Prism Server — coming soon.");
  },
};

/**
 * Retired: minted a collab grant from the Worker using the browser's vault
 * token. Kept as a throwing stub so the /collab route still compiles until the
 * Hocuspocus-based path (P3) replaces it. Callers wrap this in `.catch`.
 */
export async function mintGrant(_noteId: string, _token: string): Promise<string> {
  throw new Error("Collab grant minting moved server-side (Prism Server, P3).");
}
