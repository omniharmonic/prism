/** Live policy checks and in-flight tool accounting for hosted agent turns. */
import { db } from "./db";
import { getPat, INTERNAL_PAT_LABEL_PREFIX, isInternalPat } from "./auth/pat";
import { modeProfile, profileAllowedTools, profileMode, type AgentPermissionMode, type AgentProfile } from "./agent-profiles";
import type { McpPrincipal } from "./mcp/auth";
import { ToolError } from "./mcp/errors";

interface PolicyRow {
  id: string; profile: AgentProfile; permission_mode: AgentPermissionMode | null;
  policy_version: number; pending_mode: AgentPermissionMode | null; owner_email: string;
}
const leases = new Map<string, number>();
export const policyRow = (id: string) => db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as PolicyRow | undefined;
export function auditPolicy(row: PolicyRow, target: AgentPermissionMode, state: "pending" | "applied"): void {
  db.prepare("INSERT INTO agent_policy_audit (session_id, actor, from_mode, to_mode, policy_version, state, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.owner_email, row.permission_mode ?? profileMode(row.profile), target, row.policy_version + (state === "applied" ? 1 : 0), state, Date.now());
}

/** Confirm a change only after the runner and every already-admitted tool ended. */
export function settleAgentPolicy(id: string): void {
  const row = policyRow(id);
  if (!row?.pending_mode || leases.get(id)) return;
  if (db.prepare("SELECT 1 FROM agent_turns WHERE session_id = ? AND status IN ('queued', 'running')").get(id)) return;
  db.transaction(() => {
    auditPolicy(row, row.pending_mode!, "applied");
    db.prepare("UPDATE agent_sessions SET permission_mode = pending_mode, pending_mode = NULL, profile = ?, policy_version = policy_version + 1, updated_at = ? WHERE id = ?")
      .run(modeProfile(row.pending_mode!), Date.now(), id);
  })();
}

function admittedSession(principal: McpPrincipal, tool: string): string | null | false {
  if (principal.via !== "pat") return null;
  const pat = getPat(principal.credentialId);
  // A principal authenticated earlier in this request may have been revoked.
  if (!pat) return principal.agentTurnId ? false : null;
  if (pat.revoked_at != null || pat.expires_at <= Date.now()) return false;
  if (!isInternalPat(pat)) return null;
  const turnId = pat.label!.slice(INTERNAL_PAT_LABEL_PREFIX.length);
  const turn = db.prepare(`SELECT t.session_id, t.status, t.profile, t.policy_version, s.policy_version AS current_version,
    s.pending_mode, s.owner_email, s.vault_id FROM agent_turns t JOIN agent_sessions s ON s.id = t.session_id WHERE t.id = ?`).get(turnId) as {
      session_id: string; status: string; profile: AgentProfile | null; policy_version: number | null;
      current_version: number; pending_mode: string | null; owner_email: string; vault_id: string;
    } | undefined;
  if (!turn || !turn.profile || !["queued", "running"].includes(turn.status) || turn.pending_mode || turn.policy_version !== turn.current_version) return false;
  if (turn.owner_email !== principal.actor.email || turn.vault_id !== principal.actor.vaultId) return false;
  return profileAllowedTools(turn.profile).includes(`mcp__prism__${tool}`) ? turn.session_id : false;
}

export const agentToolAllowed = (principal: McpPrincipal, tool: string): boolean => admittedSession(principal, tool) !== false;

/** Synchronous admission precedes every await in tool access/dispatch. */
export function enterAgentTool(principal: McpPrincipal, tool: string): () => void {
  const id = admittedSession(principal, tool);
  if (id === false) throw new ToolError("forbidden", "this agent turn no longer permits that operation");
  if (id === null) return () => {};
  leases.set(id, (leases.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (leases.get(id) ?? 1) - 1;
    if (count) leases.set(id, count); else leases.delete(id);
    settleAgentPolicy(id);
  };
}
