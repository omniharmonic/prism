/**
 * Browser shim for `@tauri-apps/api/core` (aliased in vite.config.ts).
 *
 * `@prism/core` calls `invoke(cmd, args)` for everything the desktop backend
 * does. On the web we route the vault + markdown commands to Parachute REST /
 * local JS, and gracefully degrade desktop-only commands (AI agent, Gmail,
 * Calendar, Matrix, Notion, GitHub, native config) so the shared UI never hard-
 * crashes — those surfaces simply report "not available on web" if invoked.
 */
import { marked } from "marked";
import TurndownService from "turndown";
import type { NoteFilters, CreateNoteParams, UpdateNoteParams } from "@prism/core";
import * as rest from "../parachute/rest";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

type Args = Record<string, unknown>;

function notAvailable(cmd: string): Promise<never> {
  return Promise.reject(new Error(`"${cmd}" is not available in Prism Web (desktop-only feature)`));
}

async function route(cmd: string, a: Args): Promise<unknown> {
  switch (cmd) {
    // ---- vault (Parachute REST) ----
    case "vault_list_notes":
      return rest.listNotes(a as NoteFilters);
    case "vault_list_tree":
      return rest.listTree();
    case "vault_get_note":
      return rest.getNote(a.id as string);
    case "vault_create_note":
      return rest.createNote(a as unknown as CreateNoteParams);
    case "vault_update_note":
      return rest.updateNote(a.id as string, a as unknown as UpdateNoteParams);
    case "vault_delete_note":
      return rest.deleteNote(a.id as string);
    case "vault_batch_delete":
      return rest.batchDelete(a.ids as string[]);
    case "vault_search":
      return rest.search(a.query as string, a.tags as string[] | undefined, a.limit as number | undefined);
    case "vault_get_tags":
      return rest.getTags();
    case "vault_add_tags":
      return rest.addTags(a.id as string, a.tags as string[]);
    case "vault_remove_tags":
      return rest.removeTags(a.id as string, a.tags as string[]);
    case "vault_get_stats":
      return rest.getStats();
    case "vault_get_info":
      return rest.getVaultInfo();
    case "vault_update_description":
      return rest.updateVaultDescription(a.description as string);
    case "vault_get_paths":
      return rest.getPaths();
    case "vault_get_links":
      return rest.getLinks(a.noteId as string | undefined, a.relationship as string | undefined);
    case "vault_create_link":
      return rest.createLink(
        a.sourceId as string,
        a.targetId as string,
        a.relationship as string,
        a.metadata,
      );
    case "vault_delete_link":
      return rest.deleteLink(a.sourceId as string, a.targetId as string, a.relationship as string);
    case "vault_get_graph":
      return rest.getGraph(a.depth as number | undefined, a.centerId as string | undefined);

    // ---- markdown <-> html (local, no backend) ----
    case "markdown_to_html":
      return await marked.parse((a.markdown as string) ?? "");
    case "html_to_markdown":
      return turndown.turndown((a.html as string) ?? "");

    // ---- wikilinks (best-effort passthrough on web) ----
    case "resolve_wikilinks":
      return (a.content as string) ?? "";
    case "resolve_all_wikilinks":
      return [];

    // ---- benign status reads: keep widgets from erroring on mount ----
    case "check_services":
      return { parachute: true, matrix: false };
    case "get_service_status":
      return [];
    case "github_check_auth":
      return { authenticated: false, username: null, message: "Not available on web" };
    case "github_sync_status":
    case "notion_db_sync_status":
    case "notion_db_list":
    case "ollama_list_models":
    case "agent_get_dispatches":
    case "agent_get_skills":
      return [];
    case "ollama_status":
      return false;
    case "get_skill_models":
      return {};
    case "get_full_config":
      return {};

    default:
      return notAvailable(cmd);
  }
}

export function invoke<T = unknown>(cmd: string, args?: Args): Promise<T> {
  return route(cmd, args ?? {}) as Promise<T>;
}
