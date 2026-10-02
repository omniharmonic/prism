/**
 * Agent PROFILES (Arch v2 WP3.4): which tools a run may call, and through which
 * MCP server.
 *
 *   vault-ro  parachute-vault read tools (+ a READ-scoped hub token, agent-sessions.ts)
 *   vault-rw  vault read + create/update/delete-note + attachment download
 *   skill     vault-rw MINUS delete-note — background skill runs (WP1.1); never
 *             has the open note inlined (it is not a session)
 *   prism-ro  the server's OWN /mcp, read-scope tools, per-turn PAT (scope read)
 *   prism-rw  /mcp, read tools + the non-destructive write tools, per-turn PAT
 *             (scope write). No delete, share or governance voting/proposals.
 *   prism-graph  /mcp, note reads + the graph-maintenance tools (review queue,
 *             duplicates, merge RECOMMENDATIONS, filing gaps) + create/update
 *             note, per-turn PAT (scope write). Only this profile has them; it
 *             is offered only with AGENT_PRISM_PROFILES AND AGENT_GRAPH_PROFILE.
 *
 * Each allowlist is EXPLICIT (never a whole server) and the dontAsk permission
 * mode denies the rest. `buildClaudeArgs` additionally refuses any entry that
 * isn't the chosen server's. The prism-* profiles are behind
 * `AGENT_PRISM_PROFILES=true` (default off).
 */
import { PRISM_MCP_ALLOW, VAULT_MCP_ALLOW, type McpServerKind } from "./agent-exec";

export type AgentProfile = "vault-ro" | "vault-rw" | "skill" | "prism-ro" | "prism-rw" | "prism-suggest" | "prism-graph";
/** Every profile the type knows. */
export const ALL_PROFILES: readonly AgentProfile[] = ["vault-ro", "vault-rw", "skill", "prism-ro", "prism-rw", "prism-suggest", "prism-graph"];
/** Profiles a user may pick for a chat session (`skill` is server-internal; `prism-graph` needs its own flag too). */
export const SESSION_PROFILES: readonly AgentProfile[] = ["vault-ro", "vault-rw", "prism-ro", "prism-rw", "prism-suggest", "prism-graph"];
/** The always-available vault profiles (kept for existing importers). */
export const PROFILES: readonly AgentProfile[] = ["vault-ro", "vault-rw"];

/** Vault 0.7.9 tools whose manifest `requiredVerb` is "read". `doctor` is a
 *  read-only scan (core/src/doctor.ts: "never auto-fixes"; manifest verb read). */
export const READ_ONLY_TOOLS = ["query-notes", "list-tags", "find-path", "vault-info", "doctor"] as const;
/** vault-rw is an EXPLICIT allowlist too — never the whole server: the admin-verb
 *  tools (update-tag, delete-tag, rename-tag, merge-tags, prune-schema,
 *  manage-token) and request-attachment-upload are never allowed. */
export const READ_WRITE_TOOLS = [
  "query-notes",
  "create-note",
  "update-note",
  "delete-note",
  "list-tags",
  "find-path",
  "vault-info",
  "doctor",
  "read-attachment",
  "request-attachment-download",
] as const;
/** Background skills may write notes but never delete them. */
export const SKILL_TOOLS: readonly string[] = READ_WRITE_TOOLS.filter((t) => t !== "delete-note");

/** Prism MCP tools (scope read). Asserted against the live catalog in tests. */
export const PRISM_READ_TOOLS = [
  "prism_whoami",
  "prism_query_notes",
  "prism_get_note",
  "prism_semantic_search",
  "prism_list_tags",
  "prism_list_versions",
  "prism_get_version",
  "prism_list_comments",
  "prism_sheet_read",
  "prism_note_access",
  "prism_governance_state",
  "prism_dashboard_query",
] as const;
/** Write-scope additions for prism-rw. Deliberately absent: prism_delete_note,
 *  prism_share (grants), prism_propose_change / prism_vote / prism_withdraw_proposal
 *  (institutional actions a chat agent must not take on its own). */
export const PRISM_WRITE_TOOLS = [
  "prism_create_note",
  "prism_update_note",
  "prism_restore_version",
  "prism_add_comment",
  "prism_resolve_comment",
  "prism_suggest_edit",
  "prism_sheet_update",
] as const;

/**
 * Graph maintenance (mcp/tool-people.ts) — ONLY in the explicit `prism-graph`
 * profile, never in a general chat profile (review M3): the reads expose raw
 * identity keys (addresses, ids) and the writes change who a record belongs to.
 * None of them can merge, delete or create a person.
 */
export const PRISM_GRAPH_READ_TOOLS = ["prism_people_review_queue", "prism_people_review_context", "prism_people_duplicates", "prism_people_link_status"] as const;
export const PRISM_GRAPH_WRITE_TOOLS = ["prism_people_review_decide", "prism_people_recommend_merge", "prism_people_file_review"] as const;
/** prism-graph = note reads + the graph tools + creating/updating its own state and report notes. No delete, share, restore, comments. */
export const PRISM_GRAPH_TOOLS = [...PRISM_READ_TOOLS, ...PRISM_GRAPH_READ_TOOLS, ...PRISM_GRAPH_WRITE_TOOLS, "prism_create_note", "prism_update_note"] as const;

/** Which MCP server a profile talks to. */
export const profileServer = (p: AgentProfile): McpServerKind => (p === "prism-ro" || p === "prism-rw" || p === "prism-suggest" || p === "prism-graph" ? "prism" : "vault");
export const isPrismProfile = (p: AgentProfile): boolean => profileServer(p) === "prism";
/** The PAT scope a prism profile's per-turn credential carries. */
export const prismProfileScope = (p: AgentProfile): "read" | "write" => (p === "prism-rw" || p === "prism-suggest" || p === "prism-graph" ? "write" : "read");
export const isReadOnlyProfile = (p: AgentProfile): boolean => p === "vault-ro" || p === "prism-ro";

/** Server config switch for the prism-* profiles (read live so tests can flip it). */
export const prismProfilesEnabled = (): boolean => /^(1|true|on|yes)$/i.test(process.env.AGENT_PRISM_PROFILES?.trim() ?? "");
/** The graph-maintenance profile is an explicit opt-in on top of the prism profiles (read live). */
export const graphProfileEnabled = (): boolean => prismProfilesEnabled() && /^(1|true|on|yes)$/i.test(process.env.AGENT_GRAPH_PROFILE?.trim() ?? "");
/** May a session use this profile on this server right now? */
export const profileEnabled = (p: AgentProfile): boolean => (p === "prism-graph" ? graphProfileEnabled() : !isPrismProfile(p) || prismProfilesEnabled());

/** The `--allowedTools` list per profile. */
export function profileAllowedTools(profile: AgentProfile): string[] {
  switch (profile) {
    case "vault-ro":
      return READ_ONLY_TOOLS.map((t) => `${VAULT_MCP_ALLOW}__${t}`);
    case "vault-rw":
      return READ_WRITE_TOOLS.map((t) => `${VAULT_MCP_ALLOW}__${t}`);
    case "skill":
      return SKILL_TOOLS.map((t) => `${VAULT_MCP_ALLOW}__${t}`);
    case "prism-ro":
      return PRISM_READ_TOOLS.map((t) => `${PRISM_MCP_ALLOW}__${t}`);
    case "prism-suggest":
      return [...PRISM_READ_TOOLS, "prism_suggest_edit", "prism_add_comment"].map((t) => `${PRISM_MCP_ALLOW}__${t}`);
    case "prism-rw":
      return [...PRISM_READ_TOOLS, ...PRISM_WRITE_TOOLS].map((t) => `${PRISM_MCP_ALLOW}__${t}`);
    case "prism-graph":
      return PRISM_GRAPH_TOOLS.map((t) => `${PRISM_MCP_ALLOW}__${t}`);
  }
}

export const isProfile = (p: unknown): p is AgentProfile => typeof p === "string" && (ALL_PROFILES as readonly string[]).includes(p);
/** A profile a client may request for a session (prism-* only when enabled). */
export const isSessionProfile = (p: unknown): p is AgentProfile => isProfile(p) && (SESSION_PROFILES as readonly string[]).includes(p) && profileEnabled(p);
/** The profiles the server currently offers (the UI picker). */
export const availableSessionProfiles = (): AgentProfile[] => SESSION_PROFILES.filter((p) => isSessionProfile(p));

/** Per-turn MCP config pointing at THIS server's own /mcp with a per-turn PAT. */
export function prismMcpConfig(token: string, port: number): object {
  return {
    mcpServers: {
      prism: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` }, // the PAT pins the vault
      },
    },
  };
}

/** User-facing document permissions; outward actions are never implied. */
export type AgentPermissionMode = "read-only" | "suggest" | "read-write";
export const PERMISSION_MODES: readonly AgentPermissionMode[] = ["read-only", "suggest", "read-write"];
export const isPermissionMode = (value: unknown): value is AgentPermissionMode => PERMISSION_MODES.includes(value as AgentPermissionMode);
export const modeProfile = (mode: AgentPermissionMode): AgentProfile => mode === "read-only" ? "prism-ro" : mode === "suggest" ? "prism-suggest" : "prism-rw";
export const profileMode = (profile: AgentProfile): AgentPermissionMode => isReadOnlyProfile(profile) ? "read-only" : profile === "prism-suggest" ? "suggest" : "read-write";
