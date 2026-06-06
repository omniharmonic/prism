import type { VaultClient } from "@prism/core";
import * as rest from "./rest";

/**
 * Web implementation of the {@link VaultClient} seam — the typed boundary the
 * shared hooks in `@prism/core` consume via `useVaultClient()`. Delegates to the
 * Parachute REST layer. The desktop shell provides the equivalent over Tauri.
 */
export const httpVaultClient: VaultClient = {
  listNotes: rest.listNotes,
  listTree: rest.listTree,
  getNote: rest.getNote,
  createNote: rest.createNote,
  updateNote: rest.updateNote,
  deleteNote: rest.deleteNote,
  search: rest.search,
  getTags: rest.getTags,
  addTags: rest.addTags,
  removeTags: rest.removeTags,
  getStats: rest.getStats,
  getLinks: rest.getLinks,
  createLink: rest.createLink,
  deleteLink: rest.deleteLink,
  getGraph: rest.getGraph,
  getVaultInfo: rest.getVaultInfo,
  updateVaultDescription: rest.updateVaultDescription,
};
