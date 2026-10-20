/**
 * GitHub folder sync service (Client parity B): the stored configs + credential
 * + locks + audit around `pushDirectory` (github-dir.ts), the import of the
 * desktop's `github-sync-configs.json`, and AUTO-SYNC.
 *
 * Auto-sync: the desktop pushed a note after every save (and, by a bug, to every
 * auto-sync config regardless of folder). The server instead listens to the tree
 * projection's change feed (`subscribeTreeChanges`, the vault's own subscribe
 * socket — no polling): an upsert/remove whose path (old or new) is under an
 * auto-sync config's folder marks that note dirty; after GITHUB_AUTOSYNC_DEBOUNCE_MS
 * (30 s) of quiet — or GITHUB_AUTOSYNC_MAX_WAIT_MS (5 min) since the first change,
 * whichever is first — the dirty notes go out as ONE commit. A projection
 * `resync` (socket reconnect / rebuild) can hide changes, so it schedules a full
 * folder push (unchanged files cost nothing — blob SHAs are compared). Configs
 * with commit_strategy `manual` never auto-push. GITHUB_AUTOSYNC_ENABLED=false
 * turns the whole listener off.
 */
import { config as serverConfig } from "../config";
import { getSecret } from "../secrets";
import { resolveVaultEntry } from "../db";
import type { VaultEntry } from "../config";
import { vaultClient } from "../parachute";
import { subscribeTreeChanges, type TreeChange } from "../tree";
import { viewableBy } from "./sync-visibility";
import {
  GitHubApiError,
  GitHubGitClient,
  isUnderVaultPath,
  normalizeExtension,
  normalizeVaultPath,
  parseRemote,
  pushDirectory,
  validBranch,
  type CommitStrategy,
  type DirSyncVault,
  type DirectorySyncResult,
  type GhConflictStrategy,
  type PushScope,
} from "./github-dir";
import {
  auditSync,
  deleteGitHubConfig,
  getGitHubConfig,
  insertGitHubConfig,
  listGitHubConfigs,
  SyncInputError,
  updateGitHubConfig,
  withSyncLock,
  type StoredGitHubConfig,
} from "./sync-store";

// ── injectable seams (tests) ─────────────────────────────────────────────────

type FetchLike = typeof fetch;
let githubFetch: FetchLike | null = null;
let vaultFor: (vaultId: string) => DirSyncVault = (vaultId) => vaultClient(vaultId);
type FeedSubscribe = (entry: VaultEntry, l: (c: TreeChange) => void) => Promise<() => void>;
let feedSubscribe: FeedSubscribe = subscribeTreeChanges;

export function setGitHubFetchForTests(f: FetchLike | null): void {
  githubFetch = f;
}
export function setGitHubVaultForTests(f: ((vaultId: string) => DirSyncVault) | null): void {
  vaultFor = f ?? ((vaultId) => vaultClient(vaultId));
}
export function setGitHubFeedForTests(f: FeedSubscribe | null): void {
  feedSubscribe = f ?? subscribeTreeChanges;
}

export function githubToken(vaultId: string): string | null {
  const raw = getSecret(vaultId, serverConfig.ownerEmail, "github");
  if (!raw) return null;
  try {
    const t = (JSON.parse(raw) as { token?: unknown }).token;
    return typeof t === "string" && t ? t : null;
  } catch {
    return null;
  }
}

export function githubClient(vaultId: string): GitHubGitClient | null {
  const token = githubToken(vaultId);
  return token ? new GitHubGitClient(token, githubFetch ?? fetch) : null;
}

export { SyncInputError };

// ── normalization (desktop + UI spellings) ───────────────────────────────────

export function normCommitStrategy(s: unknown): CommitStrategy | null {
  const v = String(s ?? "").toLowerCase().replace(/-/g, "_");
  if (v === "per_save" || v === "persave") return "per_save";
  if (v === "batched") return "batched";
  if (v === "manual") return "manual";
  return null;
}

/** "local-wins" / "local_wins" / "remote-wins" / "remote_wins" (the desktop UI sent
 *  underscores; its adapter compared hyphens, so remote-wins never applied). */
export function normGhConflict(s: unknown): GhConflictStrategy | null {
  const v = String(s ?? "").toLowerCase().replace(/_/g, "-");
  if (v === "local-wins" || v === "local") return "local-wins";
  if (v === "remote-wins" || v === "remote") return "remote-wins";
  return null;
}

export interface GitHubConfigInput {
  vaultPath: string;
  remoteUrl: string;
  branch?: string;
  commitStrategy?: string;
  conflictStrategy?: string;
  autoSync?: boolean;
  fileExtension?: string;
  /** Explicit opt-in to auto-sync into a PUBLIC repository (review M1). */
  allowPublic?: boolean;
}

export function validateGitHubInput(b: GitHubConfigInput): {
  vaultPath: string;
  owner: string;
  repo: string;
  branch: string;
  commitStrategy: CommitStrategy;
  conflictStrategy: GhConflictStrategy;
  autoSync: boolean;
  allowPublic: boolean;
  fileExtension: string;
} {
  const vaultPath = normalizeVaultPath(b.vaultPath);
  if (!vaultPath) throw new SyncInputError("bad_request", "vaultPath must be a folder path with no '..' segments");
  const remote = parseRemote(b.remoteUrl);
  if (!remote) throw new SyncInputError("bad_request", "remoteUrl must be a github.com repository (owner/repo or https://github.com/owner/repo)");
  const branch = (b.branch ?? "main").trim() || "main";
  if (!validBranch(branch)) throw new SyncInputError("bad_request", "invalid branch name");
  const commitStrategy = normCommitStrategy(b.commitStrategy ?? "batched");
  if (!commitStrategy) throw new SyncInputError("bad_request", "commitStrategy must be per_save, batched or manual");
  const conflictStrategy = normGhConflict(b.conflictStrategy ?? "local-wins");
  if (!conflictStrategy) throw new SyncInputError("bad_request", "conflictStrategy must be local-wins or remote-wins");
  const fileExtension = normalizeExtension(b.fileExtension ?? ".md");
  if (fileExtension === null) throw new SyncInputError("bad_request", "invalid fileExtension");
  return { vaultPath, ...remote, branch, commitStrategy, conflictStrategy, autoSync: b.autoSync === true, allowPublic: b.allowPublic === true, fileExtension: fileExtension || ".md" };
}

// ── views ────────────────────────────────────────────────────────────────────

/** What a client sees: the desktop GitHubSyncInfo fields + server extras. Never a token. */
export function githubConfigView(c: StoredGitHubConfig) {
  return {
    id: c.id,
    vaultPath: c.vaultPath,
    remoteUrl: `https://github.com/${c.owner}/${c.repo}`,
    owner: c.owner,
    repo: c.repo,
    branch: c.branch,
    lastSynced: c.lastSynced,
    autoSync: c.autoSync,
    commitStrategy: c.commitStrategy,
    conflictStrategy: c.conflictStrategy,
    fileExtension: c.fileExtension,
    syncedCount: Object.keys(c.idMap).length,
    lastResult: c.lastResult,
    lastError: c.lastError,
    importedFrom: c.importedFrom,
    allowPublic: c.allowPublic,
    /** null = not checked yet; false → the UI warns: notes go to a PUBLIC repo. */
    repoPrivate: c.repoPrivate,
  };
}

const target = (c: Pick<StoredGitHubConfig, "owner" | "repo" | "branch">) => `${c.owner}/${c.repo}@${c.branch}`;

function summary(r: DirectorySyncResult) {
  return {
    pushed: r.pushed.length,
    unchanged: r.unchanged,
    conflicts: r.conflicts.length,
    errors: r.errors.length,
    pulledCandidates: r.pulled.length,
    commit: r.commit,
  };
}

// ── push (every path goes through the per-config lock + audit) ───────────────

export async function runGitHubPush(
  configId: string,
  scope: PushScope,
  actor: string,
  action: "init" | "push" | "push-file" | "auto-push",
): Promise<DirectorySyncResult> {
  return withSyncLock(`github:${configId}`, async () => {
    const cfg = getGitHubConfig(configId);
    if (!cfg) throw new SyncInputError("not_found", "no such sync config", 404);
    const gh = githubClient(cfg.vaultId);
    if (!gh) throw new SyncInputError("github_not_configured", "store a GitHub token in Network → Server → Sync integrations");
    const startedAt = new Date().toISOString();
    try {
      // Visibility first (review M1): record it, and never AUTO-push into a public
      // repository without the explicit allowPublic opt-in.
      const info = await gh.repo(cfg.owner, cfg.repo);
      if (!info) throw new SyncInputError("repo_not_found", "repository not found, or the stored token cannot see it");
      if (cfg.repoPrivate !== info.private) updateGitHubConfig(cfg.id, { repoPrivate: info.private });
      if (action === "auto-push" && !info.private && !cfg.allowPublic) {
        throw new SyncInputError("public_repo", "the repository is public; auto-sync needs allowPublic");
      }
      const out = await pushDirectory(gh, vaultFor(cfg.vaultId), cfg, scope, undefined, viewableBy(cfg.createdBy, cfg.vaultId));
      const r = out.result;
      updateGitHubConfig(cfg.id, {
        idMap: out.idMap,
        blobMap: out.blobMap,
        lastSynced: startedAt,
        lastResult: { ...summary(r), at: startedAt, action },
        lastError: r.errors.length ? r.errors.slice(0, 3).map(([p, m]) => `${p}: ${m}`).join("; ") : null,
      });
      auditSync({
        actor,
        vaultId: cfg.vaultId,
        kind: "github",
        configId: cfg.id,
        action,
        target: target(cfg),
        status: r.commit ? "ok" : "noop",
        detail: summary(r),
        error: r.errors.length ? `${r.errors.length} file error(s)` : null,
      });
      return r;
    } catch (e) {
      const msg = (e as Error).message;
      updateGitHubConfig(cfg.id, { lastError: msg });
      auditSync({ actor, vaultId: cfg.vaultId, kind: "github", configId: cfg.id, action, target: target(cfg), status: "failed", error: msg });
      throw e;
    }
  });
}

/** Create a config, verify the repo is pushable, run the initial push (desktop
 *  github_sync_init). On a failed initial push the config is removed again
 *  (the desktop only saved a config once its first sync succeeded). */
export async function initGitHubSync(vaultId: string, actor: string, input: GitHubConfigInput): Promise<{ config: StoredGitHubConfig; result: DirectorySyncResult }> {
  const v = validateGitHubInput(input);
  const gh = githubClient(vaultId);
  if (!gh) throw new SyncInputError("github_not_configured", "store a GitHub token in Network → Server → Sync integrations");
  const dup = listGitHubConfigs(vaultId).find((c) => c.owner === v.owner && c.repo === v.repo && c.branch === v.branch && c.vaultPath === v.vaultPath);
  if (dup) throw new SyncInputError("exists", "this folder already syncs to that repository and branch", 409);
  const info = await gh.repo(v.owner, v.repo);
  if (!info) throw new SyncInputError("repo_not_found", "repository not found, or the stored token cannot see it");
  if (!info.canPush) throw new SyncInputError("repo_read_only", "the stored token cannot push to this repository");
  if (v.autoSync && !info.private && !v.allowPublic) {
    throw new SyncInputError("public_repo", "this repository is PUBLIC: every note in the folder would be published. Set allowPublic to auto-sync anyway");
  }
  const cfg = insertGitHubConfig({
    vaultId,
    vaultPath: v.vaultPath,
    owner: v.owner,
    repo: v.repo,
    branch: v.branch,
    fileExtension: v.fileExtension,
    commitStrategy: v.commitStrategy,
    conflictStrategy: v.conflictStrategy,
    autoSync: v.autoSync,
    allowPublic: v.allowPublic,
    repoPrivate: info.private,
    idMap: {},
    blobMap: {},
    lastSynced: "",
    importedFrom: null,
    createdBy: actor,
  });
  try {
    const result = await runGitHubPush(cfg.id, { kind: "all" }, actor, "init");
    refreshGitHubAutoSync();
    return { config: getGitHubConfig(cfg.id)!, result };
  } catch (e) {
    deleteGitHubConfig(cfg.id);
    throw e;
  }
}

/** Turning auto-sync ON: refuse a PUBLIC repository unless allowPublic (review M1).
 *  Checks the live visibility (one GET) and records it. */
export async function assertAutoSyncAllowed(cfg: StoredGitHubConfig, allowPublic: boolean): Promise<void> {
  const gh = githubClient(cfg.vaultId);
  if (!gh) throw new SyncInputError("github_not_configured", "store a GitHub token in Network → Server → Sync integrations");
  const info = await gh.repo(cfg.owner, cfg.repo);
  if (!info) throw new SyncInputError("repo_not_found", "repository not found, or the stored token cannot see it");
  updateGitHubConfig(cfg.id, { repoPrivate: info.private });
  if (!info.private && !allowPublic) {
    throw new SyncInputError("public_repo", "this repository is PUBLIC: every note in the folder would be published. Set allowPublic to auto-sync anyway");
  }
}

// ── import of the desktop's github-sync-configs.json ─────────────────────────

export interface ImportOutcome {
  desktopId: string;
  status: "created" | "exists" | "invalid";
  id?: string;
  reason?: string;
  vaultPath?: string;
  remote?: string;
  /** The desktop's own auto_sync value (imports are created with auto-sync OFF). */
  desktopAutoSync?: boolean;
}

/**
 * Map the desktop's `github-sync-configs.json` (a map of id → DirectorySyncConfig,
 * or an array of them) to server configs in `vaultId`. Local fields
 * (`local_clone_path`) are ignored; `id_map` is carried over; `auto_sync` is
 * forced OFF unless `enableAutoSync` (the configs have been dormant since the
 * desktop stopped — re-enable each one deliberately). Idempotent: a config with
 * the same folder + repo + branch is reported `exists`. No network call.
 */
export function importDesktopGitHubConfigs(vaultId: string, actor: string, payload: unknown, enableAutoSync = false): ImportOutcome[] {
  const list: unknown[] = Array.isArray(payload) ? payload : payload && typeof payload === "object" ? Object.values(payload as Record<string, unknown>) : [];
  if (list.length > 200) throw new SyncInputError("bad_request", "too many configs in one import (max 200)");
  const out: ImportOutcome[] = [];
  for (const raw of list) {
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const desktopId = typeof d.id === "string" ? d.id.slice(0, 100) : "";
    try {
      const v = validateGitHubInput({
        vaultPath: String(d.vault_path ?? d.vaultPath ?? ""),
        remoteUrl: String(d.remote_url ?? d.remoteUrl ?? ""),
        branch: String(d.branch ?? "main"),
        commitStrategy: String(d.commit_strategy ?? d.commitStrategy ?? "batched"),
        conflictStrategy: String(d.conflict_strategy ?? d.conflictStrategy ?? "local-wins"),
        fileExtension: String(d.file_extension ?? d.fileExtension ?? ".md"),
      });
      const existing = listGitHubConfigs(vaultId).find((c) => c.owner === v.owner && c.repo === v.repo && c.branch === v.branch && c.vaultPath === v.vaultPath);
      const desktopAutoSync = d.auto_sync === true || d.autoSync === true;
      if (existing) {
        out.push({ desktopId, status: "exists", id: existing.id, vaultPath: v.vaultPath, remote: `${v.owner}/${v.repo}`, desktopAutoSync });
        continue;
      }
      const rawMap = (d.id_map ?? d.idMap) as unknown;
      const idMap: Record<string, string> = {};
      if (rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)) {
        for (const [k, val] of Object.entries(rawMap as Record<string, unknown>)) {
          if (typeof val === "string" && k.length <= 200 && val.length <= 4096) idMap[k] = val;
        }
      }
      const lastSynced = typeof d.last_synced === "string" && d.last_synced.length <= 64 ? d.last_synced : "";
      const useId = /^[0-9a-f-]{36}$/i.test(desktopId) && !getGitHubConfig(desktopId) ? desktopId : undefined;
      const cfg = insertGitHubConfig({
        id: useId,
        vaultId,
        vaultPath: v.vaultPath,
        owner: v.owner,
        repo: v.repo,
        branch: v.branch,
        fileExtension: v.fileExtension,
        commitStrategy: v.commitStrategy,
        conflictStrategy: v.conflictStrategy,
        autoSync: enableAutoSync && desktopAutoSync,
        idMap,
        blobMap: {},
        lastSynced,
        importedFrom: desktopId || null,
        createdBy: actor,
      });
      auditSync({ actor, vaultId, kind: "github", configId: cfg.id, action: "import", target: target(cfg), status: "ok", detail: { desktopId, autoSync: cfg.autoSync } });
      out.push({ desktopId, status: "created", id: cfg.id, vaultPath: v.vaultPath, remote: `${v.owner}/${v.repo}`, desktopAutoSync });
    } catch (e) {
      out.push({ desktopId, status: "invalid", reason: e instanceof SyncInputError ? e.message : "unreadable entry" });
    }
  }
  refreshGitHubAutoSync();
  return out;
}

// ── auto-sync ────────────────────────────────────────────────────────────────

const autoOpts = {
  enabled: () => process.env.GITHUB_AUTOSYNC_ENABLED !== "false",
  debounceMs: () => {
    const v = Number(process.env.GITHUB_AUTOSYNC_DEBOUNCE_MS);
    return Number.isFinite(v) && v >= 0 ? v : 30_000;
  },
  maxWaitMs: () => {
    const v = Number(process.env.GITHUB_AUTOSYNC_MAX_WAIT_MS);
    return Number.isFinite(v) && v > 0 ? v : 300_000;
  },
};

interface Pending {
  ids: Set<string>;
  full: boolean;
  firstAt: number;
  timer: NodeJS.Timeout | null;
}

const pending = new Map<string, Pending>(); // config id → pending batch
const feeds = new Map<string, { unsub: (() => void) | null; starting: Promise<void> | null }>(); // vault id → subscription
const inflight = new Set<Promise<unknown>>();

const autoConfigs = (vaultId?: string) => listGitHubConfigs(vaultId).filter((c) => c.autoSync && c.commitStrategy !== "manual");

function schedule(cfgId: string, p: Pending): void {
  if (p.timer) clearTimeout(p.timer);
  const wait = Math.max(0, Math.min(autoOpts.debounceMs(), p.firstAt + autoOpts.maxWaitMs() - Date.now()));
  p.timer = setTimeout(() => void flushGitHubAutoSync(cfgId), wait);
  p.timer.unref?.();
}

function markDirty(cfgId: string, noteId: string | null): void {
  let p = pending.get(cfgId);
  if (!p) pending.set(cfgId, (p = { ids: new Set(), full: false, firstAt: Date.now(), timer: null }));
  if (noteId) p.ids.add(noteId);
  else p.full = true;
  schedule(cfgId, p);
}

/** Route one projection change to the auto-sync configs of its vault. */
export function onTreeChange(vaultId: string, ch: TreeChange): void {
  const cfgs = autoConfigs(vaultId);
  if (!cfgs.length) return;
  for (const c of cfgs) {
    if (ch.kind === "resync") {
      markDirty(c.id, null);
      continue;
    }
    const paths = ch.kind === "upsert" ? [ch.row.path, ch.prev?.path] : [ch.prev.path];
    if (!paths.some((p) => typeof p === "string" && isUnderVaultPath(p, c.vaultPath))) continue;
    // A removed note has nothing to push (files are never deleted, desktop parity).
    if (ch.kind === "upsert" && ch.row.path && isUnderVaultPath(ch.row.path, c.vaultPath)) markDirty(c.id, ch.row.id);
  }
}

/** Push a config's pending batch now (the debounce timer's target; tests call it). */
export async function flushGitHubAutoSync(cfgId: string): Promise<DirectorySyncResult | null> {
  const p = pending.get(cfgId);
  if (!p) return null;
  pending.delete(cfgId);
  if (p.timer) clearTimeout(p.timer);
  const cfg = getGitHubConfig(cfgId);
  if (!cfg || !cfg.autoSync || cfg.commitStrategy === "manual" || !autoOpts.enabled()) return null;
  let ids = [...p.ids];
  if (p.full) {
    // A projection resync hides WHICH notes changed (review M5): find them with a
    // lean listing (no content) — only notes updated since the last sync go out,
    // and nothing at all touches GitHub when there are none.
    try {
      const since = Date.parse(cfg.lastSynced);
      const lean = await vaultFor(cfg.vaultId).listNotes({ pathPrefix: cfg.vaultPath, includeContent: false, includeMetadata: ["title"] });
      for (const n of lean) {
        if (!n.path || !isUnderVaultPath(n.path, cfg.vaultPath)) continue;
        const u = Date.parse(n.updatedAt ?? "");
        if (!Number.isFinite(since) || !Number.isFinite(u) || u > since) ids.push(n.id);
      }
    } catch (e) {
      console.warn(`[github-sync] resync scan for ${target(cfg)} failed: ${(e as Error).message}`);
      return null;
    }
    ids = [...new Set(ids)];
  }
  if (!ids.length) return null;
  const scope: PushScope = { kind: "notes", ids };
  const run = runGitHubPush(cfgId, scope, "auto-sync", "auto-push").catch((e) => {
    console.warn(`[github-sync] auto-push ${target(cfg)} failed: ${e instanceof GitHubApiError || e instanceof SyncInputError ? e.message : (e as Error).message}`);
    return null;
  });
  inflight.add(run);
  void run.finally(() => inflight.delete(run));
  return run;
}

/** (Re)attach the change feed for every vault that has an auto-sync config, and
 *  detach vaults that no longer have one. Called at boot and after config changes. */
export function refreshGitHubAutoSync(): void {
  const want = new Set(autoOpts.enabled() ? autoConfigs().map((c) => c.vaultId) : []);
  for (const [vaultId, f] of feeds) {
    if (!want.has(vaultId)) {
      f.unsub?.();
      feeds.delete(vaultId);
    }
  }
  for (const vaultId of want) {
    if (feeds.has(vaultId)) continue;
    const f: { unsub: (() => void) | null; starting: Promise<void> | null } = { unsub: null, starting: null };
    feeds.set(vaultId, f);
    let entry: VaultEntry;
    try {
      entry = resolveVaultEntry(vaultId);
    } catch {
      feeds.delete(vaultId);
      continue;
    }
    f.starting = feedSubscribe(entry, (ch) => onTreeChange(vaultId, ch))
      .then((unsub) => {
        if (feeds.get(vaultId) === f) f.unsub = unsub;
        else unsub();
      })
      .catch((e) => {
        console.warn(`[github-sync] auto-sync feed for ${vaultId} unavailable: ${(e as Error).message}`);
        feeds.delete(vaultId);
      })
      .finally(() => {
        f.starting = null;
      });
  }
}

/** Test/shutdown helper: drop every subscription and pending batch. */
export async function resetGitHubAutoSync(): Promise<void> {
  for (const [, f] of feeds) {
    await f.starting;
    f.unsub?.();
  }
  feeds.clear();
  for (const [, p] of pending) if (p.timer) clearTimeout(p.timer);
  pending.clear();
  await Promise.all([...inflight]);
}

export const githubAutoSyncState = () => ({
  vaults: [...feeds.keys()],
  pending: [...pending.entries()].map(([id, p]) => ({ id, notes: p.ids.size, full: p.full })),
});
