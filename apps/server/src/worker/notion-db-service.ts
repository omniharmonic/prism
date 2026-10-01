/**
 * Notion database sync service (Client parity B): stored configs + the vault's
 * `notion` credential + per-config lock + audit around `runNotionDbSync`, and the
 * background pass.
 *
 * Background: the desktop ran `auto_sync` configs on an idle loop until WP1.4
 * retired it (its modal promised "every 5 minutes"). The server pass runs every
 * auto-sync config every NOTION_DB_SYNC_INTERVAL_MS (10 min), but ONLY when
 * NOTION_DB_SYNC_ENABLED=true (default off: it writes to the vault AND to Notion
 * unattended). The manual route (`POST /api/sync/notion-db/configs/:id/sync`) is
 * always available.
 */
import { config as serverConfig } from "../config";
import { getSecret } from "../secrets";
import { vaultClient } from "../parachute";
import {
  NOTION_ID_RE,
  NotionDbClient,
  autoDiscoverMappings,
  normDirection,
  normNotionConflict,
  normalizeMappings,
  runNotionDbSync,
  type NotionDbSyncResult,
  type NotionDbVault,
} from "./notion-db";
import { normalizeVaultPath } from "./github-dir";
import {
  SyncInputError,
  auditSync,
  getNotionDbConfig,
  insertNotionDbConfig,
  listNotionDbConfigs,
  updateNotionDbConfig,
  withSyncLock,
  type NotionDbConfig,
} from "./sync-store";

type FetchLike = typeof fetch;
let notionFetch: FetchLike | null = null;
let notionSleep: ((ms: number) => Promise<void>) | undefined;
let vaultFor: (vaultId: string) => NotionDbVault = (vaultId) => vaultClient(vaultId);

export function setNotionDbFetchForTests(f: FetchLike | null, sleep?: (ms: number) => Promise<void>): void {
  notionFetch = f;
  notionSleep = sleep;
}
export function setNotionDbVaultForTests(f: ((vaultId: string) => NotionDbVault) | null): void {
  vaultFor = f ?? ((vaultId) => vaultClient(vaultId));
}

export function notionDbClient(vaultId: string): NotionDbClient | null {
  const raw = getSecret(vaultId, serverConfig.ownerEmail, "notion");
  if (!raw) return null;
  let key: unknown;
  try {
    key = (JSON.parse(raw) as { apiKey?: unknown }).apiKey;
  } catch {
    return null;
  }
  return typeof key === "string" && key ? new NotionDbClient(key, notionFetch ?? fetch, notionSleep) : null;
}

const notConfigured = () => new SyncInputError("notion_not_configured", "store a Notion integration token in Network → Server → Sync integrations");

export async function notionDbSchema(vaultId: string, databaseId: string) {
  if (!NOTION_ID_RE.test(databaseId)) throw new SyncInputError("bad_request", "invalid database id");
  const client = notionDbClient(vaultId);
  if (!client) throw notConfigured();
  const properties = await client.schema(databaseId);
  return { properties, suggestedMappings: autoDiscoverMappings(properties) };
}

export function notionDbConfigView(c: NotionDbConfig) {
  return {
    id: c.id,
    notionDatabaseId: c.databaseId,
    notionDatabaseName: c.databaseName,
    parachuteTag: c.parachuteTag,
    parachutePathPrefix: c.pathPrefix,
    titleProperty: c.titleProperty,
    contentProperty: c.contentProperty,
    propertyMap: c.propertyMap,
    syncDirection: c.syncDirection,
    conflictStrategy: c.conflictStrategy,
    lastSynced: c.lastSynced,
    autoSync: c.autoSync,
    syncedCount: Object.keys(c.idMap).length,
    lastResult: c.lastResult,
    lastError: c.lastError,
  };
}

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_\-/]{0,79}$/;

export interface NotionDbInitInput {
  databaseId?: unknown;
  databaseName?: unknown;
  parachuteTag?: unknown;
  parachutePathPrefix?: unknown;
  propertyMap?: unknown;
  titleProperty?: unknown;
  contentProperty?: unknown;
  syncDirection?: unknown;
  conflictStrategy?: unknown;
  autoSync?: unknown;
}

/** Validate + store a config (desktop notion_db_sync_init: no network call). */
export function initNotionDbSync(vaultId: string, actor: string, b: NotionDbInitInput): NotionDbConfig {
  const databaseId = String(b.databaseId ?? "");
  if (!NOTION_ID_RE.test(databaseId)) throw new SyncInputError("bad_request", "databaseId must be a Notion database id");
  const tag = String(b.parachuteTag ?? "").trim();
  if (!TAG_RE.test(tag)) throw new SyncInputError("bad_request", "parachuteTag must be a tag name");
  const prefix = normalizeVaultPath(String(b.parachutePathPrefix ?? ""));
  if (!prefix) throw new SyncInputError("bad_request", "parachutePathPrefix must be a folder path with no '..' segments");
  const titleProperty = String(b.titleProperty ?? "").trim();
  if (!titleProperty || titleProperty.length > 200) throw new SyncInputError("bad_request", "titleProperty is required");
  const syncDirection = normDirection(b.syncDirection ?? "bidirectional");
  if (!syncDirection) throw new SyncInputError("bad_request", "syncDirection must be bidirectional, pull or push");
  const conflictStrategy = normNotionConflict(b.conflictStrategy ?? "notion-wins");
  if (!conflictStrategy) throw new SyncInputError("bad_request", "conflictStrategy must be notion-wins, parachute-wins or newer-wins");
  const { mappings, contentProperty: fromMap } = normalizeMappings(b.propertyMap);
  const cp = typeof b.contentProperty === "string" && b.contentProperty.trim() ? b.contentProperty.trim().slice(0, 200) : fromMap;
  const cfg = insertNotionDbConfig({
    vaultId,
    databaseId,
    databaseName: String(b.databaseName ?? "Untitled").slice(0, 200) || "Untitled",
    parachuteTag: tag,
    pathPrefix: prefix,
    propertyMap: mappings,
    titleProperty,
    contentProperty: cp,
    syncDirection,
    conflictStrategy,
    autoSync: b.autoSync === true,
    createdBy: actor,
  });
  auditSync({ actor, vaultId, kind: "notion-db", configId: cfg.id, action: "init", target: databaseId, status: "ok", detail: { mappings: mappings.length, direction: syncDirection } });
  return cfg;
}

/** One sync of one config, under its lock, audited, persisted. */
export async function runNotionDbConfig(configId: string, actor: string, action: "sync" | "auto-sync" = "sync"): Promise<NotionDbSyncResult> {
  return withSyncLock(`notion-db:${configId}`, async () => {
    const cfg = getNotionDbConfig(configId);
    if (!cfg) throw new SyncInputError("not_found", "no such sync config", 404);
    const client = notionDbClient(cfg.vaultId);
    if (!client) throw notConfigured();
    const startedAt = new Date().toISOString();
    try {
      const { result, idMap } = await runNotionDbSync(client, vaultFor(cfg.vaultId), cfg);
      updateNotionDbConfig(cfg.id, {
        idMap,
        lastSynced: startedAt,
        lastResult: { ...result, errors: result.errors.length, at: startedAt, action },
        lastError: result.errors.length ? result.errors.slice(0, 3).join("; ") : null,
      });
      const wrote = result.created + result.updated > 0;
      auditSync({
        actor,
        vaultId: cfg.vaultId,
        kind: "notion-db",
        configId: cfg.id,
        action,
        target: cfg.databaseId,
        status: wrote ? "ok" : "noop",
        detail: { created: result.created, updated: result.updated, conflicts: result.conflicts, unchanged: result.unchanged, errors: result.errors.length },
        error: result.errors.length ? `${result.errors.length} row error(s)` : null,
      });
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      updateNotionDbConfig(cfg.id, { lastError: msg });
      auditSync({ actor, vaultId: cfg.vaultId, kind: "notion-db", configId: cfg.id, action, target: cfg.databaseId, status: "failed", error: msg });
      throw e;
    }
  });
}

// ── background pass ──────────────────────────────────────────────────────────

export const notionDbBackgroundEnabled = (): boolean => process.env.NOTION_DB_SYNC_ENABLED === "true";
const intervalMs = (): number => {
  const v = Number(process.env.NOTION_DB_SYNC_INTERVAL_MS);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
};
let lastPassAt = 0;
let inFlight = false;

/** Called from the worker tick: every auto-sync config, sequentially, at most once
 *  per interval. Fire-and-forget safe (never throws). */
export async function runNotionDbPassOnce(force = false): Promise<number> {
  if (!notionDbBackgroundEnabled() || inFlight) return 0;
  if (!force && Date.now() - lastPassAt < intervalMs()) return 0;
  lastPassAt = Date.now();
  inFlight = true;
  let ran = 0;
  try {
    for (const c of listNotionDbConfigs().filter((x) => x.autoSync)) {
      try {
        const r = await runNotionDbConfig(c.id, "worker", "auto-sync");
        ran++;
        if (r.created || r.updated || r.errors.length) {
          console.log(`[notion-db] ${c.databaseName}: +${r.created} ~${r.updated} !${r.conflicts} =${r.unchanged} errors=${r.errors.length}`);
        }
      } catch (e) {
        console.warn(`[notion-db] ${c.databaseName} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    inFlight = false;
  }
  return ran;
}

export const listNotionDbConfigsFor = (vaultId: string) => listNotionDbConfigs(vaultId);
