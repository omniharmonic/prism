import { invoke } from "@tauri-apps/api/core";
import type {
  Note,
  NoteFilters,
  CreateNoteParams,
  UpdateNoteParams,
  TagCount,
  VaultStats,
  VaultInfo,
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

  batchDelete: (ids: string[]) =>
    invoke<{ deleted: number; failed: number; total: number }>("vault_batch_delete", { ids }),

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

  indexMessages: () =>
    invoke<{ indexed: number; errors: number; total: number }>("index_messages"),

  getGraph: (depth?: number, centerId?: string) =>
    invoke<{ nodes: Array<{ id: string; path?: string; tags?: string[] }>; edges: Array<{ source: string; target: string; relationship: string }> }>(
      "vault_get_graph", { depth, centerId }
    ),

  getVaultInfo: () =>
    invoke<VaultInfo>("vault_get_info"),

  updateVaultDescription: (description: string) =>
    invoke<VaultInfo>("vault_update_description", { description }),
};

export const systemApi = {
  checkServices: () =>
    invoke<ServiceStatus>("check_services"),
};

export interface BackgroundServiceStatus {
  name: string;
  running: boolean;
  last_run: string | null;
  last_error: string | null;
  items_processed: number;
}

export const serviceApi = {
  getStatus: () =>
    invoke<BackgroundServiceStatus[]>("get_service_status"),
};

export interface AgentDispatch {
  id: string;
  skill: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at: string | null;
  duration_secs: number | null;
  output: string | null;
  error: string | null;
  note_id: string | null;
}

export interface AgentSkill {
  id: string;
  path: string;
  prompt: string;
  skillName: string;
  description: string;
  intervalSecs: number;
  enabled: boolean;
  lastRun: string | null;
  runAtHour: number | null;
}

export const agentApi = {
  dispatch: (skill: string, prompt: string, context?: string) =>
    invoke<{ id: string }>("agent_dispatch", { skill, prompt, context }),

  getDispatches: () =>
    invoke<AgentDispatch[]>("agent_get_dispatches"),

  cancelDispatch: (id: string) =>
    invoke<void>("agent_cancel_dispatch", { id }),

  getSkills: () =>
    invoke<AgentSkill[]>("agent_get_skills"),

  updateSkill: (id: string, updates: { enabled?: boolean; intervalSecs?: number; prompt?: string; description?: string }) =>
    invoke<void>("agent_update_skill", { id, ...updates }),
};

export const convertApi = {
  markdownToHtml: (markdown: string) =>
    invoke<string>("markdown_to_html", { markdown }),

  htmlToMarkdown: (html: string) =>
    invoke<string>("html_to_markdown", { html }),
};

// GitHub sync
export const githubSyncApi = {
  /** Check if user is authenticated via gh CLI */
  checkAuth: () =>
    invoke<{ authenticated: boolean; username: string | null; message: string }>(
      "github_check_auth"
    ),

  /** Initialize a new GitHub sync for a vault directory */
  init: (params: {
    vaultPath: string;
    remoteUrl: string;
    branch: string;
    commitStrategy: string;
    conflictStrategy: string;
    autoSync: boolean;
  }) => invoke<string>("github_sync_init", params),

  /** Sync vault directory to GitHub (push all changes) */
  push: (configId: string) =>
    invoke<{ pushed: string[]; pulled: string[]; conflicts: Array<{ path: string; localContent: string; remoteContent: string }>; errors: Array<[string, string]> }>(
      "github_sync_push", { configId }
    ),

  /** Push a single file after save (auto-sync) */
  pushFile: (configId: string, noteId: string) =>
    invoke<void>("github_sync_push_file", { configId, noteId }),

  /** Get status of all GitHub sync configs */
  status: () =>
    invoke<Array<{ id: string; vaultPath: string; remoteUrl: string; branch: string; lastSynced: string; autoSync: boolean }>>(
      "github_sync_status"
    ),

  /** Remove a GitHub sync configuration */
  remove: (configId: string) =>
    invoke<void>("github_sync_remove", { configId }),
};

// Notion database sync
export const notionDbSyncApi = {
  /** List available Notion databases */
  listDatabases: () =>
    invoke<Array<{ id: string; title: string; propertyCount: number }>>("notion_db_list"),

  /** Get database schema with auto-discovered mappings */
  getSchema: (databaseId: string) =>
    invoke<{
      properties: Array<{ name: string; propertyType: string; options: string[] }>;
      suggestedMappings: Array<{
        notionProperty: string; notionType: string; parachuteField: string;
        transform: string; valueMap: Record<string, string>; relationshipType: string | null;
      }>;
    }>("notion_db_schema", { databaseId }),

  /** Initialize a new database sync */
  init: (params: {
    databaseId: string;
    databaseName: string;
    parachuteTag: string;
    parachutePathPrefix: string;
    propertyMap: Array<{
      notionProperty: string; notionType: string; parachuteField: string;
      transform: string; valueMap?: Record<string, string>; relationshipType?: string;
    }>;
    titleProperty: string;
    contentProperty?: string;
    syncDirection: string;
    conflictStrategy: string;
    autoSync: boolean;
  }) => invoke<string>("notion_db_sync_init", params),

  /** Run sync for a configured database */
  sync: (configId: string) =>
    invoke<{ created: number; updated: number; deleted: number; conflicts: number; errors: string[] }>(
      "notion_db_sync", { configId }
    ),

  /** Get status of all Notion DB syncs */
  status: () =>
    invoke<Array<{ id: string; notionDatabaseName: string; parachuteTag: string; lastSynced: string; autoSync: boolean; syncedCount: number }>>(
      "notion_db_sync_status"
    ),

  /** Remove a Notion DB sync configuration */
  remove: (configId: string) =>
    invoke<void>("notion_db_sync_remove", { configId }),
};

// Ollama / model management
export const ollamaApi = {
  /** Check if Ollama is available */
  status: () => invoke<boolean>("ollama_status"),

  /** List available models from all providers */
  listModels: () =>
    invoke<Array<{ id: string; name: string; provider: string; size: string | null }>>(
      "ollama_list_models"
    ),

  /** Set model for a specific skill */
  setSkillModel: (skill: string, provider: string, model: string) =>
    invoke<void>("set_skill_model", { skill, provider, model }),

  /** Get current skill model configurations */
  getSkillModels: () =>
    invoke<Record<string, { provider: string; model: string }>>("get_skill_models"),
};
