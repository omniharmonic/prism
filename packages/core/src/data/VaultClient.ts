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
import type { QueryPage, QuerySpec, SchemaMap, SchemaPatch, TagSchema } from "../lib/database";

/** Transport status for recoverable UI states, without parsing diagnostic text. */
export class VaultRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "VaultRequestError"; }
}
export function isAccessUnavailable(error: unknown): boolean {
  return error instanceof VaultRequestError && [401, 403, 404, 410].includes(error.status);
}

export interface PersonSummary {
  id: string; updatedAt?: string | null; canManageIdentities?: boolean; name: string; path: string | null; role: string | null;
  identities: Array<{ kind: string; value: string }>;
}
export interface PeoplePage { people: PersonSummary[]; next: string | null }
export interface PersonPage {
  person: PersonSummary;
  related: Array<{ id: string; title: string; path: string | null; category: "conversations" | "meetings" | "tasks" | "notes"; relationships: string[] }>;
  next: string | null;
}

export interface VaultLink {
  sourceId: string;
  targetId: string;
  relationship: string;
  metadata?: unknown;
  createdAt: string;
}

export interface VaultNeighborhood {
  edges: VaultGraph["edges"];
  nodes: Array<{ id: string; path: string | null; title: string; tags: string[] }>;
  truncated: boolean;
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
 * One captured prior state of a note (Parachute vault ≥ 0.7.9 note history).
 *
 * A version is what the note looked like just BEFORE a change: `supersededAt` is
 * when that change happened and `op` is what it was (`update`, `delete`,
 * `restore`, `tag-rename`, …). The list is newest-first and carries no content.
 */
export interface NoteVersionSummary {
  versionIx: number;
  op: string;
  supersededAt: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  /** Byte length of the captured content. */
  contentLength: number;
  /** Vault-side attribution — present for the owner only. */
  actor?: string | null;
  via?: string | null;
}

export interface NoteVersion extends NoteVersionSummary {
  /** Full body; `null` only for an over-2 MB delete tombstone (unrecoverable). */
  content: string | null;
}

export interface NoteVersionPage {
  versions: NoteVersionSummary[];
  total: number;
}

/**
 * Thrown by the history methods when the connected vault predates note history
 * (< 0.7.9) — the UI shows the plain timeline instead of an error.
 */
export class HistoryUnavailableError extends Error {
  constructor() {
    super("This vault does not support version history yet.");
    this.name = "HistoryUnavailableError";
  }
}

/**
 * Thrown by `restoreNoteVersion` when the note changed after the caller last
 * saw it (409) — the UI refreshes and asks again rather than overwriting.
 */
export class HistoryConflictError extends Error {
  constructor() {
    super("This note changed since you opened it. Review the latest version and try again.");
    this.name = "HistoryConflictError";
  }
}

/**
 * Thrown by `updateProperties` when a property the caller changed was changed
 * elsewhere since they read it. `current` holds the values now stored.
 */
export class PropertyConflictError extends Error {
  constructor(public readonly fields: string[], public readonly current: Record<string, unknown>) {
    super("This property was changed somewhere else. Review the current value and try again.");
    this.name = "PropertyConflictError";
  }
}

/** Result of a property write: the note's new revision + full metadata. */
export interface PropertyWriteResult {
  id: string;
  updatedAt: string | null;
  metadata: Record<string, unknown>;
}

/** Map one raw vault version row (snake_case) onto {@link NoteVersion}. */
export function toNoteVersion(raw: Record<string, unknown>): NoteVersion {
  return {
    versionIx: raw.version_ix as number,
    op: (raw.op as string) ?? "update",
    supersededAt: raw.superseded_at as string,
    path: (raw.path as string | null) ?? null,
    metadata: (raw.metadata as Record<string, unknown> | null) ?? null,
    contentLength: (raw.content_len as number) ?? 0,
    actor: raw.actor as string | null | undefined,
    via: raw.via as string | null | undefined,
    content: raw.content === undefined ? null : (raw.content as string | null),
  };
}

/** What {@link VaultClient.uploadAttachment} returns: an embeddable, access-checked URL. */
export interface UploadedAttachment {
  id: string;
  /** Same-origin (or server-proxied) URL the editor stores in `<img src>`. */
  url: string;
  name: string;
  mimeType: string;
  size: number;
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
  /** Resolved audience identity for multi-request actions, never credentials. */
  scope?(): string;
  /** Fresh, permission-filtered exact/alias/title resolution. No document bodies. */
  resolveWikilink?(target: string): Promise<{kind:"match"|"ambiguous"|"none";candidates:Array<{id:string;path:string|null;title:string}>}>;
  getThreadMessages?(noteId: string, before?: string): Promise<import("../lib/matrix/types").MessageBatch>;
  listNotes(filters?: NoteFilters): Promise<Note[]>;
  listTree(): Promise<NoteTreeEntry[]>;
  /** fresh bypasses an offline read cache when current server access must be checked. */
  getNote(id: string, options?: { fresh?: boolean }): Promise<Note>;
  createNote(params: CreateNoteParams): Promise<Note>;
  updateNote(id: string, params: UpdateNoteParams, options?: { expectedScope?: string }): Promise<Note>;
  /** Preserve an unsent editor draft locally in its original audience; never send it. */
  preserveDraft?(id: string, content: string, audience: string): Promise<void>;
  /** True while this audience has deferred or uncertain writes awaiting sync/review. */
  hasPendingWrites?(): Promise<boolean>;
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
  reconcileCanvasRelations?(canvasId: string, fingerprint: string): Promise<{synced: number; retained: boolean}>;
  changePersonIdentity?(id: string, change: { kind: "email" | "matrix"; value: string; action: "add" | "remove"; ifUpdatedAt: string }): Promise<{ person: PersonSummary }>;
  listPeople?(query?: string, after?: string): Promise<PeoplePage>;
  getPerson?(id: string, after?: string): Promise<PersonPage>;
  getNeighborhood?(centerId: string, depth: number, limit?: number): Promise<VaultNeighborhood>;
  getVaultInfo(): Promise<VaultInfo>;
  updateVaultDescription(description: string): Promise<VaultInfo>;
  /** Note version history. Optional per shell; throws {@link HistoryUnavailableError}
   *  when the vault predates history. Newest first, no content. */
  listNoteVersions?(noteId: string, opts?: { limit?: number; offset?: number }): Promise<NoteVersionPage>;
  /** One version with its full content. */
  getNoteVersion?(noteId: string, versionIx: number): Promise<NoteVersion>;
  /** Make `versionIx` the current content + metadata (tags and path are kept).
   *  `ifUpdatedAt` is the note's `updatedAt` the user reviewed — the vault refuses
   *  a blind restore; a stale value throws {@link HistoryConflictError}. The
   *  replaced state is itself captured, so a restore is always undoable. */
  restoreNoteVersion?(noteId: string, versionIx: number, ifUpdatedAt: string): Promise<Note>;
  /** Tag schemas (vault types + Prism presentation hints), filtered to tags the
   *  caller may know. Optional: shells without it use the bundled schemas. */
  getSchemas?(tags?: string[]): Promise<{ schemas: SchemaMap; canEdit?: boolean }>;
  /** Owner-only additive schema edit (the server holds the admin credential). */
  updateSchema?(tag: string, patch: SchemaPatch): Promise<TagSchema>;
  /** Lean, permission-filtered, paged rows for a database view. Optional: the
   *  shared engine runs over `listNotes` when absent. */
  queryNotes?(spec: QuerySpec): Promise<QueryPage>;
  /** Metadata-only property write with per-field compare-and-set (`expect` = the
   *  values the caller last saw). Throws {@link PropertyConflictError}. */
  updateProperties?(id: string, set: Record<string, unknown>, expect?: Record<string, unknown>): Promise<PropertyWriteResult>;
  /** Store an image/file as an attachment of `noteId` and return a URL to embed.
   *  Optional: when absent, the editor hides upload (paste/drop/pick) and offers
   *  only "Image from URL". Rejects on refusal; the editor inserts nothing. */
  uploadAttachment?(noteId: string, file: File): Promise<UploadedAttachment>;
}
