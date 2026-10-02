import type { VaultClient } from "@prism/core";
import * as rest from "./rest";
import { agentScope } from "../config";

/**
 * Web implementation of the {@link VaultClient} seam — the typed boundary the
 * shared hooks in `@prism/core` consume via `useVaultClient()`. Delegates to the
 * Parachute REST layer. The desktop shell provides the equivalent over Tauri.
 */
export const httpVaultClient: VaultClient = {
  scope: () => agentScope() ?? "",
  listNotes: rest.listNotes,
  listPeople: rest.listPeople,
  changePersonIdentity: rest.changePersonIdentity,
  getPerson: rest.getPerson,
  resolveWikilink: rest.resolveWikilink,
  listTree: rest.listTree,
  getNote: rest.getNote,
  getThreadMessages: rest.getThreadMessages,
  createNote: rest.createNote,
  updateNote: rest.updateNote,
  deleteNote: rest.deleteNote,
  search: rest.search,
  semanticSearch: rest.semanticSearch,
  getTags: rest.getTags,
  addTags: rest.addTags,
  removeTags: rest.removeTags,
  getStats: rest.getStats,
  getLinks: rest.getLinks,
  createLink: rest.createLink,
  hasPendingWrites: rest.hasPendingWrites,
  deleteLink: rest.deleteLink,
  getGraph: rest.getGraph,
  getNeighborhood: rest.getNeighborhood,
  reconcileCanvasRelations: rest.reconcileCanvasRelations,
  getVaultInfo: rest.getVaultInfo,
  updateVaultDescription: rest.updateVaultDescription,
  listNoteVersions: rest.listNoteVersions,
  getNoteVersion: rest.getNoteVersion,
  restoreNoteVersion: rest.restoreNoteVersion,
};
