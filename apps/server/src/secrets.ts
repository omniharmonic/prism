/**
 * Per-tenant integration secrets, encrypted at rest (Phase 3 — server-first
 * runtime). The server-side ingesters + agent executor need each tenant's own
 * third-party credentials (a member's Matrix token, a workspace's Notion key,
 * …); this is the store that makes that multi-tenant. A secret is keyed by
 * (vault, owner, kind) and sealed with AES-256-GCM under a master key held ONLY
 * in the environment (SECRETS_KEY) — never in the db. Losing the key makes every
 * stored secret unrecoverable (by design); rotating it requires re-entry.
 *
 * SECRETS_KEY: 32 bytes, hex (64 chars) or base64. Generate one with
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import crypto from "node:crypto";
import { db } from "./db";

/** Resolve the 32-byte master key at call time (not import) so it's testable and
 *  a deploy that never stores secrets needn't set it until it does. */
function masterKey(): Buffer {
  const raw = (process.env.SECRETS_KEY ?? "").trim();
  if (!raw) throw new Error("SECRETS_KEY is not set — required to store/read per-tenant secrets");
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`SECRETS_KEY must decode to 32 bytes (got ${buf.length})`);
  return buf;
}

/** Whether a master key is configured (so callers can gate gracefully). */
export const secretsConfigured = (): boolean => {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
};

const upsertStmt = db.prepare(
  `INSERT INTO tenant_secrets (vault_id, owner_email, kind, ciphertext, iv, created_at)
   VALUES (@vault_id, @owner_email, @kind, @ciphertext, @iv, @created_at)
   ON CONFLICT(vault_id, owner_email, kind) DO UPDATE SET ciphertext=@ciphertext, iv=@iv, created_at=@created_at`,
);
const selectStmt = db.prepare(
  "SELECT ciphertext, iv FROM tenant_secrets WHERE vault_id = ? AND owner_email = ? AND kind = ?",
);
const deleteStmt = db.prepare(
  "DELETE FROM tenant_secrets WHERE vault_id = ? AND owner_email = ? AND kind = ?",
);
const listKindsStmt = db.prepare(
  "SELECT kind FROM tenant_secrets WHERE vault_id = ? AND owner_email = ? ORDER BY kind",
);

/** Encrypt + store a secret for (vault, owner, kind). Overwrites any existing. */
export function putSecret(vaultId: string, ownerEmail: string, kind: string, plaintext: string): void {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const ciphertext = Buffer.concat([enc, cipher.getAuthTag()]); // ct || 16-byte tag
  upsertStmt.run({ vault_id: vaultId, owner_email: ownerEmail, kind, ciphertext, iv, created_at: Date.now() });
}

/** Decrypt a stored secret, or null if absent. Throws on tamper / wrong key. */
export function getSecret(vaultId: string, ownerEmail: string, kind: string): string | null {
  const row = selectStmt.get(vaultId, ownerEmail, kind) as { ciphertext: Buffer; iv: Buffer } | undefined;
  if (!row) return null;
  const ct = row.ciphertext;
  const tag = ct.subarray(ct.length - 16);
  const enc = ct.subarray(0, ct.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), row.iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function deleteSecret(vaultId: string, ownerEmail: string, kind: string): void {
  deleteStmt.run(vaultId, ownerEmail, kind);
}

/** Which secret kinds exist for (vault, owner) — never returns the values. */
export function listSecretKinds(vaultId: string, ownerEmail: string): string[] {
  return (listKindsStmt.all(vaultId, ownerEmail) as Array<{ kind: string }>).map((r) => r.kind);
}
