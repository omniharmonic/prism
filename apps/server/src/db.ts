/**
 * SQLite store for identity + access control (sessions, users, magic-link
 * tokens, and grants). Lives on the home server next to the vault; holds no
 * vault data, only who-can-do-what.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { config, vaultRegistry, type VaultEntry } from "./config";
import type { Level } from "./permissions";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

// This db holds added-vault TOKENS (plus sessions + grants). SQLite creates the
// file world-readable by default; tighten it and its WAL/SHM siblings to 0600.
// Best-effort (skips the in-memory test db; siblings may not exist yet).
if (config.dbPath !== ":memory:" && !config.dbPath.startsWith(":")) {
  for (const p of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      /* sibling absent or not ours — best effort */
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email      TEXT PRIMARY KEY,
    name       TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS grants (
    id            TEXT PRIMARY KEY,
    subject_type  TEXT NOT NULL,   -- 'user' | 'link' | 'anyone' | 'peer'
    subject       TEXT NOT NULL,   -- email | capability id | '*' | peer pubkey
    resource_type TEXT NOT NULL,   -- 'note' | 'tag' | 'space'
    resource      TEXT NOT NULL,   -- note id | tag name | space id
    level         TEXT NOT NULL,   -- Level
    created_by    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS grants_subject  ON grants(subject_type, subject);
  CREATE INDEX IF NOT EXISTS grants_resource ON grants(resource_type, resource);
  CREATE TABLE IF NOT EXISTS capabilities (
    id            TEXT PRIMARY KEY,   -- capability id (also the grant subject)
    resource_type TEXT NOT NULL,
    resource      TEXT NOT NULL,
    level         TEXT NOT NULL,
    label         TEXT,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS capabilities_resource ON capabilities(resource_type, resource);
  CREATE TABLE IF NOT EXISTS collab_docs (
    vault_id          TEXT NOT NULL DEFAULT 'primary',  -- the tenant; a note id is only unique WITHIN a vault
    name              TEXT NOT NULL,      -- note id
    state             BLOB NOT NULL,      -- Yjs encoded state (CRDT continuity)
    source_updated_at INTEGER,            -- Parachute updatedAt at last store (external-edit detection)
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (vault_id, name)
  );
  CREATE TABLE IF NOT EXISTS invites (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    name        TEXT,
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    accepted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS invites_email ON invites(email);

  -- ── Publishing (Horizon B) ─────────────────────────────────────────────
  -- A publication is the CONFIG for a public read-only site (slug, template,
  -- optional password). ACCESS is a separate 'anyone' grant in the grants
  -- table — config and authorization stay decoupled (effectiveLevel is still
  -- the only guard). Publish = insert this row + an anyone grant in one txn.
  CREATE TABLE IF NOT EXISTS publications (
    id            TEXT PRIMARY KEY,   -- slug (also the public URL segment)
    resource_type TEXT NOT NULL,      -- 'tag' | 'path' ('note' reserved)
    resource      TEXT NOT NULL,      -- tag name OR normalized path prefix
    template      TEXT NOT NULL,      -- 'wiki' (template registry key)
    title         TEXT,
    home_note_id  TEXT,               -- landing note; null → derive at read time
    excluded_note_ids TEXT,           -- JSON string[] of note ids to DROP from the set; null → []
    password_hash TEXT,               -- scrypt (auth/password.ts); null → open
    theme         TEXT,               -- JSON blob
    expires_at    INTEGER,            -- null → no expiry
    created_by    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS publications_resource ON publications(resource_type, resource);

  -- ── Parachute-to-Parachute collaboration (Horizon C) ───────────────────
  -- A paired peer hub, identified by its Ed25519 public key (base64url). We
  -- store only the PUBLIC key; no vault token ever crosses the boundary.
  CREATE TABLE IF NOT EXISTS peers (
    pubkey     TEXT PRIMARY KEY,   -- Ed25519 public key, base64url
    email      TEXT,
    label      TEXT,
    created_at INTEGER NOT NULL,
    paired_at  INTEGER,            -- when the handshake completed; null = pending
    collab_url TEXT                -- peer hub's /collab WS URL (for FederationManager.syncSpaces)
  );
  -- One-time pairing codes (invite.ts analog: single-use, hashed, TTL'd).
  CREATE TABLE IF NOT EXISTS peer_pairings (
    code_hash  TEXT PRIMARY KEY,
    label      TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  -- A shared space: a named, bidirectionally-synced collection scoped by
  -- tags/path. Peer membership is a grant (subject_type='peer', resource_type
  -- ='space', resource=space id).
  CREATE TABLE IF NOT EXISTS spaces (
    id                 TEXT PRIMARY KEY,
    title              TEXT,
    scope_include_tags TEXT,   -- JSON string[] (any-of)
    scope_exclude_tags TEXT,   -- JSON string[]
    path_prefix        TEXT,
    created_by         TEXT,
    created_at         INTEGER NOT NULL
  );
  -- Bidirectional note-identity map. space_note_key is a content-independent
  -- UUID minted when a note first enters a space; it is the Yjs documentName
  -- for federation so both hubs address the same CRDT despite differing local
  -- ids. kind is PINNED at join (mismatched inbound updates are rejected).
  CREATE TABLE IF NOT EXISTS federated_notes (
    space_note_key    TEXT PRIMARY KEY,
    space_id          TEXT NOT NULL,
    local_id          TEXT NOT NULL,   -- this hub's note id
    kind              TEXT NOT NULL,   -- document|code|spreadsheet|canvas
    peer_synced_at    INTEGER,
    source_updated_at INTEGER,         -- Parachute updatedAt high-water mark
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS federated_notes_space ON federated_notes(space_id);
  CREATE INDEX IF NOT EXISTS federated_notes_local ON federated_notes(local_id);
  -- Durable outbound buffer: Yjs updates queued while a peer WS is down, flushed
  -- on reconnect (Yjs is idempotent under replay).
  CREATE TABLE IF NOT EXISTS federation_outbox (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    space_note_key TEXT NOT NULL,
    peer_pubkey    TEXT NOT NULL,
    update_blob    BLOB NOT NULL,
    queued_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS federation_outbox_peer ON federation_outbox(peer_pubkey);

  -- Peer-edit audit (Phase 4.3): a row per inbound edit a federated PEER applied
  -- to one of our shared docs, so the owner can review who edited what and when.
  CREATE TABLE IF NOT EXISTS peer_edits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    space_note_key TEXT NOT NULL,
    local_id       TEXT NOT NULL,
    peer_pubkey    TEXT NOT NULL,
    edited_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS peer_edits_time ON peer_edits(edited_at DESC);

  -- Durable pending suggestions (Horizon C, suggest-level). A suggest-level peer
  -- (or capability) does NOT merge into the live doc; its proposed change lands
  -- here for the owner to accept/reject, and MUST survive a server restart (the
  -- live collab path keeps suggestions only in memory). note_id is this hub's
  -- local note; space_note_key records the federation origin when applicable.
  CREATE TABLE IF NOT EXISTS pending_suggestions (
    id             TEXT PRIMARY KEY,
    space_note_key TEXT,
    note_id        TEXT NOT NULL,
    author         TEXT,            -- peer pubkey | email | capability id
    author_kind    TEXT,            -- 'peer' | 'user' | 'link'
    summary        TEXT,            -- short human description
    payload        TEXT NOT NULL,   -- the proposed change (Yjs update b64, or text/html)
    status         TEXT NOT NULL,   -- 'pending' | 'accepted' | 'rejected'
    created_at     INTEGER NOT NULL,
    resolved_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS pending_suggestions_note   ON pending_suggestions(note_id);
  CREATE INDEX IF NOT EXISTS pending_suggestions_status ON pending_suggestions(status);

  -- Inbound federation mirror requests (Horizon C). A paired PEER asks this hub to
  -- mirror a shared space's notes (so both hubs hold the same space_note_keys). A
  -- peer must NOT silently write into our vault, so the request lands here for the
  -- OWNER to accept/reject — accepting creates the local space + peer grant +
  -- placeholder notes + federated_notes rows. One pending row per (peer, space).
  CREATE TABLE IF NOT EXISTS federation_mirror_requests (
    id          TEXT PRIMARY KEY,
    peer_pubkey TEXT NOT NULL,
    space_id    TEXT NOT NULL,    -- the shared space id (same UUID on both hubs)
    space_title TEXT,
    payload     TEXT NOT NULL,    -- JSON [{ spaceNoteKey, kind, title? }]
    status      TEXT NOT NULL,    -- 'pending' | 'accepted' | 'rejected'
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS federation_mirror_status ON federation_mirror_requests(status);
  CREATE INDEX IF NOT EXISTS federation_mirror_peer   ON federation_mirror_requests(peer_pubkey, space_id);

  -- Owner-mutable runtime settings (kv). Currently: federation_enabled, so the
  -- owner can toggle the federation bridge from the UI without a restart. Each
  -- key falls back to its config/env default when unset.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Owner-added vaults (multi-vault: in-app create/link). The ENV-configured
  -- vaults live in config.ts (PRISM_VAULTS / PARACHUTE_*); these rows are the
  -- vaults added at runtime from the UI. Their TOKEN lives here, server-side
  -- ONLY — it is never returned to a client (GET /api/vaults omits token+url).
  CREATE TABLE IF NOT EXISTS prism_vaults (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    url        TEXT NOT NULL,
    vault      TEXT NOT NULL,
    token      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- ── Multi-tenancy: per-vault workspace membership (Phase 1) ──────────────
  -- A "tenant" = a vault; membership names WHO belongs to a vault and at what
  -- workspace ROLE (owner/admin/member/guest — see roles.ts). This is the source
  -- of truth for workspaceRole(email, vaultId); it sits ABOVE the per-note grants
  -- table and reconciles with the hub's own user_vaults (the token-authority
  -- layer). The env OWNER_EMAIL is owner of 'primary' even with no row (bootstrap).
  CREATE TABLE IF NOT EXISTS memberships (
    vault_id   TEXT NOT NULL,
    email      TEXT NOT NULL,
    role       TEXT NOT NULL,          -- 'owner' | 'admin' | 'member' | 'guest'
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, email)
  );
  CREATE INDEX IF NOT EXISTS memberships_email ON memberships(email);

  -- ── Per-tenant integration secrets (Phase 3 server-first runtime) ────────
  -- Encrypted-at-rest credentials (Matrix/Notion/Fathom/… tokens) keyed by
  -- (vault, owner, kind). This is the multi-tenant gate: a server-side ingester
  -- or agent run reads the secret for the tenant it's acting on, never another's.
  -- ciphertext = AES-256-GCM(secret)||authTag; the master key (SECRETS_KEY) lives
  -- in the environment, NEVER in this db. See src/secrets.ts.
  CREATE TABLE IF NOT EXISTS tenant_secrets (
    vault_id    TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    kind        TEXT NOT NULL,
    ciphertext  BLOB NOT NULL,
    iv          BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (vault_id, owner_email, kind)
  );
`);

// Migration: accounts now carry a password. Add the column if an older db
// predates it (CREATE TABLE IF NOT EXISTS won't alter an existing table).
{
  const cols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "password_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  }
}

// Migration: peers gained a collab_url (the peer hub's /collab WS URL) so the
// FederationManager can self-discover endpoints instead of taking them from the
// caller. Add the column to an older db.
{
  const cols = db.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "collab_url")) {
    db.exec("ALTER TABLE peers ADD COLUMN collab_url TEXT");
  }
}

// Migration: publications gained per-site "tending" controls — a list of note
// ids to DROP from the public set even though they match the tag/path. Add the
// column to an older db (CREATE TABLE IF NOT EXISTS won't alter an existing one).
{
  const cols = db.prepare("PRAGMA table_info(publications)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "excluded_note_ids")) {
    db.exec("ALTER TABLE publications ADD COLUMN excluded_note_ids TEXT");
  }
}

// ── Multi-tenancy migration (Phase 1): vault_id across every access-control,
// collab, and federation table. Additive with DEFAULT 'primary' — every existing
// row belongs to the env primary vault, so a single-vault deploy is byte-identical
// after the migration. (CREATE TABLE IF NOT EXISTS won't alter an existing table.)
// `collab_docs` also needs its PRIMARY KEY widened from (name) to (vault_id, name)
// since a note id is only unique WITHIN a vault — that PK rebuild is a separate,
// carefully-guarded step (see below); here we just add the column.
for (const table of [
  "grants",
  "capabilities",
  "publications",
  "spaces",
  "federated_notes",
  "collab_docs",
  "pending_suggestions",
  "federation_mirror_requests",
  "federation_outbox",
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "vault_id")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'primary'`);
  }
}
// Composite indexes so per-vault grant lookups stay fast (the hot path: load a
// subject's grants within the active vault).
db.exec(`
  CREATE INDEX IF NOT EXISTS grants_vault_subject  ON grants(vault_id, subject_type, subject);
  CREATE INDEX IF NOT EXISTS grants_vault_resource ON grants(vault_id, resource_type, resource);
`);

// TTL / expiry on grants (Phase 4.3): a nullable epoch-ms deadline. NULL = never
// expires (every existing grant → byte-identical behavior). Today only PEER
// grants honor it (time-boxed federation access); grantsForPeer filters expired.
{
  const cols = db.prepare(`PRAGMA table_info(grants)`).all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "expires_at")) {
    db.exec(`ALTER TABLE grants ADD COLUMN expires_at INTEGER`);
  }
}

// `collab_docs` PRIMARY KEY rebuild: (name) → (vault_id, name). SQLite can't
// alter a PK in place, so copy-then-swap inside a transaction — the one
// non-additive migration. Version-gated (runs once) and a no-op when the table
// is already composite (fresh DBs get the composite PK from CREATE TABLE above).
// Existing rows carry vault_id='primary' from the ADD COLUMN default, so a
// single-vault deploy keeps every doc's CRDT state byte-for-byte.
{
  // Self-contained settings I/O — this runs at module load, BEFORE the shared
  // getSetting/setSetting prepared statements below are initialized.
  const flag = (db.prepare("SELECT value FROM settings WHERE key = ?").get("collab_docs_pk_v2") as { value: string } | undefined)?.value;
  if (flag !== "done") {
    const cols = db.prepare(`PRAGMA table_info(collab_docs)`).all() as Array<{ name: string; pk: number }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    const alreadyComposite = pkCols.length === 2 && pkCols.includes("vault_id") && pkCols.includes("name");
    if (cols.length && !alreadyComposite) {
      const rebuild = db.transaction(() => {
        db.exec(`CREATE TABLE collab_docs_v2 (
          vault_id          TEXT NOT NULL DEFAULT 'primary',
          name              TEXT NOT NULL,
          state             BLOB NOT NULL,
          source_updated_at INTEGER,
          updated_at        INTEGER NOT NULL,
          PRIMARY KEY (vault_id, name)
        )`);
        db.exec(`INSERT INTO collab_docs_v2 (vault_id, name, state, source_updated_at, updated_at)
                 SELECT COALESCE(vault_id, 'primary'), name, state, source_updated_at, updated_at FROM collab_docs`);
        db.exec(`DROP TABLE collab_docs`);
        db.exec(`ALTER TABLE collab_docs_v2 RENAME TO collab_docs`);
      });
      rebuild();
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("collab_docs_pk_v2", "done");
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS collab_docs_vault ON collab_docs(vault_id, name);`);

// ── Runtime settings (owner-mutable kv) ──────────────────────────────────────
const selectSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value=@value",
);
function getSetting(key: string): string | null {
  return (selectSetting.get(key) as { value: string } | undefined)?.value ?? null;
}
function setSetting(key: string, value: string): void {
  upsertSetting.run({ key, value });
}

// Worker cursors (Phase 3): the incremental-sync resume token per (vault, kind),
// e.g. the Matrix /sync next_batch. Persisted in `settings` so a restart resumes.
export function getWorkerCursor(vaultId: string, kind: string): string | null {
  return getSetting(`cursor:${kind}:${vaultId}`);
}
export function setWorkerCursor(vaultId: string, kind: string, cursor: string): void {
  setSetting(`cursor:${kind}:${vaultId}`, cursor);
}

/**
 * Federation enablement is runtime-mutable so the owner can flip the bridge from
 * the UI (no .env edit / restart). Persisted in `settings`, defaulting to the
 * `FEDERATION_ENABLED` env flag when never set. Read straight from the row each
 * call (a 1-row prepared SELECT — the gate is per connection/action, not a hot
 * loop), so a toggle takes effect immediately and tests stay isolated (resetDb
 * clears the row → the env default returns). All the old `config.federationEnabled`
 * gates now call `getFederationEnabled()`.
 */
export function getFederationEnabled(): boolean {
  const stored = getSetting("federation_enabled");
  return stored === null ? config.federationEnabled : stored === "true";
}
export function setFederationEnabled(enabled: boolean): void {
  setSetting("federation_enabled", enabled ? "true" : "false");
}

// ── Added vaults (runtime registry; owner-managed via /acl/vaults) ───────────
// The ENV base (config.vaultRegistry) is immutable boot config; these rows are
// vaults the owner created/linked from the UI. Tokens are stored here and NEVER
// serialized to a client.
const insertVaultEntry = db.prepare(
  `INSERT INTO prism_vaults (id, label, url, vault, token, created_at)
   VALUES (@id, @label, @url, @vault, @token, @created_at)`,
);
const selectVaultEntries = db.prepare("SELECT * FROM prism_vaults ORDER BY created_at ASC");
const selectVaultEntry = db.prepare("SELECT * FROM prism_vaults WHERE id = ?");
const deleteVaultEntryStmt = db.prepare("DELETE FROM prism_vaults WHERE id = ?");

const stripVaultRow = (r: VaultEntry & { created_at?: number }): VaultEntry => ({
  id: r.id,
  label: r.label,
  url: r.url,
  vault: r.vault,
  token: r.token,
});

export function addVaultEntry(e: VaultEntry): VaultEntry {
  insertVaultEntry.run({ ...e, created_at: Date.now() });
  return e;
}
export function listVaultEntries(): VaultEntry[] {
  return (selectVaultEntries.all() as Array<VaultEntry & { created_at: number }>).map(stripVaultRow);
}
export function getVaultEntry(id: string): VaultEntry | null {
  const row = selectVaultEntry.get(id) as (VaultEntry & { created_at: number }) | undefined;
  return row ? stripVaultRow(row) : null;
}
export function removeVaultEntry(id: string): void {
  deleteVaultEntryStmt.run(id);
}

/**
 * The full vault registry: the ENV base (config.vaultRegistry) followed by the
 * owner-added vaults from SQLite, deduped by id with the ENV entries WINNING
 * (so the env primary[0] always stays primary/active). This is the authoritative
 * registry read by GET /api/vaults and the owner passthrough.
 */
export function getVaultRegistry(): VaultEntry[] {
  const merged: VaultEntry[] = [...vaultRegistry];
  const seen = new Set(merged.map((v) => v.id));
  for (const e of listVaultEntries()) {
    if (seen.has(e.id)) continue; // env wins
    seen.add(e.id);
    merged.push(e);
  }
  return merged;
}

/**
 * Resolve a vault id against the MERGED registry. Unknown/absent id → the
 * primary (first env entry), so a stale/bogus `X-Prism-Vault` header degrades to
 * the default vault rather than erroring. Lives here (not config.ts) so it can
 * see db-added vaults without a config↔db import cycle.
 */
export function resolveVaultEntry(id?: string | null): VaultEntry {
  if (id) {
    const found = getVaultRegistry().find((v) => v.id === id);
    if (found) return found;
  }
  return vaultRegistry[0]!;
}

export type SubjectType = "user" | "link" | "anyone" | "peer";
// "path" is used ONLY as a publication's resource_type (publish-by-directory);
// it is never a grant resource_type (path publications are guarded by the
// path-membership predicate, not by grants — see routes/publish.ts).
// "vault" is a whole-workspace grant (resource = the vault_id): broad access to
// every note in the vault, distinct from the management RIGHTS a role confers.
export type ResourceType = "note" | "tag" | "space" | "path" | "vault";

export interface Grant {
  id: string;
  /** The vault (tenant) this grant belongs to. Defaults to 'primary' so a
   *  single-vault deploy is unchanged; multi-tenant callers pass the active vault. */
  vault_id: string;
  subject_type: SubjectType;
  subject: string;
  resource_type: ResourceType;
  resource: string;
  level: Level;
  created_by: string | null;
  created_at: number;
  /** Epoch-ms expiry; NULL = never. Currently honored for peer grants (4.3). */
  expires_at: number | null;
}

export interface Session {
  id: string;
  email: string;
  created_at: number;
  expires_at: number;
}

const now = () => Date.now();

// ---- sessions ----
const insertSession = db.prepare(
  "INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)",
);
const selectSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");

export function createSession(id: string, email: string, ttlMs: number): void {
  insertSession.run(id, email, now(), now() + ttlMs);
}
export function getSession(id: string): Session | null {
  const s = selectSession.get(id) as Session | undefined;
  if (!s) return null;
  if (s.expires_at < now()) {
    deleteSession.run(id);
    return null;
  }
  return s;
}
export function destroySession(id: string): void {
  deleteSession.run(id);
}

// ---- users ----
const upsertUserStmt = db.prepare(
  "INSERT INTO users (email, name, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING",
);
export function ensureUser(email: string, name?: string): void {
  upsertUserStmt.run(email, name ?? null, now());
}

export interface UserRow {
  email: string;
  name: string | null;
  password_hash: string | null;
  created_at: number;
}
const selectUser = db.prepare("SELECT email, name, password_hash, created_at FROM users WHERE email = ?");
export function getUser(email: string): UserRow | null {
  return (selectUser.get(email) as UserRow | undefined) ?? null;
}
export function hasAccount(email: string): boolean {
  const u = getUser(email);
  return !!u && !!u.password_hash;
}

const insertAccount = db.prepare(
  `INSERT INTO users (email, name, password_hash, created_at) VALUES (@email, @name, @password_hash, @created_at)
   ON CONFLICT(email) DO UPDATE SET name = @name, password_hash = @password_hash`,
);
/** Create or update an account with a password (used by register + owner bootstrap). */
export function setAccount(email: string, name: string, passwordHash: string): void {
  insertAccount.run({ email, name, password_hash: passwordHash, created_at: now() });
}

const updatePassword = db.prepare("UPDATE users SET password_hash = ? WHERE email = ?");
export function setUserPassword(email: string, passwordHash: string): void {
  ensureUser(email);
  updatePassword.run(passwordHash, email);
}

// ---- invites (owner-issued; gate registration to invited emails) ----
export interface Invite {
  token_hash: string;
  email: string;
  name: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}
const insertInvite = db.prepare(
  `INSERT INTO invites (token_hash, email, name, created_by, created_at, expires_at)
   VALUES (@token_hash, @email, @name, @created_by, @created_at, @expires_at)`,
);
const selectInvite = db.prepare("SELECT * FROM invites WHERE token_hash = ?");
const markInviteAccepted = db.prepare("UPDATE invites SET accepted_at = ? WHERE token_hash = ?");
const selectPendingInviteByEmail = db.prepare(
  "SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
);

export function storeInvite(tokenHash: string, email: string, name: string | null, createdBy: string, ttlMs: number): void {
  insertInvite.run({
    token_hash: tokenHash,
    email,
    name,
    created_by: createdBy,
    created_at: now(),
    expires_at: now() + ttlMs,
  });
}
/** Look up a still-valid invite by its token hash (does not consume it). */
export function getValidInvite(tokenHash: string): Invite | null {
  const row = selectInvite.get(tokenHash) as Invite | undefined;
  if (!row || row.accepted_at || row.expires_at < now()) return null;
  return row;
}
export function acceptInvite(tokenHash: string): void {
  markInviteAccepted.run(now(), tokenHash);
}
export function pendingInviteForEmail(email: string): Invite | null {
  return (selectPendingInviteByEmail.get(email, now()) as Invite | undefined) ?? null;
}

// ---- magic links ----
const insertMagic = db.prepare(
  "INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)",
);
const selectMagic = db.prepare("SELECT * FROM magic_links WHERE token_hash = ?");
const markMagicUsed = db.prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ?");

export function storeMagicLink(tokenHash: string, email: string, ttlMs: number): void {
  insertMagic.run(tokenHash, email, now(), now() + ttlMs);
}
export function consumeMagicLink(tokenHash: string): string | null {
  const row = selectMagic.get(tokenHash) as
    | { email: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row || row.used_at || row.expires_at < now()) return null;
  markMagicUsed.run(now(), tokenHash);
  return row.email;
}

// ---- grants ----
// Grant input: vault_id is OPTIONAL (defaults to 'primary') so every existing
// single-vault call site is unchanged; multi-tenant callers pass the active vault.
type GrantInput = Omit<Grant, "id" | "created_at" | "vault_id" | "expires_at"> & {
  id?: string;
  vault_id?: string;
  expires_at?: number | null;
};

const insertGrant = db.prepare(
  `INSERT INTO grants (id, vault_id, subject_type, subject, resource_type, resource, level, created_by, created_at, expires_at)
   VALUES (@id, @vault_id, @subject_type, @subject, @resource_type, @resource, @level, @created_by, @created_at, @expires_at)`,
);
// User grants are scoped to the active vault: a member of vault A must not pick up
// their (or an "anyone") grant from vault B. (anyone grants are per-vault too.)
const selectGrantsByUser = db.prepare(
  "SELECT * FROM grants WHERE vault_id = ? AND ((subject_type = 'user' AND subject = ?) OR subject_type = 'anyone')",
);
const selectGrantsByCapability = db.prepare(
  "SELECT * FROM grants WHERE subject_type = 'link' AND subject = ?",
);
const selectGrantsByResource = db.prepare(
  "SELECT * FROM grants WHERE vault_id = ? AND resource_type = ? AND resource = ?",
);
const deleteGrantStmt = db.prepare("DELETE FROM grants WHERE id = ?");

export function addGrant(g: GrantInput): Grant {
  const row: Grant = { ...g, vault_id: g.vault_id ?? "primary", id: g.id ?? randomUUID(), created_at: now(), expires_at: g.expires_at ?? null };
  insertGrant.run(row);
  return row;
}
/** Grants for a signed-in user IN a vault (their own + any "anyone-with-link"
 *  grants in that vault). Defaults to the primary vault for single-vault callers. */
export function grantsForUser(email: string, vaultId = "primary"): Grant[] {
  return selectGrantsByUser.all(vaultId, email) as Grant[];
}
/** Grants attached to a specific capability link (each carries its own vault_id;
 *  a link is bound to one resource in one vault). */
export function grantsForCapability(capabilityId: string): Grant[] {
  return selectGrantsByCapability.all(capabilityId) as Grant[];
}
export function grantsForResource(type: ResourceType, resource: string, vaultId = "primary"): Grant[] {
  return selectGrantsByResource.all(vaultId, type, resource) as Grant[];
}
/** The distinct vault_ids where this user holds ≥1 direct grant — a guest
 *  invited to a workspace (via /acl people-sharing) has grants but no membership
 *  row, yet should still see that one workspace in their switcher (Phase 1.5). */
const selectGrantVaultsByUser = db.prepare(
  "SELECT DISTINCT vault_id FROM grants WHERE subject_type = 'user' AND subject = ?",
);
export function vaultIdsWithGrantsForUser(email: string): string[] {
  return (selectGrantVaultsByUser.all(email.toLowerCase()) as Array<{ vault_id: string }>).map((r) => r.vault_id);
}
export function removeGrant(id: string): void {
  deleteGrantStmt.run(id);
}
// ── grants audit (Phase 2.2): list every grant in a vault, and fetch one by id
// (so a revoke can be scoped to the admin's OWN vault — no cross-vault deletes).
const selectGrantsByVault = db.prepare("SELECT * FROM grants WHERE vault_id = ? ORDER BY created_at DESC");
const selectGrantById = db.prepare("SELECT * FROM grants WHERE id = ?");
export function listGrantsForVault(vaultId: string): Grant[] {
  return selectGrantsByVault.all(vaultId) as Grant[];
}
export function getGrantById(id: string): Grant | null {
  return (selectGrantById.get(id) as Grant | undefined) ?? null;
}

const selectGrantBySubjectResource = db.prepare(
  `SELECT * FROM grants WHERE vault_id = ? AND subject_type = ? AND subject = ? AND resource_type = ? AND resource = ?`,
);
const updateGrantLevel = db.prepare("UPDATE grants SET level = ?, expires_at = ? WHERE id = ?");

/** Insert or, if a grant for the same (vault, subject, resource) exists, update
 *  its level (and expiry — re-granting refreshes/clears the TTL). */
export function upsertGrant(g: GrantInput): Grant {
  const vaultId = g.vault_id ?? "primary";
  const existing = selectGrantBySubjectResource.get(
    vaultId,
    g.subject_type,
    g.subject,
    g.resource_type,
    g.resource,
  ) as Grant | undefined;
  if (existing) {
    const expires_at = g.expires_at ?? null;
    updateGrantLevel.run(g.level, expires_at, existing.id);
    return { ...existing, level: g.level, expires_at };
  }
  return addGrant(g);
}

const deleteGrantBySubjectResourceStmt = db.prepare(
  `DELETE FROM grants WHERE vault_id = ? AND subject_type = ? AND subject = ? AND resource_type = ? AND resource = ?`,
);
export function removeGrantBySubjectResource(
  subjectType: SubjectType,
  subject: string,
  resourceType: ResourceType,
  resource: string,
  vaultId = "primary",
): void {
  deleteGrantBySubjectResourceStmt.run(vaultId, subjectType, subject, resourceType, resource);
}

// ── Memberships (Phase 1 multi-tenancy) ──────────────────────────────────────
export interface MembershipRow {
  vault_id: string;
  email: string;
  role: string; // 'owner' | 'admin' | 'member' | 'guest' (validated by roles.ts)
  created_at: number;
}
const upsertMembershipStmt = db.prepare(
  `INSERT INTO memberships (vault_id, email, role, created_by, created_at)
   VALUES (@vault_id, @email, @role, @created_by, @created_at)
   ON CONFLICT(vault_id, email) DO UPDATE SET role = @role`,
);
const selectMembershipRole = db.prepare("SELECT role FROM memberships WHERE vault_id = ? AND email = ?");
const selectMembershipsByVault = db.prepare(
  "SELECT vault_id, email, role, created_at FROM memberships WHERE vault_id = ? ORDER BY created_at",
);
const selectMembershipsByUser = db.prepare(
  "SELECT vault_id, email, role, created_at FROM memberships WHERE email = ?",
);
const deleteMembershipStmt = db.prepare("DELETE FROM memberships WHERE vault_id = ? AND email = ?");

/** The raw membership role string for (email, vault), or null if not a member.
 *  roles.ts `workspaceRole` wraps this with the OWNER_EMAIL bootstrap fallback. */
export function getMembershipRole(email: string, vaultId: string): string | null {
  return (selectMembershipRole.get(vaultId, email) as { role: string } | undefined)?.role ?? null;
}
export function setMembership(vaultId: string, email: string, role: string, createdBy: string | null): void {
  ensureUser(email);
  upsertMembershipStmt.run({ vault_id: vaultId, email, role, created_by: createdBy, created_at: now() });
}
export function removeMembership(vaultId: string, email: string): void {
  deleteMembershipStmt.run(vaultId, email);
}
export function listMemberships(vaultId: string): MembershipRow[] {
  return selectMembershipsByVault.all(vaultId) as MembershipRow[];
}
export function membershipsForUser(email: string): MembershipRow[] {
  return selectMembershipsByUser.all(email) as MembershipRow[];
}

// ---- users (listing) ----
const selectUsers = db.prepare("SELECT email, name FROM users ORDER BY email");
export function listUsers(): Array<{ email: string; name: string | null }> {
  return selectUsers.all() as Array<{ email: string; name: string | null }>;
}

// ---- capabilities (link metadata, so the share dialog can list + re-render links) ----
export interface Capability {
  id: string;
  resource_type: ResourceType;
  resource: string;
  level: Level;
  label: string | null;
  expires_at: number;
  created_at: number;
}
const insertCapability = db.prepare(
  `INSERT INTO capabilities (id, resource_type, resource, level, label, expires_at, created_at)
   VALUES (@id, @resource_type, @resource, @level, @label, @expires_at, @created_at)`,
);
const selectCapabilitiesByResource = db.prepare(
  "SELECT * FROM capabilities WHERE resource_type = ? AND resource = ? ORDER BY created_at DESC",
);
const deleteCapabilityStmt = db.prepare("DELETE FROM capabilities WHERE id = ?");

export function createCapability(c: Omit<Capability, "created_at">): Capability {
  const row: Capability = { ...c, created_at: now() };
  insertCapability.run(row);
  return row;
}
export function capabilitiesForResource(type: ResourceType, resource: string): Capability[] {
  return selectCapabilitiesByResource.all(type, resource) as Capability[];
}
export function deleteCapability(id: string): void {
  deleteCapabilityStmt.run(id);
}

// ---- collab doc state (Yjs CRDT continuity across unloads) ----
export interface DocState {
  state: Uint8Array;
  sourceUpdatedAt: number | null;
}
const selectDocState = db.prepare("SELECT state, source_updated_at FROM collab_docs WHERE vault_id = ? AND name = ?");
const upsertDocState = db.prepare(
  `INSERT INTO collab_docs (vault_id, name, state, source_updated_at, updated_at)
   VALUES (@vault_id, @name, @state, @source_updated_at, @updated_at)
   ON CONFLICT(vault_id, name) DO UPDATE SET state=@state, source_updated_at=@source_updated_at, updated_at=@updated_at`,
);

/** CRDT doc state, scoped to a vault (a note id is only unique within a vault).
 *  vaultId defaults to 'primary' so pre-multitenant callers are unaffected. */
export function getDocState(name: string, vaultId = "primary"): DocState | null {
  const row = selectDocState.get(vaultId, name) as { state: Buffer; source_updated_at: number | null } | undefined;
  if (!row) return null;
  return { state: new Uint8Array(row.state), sourceUpdatedAt: row.source_updated_at };
}
export function saveDocState(name: string, state: Uint8Array, sourceUpdatedAt: number | null, vaultId = "primary"): void {
  upsertDocState.run({
    vault_id: vaultId,
    name,
    state: Buffer.from(state),
    source_updated_at: sourceUpdatedAt,
    updated_at: now(),
  });
}

// ---- grants (peer subject) ----
// Expired peer grants (TTL, 4.3) simply don't load → federation access lapses on
// its own with no sweep needed. NULL expires_at = never expires.
const selectGrantsByPeer = db.prepare(
  "SELECT * FROM grants WHERE subject_type = 'peer' AND subject = ? AND (expires_at IS NULL OR expires_at > ?)",
);
/** Grants attached to a paired peer (matched by its pubkey), excluding expired. */
export function grantsForPeer(pubkey: string): Grant[] {
  return selectGrantsByPeer.all(pubkey, now()) as Grant[];
}

// ---- publications (Horizon B) ----
export interface Publication {
  id: string;
  resource_type: ResourceType;
  resource: string;
  template: string;
  title: string | null;
  home_note_id: string | null;
  excluded_note_ids: string | null; // JSON string[]
  password_hash: string | null;
  theme: string | null;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
}
const insertPublication = db.prepare(
  `INSERT INTO publications (id, resource_type, resource, template, title, home_note_id, excluded_note_ids, password_hash, theme, expires_at, created_by, created_at)
   VALUES (@id, @resource_type, @resource, @template, @title, @home_note_id, @excluded_note_ids, @password_hash, @theme, @expires_at, @created_by, @created_at)`,
);
const selectPublication = db.prepare("SELECT * FROM publications WHERE id = ?");
const selectPublicationByResource = db.prepare(
  "SELECT * FROM publications WHERE resource_type = ? AND resource = ? LIMIT 1",
);
const selectPublications = db.prepare("SELECT * FROM publications ORDER BY created_at DESC");
const deletePublicationStmt = db.prepare("DELETE FROM publications WHERE id = ?");
const updatePublicationStmt = db.prepare(
  `UPDATE publications SET title=@title, home_note_id=@home_note_id, excluded_note_ids=@excluded_note_ids, password_hash=@password_hash, theme=@theme, expires_at=@expires_at WHERE id=@id`,
);

export function createPublication(
  p: Omit<Publication, "created_at" | "excluded_note_ids"> & { excluded_note_ids?: string | null },
): Publication {
  const row: Publication = { excluded_note_ids: null, ...p, created_at: now() };
  insertPublication.run(row);
  return row;
}

/** Parsed list of note ids excluded from a publication's public set (defaults to
 *  [] when unset or malformed). */
export function excludedNoteIds(pub: Publication): string[] {
  if (!pub.excluded_note_ids) return [];
  try {
    const parsed = JSON.parse(pub.excluded_note_ids);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
export function getPublicationBySlug(slug: string): Publication | null {
  return (selectPublication.get(slug) as Publication | undefined) ?? null;
}
export function getPublicationByResource(type: ResourceType, resource: string): Publication | null {
  return (selectPublicationByResource.get(type, resource) as Publication | undefined) ?? null;
}
export function listPublications(): Publication[] {
  return selectPublications.all() as Publication[];
}
export function deletePublication(slug: string): void {
  deletePublicationStmt.run(slug);
}
/** Patch the mutable fields of a publication (title/home/excluded/password/theme/expiry). */
export function updatePublication(
  slug: string,
  patch: Partial<Pick<Publication, "title" | "home_note_id" | "excluded_note_ids" | "password_hash" | "theme" | "expires_at">>,
): Publication | null {
  const existing = getPublicationBySlug(slug);
  if (!existing) return null;
  const merged: Publication = { ...existing, ...patch };
  updatePublicationStmt.run({
    id: slug,
    title: merged.title,
    home_note_id: merged.home_note_id,
    excluded_note_ids: merged.excluded_note_ids,
    password_hash: merged.password_hash,
    theme: merged.theme,
    expires_at: merged.expires_at,
  });
  return merged;
}

// ---- peers (Horizon C) ----
export interface Peer {
  pubkey: string;
  email: string | null;
  label: string | null;
  created_at: number;
  paired_at: number | null;
  collab_url: string | null;
}
const insertPeer = db.prepare(
  `INSERT INTO peers (pubkey, email, label, created_at, paired_at, collab_url)
   VALUES (@pubkey, @email, @label, @created_at, @paired_at, @collab_url)
   ON CONFLICT(pubkey) DO UPDATE SET email=@email, label=@label, paired_at=@paired_at,
     collab_url=COALESCE(@collab_url, collab_url)`,
);
const selectPeer = db.prepare("SELECT * FROM peers WHERE pubkey = ?");
const selectPeers = db.prepare("SELECT * FROM peers ORDER BY created_at DESC");
const deletePeerStmt = db.prepare("DELETE FROM peers WHERE pubkey = ?");
const updatePeerCollabUrl = db.prepare("UPDATE peers SET collab_url = ? WHERE pubkey = ?");

export function upsertPeer(p: { pubkey: string; email?: string | null; label?: string | null; paired_at?: number | null; collab_url?: string | null }): Peer {
  const row: Peer = {
    pubkey: p.pubkey,
    email: p.email ?? null,
    label: p.label ?? null,
    created_at: now(),
    paired_at: p.paired_at ?? null,
    // COALESCE in the upsert preserves an existing URL when this call omits one.
    collab_url: p.collab_url ?? null,
  };
  insertPeer.run(row);
  return (selectPeer.get(p.pubkey) as Peer);
}
export function setPeerCollabUrl(pubkey: string, url: string | null): void {
  updatePeerCollabUrl.run(url, pubkey);
}
export function getPeer(pubkey: string): Peer | null {
  return (selectPeer.get(pubkey) as Peer | undefined) ?? null;
}
export function listPeers(): Peer[] {
  return selectPeers.all() as Peer[];
}
export function removePeer(pubkey: string): void {
  deletePeerStmt.run(pubkey);
}

// ---- peer pairing codes (single-use, hashed, TTL'd) ----
const insertPairing = db.prepare(
  `INSERT INTO peer_pairings (code_hash, label, created_by, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?)`,
);
const selectPairing = db.prepare("SELECT * FROM peer_pairings WHERE code_hash = ?");
const markPairingUsed = db.prepare("UPDATE peer_pairings SET used_at = ? WHERE code_hash = ?");

export interface Pairing {
  code_hash: string;
  label: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}
export function storePairing(codeHash: string, label: string | null, createdBy: string, ttlMs: number): void {
  insertPairing.run(codeHash, label, createdBy, now(), now() + ttlMs);
}
/** Consume a pairing code (single-use). Returns the row if still valid, else null. */
export function consumePairing(codeHash: string): Pairing | null {
  const row = selectPairing.get(codeHash) as Pairing | undefined;
  if (!row || row.used_at || row.expires_at < now()) return null;
  markPairingUsed.run(now(), codeHash);
  return row;
}

// ---- spaces ----
export interface Space {
  id: string;
  title: string | null;
  scope_include_tags: string | null; // JSON string[]
  scope_exclude_tags: string | null; // JSON string[]
  path_prefix: string | null;
  created_by: string | null;
  created_at: number;
}
const insertSpace = db.prepare(
  `INSERT INTO spaces (id, title, scope_include_tags, scope_exclude_tags, path_prefix, created_by, created_at)
   VALUES (@id, @title, @scope_include_tags, @scope_exclude_tags, @path_prefix, @created_by, @created_at)`,
);
const selectSpace = db.prepare("SELECT * FROM spaces WHERE id = ?");
const selectSpaces = db.prepare("SELECT * FROM spaces ORDER BY created_at DESC");
const deleteSpaceStmt = db.prepare("DELETE FROM spaces WHERE id = ?");

export function createSpace(s: Omit<Space, "created_at">): Space {
  const row: Space = { ...s, created_at: now() };
  insertSpace.run(row);
  return row;
}
export function getSpace(id: string): Space | null {
  return (selectSpace.get(id) as Space | undefined) ?? null;
}
export function listSpaces(): Space[] {
  return selectSpaces.all() as Space[];
}
export function deleteSpace(id: string): void {
  deleteSpaceStmt.run(id);
}

// ---- federated notes (cross-vault identity map) ----
export interface FederatedNote {
  space_note_key: string;
  space_id: string;
  local_id: string;
  kind: string;
  peer_synced_at: number | null;
  source_updated_at: number | null;
  created_at: number;
  vault_id: string; // the tenant this hub maps the federated note into (default 'primary')
}
const insertFederatedNote = db.prepare(
  `INSERT INTO federated_notes (space_note_key, space_id, local_id, kind, peer_synced_at, source_updated_at, created_at)
   VALUES (@space_note_key, @space_id, @local_id, @kind, @peer_synced_at, @source_updated_at, @created_at)
   ON CONFLICT(space_note_key) DO UPDATE SET local_id=@local_id, kind=@kind, peer_synced_at=@peer_synced_at, source_updated_at=@source_updated_at`,
);
const selectFederatedByKey = db.prepare("SELECT * FROM federated_notes WHERE space_note_key = ?");
const selectFederatedByLocal = db.prepare("SELECT * FROM federated_notes WHERE local_id = ?");
const selectFederatedBySpace = db.prepare("SELECT * FROM federated_notes WHERE space_id = ?");
const deleteFederatedStmt = db.prepare("DELETE FROM federated_notes WHERE space_note_key = ?");

export function upsertFederatedNote(
  f: Omit<FederatedNote, "created_at" | "vault_id"> & { created_at?: number; vault_id?: string },
): FederatedNote {
  // vault_id is not written by the prepared statement (the DB column defaults to
  // 'primary'); it's carried on the read shape only. Callers may omit it — and it
  // must NOT be passed to .run() (better-sqlite3 rejects unknown named params).
  const created_at = f.created_at ?? now();
  insertFederatedNote.run({
    space_note_key: f.space_note_key,
    space_id: f.space_id,
    local_id: f.local_id,
    kind: f.kind,
    peer_synced_at: f.peer_synced_at,
    source_updated_at: f.source_updated_at,
    created_at,
  });
  return { ...f, vault_id: f.vault_id ?? "primary", created_at };
}
export function getFederatedByKey(key: string): FederatedNote | null {
  return (selectFederatedByKey.get(key) as FederatedNote | undefined) ?? null;
}
export function getFederatedByLocal(localId: string): FederatedNote | null {
  return (selectFederatedByLocal.get(localId) as FederatedNote | undefined) ?? null;
}
export function federatedNotesForSpace(spaceId: string): FederatedNote[] {
  return selectFederatedBySpace.all(spaceId) as FederatedNote[];
}
/** The space ids a local note participates in (for permissions.NoteRef.spaceIds). */
export function spaceIdsForLocalNote(localId: string): string[] {
  return [...new Set((selectFederatedByLocal.all(localId) as FederatedNote[]).map((f) => f.space_id))];
}
export function deleteFederatedNote(key: string): void {
  deleteFederatedStmt.run(key);
}

// ---- federation outbox (queued Yjs updates for offline peers) ----
const insertOutbox = db.prepare(
  `INSERT INTO federation_outbox (space_note_key, peer_pubkey, update_blob, queued_at)
   VALUES (?, ?, ?, ?)`,
);
const selectOutboxByPeer = db.prepare(
  "SELECT * FROM federation_outbox WHERE peer_pubkey = ? ORDER BY id ASC",
);
const deleteOutboxStmt = db.prepare("DELETE FROM federation_outbox WHERE id = ?");

export interface OutboxItem {
  id: number;
  space_note_key: string;
  peer_pubkey: string;
  update_blob: Uint8Array;
  queued_at: number;
}
export function queueOutbox(spaceNoteKey: string, peerPubkey: string, update: Uint8Array): void {
  insertOutbox.run(spaceNoteKey, peerPubkey, Buffer.from(update), now());
}
export function outboxForPeer(pubkey: string): OutboxItem[] {
  const rows = selectOutboxByPeer.all(pubkey) as Array<{
    id: number; space_note_key: string; peer_pubkey: string; update_blob: Buffer; queued_at: number;
  }>;
  return rows.map((r) => ({ ...r, update_blob: new Uint8Array(r.update_blob) }));
}
export function clearOutboxItem(id: number): void {
  deleteOutboxStmt.run(id);
}

// ── peer-edit audit (4.3) ─────────────────────────────────────────────────────
export interface PeerEdit {
  id: number;
  space_note_key: string;
  local_id: string;
  peer_pubkey: string;
  edited_at: number;
}
const insertPeerEdit = db.prepare(
  "INSERT INTO peer_edits (space_note_key, local_id, peer_pubkey, edited_at) VALUES (?, ?, ?, ?)",
);
const selectPeerEdits = db.prepare("SELECT * FROM peer_edits ORDER BY edited_at DESC, id DESC LIMIT ?");
export function recordPeerEdit(spaceNoteKey: string, localId: string, peerPubkey: string): void {
  insertPeerEdit.run(spaceNoteKey, localId, peerPubkey, now());
}
export function listPeerEdits(limit = 200): PeerEdit[] {
  return selectPeerEdits.all(limit) as PeerEdit[];
}

// ---- pending suggestions (durable; survive restart) ----
export interface Suggestion {
  id: string;
  space_note_key: string | null;
  note_id: string;
  author: string | null;
  author_kind: string | null;
  summary: string | null;
  payload: string;
  status: "pending" | "accepted" | "rejected";
  created_at: number;
  resolved_at: number | null;
}
const insertSuggestion = db.prepare(
  `INSERT INTO pending_suggestions (id, space_note_key, note_id, author, author_kind, summary, payload, status, created_at, resolved_at)
   VALUES (@id, @space_note_key, @note_id, @author, @author_kind, @summary, @payload, @status, @created_at, @resolved_at)`,
);
const selectSuggestion = db.prepare("SELECT * FROM pending_suggestions WHERE id = ?");
const selectSuggestionsByStatus = db.prepare(
  "SELECT * FROM pending_suggestions WHERE status = ? ORDER BY created_at DESC",
);
const selectAllSuggestions = db.prepare("SELECT * FROM pending_suggestions ORDER BY created_at DESC");
const selectSuggestionsByNote = db.prepare(
  "SELECT * FROM pending_suggestions WHERE note_id = ? ORDER BY created_at DESC",
);
const updateSuggestionStatus = db.prepare(
  "UPDATE pending_suggestions SET status = ?, resolved_at = ? WHERE id = ?",
);
const deleteSuggestionStmt = db.prepare("DELETE FROM pending_suggestions WHERE id = ?");

export function createSuggestion(
  s: Omit<Suggestion, "created_at" | "resolved_at" | "status"> & { status?: Suggestion["status"] },
): Suggestion {
  const row: Suggestion = { ...s, status: s.status ?? "pending", created_at: now(), resolved_at: null };
  insertSuggestion.run(row);
  return row;
}
export function getSuggestion(id: string): Suggestion | null {
  return (selectSuggestion.get(id) as Suggestion | undefined) ?? null;
}
export function listSuggestions(status?: Suggestion["status"]): Suggestion[] {
  return (status ? selectSuggestionsByStatus.all(status) : selectAllSuggestions.all()) as Suggestion[];
}
export function suggestionsForNote(noteId: string): Suggestion[] {
  return selectSuggestionsByNote.all(noteId) as Suggestion[];
}
export function setSuggestionStatus(id: string, status: Suggestion["status"]): void {
  updateSuggestionStatus.run(status, now(), id);
}
export function deleteSuggestion(id: string): void {
  deleteSuggestionStmt.run(id);
}

// ---- federation mirror requests (inbound space-share, owner-reviewed) ----
export interface MirrorRequest {
  id: string;
  peer_pubkey: string;
  space_id: string;
  space_title: string | null;
  payload: string; // JSON [{ spaceNoteKey, kind, title? }]
  status: "pending" | "accepted" | "rejected";
  created_at: number;
  resolved_at: number | null;
}
const insertMirrorReq = db.prepare(
  `INSERT INTO federation_mirror_requests (id, peer_pubkey, space_id, space_title, payload, status, created_at, resolved_at)
   VALUES (@id, @peer_pubkey, @space_id, @space_title, @payload, 'pending', @created_at, NULL)`,
);
const selectMirrorReq = db.prepare("SELECT * FROM federation_mirror_requests WHERE id = ?");
const selectPendingMirrorByPeerSpace = db.prepare(
  "SELECT * FROM federation_mirror_requests WHERE peer_pubkey = ? AND space_id = ? AND status = 'pending' LIMIT 1",
);
const selectMirrorByStatus = db.prepare("SELECT * FROM federation_mirror_requests WHERE status = ? ORDER BY created_at DESC");
const selectAllMirror = db.prepare("SELECT * FROM federation_mirror_requests ORDER BY created_at DESC");
const updateMirrorPayload = db.prepare("UPDATE federation_mirror_requests SET payload = ?, space_title = ? WHERE id = ?");
const updateMirrorStatus = db.prepare("UPDATE federation_mirror_requests SET status = ?, resolved_at = ? WHERE id = ?");
const deleteMirrorReqStmt = db.prepare("DELETE FROM federation_mirror_requests WHERE id = ?");

/** Create (or, if one is already pending for this peer+space, refresh) a mirror
 *  request. Idempotent so a peer re-pushing the same space updates the manifest
 *  instead of piling up duplicates. */
export function upsertMirrorRequest(r: {
  peer_pubkey: string;
  space_id: string;
  space_title?: string | null;
  payload: string;
}): MirrorRequest {
  const existing = selectPendingMirrorByPeerSpace.get(r.peer_pubkey, r.space_id) as MirrorRequest | undefined;
  if (existing) {
    updateMirrorPayload.run(r.payload, r.space_title ?? existing.space_title, existing.id);
    return { ...existing, payload: r.payload, space_title: r.space_title ?? existing.space_title };
  }
  const row: MirrorRequest = {
    id: randomUUID(),
    peer_pubkey: r.peer_pubkey,
    space_id: r.space_id,
    space_title: r.space_title ?? null,
    payload: r.payload,
    status: "pending",
    created_at: now(),
    resolved_at: null,
  };
  insertMirrorReq.run(row);
  return row;
}
export function getMirrorRequest(id: string): MirrorRequest | null {
  return (selectMirrorReq.get(id) as MirrorRequest | undefined) ?? null;
}
export function listMirrorRequests(status?: MirrorRequest["status"]): MirrorRequest[] {
  return (status ? selectMirrorByStatus.all(status) : selectAllMirror.all()) as MirrorRequest[];
}
export function setMirrorRequestStatus(id: string, status: MirrorRequest["status"]): void {
  updateMirrorStatus.run(status, now(), id);
}
export function deleteMirrorRequest(id: string): void {
  deleteMirrorReqStmt.run(id);
}
