import type {
  Note,
  NoteFilters,
  NoteTreeEntry,
  CreateNoteParams,
  UpdateNoteParams,
  TagCount,
  VaultStats,
  VaultInfo,
} from "../lib/types";

export interface VaultLink {
  sourceId: string;
  targetId: string;
  relationship: string;
  metadata?: unknown;
  createdAt: string;
}

export interface VaultGraph {
  nodes: Array<{ id: string; path?: string; tags?: string[] }>;
  edges: Array<{ source: string; target: string; relationship: string }>;
}

/** A note returned by semantic search, carrying its fused relevance score and a
 *  matching passage snippet (both populated by the server's RAG service). */
export interface SemanticHit extends Note {
  _score?: number;
  _snippet?: string;
}

/**
 * The data-source seam between the shared UI (`@prism/core`) and a host shell.
 *
 * The desktop shell implements this over Tauri `invoke` (see
 * `apps/desktop/src/data/TauriVaultClient.ts`); the planned web shell will
 * implement the same interface over `fetch` against the Parachute REST API.
 *
 * Core components and hooks MUST reach the vault only through this interface,
 * obtained via `useVaultClient()` — never by importing a concrete client.
 * That single indirection is what lets one codebase serve both shells.
 */
export interface VaultClient {
  listNotes(filters?: NoteFilters): Promise<Note[]>;
  listTree(): Promise<NoteTreeEntry[]>;
  getNote(id: string): Promise<Note>;
  createNote(params: CreateNoteParams): Promise<Note>;
  updateNote(id: string, params: UpdateNoteParams): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  search(query: string, tags?: string[], limit?: number): Promise<Note[]>;
  /** Hybrid semantic search (dense vectors + full-text), when the host provides
   *  it. Optional: shells without a RAG backend omit it, and callers fall back
   *  to {@link search}. Results are relevance-ranked with score + snippet. */
  semanticSearch?(query: string, limit?: number): Promise<SemanticHit[]>;
  getTags(): Promise<TagCount[]>;
  addTags(id: string, tags: string[]): Promise<void>;
  removeTags(id: string, tags: string[]): Promise<void>;
  getStats(): Promise<VaultStats>;
  getLinks(noteId?: string, relationship?: string): Promise<VaultLink[]>;
  createLink(
    sourceId: string,
    targetId: string,
    relationship: string,
    metadata?: unknown,
  ): Promise<VaultLink>;
  deleteLink(sourceId: string, targetId: string, relationship: string): Promise<void>;
  getGraph(depth?: number, centerId?: string): Promise<VaultGraph>;
  getVaultInfo(): Promise<VaultInfo>;
  updateVaultDescription(description: string): Promise<VaultInfo>;
}
