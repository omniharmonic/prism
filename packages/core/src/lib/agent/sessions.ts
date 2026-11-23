import type { AgentContextSnapshot } from "./contextSnapshots";
/**
 * The AgentClient seam (Arch v2 WP3.2) — durable, server-side agent sessions.
 *
 * Mirrors the Prism Server's `/api/agent/sessions*` API (apps/server/src/routes/
 * agent.ts + agent-sessions.ts + agent-events.ts). Like `VaultClient`, the UI
 * depends only on this interface; each shell injects an implementation:
 *   web / PWA / native build → `createHttpAgentClient(serverFetch, …)`
 *   desktop (Tauri)          → none yet (keeps its Tauri agent path until WP4)
 * No provider = the Agent chat entry points are hidden.
 *
 * Types are copied (not imported) from the server so `@prism/core` stays free of
 * server code. Field names follow the wire format exactly (snake_case rows).
 */

export type AgentProfile = "vault-ro" | "vault-rw" | "skill" | "prism-ro" | "prism-rw" | "prism-suggest";
export type AgentPermissionMode = "read-only" | "suggest" | "read-write";
/** How the server's `claude` runner is billed: a subscription login reports an API-equivalent ESTIMATE. */
export type AgentBilling = "subscription" | "api" | "unknown";

/** `GET /api/agent/limits` (WP3.4): billing mode, budgets (server config, read-only here) and the selectable profiles. */
export interface AgentLimits {
  billing: AgentBilling;
  session: { limitUsd: number | null };
  daily: { limitUsd: number | null; spentUsd: number; remainingUsd: number | null; resetsAt: number };
  profiles: AgentProfile[];
  defaultProfile: AgentProfile;
  permissionModes?: AgentPermissionMode[];
  idempotentRequests?: boolean;
  followups?: { maxQueued: number };
  contextSnapshots?: { maxSnapshots: number; maxCharacters: number };
  contextNotes?: { maxNotes: number; maxCharactersPerNote: number };
}
export type AgentSessionStatus = "idle" | "running" | "archived";
export type AgentTurnStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export const TERMINAL_TURN_STATUSES: ReadonlySet<AgentTurnStatus> = new Set(["done", "error", "cancelled", "interrupted"]);
export const isTerminalTurn = (s: AgentTurnStatus | null | undefined): boolean => !!s && TERMINAL_TURN_STATUSES.has(s);

/** `agent_sessions` row. Timestamps are epoch ms. */
export interface AgentSession {
  id: string;
  vault_id: string;
  owner_email: string;
  title: string | null;
  profile: AgentProfile;
  permission_mode?: AgentPermissionMode | null;
  policy_version?: number;
  pending_mode?: AgentPermissionMode | null;
  note_id: string | null;
  cli_session_id: string | null;
  status: AgentSessionStatus;
  transcript_note_id: string | null;
  cost_usd: number;
  created_at: number;
  updated_at: number;
}

/** `GET /sessions` list row: the session + a summary of its latest turn. */
export interface AgentSessionSummary extends AgentSession {
  turnCount: number;
  lastTurnAt: number | null;
  lastTurnStatus: AgentTurnStatus | null;
}

/** `agent_turns` row + the detail route's per-turn summary. */
export interface AgentTurn {
  id: string;
  session_id: string;
  prompt: string;
  note_id: string | null;
  context?: AgentContextRecord[];
  status: AgentTurnStatus;
  pid: number | null;
  exit_code: number | null;
  error: string | null;
  /** Stable failure class of a failed turn (null: it did not fail; absent on older servers). */
  errorCode?: string | null;
  cost_usd: number | null;
  started_at: number | null;
  ended_at: number | null;
  /** Text blocks after the last tool call (the reply). */
  finalText: string;
  /** Tool names used, in order (vault prefix stripped). */
  tools: string[];
  touched: Array<{ noteId: string; op: string }>;
  /** First/last persisted event seq of this turn (null = no events yet). */
  firstSeq?: number | null;
  lastSeq?: number | null;
}
export interface AgentContextRecord { noteId: string; characters: number; truncated: boolean; updatedAt: string | null; snapshot?: AgentContextSnapshot }

export interface AgentSessionDetail {
  session: AgentSession;
  turns: AgentTurn[];
  /** Highest persisted seq in the session (0 = none). Older servers omit it. */
  lastSeq?: number;
}

/** Normalized agent events (server `AgentEvent`). */
export type AgentEvent =
  | { t: "init"; cliSessionId: string; model: string; tools: string[]; mcp: Array<{ name: string; status: string }> }
  | { t: "text_delta"; blockId: string; text: string }
  | { t: "text"; blockId: string; text: string }
  | { t: "tool_use"; id: string; name: string; input: unknown }
  | { t: "tool_result"; toolUseId: string; ok: boolean; summary: string }
  | { t: "note_touched"; noteId: string; op: "create" | "update" | "delete" }
  /** The CLI reporting a failure of its own (sign-in, usage limit) — never assistant text. */
  | { t: "error"; code: string; text: string }
  /** `errorCode`: why it failed (terminal) or why it waits ("memory"); `retry`: the server is
   *  re-spawning once after a sign-in failure — forget the failed attempt. */
  | { t: "status"; status: AgentTurnStatus; reason?: string; errorCode?: string; retry?: boolean }
  | { t: "result"; ok: boolean; costUsd?: number; durationMs: number; numTurns?: number; error?: string; errorCode?: string };

/** One SSE message: a persisted event carries `seq`; a live `text_delta` does not. */
export type AgentStreamMessage = AgentEvent & { turnId: string; seq?: number };

export interface AgentStreamHandlers {
  onEvent(msg: AgentStreamMessage): void;
  /** A connection (re)opened. */
  onOpen?(): void;
  /** A drop (willRetry) or a fatal error (e.g. 403/404). */
  onError?(err: Error, info: { willRetry: boolean }): void;
  /** The stream is finished for good (turn ended, server closed with nothing in flight, fatal error, or unsubscribed). */
  onClose?(): void;
}

export interface CreateSessionParams {
  requestId?: string;
  title?: string;
  noteId?: string;
  profile?: AgentProfile;
  permissionMode?: AgentPermissionMode;
}

/** Error from the agent API, with the server's `{error, detail, turnId}` body. */
export class AgentApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: string,
    /** On a 409 "conflict": the turn that is already queued/running. */
    public turnId?: string,
  ) {
    super(detail || code || `agent API ${status}`);
    this.name = "AgentApiError";
  }
}

export interface AgentFollowupPayload { prompt: string; noteId?: string; contextNoteIds?: string[]; contextSnapshots?: AgentContextSnapshot[] }
export interface AgentFollowup { id: string; sessionId: string; status: "waiting" | "dispatching" | "blocked" | "accepted" | "cancelled"; version: number; permissionMode: AgentPermissionMode; payload: AgentFollowupPayload; error: string | null; turnId: string | null; createdAt: number }
export interface AgentClient {
  listFollowups?(sessionId: string): Promise<{ followups: AgentFollowup[] }>;
  queueFollowup?(sessionId: string, payload: AgentFollowupPayload & { requestId: string; policyVersion: number }): Promise<{ followup: AgentFollowup }>;
  changeFollowup?(sessionId: string, id: string, change: { version: number; action: "edit" | "cancel" | "resume"; policyVersion?: number; payload?: AgentFollowupPayload }): Promise<{ followup: AgentFollowup }>;
  updatePermissions?(sessionId: string, mode: AgentPermissionMode, expectedVersion: number): Promise<{ session: AgentSession }>;
  createSession(params?: CreateSessionParams): Promise<{ sessionId: string; session: AgentSession }>;
  listSessions(opts?: { limit?: number; archived?: boolean }): Promise<AgentSessionSummary[]>;
  getSession(sessionId: string): Promise<AgentSessionDetail>;
  /** 409 → AgentApiError(code "conflict", turnId) when a turn is already active; "budget_exceeded" at the session cap. */
  sendTurn(sessionId: string, prompt: string, opts?: { noteId?: string; requestId?: string; contextNoteIds?: string[]; contextSnapshots?: AgentContextSnapshot[] }): Promise<{ turnId: string; status: AgentTurnStatus; context?: AgentContextRecord[] }>;
  /** Replays persisted events with seq > afterSeq, then streams live until the in-flight turn ends. Returns unsubscribe. */
  streamSession(sessionId: string, afterSeq: number, handlers: AgentStreamHandlers): () => void;
  cancelTurn(turnId: string): Promise<boolean>;
  archiveSession(sessionId: string): Promise<void>;
  /** Billing mode + budgets + selectable profiles (WP3.4). Optional: older servers 404. */
  getLimits?(): Promise<AgentLimits>;
  /** Cache scope (e.g. the active vault) so sessions of different vaults never share a query key. */
  scope?(): string;
}
