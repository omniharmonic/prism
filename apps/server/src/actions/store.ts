/**
 * Live actions (Arch v2 WP1.5) — audit log + idempotency ledger.
 *
 * AUDIT: one `action_audit` row per attempt that passed the server-owner gate
 * (ok / failed / refused / replayed). It records WHO (actor email + how the
 * request authenticated + human/agent origin), WHAT (action name), and the
 * TARGET as ids and short SHA-256 hashes only — never a message body, a subject
 * or a plain recipient address. Errors are scrubbed and capped.
 *
 * IDEMPOTENCY: `(actor, Idempotency-Key)` → the first outcome. A retry with the
 * same key and the same request replays that outcome without acting again; the
 * same key on a DIFFERENT request is refused (422). A key whose first attempt is
 * still running answers 409. Only a failure that provably happened BEFORE
 * anything left the server (validation, connect/pin/login failure) releases the
 * key for a retry — anything after the send started is kept, so a lost response
 * can never turn into a second send.
 */
import crypto from "node:crypto";
import { db } from "../db";

export type ActionOrigin = "human" | "agent";
export type AuditStatus = "ok" | "failed" | "refused" | "replayed";

export interface AuditInput {
  actorEmail: string;
  via: string;
  origin: ActionOrigin;
  action: string;
  vaultId: string;
  target: Record<string, unknown>;
  idempotencyKey?: string | null;
  status: AuditStatus;
  error?: string | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  actorEmail: string;
  via: string;
  origin: ActionOrigin;
  action: string;
  vaultId: string;
  target: Record<string, unknown>;
  idempotencyKey: string | null;
  status: AuditStatus;
  error: string | null;
}

/** Short, stable hash for audit targets (never reversible to the value in practice). */
export const shortHash = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/** Hash a recipient set order-independently (lowercased, deduped). */
export const recipientsHash = (addrs: string[]): string =>
  shortHash([...new Set(addrs.map((a) => a.trim().toLowerCase()))].sort().join(","));

/**
 * Strip anything secret- or content-like from an error before it is stored or
 * returned: bearer/key=value pairs, long opaque tokens, email addresses, and
 * CR/LF; capped at 200 chars.
 */
export function scrubActionError(msg: unknown): string {
  let s = String((msg as Error)?.message ?? msg ?? "").slice(0, 2000);
  s = s.replace(/[\r\n]+/g, " ");
  s = s.replace(/\b(bearer|token|password|pass|secret|key|authorization)\b\s*[:=]?\s*\S+/gi, "$1=[redacted]");
  s = s.replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, "[address]");
  s = s.replace(/\b[A-Za-z0-9+/_-]{24,}={0,2}/g, "[redacted]");
  return s.slice(0, 200);
}

export function recordAction(a: AuditInput): void {
  try {
    db.prepare(
      `INSERT INTO action_audit (ts, actor_email, via, origin, action, vault_id, target, idempotency_key, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      a.actorEmail,
      a.via,
      a.origin,
      a.action,
      a.vaultId,
      JSON.stringify(a.target ?? {}),
      a.idempotencyKey ?? null,
      a.status,
      a.error ? scrubActionError(a.error) : null,
    );
  } catch (e) {
    // Auditing must never be the reason an action's RESPONSE is lost; log loudly.
    console.error(`[actions] AUDIT WRITE FAILED for ${a.action}: ${scrubActionError(e)}`);
  }
}

interface AuditDbRow {
  id: number;
  ts: number;
  actor_email: string;
  via: string;
  origin: ActionOrigin;
  action: string;
  vault_id: string;
  target: string;
  idempotency_key: string | null;
  status: AuditStatus;
  error: string | null;
}

export function listActionAudit(opts: { limit?: number; action?: string[]; before?: number } = {}): AuditRow[] {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 1000);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.action?.length) {
    where.push(`action IN (${opts.action.map(() => "?").join(",")})`);
    args.push(...opts.action);
  }
  if (opts.before) {
    where.push("id < ?");
    args.push(opts.before);
  }
  const rows = db
    .prepare(`SELECT * FROM action_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as AuditDbRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actorEmail: r.actor_email,
    via: r.via,
    origin: r.origin,
    action: r.action,
    vaultId: r.vault_id,
    target: safeJson(r.target),
    idempotencyKey: r.idempotency_key,
    status: r.status,
    error: r.error,
  }));
}

const safeJson = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
};

// ── idempotency ─────────────────────────────────────────────────────────────

/** Keys are client-chosen opaque strings (a UUID is ideal). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
/** A pending row older than this is an attempt that died mid-flight (crash). */
const PENDING_STALE_MS = 10 * 60_000;
const KEEP_MS = 7 * 24 * 3_600_000;

export const requestHash = (action: string, body: unknown): string =>
  crypto.createHash("sha256").update(`${action}\n${stableStringify(body)}`, "utf8").digest("hex");

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "replay"; status: number; response: unknown }
  | { kind: "in_progress" }
  | { kind: "unknown_outcome" }
  | { kind: "mismatch" };

interface IdemRow {
  action: string;
  request_hash: string;
  state: "pending" | "done";
  http_status: number | null;
  response: string | null;
  created_at: number;
}

/** Atomically claim `(actor, key)` for this request, or report why not. */
export function claimIdempotency(actorEmail: string, key: string, action: string, reqHash: string, now = Date.now()): ClaimResult {
  const tx = db.transaction((): ClaimResult => {
    db.prepare("DELETE FROM action_idempotency WHERE created_at < ?").run(now - KEEP_MS);
    const row = db
      .prepare("SELECT action, request_hash, state, http_status, response, created_at FROM action_idempotency WHERE actor_email = ? AND key = ?")
      .get(actorEmail, key) as IdemRow | undefined;
    if (!row) {
      db.prepare(
        "INSERT INTO action_idempotency (actor_email, key, action, request_hash, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      ).run(actorEmail, key, action, reqHash, now);
      return { kind: "claimed" };
    }
    if (row.action !== action || row.request_hash !== reqHash) return { kind: "mismatch" };
    if (row.state === "done") return { kind: "replay", status: row.http_status ?? 200, response: row.response ? safeJson(row.response) : {} };
    return now - row.created_at > PENDING_STALE_MS ? { kind: "unknown_outcome" } : { kind: "in_progress" };
  });
  return tx();
}

/** Record the outcome (success, or a failure after the send may have started). */
export function completeIdempotency(actorEmail: string, key: string, status: number, response: unknown): void {
  db.prepare("UPDATE action_idempotency SET state = 'done', http_status = ?, response = ? WHERE actor_email = ? AND key = ?").run(
    status,
    JSON.stringify(response ?? {}),
    actorEmail,
    key,
  );
}

/** Release the key: the attempt provably sent nothing, so the same key may retry. */
export function releaseIdempotency(actorEmail: string, key: string): void {
  db.prepare("DELETE FROM action_idempotency WHERE actor_email = ? AND key = ? AND state = 'pending'").run(actorEmail, key);
}
