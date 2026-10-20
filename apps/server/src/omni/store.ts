/**
 * Omni module SQLite state (tables created by this module, not db.ts — same as
 * identity-store.ts). Hermes is the canonical THREAD store (messages, memory);
 * these tables hold only what the gateway itself owns:
 *
 *   omni_threads   — app-side thread metadata: state, objective, task binding, unread, the
 *                    per-thread event counter. Keyed by the Hermes session id.
 *   omni_turns     — turns the gateway started (status, Hermes run id, idempotency key).
 *   omni_events    — the PERSISTED normalized stream events (never `text_delta`), for
 *                    `?after=<seq>` replay after a dropped connection.
 *   omni_cards     — record cards derived from the agent's writes.
 *   omni_approvals — proposed outward actions: full payload + its digest, status, decision.
 *   omni_audit     — one row per approval decision / execution / proposal: ids + digests only.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";

db.exec(`
CREATE TABLE IF NOT EXISTS omni_threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  state TEXT NOT NULL DEFAULT 'waiting',
  objective TEXT,
  task_note_id TEXT,
  source TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  event_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS omni_turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  idem_key TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS omni_turns_idem ON omni_turns(thread_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS omni_turns_thread ON omni_turns(thread_id, started_at);
CREATE TABLE IF NOT EXISTS omni_events (
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE TABLE IF NOT EXISTS omni_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  note_id TEXT NOT NULL,
  op TEXT NOT NULL,
  card TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS omni_cards_thread ON omni_cards(thread_id, id);
CREATE TABLE IF NOT EXISTS omni_approvals (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  thread_id TEXT,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_via TEXT,
  decided_device TEXT,
  idem_key TEXT,
  result TEXT,
  superseded_by TEXT,
  revises TEXT
);
CREATE INDEX IF NOT EXISTS omni_approvals_status ON omni_approvals(owner_email, status, created_at);
CREATE TABLE IF NOT EXISTS omni_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  via TEXT NOT NULL,
  action TEXT NOT NULL,
  approval_id TEXT,
  thread_id TEXT,
  digest TEXT,
  status TEXT NOT NULL,
  error TEXT
);
`);

export const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;
export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ── threads ─────────────────────────────────────────────────────────────────

export const THREAD_STATES = ["working", "needs-you", "waiting", "scheduled", "conversation", "done"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export interface ThreadRow {
  id: string;
  title: string | null;
  state: ThreadState;
  objective: string | null;
  taskNoteId: string | null;
  source: string | null;
  pinned: boolean;
  archived: boolean;
  unread: number;
  createdAt: number;
  lastActivityAt: number;
  eventSeq: number;
}
type RawThread = {
  id: string; title: string | null; state: string; objective: string | null; task_note_id: string | null; source: string | null;
  pinned: number; archived: number; unread: number; created_at: number; last_activity_at: number; event_seq: number;
};
const toThread = (r: RawThread): ThreadRow => ({
  id: r.id, title: r.title, state: r.state as ThreadState, objective: r.objective, taskNoteId: r.task_note_id, source: r.source,
  pinned: !!r.pinned, archived: !!r.archived, unread: r.unread, createdAt: r.created_at, lastActivityAt: r.last_activity_at, eventSeq: r.event_seq,
});

const q = {
  insThread: db.prepare(
    "INSERT OR IGNORE INTO omni_threads (id, title, state, objective, task_note_id, source, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ),
  getThread: db.prepare("SELECT * FROM omni_threads WHERE id = ?"),
  listThreads: db.prepare("SELECT * FROM omni_threads ORDER BY last_activity_at DESC LIMIT ?"),
  touch: db.prepare("UPDATE omni_threads SET last_activity_at = ? WHERE id = ?"),
  setState: db.prepare("UPDATE omni_threads SET state = ? WHERE id = ?"),
  bumpUnread: db.prepare("UPDATE omni_threads SET unread = unread + 1, last_activity_at = ? WHERE id = ?"),
  nextSeq: db.prepare("UPDATE omni_threads SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq"),
  insEvent: db.prepare("INSERT INTO omni_events (thread_id, seq, turn_id, payload, at) VALUES (?, ?, ?, ?, ?)"),
  eventsAfter: db.prepare("SELECT seq, turn_id, payload FROM omni_events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT 1000"),
  pruneEvents: db.prepare("DELETE FROM omni_events WHERE thread_id = ? AND seq <= ?"),
  insTurn: db.prepare("INSERT INTO omni_turns (id, thread_id, status, idem_key, started_at) VALUES (?, ?, 'running', ?, ?)"),
  turnByKey: db.prepare("SELECT * FROM omni_turns WHERE thread_id = ? AND idem_key = ?"),
  activeTurn: db.prepare("SELECT * FROM omni_turns WHERE thread_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1"),
  getTurn: db.prepare("SELECT * FROM omni_turns WHERE id = ?"),
  setRun: db.prepare("UPDATE omni_turns SET run_id = ? WHERE id = ?"),
  endTurn: db.prepare("UPDATE omni_turns SET status = ?, ended_at = ?, error_code = ? WHERE id = ? AND status = 'running'"),
  runningTurns: db.prepare("SELECT thread_id FROM omni_turns WHERE status = 'running'"),
  sweepTurns: db.prepare("UPDATE omni_turns SET status = 'interrupted', ended_at = ?, error_code = 'server_restart' WHERE status = 'running'"),
  insCard: db.prepare("INSERT INTO omni_cards (thread_id, turn_id, note_id, op, card, at) VALUES (?, ?, ?, ?, ?, ?)"),
  cards: db.prepare("SELECT card FROM omni_cards WHERE thread_id = ? ORDER BY id DESC LIMIT ?"),
  audit: db.prepare("INSERT INTO omni_audit (ts, actor, via, action, approval_id, thread_id, digest, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
};

export function ensureThread(t: { id: string; title?: string | null; objective?: string | null; taskNoteId?: string | null; source?: string | null; state?: ThreadState }): ThreadRow {
  const now = Date.now();
  q.insThread.run(t.id, t.title ?? null, t.state ?? "waiting", t.objective ?? null, t.taskNoteId ?? null, t.source ?? null, now, now);
  return getThread(t.id)!;
}
export const getThread = (id: string): ThreadRow | null => {
  const r = q.getThread.get(id) as RawThread | undefined;
  return r ? toThread(r) : null;
};
export const listThreads = (limit = 200): ThreadRow[] => (q.listThreads.all(limit) as RawThread[]).map(toThread);
export function updateThread(id: string, patch: { title?: string | null; state?: ThreadState; pinned?: boolean; archived?: boolean; unread?: number }): ThreadRow | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) (sets.push("title = ?"), vals.push(patch.title));
  if (patch.state !== undefined) (sets.push("state = ?"), vals.push(patch.state));
  if (patch.pinned !== undefined) (sets.push("pinned = ?"), vals.push(patch.pinned ? 1 : 0));
  if (patch.archived !== undefined) (sets.push("archived = ?"), vals.push(patch.archived ? 1 : 0));
  if (patch.unread !== undefined) (sets.push("unread = ?"), vals.push(patch.unread));
  if (sets.length) db.prepare(`UPDATE omni_threads SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getThread(id);
}
export const setThreadState = (id: string, s: ThreadState): void => void q.setState.run(s, id);
export const touchThread = (id: string): void => void q.touch.run(Date.now(), id);
export const bumpUnread = (id: string): void => void q.bumpUnread.run(Date.now(), id);

// ── events ──────────────────────────────────────────────────────────────────

/** Persist one event; returns its seq. Old events beyond the per-thread cap are pruned. */
export function appendEvent(threadId: string, turnId: string | null, payload: Record<string, unknown>, keep: number): number {
  const row = q.nextSeq.get(threadId) as { event_seq: number } | undefined;
  if (!row) throw new Error("unknown thread");
  q.insEvent.run(threadId, row.event_seq, turnId, JSON.stringify(payload), Date.now());
  if (keep > 0 && row.event_seq % 100 === 0 && row.event_seq > keep) q.pruneEvents.run(threadId, row.event_seq - keep);
  return row.event_seq;
}
export function eventsAfter(threadId: string, after: number): Array<{ seq: number; turnId: string | null; payload: Record<string, unknown> }> {
  return (q.eventsAfter.all(threadId, after) as Array<{ seq: number; turn_id: string | null; payload: string }>).map((r) => ({
    seq: r.seq,
    turnId: r.turn_id,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
}

// ── turns ───────────────────────────────────────────────────────────────────

export interface TurnRow {
  id: string;
  threadId: string;
  status: "running" | "done" | "error" | "cancelled" | "interrupted";
  runId: string | null;
  idemKey: string | null;
  startedAt: number;
  endedAt: number | null;
  errorCode: string | null;
}
type RawTurn = { id: string; thread_id: string; status: string; run_id: string | null; idem_key: string | null; started_at: number; ended_at: number | null; error_code: string | null };
const toTurn = (r: RawTurn): TurnRow => ({
  id: r.id, threadId: r.thread_id, status: r.status as TurnRow["status"], runId: r.run_id, idemKey: r.idem_key,
  startedAt: r.started_at, endedAt: r.ended_at, errorCode: r.error_code,
});

/** Claim a new turn: `{turn}` on success, `{active}` when one is already running,
 *  `{replay}` when the idempotency key names an earlier turn. Atomic. */
export const claimTurn = db.transaction((threadId: string, idemKey: string | null): { turn?: TurnRow; active?: TurnRow; replay?: TurnRow } => {
  if (idemKey) {
    const prior = q.turnByKey.get(threadId, idemKey) as RawTurn | undefined;
    if (prior) return { replay: toTurn(prior) };
  }
  const active = q.activeTurn.get(threadId) as RawTurn | undefined;
  if (active) return { active: toTurn(active) };
  const id = newId("turn");
  q.insTurn.run(id, threadId, idemKey, Date.now());
  return { turn: toTurn(q.getTurn.get(id) as RawTurn) };
});
export const getTurn = (id: string): TurnRow | null => {
  const r = q.getTurn.get(id) as RawTurn | undefined;
  return r ? toTurn(r) : null;
};
export const activeTurn = (threadId: string): TurnRow | null => {
  const r = q.activeTurn.get(threadId) as RawTurn | undefined;
  return r ? toTurn(r) : null;
};
export const setTurnRun = (turnId: string, runId: string): void => void q.setRun.run(runId, turnId);
/** End a running turn (no-op when it already ended). Returns whether this call ended it. */
export const endTurn = (turnId: string, status: TurnRow["status"], errorCode: string | null = null): boolean =>
  q.endTurn.run(status, Date.now(), errorCode, turnId).changes > 0;
export const runningThreadIds = (): string[] => (q.runningTurns.all() as Array<{ thread_id: string }>).map((r) => r.thread_id);
/** At boot: no in-memory stream survives a restart, so a `running` turn is interrupted. */
export const sweepRunningTurns = (): number => q.sweepTurns.run(Date.now()).changes;
/** The Hermes run ids of the turns still marked `running` (read BEFORE the sweep). */
export const runningRunIds = (): string[] =>
  (db.prepare("SELECT run_id AS r FROM omni_turns WHERE status = 'running' AND run_id IS NOT NULL").all() as Array<{ r: string }>).map((x) => x.r);

// ── cards ───────────────────────────────────────────────────────────────────

export function saveCard(threadId: string, turnId: string | null, card: { noteId: string; op: string } & Record<string, unknown>): void {
  q.insCard.run(threadId, turnId, card.noteId, card.op, JSON.stringify(card), Date.now());
}
export const threadCards = (threadId: string, limit = 100): Array<Record<string, unknown>> =>
  (q.cards.all(threadId, limit) as Array<{ card: string }>).map((r) => JSON.parse(r.card) as Record<string, unknown>);

// ── audit ───────────────────────────────────────────────────────────────────

export function omniAudit(a: { actor: string; via: string; action: string; approvalId?: string | null; threadId?: string | null; digest?: string | null; status: string; error?: string | null }): void {
  q.audit.run(Date.now(), a.actor, a.via, a.action, a.approvalId ?? null, a.threadId ?? null, a.digest ? a.digest.slice(0, 16) : null, a.status, a.error ? a.error.slice(0, 200) : null);
}
export const auditRows = (): Array<Record<string, unknown>> => db.prepare("SELECT * FROM omni_audit ORDER BY id").all() as Array<Record<string, unknown>>;

export function resetOmniStoreForTests(): void {
  db.exec("DELETE FROM omni_threads; DELETE FROM omni_turns; DELETE FROM omni_events; DELETE FROM omni_cards; DELETE FROM omni_approvals; DELETE FROM omni_audit;");
}
