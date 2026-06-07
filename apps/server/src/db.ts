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
    subject_type  TEXT NOT NULL,   -- 'user' | 'link' | 'anyone'
    subject       TEXT NOT NULL,   -- email | capability id | '*'
    resource_type TEXT NOT NULL,   -- 'note' | 'tag'
    resource      TEXT NOT NULL,   -- note id | tag name
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
`);

// Migration: accounts now carry a password. Add the column if an older db
// predates it (CREATE TABLE IF NOT EXISTS won't alter an existing table).
{
  const cols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "password_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  }
}

export type SubjectType = "user" | "link" | "anyone";
export type ResourceType = "note" | "tag";

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
