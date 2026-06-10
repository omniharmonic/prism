import { invoke } from "@tauri-apps/api/core";
import { vaultApi, type VaultClient, type SemanticHit } from "@prism/core";

/**
 * Desktop implementation of the {@link VaultClient} seam.
 *
 * Delegates to the existing Tauri `invoke`-based `vaultApi`, which proxies to
 * the Parachute REST API inside the Rust backend. The web shell will provide a
 * `fetch`-based implementation of this same interface, so the shared UI in
 * `@prism/core` stays identical across both.
 */
export const tauriVaultClient: VaultClient = {
  listNotes: (filters) => vaultApi.listNotes(filters),
  listTree: () => vaultApi.listTree(),
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
  getVaultInfo: () => vaultApi.getVaultInfo(),
  updateVaultDescription: (description) => vaultApi.updateVaultDescription(description),
};
