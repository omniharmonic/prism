/**
 * Storage for the server folder / database syncs (Client parity B): GitHub folder
 * configs, Notion database configs, the sync_audit trail, and the per-config
 * lock every push/sync goes through. Tables are created in db.ts.
 *
 * No credential is stored here — the token is the vault's `github` / `notion`
 * secret (secrets.ts), read at push time and never returned by any route.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db";
import type { CommitStrategy, GhConflictStrategy, GitHubDirConfig } from "./github-dir";
import { scrubMessage } from "./github-dir";

/** A caller-facing refusal (route → `{error: code, detail: message}` + status). */
export class SyncInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ── per-config lock ──────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier holder of `key` has finished (FIFO). Two pushes
 *  of one config never interleave (their remote reads + ref update would race). */
export function withSyncLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

export const syncLockBusy = (key: string): boolean => chains.has(key);

// ── audit ────────────────────────────────────────────────────────────────────

export interface SyncAuditRow {
  id: number;
  ts: number;
  actor: string;
  vault_id: string;
  kind: string;
  config_id: string | null;
  action: string;
  target: string;
  status: string;
  detail: string | null;
  error: string | null;
}

export function auditSync(row: {
  actor: string;
  vaultId: string;
  kind: "github" | "notion-db";
  configId?: string | null;
  action: string;
  target: string;
  status: "ok" | "noop" | "failed";
  detail?: Record<string, unknown> | null;
  error?: string | null;
}): void {
  db.prepare(
    `INSERT INTO sync_audit (ts, actor, vault_id, kind, config_id, action, target, status, detail, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    row.actor,
    row.vaultId,
    row.kind,
    row.configId ?? null,
    row.action,
    row.target.slice(0, 300),
    row.status,
    row.detail ? JSON.stringify(row.detail).slice(0, 4000) : null,
    row.error ? scrubMessage(row.error) : null,
  );
}

export function listSyncAudit(vaultId: string, opts: { kind?: string; configId?: string; limit?: number } = {}): SyncAuditRow[] {
  const where = ["vault_id = ?"];
  const args: unknown[] = [vaultId];
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts.configId) {
    where.push("config_id = ?");
    args.push(opts.configId);
  }
  args.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  return db.prepare(`SELECT * FROM sync_audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args) as SyncAuditRow[];
}

// ── GitHub folder configs ────────────────────────────────────────────────────

interface GhRow {
  id: string;
  vault_id: string;
  vault_path: string;
  owner: string;
  repo: string;
  branch: string;
  file_extension: string;
  commit_strategy: string;
  conflict_strategy: string;
  auto_sync: number;
  id_map: string;
  blob_map: string;
  last_synced: string;
  last_result: string | null;
  last_error: string | null;
  imported_from: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface StoredGitHubConfig extends GitHubDirConfig {
  lastResult: Record<string, unknown> | null;
  lastError: string | null;
  importedFrom: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

const parseJson = <T>(s: string | null, d: T): T => {
  if (!s) return d;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as T) : d;
  } catch {
    return d;
  }
};

function ghFromRow(r: GhRow): StoredGitHubConfig {
  return {
    id: r.id,
    vaultId: r.vault_id,
    vaultPath: r.vault_path,
    owner: r.owner,
    repo: r.repo,
    branch: r.branch,
    fileExtension: r.file_extension,
    commitStrategy: r.commit_strategy as CommitStrategy,
    conflictStrategy: r.conflict_strategy as GhConflictStrategy,
    autoSync: r.auto_sync === 1,
    idMap: parseJson(r.id_map, {}),
    blobMap: parseJson(r.blob_map, {}),
    lastSynced: r.last_synced,
    lastResult: parseJson(r.last_result, null),
    lastError: r.last_error,
    importedFrom: r.imported_from,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertGitHubConfig(c: Omit<StoredGitHubConfig, "id" | "createdAt" | "updatedAt" | "lastResult" | "lastError"> & { id?: string }): StoredGitHubConfig {
  const id = c.id ?? randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO github_sync_configs (id, vault_id, vault_path, owner, repo, branch, file_extension, commit_strategy, conflict_strategy,
       auto_sync, id_map, blob_map, last_synced, imported_from, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    c.vaultId,
    c.vaultPath,
    c.owner,
    c.repo,
    c.branch,
    c.fileExtension,
    c.commitStrategy,
    c.conflictStrategy,
    c.autoSync ? 1 : 0,
    JSON.stringify(c.idMap ?? {}),
    JSON.stringify(c.blobMap ?? {}),
    c.lastSynced ?? "",
    c.importedFrom ?? null,
    c.createdBy,
    now,
    now,
  );
  return getGitHubConfig(id)!;
}

export function getGitHubConfig(id: string): StoredGitHubConfig | null {
  const r = db.prepare("SELECT * FROM github_sync_configs WHERE id = ?").get(id) as GhRow | undefined;
  return r ? ghFromRow(r) : null;
}

export function listGitHubConfigs(vaultId?: string): StoredGitHubConfig[] {
  const rows = (
    vaultId
      ? db.prepare("SELECT * FROM github_sync_configs WHERE vault_id = ? ORDER BY created_at").all(vaultId)
      : db.prepare("SELECT * FROM github_sync_configs ORDER BY created_at").all()
  ) as GhRow[];
  return rows.map(ghFromRow);
}

export function updateGitHubConfig(
  id: string,
  p: Partial<Pick<StoredGitHubConfig, "autoSync" | "commitStrategy" | "conflictStrategy" | "idMap" | "blobMap" | "lastSynced" | "lastResult" | "lastError">>,
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (p.autoSync !== undefined) set("auto_sync", p.autoSync ? 1 : 0);
  if (p.commitStrategy !== undefined) set("commit_strategy", p.commitStrategy);
  if (p.conflictStrategy !== undefined) set("conflict_strategy", p.conflictStrategy);
  if (p.idMap !== undefined) set("id_map", JSON.stringify(p.idMap));
  if (p.blobMap !== undefined) set("blob_map", JSON.stringify(p.blobMap));
  if (p.lastSynced !== undefined) set("last_synced", p.lastSynced);
  if (p.lastResult !== undefined) set("last_result", p.lastResult ? JSON.stringify(p.lastResult) : null);
  if (p.lastError !== undefined) set("last_error", p.lastError ? scrubMessage(p.lastError) : null);
  if (!sets.length) return;
  set("updated_at", Date.now());
  args.push(id);
  db.prepare(`UPDATE github_sync_configs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

export function deleteGitHubConfig(id: string): boolean {
  return db.prepare("DELETE FROM github_sync_configs WHERE id = ?").run(id).changes > 0;
}

// ── Notion database configs ──────────────────────────────────────────────────

export interface PropertyMapping {
  notionProperty: string;
  notionType: string;
  parachuteField: string;
  transform: string;
  valueMap: Record<string, string>;
  relationshipType: string | null;
}

export type NotionDirection = "bidirectional" | "pull" | "push";
export type NotionConflict = "notion-wins" | "parachute-wins" | "newer-wins";

export interface NotionDbConfig {
  id: string;
  vaultId: string;
  databaseId: string;
  databaseName: string;
  parachuteTag: string;
  pathPrefix: string;
  propertyMap: PropertyMapping[];
  titleProperty: string;
  contentProperty: string | null;
  syncDirection: NotionDirection;
  conflictStrategy: NotionConflict;
  autoSync: boolean;
  /** Notion page id → vault note id (desktop id_map). */
  idMap: Record<string, string>;
  lastSynced: string;
  lastResult: Record<string, unknown> | null;
  lastError: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface NdRow {
  id: string;
  vault_id: string;
  database_id: string;
  database_name: string;
  parachute_tag: string;
  path_prefix: string;
  property_map: string;
  title_property: string;
  content_property: string | null;
  sync_direction: string;
  conflict_strategy: string;
  auto_sync: number;
  id_map: string;
  last_synced: string;
  last_result: string | null;
  last_error: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function ndFromRow(r: NdRow): NotionDbConfig {
  return {
    id: r.id,
    vaultId: r.vault_id,
    databaseId: r.database_id,
    databaseName: r.database_name,
    parachuteTag: r.parachute_tag,
    pathPrefix: r.path_prefix,
    propertyMap: parseJson<PropertyMapping[]>(r.property_map, []),
    titleProperty: r.title_property,
    contentProperty: r.content_property,
    syncDirection: r.sync_direction as NotionDirection,
    conflictStrategy: r.conflict_strategy as NotionConflict,
    autoSync: r.auto_sync === 1,
    idMap: parseJson(r.id_map, {}),
    lastSynced: r.last_synced,
    lastResult: parseJson(r.last_result, null),
    lastError: r.last_error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertNotionDbConfig(
  c: Omit<NotionDbConfig, "id" | "createdAt" | "updatedAt" | "lastResult" | "lastError" | "idMap" | "lastSynced"> & { idMap?: Record<string, string> },
): NotionDbConfig {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO notion_db_sync_configs (id, vault_id, database_id, database_name, parachute_tag, path_prefix, property_map, title_property,
       content_property, sync_direction, conflict_strategy, auto_sync, id_map, last_synced, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
  ).run(
    id,
    c.vaultId,
    c.databaseId,
    c.databaseName,
    c.parachuteTag,
    c.pathPrefix,
    JSON.stringify(c.propertyMap),
    c.titleProperty,
    c.contentProperty,
    c.syncDirection,
    c.conflictStrategy,
    c.autoSync ? 1 : 0,
    JSON.stringify(c.idMap ?? {}),
    c.createdBy,
    now,
    now,
  );
  return getNotionDbConfig(id)!;
}

export function getNotionDbConfig(id: string): NotionDbConfig | null {
  const r = db.prepare("SELECT * FROM notion_db_sync_configs WHERE id = ?").get(id) as NdRow | undefined;
  return r ? ndFromRow(r) : null;
}

export function listNotionDbConfigs(vaultId?: string): NotionDbConfig[] {
  const rows = (
    vaultId
      ? db.prepare("SELECT * FROM notion_db_sync_configs WHERE vault_id = ? ORDER BY created_at").all(vaultId)
      : db.prepare("SELECT * FROM notion_db_sync_configs ORDER BY created_at").all()
  ) as NdRow[];
  return rows.map(ndFromRow);
}

export function updateNotionDbConfig(
  id: string,
  p: Partial<Pick<NotionDbConfig, "autoSync" | "conflictStrategy" | "syncDirection" | "idMap" | "lastSynced" | "lastResult" | "lastError">>,
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (p.autoSync !== undefined) set("auto_sync", p.autoSync ? 1 : 0);
  if (p.conflictStrategy !== undefined) set("conflict_strategy", p.conflictStrategy);
  if (p.syncDirection !== undefined) set("sync_direction", p.syncDirection);
  if (p.idMap !== undefined) set("id_map", JSON.stringify(p.idMap));
  if (p.lastSynced !== undefined) set("last_synced", p.lastSynced);
  if (p.lastResult !== undefined) set("last_result", p.lastResult ? JSON.stringify(p.lastResult) : null);
  if (p.lastError !== undefined) set("last_error", p.lastError ? scrubMessage(p.lastError) : null);
  if (!sets.length) return;
  set("updated_at", Date.now());
  args.push(id);
  db.prepare(`UPDATE notion_db_sync_configs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

export function deleteNotionDbConfig(id: string): boolean {
  return db.prepare("DELETE FROM notion_db_sync_configs WHERE id = ?").run(id).changes > 0;
}
