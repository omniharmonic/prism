/**
 * SQLite store for identity + access control (sessions, users, magic-link
 * tokens, and grants). Lives on the home server next to the vault; holds no
 * vault data, only who-can-do-what.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import type { Level } from "./permissions";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

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
    name              TEXT PRIMARY KEY,   -- note id
    state             BLOB NOT NULL,      -- Yjs encoded state (CRDT continuity)
    source_updated_at INTEGER,            -- Parachute updatedAt at last store (external-edit detection)
    updated_at        INTEGER NOT NULL
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
    resource_type TEXT NOT NULL,      -- 'tag' (v1; 'note' reserved)
    resource      TEXT NOT NULL,      -- tag name
    template      TEXT NOT NULL,      -- 'wiki' (template registry key)
    title         TEXT,
    home_note_id  TEXT,               -- landing note; null → derive at read time
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

export type SubjectType = "user" | "link" | "anyone" | "peer";
export type ResourceType = "note" | "tag" | "space";

export interface Grant {
  id: string;
  subject_type: SubjectType;
  subject: string;
  resource_type: ResourceType;
  resource: string;
  level: Level;
  created_by: string | null;
  created_at: number;
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
const insertGrant = db.prepare(
  `INSERT INTO grants (id, subject_type, subject, resource_type, resource, level, created_by, created_at)
   VALUES (@id, @subject_type, @subject, @resource_type, @resource, @level, @created_by, @created_at)`,
);
const selectGrantsByUser = db.prepare(
  "SELECT * FROM grants WHERE (subject_type = 'user' AND subject = ?) OR subject_type = 'anyone'",
);
const selectGrantsByCapability = db.prepare(
  "SELECT * FROM grants WHERE subject_type = 'link' AND subject = ?",
);
const selectGrantsByResource = db.prepare(
  "SELECT * FROM grants WHERE resource_type = ? AND resource = ?",
);
const deleteGrantStmt = db.prepare("DELETE FROM grants WHERE id = ?");

export function addGrant(g: Omit<Grant, "id" | "created_at"> & { id?: string }): Grant {
  const row: Grant = { ...g, id: g.id ?? randomUUID(), created_at: now() };
  insertGrant.run(row);
  return row;
}
/** Grants for a signed-in user (their own grants + any "anyone-with-link" grants). */
export function grantsForUser(email: string): Grant[] {
  return selectGrantsByUser.all(email) as Grant[];
}
/** Grants attached to a specific capability link. */
export function grantsForCapability(capabilityId: string): Grant[] {
  return selectGrantsByCapability.all(capabilityId) as Grant[];
}
export function grantsForResource(type: ResourceType, resource: string): Grant[] {
  return selectGrantsByResource.all(type, resource) as Grant[];
}
export function removeGrant(id: string): void {
  deleteGrantStmt.run(id);
}

const selectGrantBySubjectResource = db.prepare(
  `SELECT * FROM grants WHERE subject_type = ? AND subject = ? AND resource_type = ? AND resource = ?`,
);
const updateGrantLevel = db.prepare("UPDATE grants SET level = ? WHERE id = ?");

/** Insert or, if a grant for the same (subject, resource) exists, update its level. */
export function upsertGrant(g: Omit<Grant, "id" | "created_at">): Grant {
  const existing = selectGrantBySubjectResource.get(
    g.subject_type,
    g.subject,
    g.resource_type,
    g.resource,
  ) as Grant | undefined;
  if (existing) {
    updateGrantLevel.run(g.level, existing.id);
    return { ...existing, level: g.level };
  }
  return addGrant(g);
}

const deleteGrantBySubjectResourceStmt = db.prepare(
  `DELETE FROM grants WHERE subject_type = ? AND subject = ? AND resource_type = ? AND resource = ?`,
);
export function removeGrantBySubjectResource(
  subjectType: SubjectType,
  subject: string,
  resourceType: ResourceType,
  resource: string,
): void {
  deleteGrantBySubjectResourceStmt.run(subjectType, subject, resourceType, resource);
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
const selectDocState = db.prepare("SELECT state, source_updated_at FROM collab_docs WHERE name = ?");
const upsertDocState = db.prepare(
  `INSERT INTO collab_docs (name, state, source_updated_at, updated_at)
   VALUES (@name, @state, @source_updated_at, @updated_at)
   ON CONFLICT(name) DO UPDATE SET state=@state, source_updated_at=@source_updated_at, updated_at=@updated_at`,
);

export function getDocState(name: string): DocState | null {
  const row = selectDocState.get(name) as { state: Buffer; source_updated_at: number | null } | undefined;
  if (!row) return null;
  return { state: new Uint8Array(row.state), sourceUpdatedAt: row.source_updated_at };
}
export function saveDocState(name: string, state: Uint8Array, sourceUpdatedAt: number | null): void {
  upsertDocState.run({
    name,
    state: Buffer.from(state),
    source_updated_at: sourceUpdatedAt,
    updated_at: now(),
  });
}

// ---- grants (peer subject) ----
const selectGrantsByPeer = db.prepare(
  "SELECT * FROM grants WHERE subject_type = 'peer' AND subject = ?",
);
/** Grants attached to a paired peer (matched by its pubkey). */
export function grantsForPeer(pubkey: string): Grant[] {
  return selectGrantsByPeer.all(pubkey) as Grant[];
}

// ---- publications (Horizon B) ----
export interface Publication {
  id: string;
  resource_type: ResourceType;
  resource: string;
  template: string;
  title: string | null;
  home_note_id: string | null;
  password_hash: string | null;
  theme: string | null;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
}
const insertPublication = db.prepare(
  `INSERT INTO publications (id, resource_type, resource, template, title, home_note_id, password_hash, theme, expires_at, created_by, created_at)
   VALUES (@id, @resource_type, @resource, @template, @title, @home_note_id, @password_hash, @theme, @expires_at, @created_by, @created_at)`,
);
const selectPublication = db.prepare("SELECT * FROM publications WHERE id = ?");
const selectPublicationByResource = db.prepare(
  "SELECT * FROM publications WHERE resource_type = ? AND resource = ? LIMIT 1",
);
const selectPublications = db.prepare("SELECT * FROM publications ORDER BY created_at DESC");
const deletePublicationStmt = db.prepare("DELETE FROM publications WHERE id = ?");
const updatePublicationStmt = db.prepare(
  `UPDATE publications SET title=@title, home_note_id=@home_note_id, password_hash=@password_hash, theme=@theme, expires_at=@expires_at WHERE id=@id`,
);

export function createPublication(p: Omit<Publication, "created_at">): Publication {
  const row: Publication = { ...p, created_at: now() };
  insertPublication.run(row);
  return row;
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
/** Patch the mutable fields of a publication (title/home/password/theme/expiry). */
export function updatePublication(
  slug: string,
  patch: Partial<Pick<Publication, "title" | "home_note_id" | "password_hash" | "theme" | "expires_at">>,
): Publication | null {
  const existing = getPublicationBySlug(slug);
  if (!existing) return null;
  const merged: Publication = { ...existing, ...patch };
  updatePublicationStmt.run({
    id: slug,
    title: merged.title,
    home_note_id: merged.home_note_id,
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

export function upsertFederatedNote(f: Omit<FederatedNote, "created_at"> & { created_at?: number }): FederatedNote {
  const row: FederatedNote = { ...f, created_at: f.created_at ?? now() };
  insertFederatedNote.run(row);
  return row;
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
