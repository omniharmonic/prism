/**
 * What AGENTS did, and proposed, in the identity layer (SQLite; the table is
 * created here like `identity_candidates`, not in db.ts).
 *
 *  - `people_agent_decisions` — one row per review-queue action an agent took
 *    through the Prism MCP tools (resolve / dismiss / file). It is the decision
 *    LEDGER the owner reads (it holds the agent's rationale, which is free text
 *    and therefore NOT in `action_audit`, whose rows are ids + hashes only) and
 *    the counter behind the per-credential daily caps.
 *  - `people_merge_recommendations` — an agent's RECOMMENDATION that two person
 *    notes are the same human. A recommendation is a note to the owner. Nothing
 *    in this module, or in the tools that write it, can merge: the only merge is
 *    `POST /api/admin/people/merge`, which refuses an agent origin.
 *
 * Rows are pinned to the vault they were made in (`vault_identity`, as in
 * identity-store.ts).
 */
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { vaultIdentity } from "./identity-store";
import { config } from "./config";

db.exec(`
  CREATE TABLE IF NOT EXISTS people_agent_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    vault_id TEXT NOT NULL,
    vault_identity TEXT NOT NULL,
    cap_key TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    credential_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    candidate_id TEXT,
    person_id TEXT,
    rationale TEXT NOT NULL,
    outcome TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS people_agent_decisions_cap ON people_agent_decisions (cap_key, kind, ts);
  CREATE INDEX IF NOT EXISTS people_agent_decisions_vault ON people_agent_decisions (vault_identity, id);

  CREATE TABLE IF NOT EXISTS people_merge_recommendations (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    vault_identity TEXT NOT NULL,
    pair_key TEXT NOT NULL,
    a_id TEXT NOT NULL,
    b_id TEXT NOT NULL,
    canonical_id TEXT NOT NULL,
    rationale TEXT NOT NULL,
    confidence REAL NOT NULL,
    detected INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    cap_key TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    decided_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (vault_identity, pair_key)
  );
  CREATE INDEX IF NOT EXISTS people_merge_recommendations_open ON people_merge_recommendations (vault_identity, status, created_at);
`);
{
  // A table made by an earlier build of this branch lacks `account`.
  const cols = new Set((db.prepare("PRAGMA table_info(people_agent_decisions)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("account")) db.exec("ALTER TABLE people_agent_decisions ADD COLUMN account TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS people_agent_decisions_account ON people_agent_decisions (account, kind, ts)");
}

export const RATIONALE_MAX = 600;
const DAY_MS = 24 * 3600_000;

/** `resolve` + `dismiss` share one budget ("decide"); `file` and `recommend` have their own. */
export type AgentActionKind = "resolve" | "dismiss" | "file" | "recommend";
const BUDGET_KINDS: Record<"decide" | "file" | "recommend", AgentActionKind[]> = { decide: ["resolve", "dismiss"], file: ["file"], recommend: ["recommend"] };

export type AgentBudget = keyof typeof BUDGET_KINDS;

/** Actions of one budget taken with this cap key in the last 24 h (rolling: no midnight to wait for). */
export function agentActionsLastDay(capKey: string, budget: AgentBudget, now = Date.now()): number {
  const kinds = BUDGET_KINDS[budget];
  return (
    db
      .prepare(`SELECT count(*) n FROM people_agent_decisions WHERE cap_key = ? AND kind IN (${kinds.map(() => "?").join(",")}) AND ts > ? AND outcome != 'released'`)
      .get(capKey, ...kinds, now - DAY_MS) as { n: number }
  ).n;
}

/** The same, across every credential of one account (the per-account ceiling). */
export function accountActionsLastDay(account: string, budget: AgentBudget, now = Date.now()): number {
  const kinds = BUDGET_KINDS[budget];
  return (
    db
      .prepare(`SELECT count(*) n FROM people_agent_decisions WHERE account = ? AND kind IN (${kinds.map(() => "?").join(",")}) AND ts > ? AND outcome != 'released'`)
      .get(account, ...kinds, now - DAY_MS) as { n: number }
  ).n;
}

export interface AgentDecisionInput {
  vaultId: string;
  capKey: string;
  /** The account (email) the credential belongs to. */
  account: string;
  credentialId: string;
  kind: AgentActionKind;
  candidateId?: string | null;
  personId?: string | null;
  rationale: string;
}

/**
 * Reserve a slot in the ledger BEFORE acting (so two calls cannot both pass a
 * count check), then `finish` it with what happened. `released` = nothing was
 * attempted (the people lock was busy) — it does not count toward the cap.
 */
export function beginAgentAction(a: AgentDecisionInput, now = Date.now()): { id: number; finish(outcome: "ok" | "open" | "failed" | "released", personId?: string | null): void } {
  pruneAgentRecords(now);
  const r = db
    .prepare("INSERT INTO people_agent_decisions (ts, vault_id, vault_identity, cap_key, account, credential_id, kind, candidate_id, person_id, rationale, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started')")
    .run(now, a.vaultId, vaultIdentity(a.vaultId), a.capKey, a.account, a.credentialId, a.kind, a.candidateId ?? null, a.personId ?? null, a.rationale.slice(0, RATIONALE_MAX));
  const id = Number(r.lastInsertRowid);
  return {
    id,
    finish(outcome, personId) {
      if (personId !== undefined) db.prepare("UPDATE people_agent_decisions SET outcome = ?, person_id = ? WHERE id = ?").run(outcome, personId, id);
      else db.prepare("UPDATE people_agent_decisions SET outcome = ? WHERE id = ?").run(outcome, id);
    },
  };
}

export interface AgentDecision {
  id: number;
  at: string;
  kind: AgentActionKind;
  candidateId: string | null;
  personId: string | null;
  rationale: string;
  outcome: string;
  credentialId: string;
}

/** The ledger, newest first (owner route). */
export function listAgentDecisions(vaultId: string, o: { limit?: number; before?: number } = {}): { decisions: AgentDecision[]; next: number | null } {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 50)));
  const args: Array<string | number> = [vaultIdentity(vaultId)];
  let where = "vault_identity = ?";
  if (o.before) {
    where += " AND id < ?";
    args.push(o.before);
  }
  const rows = db.prepare(`SELECT * FROM people_agent_decisions WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1) as Array<{
    id: number; ts: number; kind: AgentActionKind; candidate_id: string | null; person_id: string | null; rationale: string; outcome: string; credential_id: string;
  }>;
  const page = rows.slice(0, limit);
  return {
    decisions: page.map((r) => ({ id: r.id, at: new Date(r.ts).toISOString(), kind: r.kind, candidateId: r.candidate_id, personId: r.person_id, rationale: r.rationale, outcome: r.outcome, credentialId: r.credential_id })),
    next: rows.length > limit ? page.at(-1)!.id : null,
  };
}

/** Counts of the last 24 h by kind + outcome, for one vault (the status tool). */
export function agentActionCounts(vaultId: string, now = Date.now()): Record<string, number> {
  const rows = db
    .prepare("SELECT kind, outcome, count(*) n FROM people_agent_decisions WHERE vault_identity = ? AND ts > ? AND outcome != 'released' GROUP BY kind, outcome")
    .all(vaultIdentity(vaultId), now - DAY_MS) as Array<{ kind: string; outcome: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[`${r.kind}:${r.outcome}`] = r.n;
  return out;
}

// ── merge recommendations ────────────────────────────────────────────────────

/** `obsolete` = another merge took one of the two notes away first. */
export type RecommendationStatus = "open" | "dismissed" | "merged" | "obsolete";
export interface MergeRecommendation {
  id: string;
  personIds: [string, string];
  canonicalId: string;
  rationale: string;
  /** 0 … 1, the agent's own estimate. */
  confidence: number;
  /** Was the pair also a DETECTED duplicate when it was recommended? (false → the merge needs `confirmUnrelated`). */
  detected: boolean;
  status: RecommendationStatus;
  credentialId: string;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RecRow {
  id: string; a_id: string; b_id: string; canonical_id: string; rationale: string; confidence: number; detected: number;
  status: RecommendationStatus; credential_id: string; decided_by: string | null; created_at: number; updated_at: number;
}
const recFromRow = (r: RecRow): MergeRecommendation => ({
  id: r.id,
  personIds: [r.a_id, r.b_id],
  canonicalId: r.canonical_id,
  rationale: r.rationale,
  confidence: r.confidence,
  detected: !!r.detected,
  status: r.status,
  credentialId: r.credential_id,
  decidedBy: r.decided_by,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

export const pairKey = (a: string, b: string): string => [a, b].sort().join("\u0000");

/**
 * Record (or refresh) a recommendation for one pair. `created` / `refreshed`
 * (still open: the latest canonical, rationale and confidence replace the old),
 * or `closed` — the owner already dismissed or merged this pair; it stays closed.
 */
export function recommendMerge(
  r: { vaultId: string; a: string; b: string; canonicalId: string; rationale: string; confidence: number; detected: boolean; capKey: string; credentialId: string },
  now = Date.now(),
): { result: "created" | "refreshed" | "closed"; recommendation: MergeRecommendation } {
  const identity = vaultIdentity(r.vaultId);
  const key = pairKey(r.a, r.b);
  const [a, b] = [r.a, r.b].sort() as [string, string];
  const existing = db.prepare("SELECT * FROM people_merge_recommendations WHERE vault_identity = ? AND pair_key = ?").get(identity, key) as RecRow | undefined;
  if (existing) {
    if (existing.status !== "open") return { result: "closed", recommendation: recFromRow(existing) };
    db.prepare("UPDATE people_merge_recommendations SET canonical_id = ?, rationale = ?, confidence = ?, detected = ?, credential_id = ?, cap_key = ?, updated_at = ? WHERE id = ?").run(
      r.canonicalId, r.rationale.slice(0, RATIONALE_MAX), r.confidence, r.detected ? 1 : 0, r.credentialId, r.capKey, now, existing.id,
    );
    return { result: "refreshed", recommendation: recFromRow(db.prepare("SELECT * FROM people_merge_recommendations WHERE id = ?").get(existing.id) as RecRow) };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people_merge_recommendations (id, vault_id, vault_identity, pair_key, a_id, b_id, canonical_id, rationale, confidence, detected, status, cap_key, credential_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(id, r.vaultId, identity, key, a, b, r.canonicalId, r.rationale.slice(0, RATIONALE_MAX), r.confidence, r.detected ? 1 : 0, r.capKey, r.credentialId, now, now);
  return { result: "created", recommendation: recFromRow(db.prepare("SELECT * FROM people_merge_recommendations WHERE id = ?").get(id) as RecRow) };
}

/** Newest first, bounded. */
export function listRecommendations(vaultId: string, o: { status?: RecommendationStatus; limit?: number } = {}): MergeRecommendation[] {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 100)));
  return (
    db.prepare("SELECT * FROM people_merge_recommendations WHERE vault_identity = ? AND status = ? ORDER BY updated_at DESC, id LIMIT ?").all(vaultIdentity(vaultId), o.status ?? "open", limit) as RecRow[]
  ).map(recFromRow);
}

/** The open recommendations for exactly these pairs (a page of duplicate pairs). */
export function recommendationsForPairs(vaultId: string, pairs: Array<[string, string]>): Map<string, MergeRecommendation> {
  const out = new Map<string, MergeRecommendation>();
  if (!pairs.length) return out;
  const keys = pairs.map(([a, b]) => pairKey(a, b));
  const rows = db
    .prepare(`SELECT * FROM people_merge_recommendations WHERE vault_identity = ? AND status = 'open' AND pair_key IN (${keys.map(() => "?").join(",")})`)
    .all(vaultIdentity(vaultId), ...keys) as Array<RecRow & { pair_key: string }>;
  for (const r of rows) out.set(r.pair_key, recFromRow(r));
  return out;
}

export function openRecommendationCount(vaultId: string): number {
  return (db.prepare("SELECT count(*) n FROM people_merge_recommendations WHERE vault_identity = ? AND status = 'open'").get(vaultIdentity(vaultId)) as { n: number }).n;
}

/** The owner closes a recommendation without merging. */
export function dismissRecommendation(vaultId: string, id: string, by: string, now = Date.now()): boolean {
  return db.prepare("UPDATE people_merge_recommendations SET status = 'dismissed', decided_by = ?, updated_at = ? WHERE id = ? AND vault_identity = ? AND status = 'open'").run(by, now, id, vaultIdentity(vaultId)).changes > 0;
}

/**
 * A merge of (canonical, secondary) completed (by the owner): that pair's
 * recommendation becomes `merged`, and every OTHER open recommendation that
 * involves the merged-away note becomes `obsolete` (that note is a tombstone now).
 */
export function closeRecommendationsAfterMerge(vaultId: string, canonicalId: string, secondaryId: string, by: string, now = Date.now()): void {
  const identity = vaultIdentity(vaultId);
  db.prepare("UPDATE people_merge_recommendations SET status = 'merged', decided_by = ?, updated_at = ? WHERE vault_identity = ? AND pair_key = ? AND status = 'open'").run(by, now, identity, pairKey(canonicalId, secondaryId));
  db.prepare("UPDATE people_merge_recommendations SET status = 'obsolete', decided_by = ?, updated_at = ? WHERE vault_identity = ? AND status = 'open' AND (a_id = ? OR b_id = ?)").run(by, now, identity, secondaryId, secondaryId);
}

let lastPrune = 0;
/**
 * Retention (PEOPLE_AGENT_RETENTION_DAYS): ledger rows and CLOSED
 * recommendations older than that are deleted. Runs at most hourly, from the
 * agent write path (cheap indexed deletes).
 */
export function pruneAgentRecords(now = Date.now(), force = false): { decisions: number; recommendations: number } {
  const days = config.peopleAgentRetentionDays;
  if (!(days > 0) || (!force && now - lastPrune < 3600_000)) return { decisions: 0, recommendations: 0 };
  lastPrune = now;
  const cutoff = now - days * DAY_MS;
  return {
    decisions: db.prepare("DELETE FROM people_agent_decisions WHERE ts < ?").run(cutoff).changes,
    recommendations: db.prepare("DELETE FROM people_merge_recommendations WHERE status != 'open' AND updated_at < ?").run(cutoff).changes,
  };
}
