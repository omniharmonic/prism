import type { VaultClient } from "@prism/core/shell";
import * as rest from "./rest";
import * as pages from "./pages";
import * as sharing from "./sharing";
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
  preserveDraft: rest.preserveDraft,
  deleteNote: rest.deleteNote,
  search: rest.search,
  searchNotes: rest.searchNotes,
  searchFilterSupport: rest.searchFilterSupport,
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
  movePage: pages.movePage,
  setPageMeta: pages.setPageMeta,
  trashPage: pages.trashPage,
  listTrash: pages.listTrash,
  listSharedWithMe: sharing.listSharedWithMe,
  listComments: sharing.listComments,
  getPageActivity: sharing.getPageActivity,
  getAccessPreview: sharing.getAccessPreview,
  restoreFromTrash: pages.restoreFromTrash,
  deleteFromTrash: pages.deleteFromTrash,
  getPreferences: pages.getPreferences,
  savePreferences: pages.savePreferences,
  getSchemas: rest.getSchemas,
  updateSchema: rest.updateSchema,
  removePropertyValues: rest.removePropertyValues,
  checkNewTag: rest.checkNewTag,
  queryNotes: rest.queryNotes,
  updateProperties: rest.updateProperties,
  uploadAttachment: rest.uploadAttachment,
  copyAttachments: rest.copyAttachments,
  unfurl: rest.unfurl,
  updatePropertiesBatch: rest.updatePropertiesBatch,
  importCsv: rest.importCsv,
};
