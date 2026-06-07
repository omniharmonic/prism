import { invoke } from "@tauri-apps/api/core";
import type { CollabSharing } from "@prism/core";

/**
 * Desktop implementation of the CollabSharing seam. Delegates to a Rust command
 * that mints the per-note grant server-side using the vault token held in the
 * desktop config — so the token never enters the web context.
 */
export const tauriCollabSharing: CollabSharing = {
  createShareLink: (noteId: string) =>
    invoke<string>("create_collab_share_link", { noteId }),
};
