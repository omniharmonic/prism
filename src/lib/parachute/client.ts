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
