import { projectRelatedPage } from "@prism/core/projects";
import { invoke } from "@tauri-apps/api/core";
import {
  vaultApi,
  toNoteVersion,
  HistoryUnavailableError,
  HistoryConflictError,
  type Note,
  type VaultClient,
  type SemanticHit,
} from "@prism/core";

/** Map the Rust history error markers (see clients/parachute.rs) onto typed errors. */
function historyError(e: unknown): never {
  const msg = String(e);
  if (msg.includes("history_unavailable")) throw new HistoryUnavailableError();
  if (msg.includes("history_conflict")) throw new HistoryConflictError();
  throw e instanceof Error ? e : new Error(msg);
}

/**
 * Desktop implementation of the {@link VaultClient} seam.
 *
 * Delegates to the existing Tauri `invoke`-based `vaultApi`, which proxies to
 * the Parachute REST API inside the Rust backend. The web shell will provide a
 * `fetch`-based implementation of this same interface, so the shared UI in
 * `@prism/core` stays identical across both.
 */
let projectTree: { at: number; rows: ReturnType<typeof vaultApi.listTree> } | undefined;
function projectInventory() {
  if (!projectTree || Date.now() - projectTree.at > 3000) {
    const rows = vaultApi.listTree();
    projectTree = { at: Date.now(), rows };
    rows.catch(() => { if (projectTree?.rows === rows) projectTree = undefined; });
  }
  return projectTree.rows;
}
export const tauriVaultClient: VaultClient = {
  listNotes: (filters) => vaultApi.listNotes(filters),
  listTree: () => vaultApi.listTree(),
  getProjectRelated: async (id, kind, after) => {
    const notes = await projectInventory();
    const project = notes.find(note => note.id === id);
    if (!project) throw new Error("Project unavailable");
    return projectRelatedPage(notes, project, kind, after);
  },
  getNote: (id) => vaultApi.getNote(id),
  createNote: (params) => vaultApi.createNote(params),
  updateNote: (id, params) => vaultApi.updateNote(id, params),
  deleteNote: (id) => vaultApi.deleteNote(id),
  search: (query, tags, limit) => vaultApi.search(query, tags, limit),
  // Proxies to the Prism Server's RAG service via the Rust backend. Throws when
  // no server is configured; useVaultSearch then falls back to full-text search.
  semanticSearch: (query, limit) =>
    invoke<SemanticHit[]>("vault_semantic_search", { query, limit }),
  getTags: () => vaultApi.getTags(),
  addTags: (id, tags) => vaultApi.addTags(id, tags),
  removeTags: (id, tags) => vaultApi.removeTags(id, tags),
  getStats: () => vaultApi.getStats(),
  getLinks: (noteId, relationship) => vaultApi.getLinks(noteId, relationship),
  createLink: (sourceId, targetId, relationship, metadata) =>
    vaultApi.createLink(sourceId, targetId, relationship, metadata),
  deleteLink: (sourceId, targetId, relationship) =>
    vaultApi.deleteLink(sourceId, targetId, relationship),
  getGraph: (depth, centerId) => vaultApi.getGraph(depth, centerId),
  reconcileCanvasRelations: async (canvasId, fingerprint) => {
    try { return await invoke<{synced:number;retained:boolean}>("vault_canvas_reconcile", {canvasId, fingerprint}); }
    catch (e) { throw new Error(String(e).includes("canvas_scene_changed") ? "canvas_scene_changed" : "canvas_relationships_unavailable"); }
  },
  getVaultInfo: () => vaultApi.getVaultInfo(),
  updateVaultDescription: (description) => vaultApi.updateVaultDescription(description),
  listNoteVersions: async (id, opts) => {
    const page = await invoke<{ versions?: Record<string, unknown>[]; total?: number }>(
      "vault_list_note_versions",
      { id, limit: opts?.limit, offset: opts?.offset },
    ).catch(historyError);
    return { versions: (page.versions ?? []).map(toNoteVersion), total: page.total ?? 0 };
  },
  getNoteVersion: async (id, versionIx) =>
    toNoteVersion(
      await invoke<Record<string, unknown>>("vault_get_note_version", { id, versionIx }).catch(historyError),
    ),
  restoreNoteVersion: (id, versionIx, ifUpdatedAt) =>
    invoke<Note>("vault_restore_note_version", { id, versionIx, ifUpdatedAt }).catch(historyError),
};
