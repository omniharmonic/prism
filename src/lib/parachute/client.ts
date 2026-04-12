import { invoke } from "@tauri-apps/api/core";
import type {
  Note,
  NoteFilters,
  CreateNoteParams,
  UpdateNoteParams,
  TagCount,
  VaultStats,
  ServiceStatus,
} from "../types";

export const vaultApi = {
  listNotes: (filters?: NoteFilters) =>
    invoke<Note[]>("vault_list_notes", { ...filters }),

  getNote: (id: string) =>
    invoke<Note>("vault_get_note", { id }),

  createNote: (params: CreateNoteParams) =>
    invoke<Note>("vault_create_note", { ...params }),

  updateNote: (id: string, params: UpdateNoteParams) =>
    invoke<Note>("vault_update_note", { id, ...params } as Record<string, unknown>),

  deleteNote: (id: string) =>
    invoke<void>("vault_delete_note", { id }),

  search: (query: string, tags?: string[], limit?: number) =>
    invoke<Note[]>("vault_search", { query, tags, limit }),

  getTags: () =>
    invoke<TagCount[]>("vault_get_tags"),

  addTags: (id: string, tags: string[]) =>
    invoke<void>("vault_add_tags", { id, tags }),

  removeTags: (id: string, tags: string[]) =>
    invoke<void>("vault_remove_tags", { id, tags }),

  getStats: () =>
    invoke<VaultStats>("vault_get_stats"),

  getLinks: (noteId?: string, relationship?: string) =>
    invoke<Array<{ sourceId: string; targetId: string; relationship: string; metadata?: unknown; createdAt: string }>>(
      "vault_get_links", { noteId, relationship }
    ),

  createLink: (sourceId: string, targetId: string, relationship: string, metadata?: unknown) =>
    invoke<{ sourceId: string; targetId: string; relationship: string; createdAt: string }>(
      "vault_create_link", { sourceId, targetId, relationship, metadata }
    ),

  deleteLink: (sourceId: string, targetId: string, relationship: string) =>
    invoke<void>("vault_delete_link", { sourceId, targetId, relationship }),

  getGraph: (depth?: number, centerId?: string) =>
    invoke<{ nodes: Array<{ id: string; path?: string; tags?: string[] }>; edges: Array<{ source: string; target: string; relationship: string }> }>(
      "vault_get_graph", { depth, centerId }
    ),
};

export const systemApi = {
  checkServices: () =>
    invoke<ServiceStatus>("check_services"),
};

export const convertApi = {
  markdownToHtml: (markdown: string) =>
    invoke<string>("markdown_to_html", { markdown }),

  htmlToMarkdown: (html: string) =>
    invoke<string>("html_to_markdown", { html }),
};
