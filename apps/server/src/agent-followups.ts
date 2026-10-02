/** Durable owner-authored follow-ups. The ordinary turn admission remains the only executor. */
import { createHash, randomUUID } from "node:crypto";
import { db, grantsForUser, resolveVaultEntry } from "./db";
import { config } from "./config";
import { profileMode } from "./agent-profiles";
import { workspaceRole } from "./roles";
import {
  activeTurn,
  getSession,
  isAgentRequestId,
  startTurn,
  validContextNoteIds,
  TurnConflictError,
} from "./agent-sessions";
import {
  canonicalSnapshot,
  validContextSnapshots,
  type AgentContextSnapshot,
} from "../../../packages/core/src/lib/agent/contextSnapshots";

export interface FollowupPayload {
  prompt: string;
  noteId?: string;
  contextNoteIds?: string[];
  contextSnapshots?: AgentContextSnapshot[];
}
interface Row {
  id: string;
  session_id: string;
  request_id: string;
  request_hash: string;
  payload: string;
  status: "waiting" | "dispatching" | "blocked" | "accepted" | "cancelled";
  version: number;
  policy_version: number;
  permission_mode: string;
  allow_after_failure: number;
  turn_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export class FollowupError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const get = (id: string) =>
  db.prepare("SELECT * FROM agent_followups WHERE id=?").get(id) as
    | Row
    | undefined;
const project = (r: Row) => ({
  id: r.id,
  sessionId: r.session_id,
  status: r.status,
  version: r.version,
  permissionMode: r.permission_mode,
  payload: JSON.parse(r.payload) as FollowupPayload,
  error: r.error,
  turnId: r.turn_id,
  createdAt: r.created_at,
});
export function parseFollowup(value: unknown): FollowupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FollowupError("bad_request");
  const p = value as Record<string, unknown>;
  if (
    typeof p.prompt !== "string" ||
    !p.prompt.trim() ||
    p.prompt.length > 50_000
  )
    throw new FollowupError("bad_request");
  if (
    p.noteId !== undefined &&
    (typeof p.noteId !== "string" || !validContextNoteIds([p.noteId]))
  )
    throw new FollowupError("bad_request");
  if (p.contextNoteIds !== undefined && !validContextNoteIds(p.contextNoteIds))
    throw new FollowupError("bad_request");
  if (
    p.contextSnapshots !== undefined &&
    !validContextSnapshots(p.contextSnapshots)
  )
    throw new FollowupError("bad_request");
  return {
    prompt: p.prompt,
    ...(typeof p.noteId === "string" ? { noteId: p.noteId } : {}),
    ...(Array.isArray(p.contextNoteIds) && p.contextNoteIds.length
      ? { contextNoteIds: p.contextNoteIds as string[] }
      : {}),
    ...(validContextSnapshots(p.contextSnapshots) && p.contextSnapshots.length
      ? { contextSnapshots: p.contextSnapshots.map(canonicalSnapshot) }
      : {}),
  };
}
export function listFollowups(sessionId: string) {
  return (
    db
      .prepare(
        "SELECT * FROM agent_followups WHERE session_id=? AND status IN ('waiting','dispatching','blocked') ORDER BY rowid",
      )
      .all(sessionId) as Row[]
  ).map(project);
}
export function addFollowup(
  sessionId: string,
  requestId: unknown,
  input: unknown,
) {
  if (!isAgentRequestId(requestId)) throw new FollowupError("bad_request");
  const payload = parseFollowup(input),
    encoded = JSON.stringify(payload),
    hash = createHash("sha256").update(encoded).digest("hex");
  const result = db.transaction(() => {
    const previous = db
      .prepare(
        "SELECT * FROM agent_followups WHERE session_id=? AND request_id=?",
      )
      .get(sessionId, requestId) as Row | undefined;
    if (previous) {
      if (previous.request_hash !== hash)
        throw new FollowupError("request_mismatch");
      return previous;
    }
    const session = getSession(sessionId);
    if (
      !session ||
      session.status === "archived" ||
      session.owner_email !== config.ownerEmail
    )
      throw new FollowupError("not_found");
    if (session.pending_mode)
      throw new FollowupError("permission_change_pending");
    if (
      (input as Record<string, unknown>).policyVersion !==
      session.policy_version
    )
      throw new FollowupError("permission_changed");
    if (listFollowups(sessionId).length >= 10)
      throw new FollowupError("queue_full");
    const id = randomUUID(),
      now = Date.now();
    db.prepare(
      "INSERT INTO agent_followups (id,session_id,request_id,request_hash,payload,policy_version,permission_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      sessionId,
      requestId,
      hash,
      encoded,
      session.policy_version,
      session.permission_mode ?? profileMode(session.profile),
      now,
      now,
    );
    return get(id)!;
  })();
  scheduleFollowups(sessionId);
  return project(result);
}
export function changeFollowup(sessionId: string, id: string, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new FollowupError("bad_request");
  const body = input as Record<string, unknown>;
  if (
    !Number.isInteger(body.version) ||
    !["edit", "cancel", "resume"].includes(String(body.action))
  )
    throw new FollowupError("bad_request");
  const result = db.transaction(() => {
    const row = get(id),
      session = getSession(sessionId);
    if (
      !row ||
      row.session_id !== sessionId ||
      !session ||
      session.status === "archived"
    )
      throw new FollowupError("not_found");
    if (
      row.version !== body.version ||
      !["waiting", "blocked"].includes(row.status)
    )
      throw new FollowupError("queue_changed");
    if (body.action === "resume" && session.pending_mode)
      throw new FollowupError("permission_change_pending");
    if (
      body.action === "resume" &&
      body.policyVersion !== session.policy_version
    )
      throw new FollowupError("permission_changed");
    const payload =
      body.action === "cancel" ? { prompt: "" } : parseFollowup(body.payload);
    db.prepare(
      "UPDATE agent_followups SET payload=?,status=?,version=version+1,policy_version=?,permission_mode=?,allow_after_failure=?,error=?,updated_at=? WHERE id=?",
    ).run(
      JSON.stringify(payload),
      body.action === "cancel"
        ? "cancelled"
        : body.action === "resume"
          ? "waiting"
          : row.status,
      body.action === "resume" ? session.policy_version : row.policy_version,
      body.action === "resume"
        ? (session.permission_mode ?? profileMode(session.profile))
        : row.permission_mode,
      body.action === "resume" ? 1 : row.allow_after_failure,
      body.action === "resume" ? null : row.error,
      Date.now(),
      id,
    );
    return get(id)!;
  })();
  scheduleFollowups(sessionId);
  return project(result);
}
const draining = new Set<string>();
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleFollowups(sessionId: string) {
  if (scheduled.has(sessionId)) return;
  const timer = setTimeout(() => {
    scheduled.delete(sessionId);
    void drainFollowups(sessionId);
  }, 25);
  timer.unref();
  scheduled.set(sessionId, timer);
}
export async function drainFollowups(sessionId: string) {
  if (draining.has(sessionId) || activeTurn(sessionId)) return;
  draining.add(sessionId);
  try {
    const row = db
      .prepare(
        "SELECT * FROM agent_followups WHERE session_id=? AND status IN ('waiting','dispatching','blocked') ORDER BY rowid LIMIT 1",
      )
      .get(sessionId) as Row | undefined;
    if (!row || row.status !== "waiting") return;
    const session = getSession(sessionId);
    if (!session || session.status === "archived") {
      db.prepare("DELETE FROM agent_followups WHERE session_id=?").run(
        sessionId,
      );
      return;
    }
    const block = (message: string) =>
      db
        .prepare(
          "UPDATE agent_followups SET status='blocked',error=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(message, Date.now(), row.id);
    if (
      session.owner_email !== config.ownerEmail ||
      session.pending_mode ||
      session.policy_version !== row.policy_version
    ) {
      block(
        "Session permissions changed. Review this message before resuming.",
      );
      return;
    }
    const last = db
      .prepare(
        "SELECT status FROM agent_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId) as { status: string } | undefined;
    if (last && last.status !== "done" && !row.allow_after_failure) {
      block(
        "The previous turn did not finish successfully. Review before continuing.",
      );
      return;
    }
    db.prepare(
      "UPDATE agent_followups SET status='dispatching',version=version+1,updated_at=? WHERE id=?",
    ).run(Date.now(), row.id);
    try {
      const turn = await startTurn(
        sessionId,
        resolveVaultEntry(session.vault_id),
        {
          ...parseFollowup(JSON.parse(row.payload)),
          requestId: `followup_${row.id}`,
        },
        {
          role: workspaceRole(session.owner_email, session.vault_id),
          subject: session.owner_email,
          grants: grantsForUser(session.owner_email, session.vault_id),
        },
      );
      db.prepare(
        "UPDATE agent_followups SET status='accepted',payload='{\"prompt\":\"\"}',turn_id=?,error=NULL,version=version+1,updated_at=? WHERE id=?",
      ).run(turn.id, Date.now(), row.id);
      if (turn.status === "done") scheduleFollowups(sessionId);
    } catch (e) {
      if (e instanceof TurnConflictError)
        db.prepare(
          "UPDATE agent_followups SET status='waiting',updated_at=? WHERE id=?",
        ).run(Date.now(), row.id);
      else
        block(
          "Could not start this message. Review its sources, budget and permissions before retrying.",
        );
    }
  } finally {
    draining.delete(sessionId);
  }
}
/** Restart never silently runs waiting instructions after interrupted work. */
export function recoverFollowups() {
  for (const row of db
    .prepare("SELECT * FROM agent_followups WHERE status='dispatching'")
    .all() as Row[]) {
    const turn = db
      .prepare(
        "SELECT id FROM agent_turns WHERE session_id=? AND request_id=? AND request_ready=1",
      )
      .get(row.session_id, `followup_${row.id}`) as { id: string } | undefined;
    db.prepare(
      "UPDATE agent_followups SET status=?,turn_id=?,error=?,version=version+1 WHERE id=?",
    ).run(
      turn ? "accepted" : "blocked",
      turn?.id ?? null,
      turn
        ? null
        : "Server restarted while admitting this message. Review before retrying.",
      row.id,
    );
  }
  db.prepare(
    "UPDATE agent_followups SET status='blocked',error='Server restarted. Review queued messages before continuing.',version=version+1 WHERE status='waiting'",
  ).run();
}
export function discardFollowups(sessionId: string) {
  db.prepare("DELETE FROM agent_followups WHERE session_id=?").run(sessionId);
}
export function resetFollowupTimers() {
  for (const timer of scheduled.values()) clearTimeout(timer);
  scheduled.clear();
  draining.clear();
}
