/**
 * Prism personal access tokens (PATs) — the agent credential for the Prism MCP
 * endpoint (Architecture v2 WP6.1).
 *
 * Why a Prism-issued token rather than a hub JWT: a PAT carries the holder's
 * PRISM permissions (per-note grants, private notes, caps), which a whole-vault
 * `vault:<name>:<verb>` hub JWT cannot express. It is issued, verified and
 * revoked here — revocation is a row update and bites on the next request (no
 * 60 s hub cache).
 *
 * Token design (mirrors device tokens, auth/device.ts):
 *  - format `pp_` + 32 random bytes base64url; ONLY its SHA-256 is stored, plus a
 *    short non-secret prefix so a list can show which token is which;
 *  - bound to ONE registry vault (required) and to one account (email);
 *  - `scope` is a ceiling: `read` sees only read-only tools, `write` sees all the
 *    tools the account's Prism permissions allow;
 *  - fixed expiry (1–365 days, default 90), no sliding refresh;
 *  - resolves to the SAME user actor a session would (role + grants recomputed on
 *    every request), so a revoked grant or membership bites immediately.
 *
 * TRUST BOUNDARY: a PAT is accepted by the MCP endpoint ONLY (mcp/auth.ts). It is
 * never a general web credential — resolveActor() does not know about it — so a
 * leaked PAT cannot reach /api, /acl or /auth.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const PAT_PREFIX = "pp_";
export const PAT_DEFAULT_DAYS = 90;
export const PAT_MAX_DAYS = 365;
/** Owner/admin WRITE tokens (a whole-workspace write credential) are capped shorter. */
export const PAT_ADMIN_WRITE_MAX_DAYS = 90;
/** Per-account cap on LIVE tokens — bounds row-creation abuse by a signed-in user. */
export const PAT_MAX_LIVE_PER_ACCOUNT = 25;
/** last_used_at is written at most this often per token. */
const TOUCH_THROTTLE_MS = 60_000;
const DAY_MS = 86_400_000;

export type PatScope = "read" | "write";

export interface PatRow {
  id: string;
  token_hash: string;
  prefix: string;
  email: string;
  vault_id: string;
  scope: PatScope;
  label: string | null;
  device_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  revoked_at: number | null;
}

/** The listable, secret-free view of a PAT. */
export interface PatView {
  id: string;
  prefix: string;
  email: string;
  vaultId: string;
  scope: PatScope;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

export const patView = (r: PatRow): PatView => ({
  id: r.id,
  prefix: r.prefix,
  email: r.email,
  vaultId: r.vault_id,
  scope: r.scope,
  label: r.label,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
});

/** Clamp a client-supplied label to something safe to store + display. */
export function sanitizePatLabel(label: unknown): string | null {
  let s = typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  // The internal prefix is reserved: a user label can never hide a PAT from the list.
  if (s.startsWith(INTERNAL_PAT_LABEL_PREFIX)) s = `agent-turn -${s.slice(INTERNAL_PAT_LABEL_PREFIX.length)}`;
  return s ? s.slice(0, 80) : null;
}

/** Reserved label prefix of the per-turn agent credentials (agent-sessions.ts
 *  prism-* profiles). Such rows are minted per turn, ≤3 h, revoked at turn end,
 *  and never listed in "Agent access tokens". */
export const INTERNAL_PAT_LABEL_PREFIX = "agent-turn:";
/** Hard ceiling for an internal per-turn credential. */
export const INTERNAL_PAT_MAX_MS = 3 * 3_600_000;
export const isInternalPat = (r: Pick<PatRow, "label">): boolean => !!r.label && r.label.startsWith(INTERNAL_PAT_LABEL_PREFIX);

/** Mint a per-turn agent credential: ttl clamped to INTERNAL_PAT_MAX_MS. */
export function issueInternalPat(opts: { email: string; vaultId: string; scope: PatScope; turnId: string; ttlMs?: number; now?: number }): { token: string; row: PatRow } {
  return issuePat({
    email: opts.email,
    vaultId: opts.vaultId,
    scope: opts.scope,
    label: `${INTERNAL_PAT_LABEL_PREFIX}${opts.turnId}`.slice(0, 80),
    expiresInMs: Math.min(INTERNAL_PAT_MAX_MS, Math.max(60_000, opts.ttlMs ?? INTERNAL_PAT_MAX_MS)),
    now: opts.now,
  });
}

/** Revoke every live internal per-turn credential (boot sweep: a crash mid-turn). */
export function revokeInternalPats(now = Date.now()): number {
  return db.prepare("UPDATE mcp_pats SET revoked_at = ? WHERE label LIKE ? AND revoked_at IS NULL").run(now, `${INTERNAL_PAT_LABEL_PREFIX}%`).changes;
}

/** Mint a PAT. The plaintext is returned exactly once and never stored. */
export function issuePat(opts: {
  email: string;
  vaultId: string;
  scope: PatScope;
  label?: string | null;
  expiresInDays?: number;
  /** Server-internal: exact lifetime in ms (overrides expiresInDays; no day floor). */
  expiresInMs?: number;
  deviceId?: string | null;
  now?: number;
}): { token: string; row: PatRow } {
  const token = PAT_PREFIX + randomBytes(32).toString("base64url");
  const t = opts.now ?? Date.now();
  const days = Math.min(PAT_MAX_DAYS, Math.max(1, Math.floor(opts.expiresInDays ?? PAT_DEFAULT_DAYS)));
  const row: PatRow = {
    id: `pat_${randomBytes(12).toString("base64url")}`,
    token_hash: sha256hex(token),
    // `pp_` + 6 chars: enough to tell tokens apart in a list, ~36 bits — far too
    // little to help guess the 256-bit remainder.
    prefix: token.slice(0, PAT_PREFIX.length + 6),
    email: opts.email.trim().toLowerCase(),
    vault_id: opts.vaultId,
    scope: opts.scope,
    label: opts.label ?? null,
    device_id: opts.deviceId ?? null,
    created_at: t,
    last_used_at: null,
    expires_at: t + (opts.expiresInMs != null ? opts.expiresInMs : days * DAY_MS),
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO mcp_pats (id, token_hash, prefix, email, vault_id, scope, label, device_id, created_at, last_used_at, expires_at, revoked_at)
     VALUES (@id, @token_hash, @prefix, @email, @vault_id, @scope, @label, @device_id, @created_at, @last_used_at, @expires_at, @revoked_at)`,
  ).run(row);
  return { token, row };
}

/**
 * Resolve a presented bearer to its live PAT row, or null (not a `pp_` token,
 * unknown, revoked, or expired). A hit stamps last_used_at (throttled).
 */
export function verifyPat(token: string | null | undefined, now = Date.now()): PatRow | null {
  if (!token || !token.startsWith(PAT_PREFIX) || token.length > 200) return null;
  const row = db.prepare("SELECT * FROM mcp_pats WHERE token_hash = ?").get(sha256hex(token)) as PatRow | undefined;
  if (!row) return null;
  if (row.revoked_at !== null || row.expires_at <= now) return null;
  if (row.last_used_at === null || now - row.last_used_at >= TOUCH_THROTTLE_MS) {
    db.prepare("UPDATE mcp_pats SET last_used_at = ? WHERE id = ?").run(now, row.id);
    row.last_used_at = now;
  }
  return row;
}

export function getPat(id: string): PatRow | null {
  return (db.prepare("SELECT * FROM mcp_pats WHERE id = ?").get(id) as PatRow | undefined) ?? null;
}

/** Live (unrevoked, unexpired) PATs — for one account, or every account when email is null. */
export function listLivePats(email: string | null, now = Date.now()): PatRow[] {
  return (
    email === null
      ? db.prepare("SELECT * FROM mcp_pats WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(now)
      : db.prepare("SELECT * FROM mcp_pats WHERE email = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(email, now)
  ) as PatRow[];
}

/** Revoke one PAT. Returns whether it was live. Immediate: the next request 401s. */
export function revokePat(id: string, now = Date.now()): boolean {
  return db.prepare("UPDATE mcp_pats SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes > 0;
}

/** Revoke every live PAT minted through a native device (called when the device is revoked). */
export function revokePatsForDevice(deviceId: string, now = Date.now()): number {
  return db.prepare("UPDATE mcp_pats SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now, deviceId).changes;
}
