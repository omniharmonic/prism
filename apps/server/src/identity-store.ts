/**
 * The identity REVIEW QUEUE (SQLite `identity_candidates`): every identity the
 * conservative matcher (src/identity.ts) would not link on its own — an
 * ambiguous key, a single-token name, a shared name, a name beside an unknown
 * key — with the people it MIGHT be. The owner resolves or dismisses each one
 * (routes/people-admin.ts); nothing here ever links by itself.
 *
 * One row per (vault, source note, relationship, key): re-running the backfill
 * job or re-ingesting the same message refreshes the row, never duplicates it,
 * and never re-opens a row the owner already resolved or dismissed.
 *
 * PRIVACY DECISION — the key VALUE is stored, not only its hash. Resolving must
 * be able to write the key onto the chosen person ("never queue this again"),
 * and the owner has to see what they are deciding; a hash can do neither. The
 * value is one the vault already holds, this database already holds user emails
 * and the encrypted vault credentials, and the routes are server-owner only. The
 * hash (SHA-256 of kind + value) is what rows are de-duplicated and grouped by,
 * and it — never the value — is what appears in logs, job samples and audit rows.
 *
 * `vault_identity` pins a row to the vault it was observed in (a hash of the
 * registry entry's url + vault name), so re-pointing a registry id at another
 * vault cannot surface the old vault's note ids or addresses in the new one.
 *
 * The table is created here (not in db.ts) so the module is self-contained.
 */
import { createHash, randomUUID } from "node:crypto";
import { db, resolveVaultEntry } from "./db";
import { config } from "./config";

db.exec(`
  CREATE TABLE IF NOT EXISTS identity_candidates (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    vault_identity TEXT NOT NULL,
    source_note_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    key_kind TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_value TEXT NOT NULL,
    display TEXT,
    candidate_ids TEXT NOT NULL,
    reason TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_person_id TEXT,
    decided_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (vault_identity, source_note_id, relationship, key_kind, key_hash)
  );
  CREATE INDEX IF NOT EXISTS identity_candidates_open ON identity_candidates (vault_identity, status, created_at, id);
  CREATE INDEX IF NOT EXISTS identity_candidates_key ON identity_candidates (vault_identity, key_kind, key_hash, status);
`);

export type CandidateStatus = "open" | "resolved" | "dismissed";
const STATUSES: CandidateStatus[] = ["open", "resolved", "dismissed"];
export const isCandidateStatus = (s: unknown): s is CandidateStatus => typeof s === "string" && (STATUSES as string[]).includes(s);

export interface IdentityCandidate {
  id: string;
  vaultId: string;
  sourceNoteId: string;
  relationship: string;
  key: { kind: string; value: string; hash: string };
  /** The display name that came with the key, if any. */
  display: string | null;
  candidateIds: string[];
  reason: string;
  /** Who queued it: `backfill:<phase>` or `ingest:<source>`. */
  origin: string;
  status: CandidateStatus;
  resolvedPersonId: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  vault_id: string;
  source_note_id: string;
  relationship: string;
  key_kind: string;
  key_hash: string;
  key_value: string;
  display: string | null;
  candidate_ids: string;
  reason: string;
  origin: string;
  status: CandidateStatus;
  resolved_person_id: string | null;
  decided_by: string | null;
  created_at: number;
  updated_at: number;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Stable id of the vault a registry entry currently points at. */
export function vaultIdentity(vaultId: string): string {
  const e = resolveVaultEntry(vaultId);
  return sha(`${e.url}\u0000${e.vault}`).slice(0, 24);
}

export const keyHash = (kind: string, value: string): string => sha(`${kind}\u0000${value}`);

function fromRow(r: Row): IdentityCandidate {
  let candidateIds: string[] = [];
  try {
    const v = JSON.parse(r.candidate_ids) as unknown;
    if (Array.isArray(v)) candidateIds = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* an unreadable list is an empty list */
  }
  return {
    id: r.id,
    vaultId: r.vault_id,
    sourceNoteId: r.source_note_id,
    relationship: r.relationship,
    key: { kind: r.key_kind, value: r.key_value, hash: r.key_hash },
    display: r.display,
    candidateIds,
    reason: r.reason,
    origin: r.origin,
    status: r.status,
    resolvedPersonId: r.resolved_person_id,
    decidedBy: r.decided_by,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export interface CandidateInput {
  vaultId: string;
  sourceNoteId: string;
  relationship: string;
  key: { kind: string; value: string };
  display?: string | null;
  candidateIds: string[];
  reason: string;
  origin: string;
}

const MAX_VALUE = 320;
const MAX_CANDIDATES = 20;

/**
 * Queue (or refresh) one candidate. Returns what happened: `created`, `refreshed`
 * (an OPEN row got the latest candidate list), `closed` (the owner already
 * resolved/dismissed this exact source + key — it stays closed, untouched) or
 * `full` (the vault already holds PEOPLE_QUEUE_MAX_OPEN open rows — not inserted).
 */
export function enqueueCandidate(c: CandidateInput, now = Date.now(), maxOpen = config.peopleQueueMaxOpen): "created" | "refreshed" | "closed" | "full" {
  const value = c.key.value.slice(0, MAX_VALUE);
  const identity = vaultIdentity(c.vaultId);
  const hash = keyHash(c.key.kind, value);
  const existing = db
    .prepare("SELECT id, status FROM identity_candidates WHERE vault_identity = ? AND source_note_id = ? AND relationship = ? AND key_kind = ? AND key_hash = ?")
    .get(identity, c.sourceNoteId, c.relationship, c.key.kind, hash) as { id: string; status: CandidateStatus } | undefined;
  const ids = JSON.stringify([...new Set(c.candidateIds)].sort().slice(0, MAX_CANDIDATES));
  if (existing) {
    if (existing.status !== "open") return "closed";
    db.prepare("UPDATE identity_candidates SET candidate_ids = ?, reason = ?, display = COALESCE(?, display), updated_at = ? WHERE id = ?").run(ids, c.reason, c.display?.slice(0, MAX_VALUE) ?? null, now, existing.id);
    return "refreshed";
  }
  // A bounded to-do list: past the cap nothing new is inserted (existing rows still refresh).
  if (maxOpen > 0) {
    const open = (db.prepare("SELECT count(*) n FROM identity_candidates WHERE vault_identity = ? AND status = 'open'").get(identity) as { n: number }).n;
    if (open >= maxOpen) return "full";
  }
  db.prepare(
    `INSERT INTO identity_candidates (id, vault_id, vault_identity, source_note_id, relationship, key_kind, key_hash, key_value, display, candidate_ids, reason, origin, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(randomUUID(), c.vaultId, identity, c.sourceNoteId, c.relationship, c.key.kind, hash, value, c.display?.slice(0, MAX_VALUE) ?? null, ids, c.reason, c.origin.slice(0, 64), now, now);
  return "created";
}

/** The owner's standing decision for this exact source + key, if any. */
export function candidateStatus(vaultId: string, sourceNoteId: string, relationship: string, key: { kind: string; value: string }): CandidateStatus | null {
  const r = db
    .prepare("SELECT status FROM identity_candidates WHERE vault_identity = ? AND source_note_id = ? AND relationship = ? AND key_kind = ? AND key_hash = ?")
    .get(vaultIdentity(vaultId), sourceNoteId, relationship, key.kind, keyHash(key.kind, key.value.slice(0, MAX_VALUE))) as { status: CandidateStatus } | undefined;
  return r?.status ?? null;
}

export function getCandidate(vaultId: string, id: string): IdentityCandidate | null {
  const r = db.prepare("SELECT * FROM identity_candidates WHERE id = ? AND vault_identity = ?").get(id, vaultIdentity(vaultId)) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Open candidates that share one key (the same unknown sender across many notes). */
export function openCandidatesForKey(vaultId: string, kind: string, hash: string, limit: number): IdentityCandidate[] {
  return (
    db
      .prepare("SELECT * FROM identity_candidates WHERE vault_identity = ? AND key_kind = ? AND key_hash = ? AND status = 'open' ORDER BY created_at, id LIMIT ?")
      .all(vaultIdentity(vaultId), kind, hash, limit) as Row[]
  ).map(fromRow);
}

export interface CandidatePage {
  candidates: IdentityCandidate[];
  /** Opaque cursor for the next page, or null. */
  next: string | null;
}

/** Bounded, cursor-paged listing (oldest first; the cursor is `created_at:id`). */
export function listCandidates(vaultId: string, o: { status?: CandidateStatus; reason?: string; relationship?: string; limit?: number; after?: string | null } = {}): CandidatePage {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 50)));
  const where = ["vault_identity = ?", "status = ?"];
  const args: Array<string | number> = [vaultIdentity(vaultId), o.status ?? "open"];
  if (o.reason) (where.push("reason = ?"), args.push(o.reason));
  if (o.relationship) (where.push("relationship = ?"), args.push(o.relationship));
  const m = /^(\d{1,16}):([0-9a-f-]{1,64})$/.exec(o.after ?? "");
  if (m) (where.push("(created_at > ? OR (created_at = ? AND id > ?))"), args.push(Number(m[1]), Number(m[1]), m[2]!));
  const rows = db.prepare(`SELECT * FROM identity_candidates WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ?`).all(...args, limit + 1) as Row[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { candidates: page.map(fromRow), next: rows.length > limit && last ? `${last.created_at}:${last.id}` : null };
}

export function decideCandidates(ids: string[], status: "resolved" | "dismissed", personId: string | null, by: string, now = Date.now()): number {
  const stmt = db.prepare("UPDATE identity_candidates SET status = ?, resolved_person_id = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'open'");
  let n = 0;
  for (const id of ids) n += stmt.run(status, personId, by, now, id).changes;
  return n;
}

/** Open-queue depth per reason for one vault (health + the list header). */
export function openCandidateCounts(vaultId: string): { total: number; byReason: Record<string, number> } {
  const rows = db.prepare("SELECT reason, count(*) n FROM identity_candidates WHERE vault_identity = ? AND status = 'open' GROUP BY reason").all(vaultIdentity(vaultId)) as Array<{ reason: string; n: number }>;
  const byReason: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byReason[r.reason] = r.n;
    total += r.n;
  }
  return { total, byReason };
}

/**
 * A link for (source, relationship) → person landed (or was found to exist):
 * close every OPEN row of that source + relationship that asked about that
 * person, so the queue does not keep questions that have been answered.
 * Marked `resolved`, decided by `linked-by-job`.
 */
export function closeCandidatesLinked(vaultId: string, sourceNoteId: string, relationship: string, personId: string, now = Date.now()): number {
  const rows = db
    .prepare("SELECT id, candidate_ids FROM identity_candidates WHERE vault_identity = ? AND source_note_id = ? AND relationship = ? AND status = 'open'")
    .all(vaultIdentity(vaultId), sourceNoteId, relationship) as Array<{ id: string; candidate_ids: string }>;
  const ids = rows.filter((r) => {
    try {
      return (JSON.parse(r.candidate_ids) as unknown[]).includes(personId);
    } catch {
      return false;
    }
  });
  const stmt = db.prepare("UPDATE identity_candidates SET status = 'resolved', resolved_person_id = ?, decided_by = 'linked-by-job', updated_at = ? WHERE id = ? AND status = 'open'");
  let n = 0;
  for (const r of ids) n += stmt.run(personId, now, r.id).changes;
  return n;
}
