/**
 * Server-side sync surface (Phase 3). Mirrors the desktop sync_cmds: push/pull a
 * note to its configured targets (metadata.sync[] with adapter "google-docs" |
 * "notion"), and push/pull a directory to GitHub. Admin-session only; mounted
 * under /api/sync BEFORE the gateway. Credentials come from the secret store.
 * This is what lets the web/mobile app trigger syncs with no desktop running.
 * Client parity B adds the STORED folder/database syncs (/github/configs*,
 * /github/import, /notion-db/*, /audit) — see docs/sync.md.
 */
import { Hono, type Context } from "hono";
import { resolveActor } from "../auth/actor";
import { GitHubApiError, normalizeVaultPath, parseRemote, validBranch } from "../worker/github-dir";
import { viewableBy } from "../worker/sync-visibility";
import {
  githubClient,
  githubConfigView,
  importDesktopGitHubConfigs,
  initGitHubSync,
  assertAutoSyncAllowed,
  normCommitStrategy,
  normGhConflict,
  refreshGitHubAutoSync,
  runGitHubPush,
  type GitHubConfigInput,
} from "../worker/github-folder";
import { NotionDbApiError, normDirection, normNotionConflict } from "../worker/notion-db";
import {
  initNotionDbSync,
  notionDbClient,
  notionDbConfigView,
  notionDbSchema,
  runNotionDbConfig,
  type NotionDbInitInput,
} from "../worker/notion-db-service";
import {
  SyncInputError,
  auditSync,
  deleteGitHubConfig,
  deleteNotionDbConfig,
  getGitHubConfig,
  getNotionDbConfig,
  listGitHubConfigs,
  listNotionDbConfigs,
  listSyncAudit,
  updateGitHubConfig,
  updateNotionDbConfig,
} from "../worker/sync-store";
import { roleAtLeast } from "../roles";
import { config } from "../config";
import { vaultClient } from "../parachute";
import { getSecret } from "../secrets";
import { GoogleDocsClient, pushNoteToGoogleDoc, pullGoogleDoc } from "../worker/googledocs";
import { NotionClient, pushNotionPage, pullNotionPage } from "../worker/notion";
import { GitHubClient, pushToGitHub, pullFromGitHub } from "../worker/github";

export const sync = new Hono();

sync.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || !roleAtLeast(actor.role, "admin")) return c.json({ error: "forbidden" }, 403);
  await next();
});

function cred<T>(vaultId: string, kind: string): T | null {
  const raw = getSecret(vaultId, config.ownerEmail, kind);
  return raw ? (JSON.parse(raw) as T) : null;
}

interface NoteSyncConfig {
  adapter: string;
  remote_id?: string;
  direction?: string;
  last_synced?: string;
}

// ── per-note push (vault → external) ──────────────────────────────────────────
sync.post("/note/:id/push", async (c) => {
  const actor = resolveActor(c);
  const vc = vaultClient(actor.vaultId);
  let note;
  try {
    note = await vc.getNote(c.req.param("id"));
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
  const configs = ((note.metadata?.sync as NoteSyncConfig[]) ?? []).filter(Boolean);
  if (!configs.length) return c.json({ error: "no_sync_config", detail: "note has no metadata.sync[]" }, 400);

  const results: Array<Record<string, unknown>> = [];
  let mutated = false;
  for (const sc of configs) {
    try {
      if (sc.adapter === "google-docs") {
        const g = cred<{ account: string }>(actor.vaultId, "google");
        if (!g) { results.push({ adapter: sc.adapter, error: "google not configured" }); continue; }
        const res = await pushNoteToGoogleDoc(new GoogleDocsClient(g.account), note, sc.remote_id || undefined);
        if (res.created) sc.remote_id = res.docId;
        sc.last_synced = new Date().toISOString(); // what sync_status reads (desktop parity)
        mutated = true;
        results.push({ adapter: sc.adapter, remote_id: res.docId, pushed: true });
      } else if (sc.adapter === "notion") {
        const n = cred<{ apiKey: string }>(actor.vaultId, "notion");
        if (!n) { results.push({ adapter: sc.adapter, error: "notion not configured" }); continue; }
        if (!sc.remote_id) { results.push({ adapter: sc.adapter, error: "no page id — link a Notion page first" }); continue; }
        await pushNotionPage(new NotionClient(n.apiKey), sc.remote_id!, note.content);
        sc.last_synced = new Date().toISOString();
        mutated = true;
        results.push({ adapter: sc.adapter, remote_id: sc.remote_id, pushed: true });
      } else {
        results.push({ adapter: sc.adapter, error: "unsupported adapter" });
      }
    } catch (e) {
      results.push({ adapter: sc.adapter, error: (e as Error).message });
    }
  }
  if (mutated) await vc.updateNote(note.id, { metadata: { ...note.metadata, sync: configs } });
  return c.json({ results });
});

// ── per-note pull (external → vault) ──────────────────────────────────────────
sync.post("/note/:id/pull", async (c) => {
  const actor = resolveActor(c);
  const vc = vaultClient(actor.vaultId);
  let note;
  try {
    note = await vc.getNote(c.req.param("id"));
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
  const configs = ((note.metadata?.sync as NoteSyncConfig[]) ?? []).filter((s) => s?.remote_id);
  for (const sc of configs) {
    try {
      let content: string | null = null;
      const remoteId = sc.remote_id!;
      if (sc.adapter === "google-docs") {
        const g = cred<{ account: string }>(actor.vaultId, "google");
        if (g) content = await pullGoogleDoc(new GoogleDocsClient(g.account), remoteId);
      } else if (sc.adapter === "notion") {
        const n = cred<{ apiKey: string }>(actor.vaultId, "notion");
        if (n) content = await pullNotionPage(new NotionClient(n.apiKey), remoteId);
      }
      if (content != null) {
        await vc.updateNote(note.id, { content });
        return c.json({ ok: true, adapter: sc.adapter, pulled: true });
      }
    } catch (e) {
      return c.json({ error: "pull_failed", adapter: sc.adapter, detail: (e as Error).message }, 502);
    }
  }
  return c.json({ error: "no_pullable_target" }, 400);
});

// ── Notion page picker (WP4.3: replaces the desktop `notion_list_pages`) ──────
// Read-only: lists pages the stored integration can see, so the web/client
// "Sync to Notion" flow can bind a note to a page (metadata.sync[]).
sync.get("/notion/pages", async (c) => {
  const actor = resolveActor(c);
  const n = cred<{ apiKey: string }>(actor.vaultId, "notion");
  if (!n) return c.json({ error: "notion_not_configured", detail: "store a Notion integration token in Network → Server" }, 400);
  const q = (c.req.query("q") ?? "").slice(0, 200);
  try {
    return c.json(await new NotionClient(n.apiKey).searchPages(q));
  } catch {
    // Never echo the upstream body (it can quote the request).
    return c.json({ error: "notion_search_failed" }, 502);
  }
});

// ── Stored folder / database syncs (Client parity B) ──────────────────────────
// The desktop's GitHub folder sync and Notion DATABASE sync, now server-side with
// stored configs (worker/sync-store.ts), scoped to the actor's active vault: a
// config of another vault is a 404. No route ever returns a token; outbound
// targets are api.github.com / api.notion.com only.
//
// SERVER-OWNER ONLY (security review H2): every one of these routes either
// writes outward AS the owner (the stored github/notion token reaches whatever
// the owner can reach), reveals what that token sees (/github/auth login, the
// Notion database list/schema), or creates a config that will. A vault admin
// keeps exactly the READ of status: GET /github/configs, GET /notion-db/configs,
// GET /audit. The stateless /github/push|pull (H1) is owner-only too.
const ADMIN_READABLE = new Set(["/github/configs", "/notion-db/configs", "/audit"]);
const isServerOwner = (c: Context) => {
  const a = resolveActor(c);
  return a.kind === "user" && a.email === config.ownerEmail;
};
sync.use("*", async (c, next) => {
  // Allow-list, not deny-list: only the pre-existing per-note routes and the
  // status reads stay admin; ANY other path (incl. odd spellings) needs the owner.
  const sub = new URL(c.req.url).pathname.replace(/^\/api\/sync(?=\/)/, "");
  if (/^\/note\/[^/]+\/(push|pull)$/.test(sub) || (c.req.method === "GET" && sub === "/notion/pages")) return next();
  if (c.req.method === "GET" && ADMIN_READABLE.has(sub)) return next();
  if (!isServerOwner(c)) return c.json({ error: "forbidden", detail: "only the server owner may do this" }, 403);
  // Form-CSRF (review Low): a cross-site <form> can't send application/json.
  if ((c.req.method === "POST" || c.req.method === "PATCH") && !(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "unsupported_media_type", detail: "Content-Type: application/json required" }, 415);
  }
  return next();
});

function syncError(c: Context, e: unknown) {
  if (e instanceof SyncInputError) return c.json({ error: e.code, detail: e.message }, e.status as 400);
  if (e instanceof GitHubApiError) return c.json({ error: "github_failed", detail: e.message }, 502);
  if (e instanceof NotionDbApiError) return c.json({ error: "notion_failed", detail: e.message }, 502);
  console.warn("[sync] failed:", (e as Error).message);
  return c.json({ error: "sync_failed" }, 502);
}

const MAX_BODY = 1_000_000;
async function body<T>(c: Context): Promise<T | null> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_BODY) return null;
  const text = await c.req.text().catch(() => "");
  if (text.length > MAX_BODY) return null;
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return null;
  }
}

const actorEmail = (c: Context) => {
  const a = resolveActor(c);
  return a.kind === "user" ? a.email : "unknown";
};

function ownGitHubConfig(c: Context) {
  const cfg = getGitHubConfig(c.req.param("id") ?? "");
  return cfg && cfg.vaultId === resolveActor(c).vaultId ? cfg : null;
}
function ownNotionDbConfig(c: Context) {
  const cfg = getNotionDbConfig(c.req.param("id") ?? "");
  return cfg && cfg.vaultId === resolveActor(c).vaultId ? cfg : null;
}

// GitHub: does the server hold a working token? (desktop github_check_auth)
sync.get("/github/auth", async (c) => {
  const gh = githubClient(resolveActor(c).vaultId);
  if (!gh) return c.json({ authenticated: false, configured: false, username: null, message: "No GitHub token is stored on the server (Network → Server → Sync integrations)." });
  try {
    const u = await gh.user();
    if ("login" in u) return c.json({ authenticated: true, configured: true, username: u.login, message: `Authenticated as @${u.login}` });
    return c.json({ authenticated: false, configured: true, username: null, message: `GitHub rejected the stored token (${u.status}).` });
  } catch {
    return c.json({ authenticated: false, configured: true, username: null, message: "Could not reach GitHub." });
  }
});

sync.get("/github/configs", (c) => c.json(listGitHubConfigs(resolveActor(c).vaultId).map(githubConfigView)));

sync.post("/github/configs", async (c) => {
  const b = await body<GitHubConfigInput>(c);
  if (!b) return c.json({ error: "bad_request", detail: "JSON body required" }, 400);
  try {
    const { config: cfg, result } = await initGitHubSync(resolveActor(c).vaultId, actorEmail(c), b);
    return c.json({ id: cfg.id, config: githubConfigView(cfg), result });
  } catch (e) {
    return syncError(c, e);
  }
});

sync.post("/github/configs/:id/push", async (c) => {
  const cfg = ownGitHubConfig(c);
  if (!cfg) return c.json({ error: "not_found" }, 404);
  try {
    return c.json(await runGitHubPush(cfg.id, { kind: "all" }, actorEmail(c), "push"));
  } catch (e) {
    return syncError(c, e);
  }
});

sync.post("/github/configs/:id/push-file", async (c) => {
  const cfg = ownGitHubConfig(c);
  if (!cfg) return c.json({ error: "not_found" }, 404);
  const b = await body<{ noteId?: unknown }>(c);
  if (!b || typeof b.noteId !== "string" || !b.noteId || b.noteId.length > 200) return c.json({ error: "bad_request", detail: "noteId required" }, 400);
  try {
    const r = await runGitHubPush(cfg.id, { kind: "notes", ids: [b.noteId], single: true }, actorEmail(c), "push-file");
    if (r.errors.length && !r.pushed.length && !r.unchanged) return c.json({ error: "push_refused", detail: r.errors[0]![1], result: r }, 400);
    return c.json(r);
  } catch (e) {
    return syncError(c, e);
  }
});

sync.patch("/github/configs/:id", async (c) => {
  const cfg = ownGitHubConfig(c);
  if (!cfg) return c.json({ error: "not_found" }, 404);
  const b = await body<{ autoSync?: unknown; allowPublic?: unknown; commitStrategy?: unknown; conflictStrategy?: unknown }>(c);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const patch: Parameters<typeof updateGitHubConfig>[1] = {};
  if (b.allowPublic !== undefined) {
    if (typeof b.allowPublic !== "boolean") return c.json({ error: "bad_request", detail: "allowPublic must be a boolean" }, 400);
    patch.allowPublic = b.allowPublic;
  }
  if (b.autoSync !== undefined) {
    if (typeof b.autoSync !== "boolean") return c.json({ error: "bad_request", detail: "autoSync must be a boolean" }, 400);
    patch.autoSync = b.autoSync;
  }
  // Turning auto-sync on (or keeping it on while revoking allowPublic) re-checks
  // the repository's visibility: a PUBLIC repo needs allowPublic (review M1).
  const willAuto = patch.autoSync ?? cfg.autoSync;
  if (willAuto && (patch.autoSync === true || patch.allowPublic === false)) {
    try {
      await assertAutoSyncAllowed(cfg, patch.allowPublic ?? cfg.allowPublic);
    } catch (e) {
      return syncError(c, e);
    }
  }
  if (b.commitStrategy !== undefined) {
    const v = normCommitStrategy(b.commitStrategy);
    if (!v) return c.json({ error: "bad_request", detail: "commitStrategy must be per_save, batched or manual" }, 400);
    patch.commitStrategy = v;
  }
  if (b.conflictStrategy !== undefined) {
    const v = normGhConflict(b.conflictStrategy);
    if (!v) return c.json({ error: "bad_request", detail: "conflictStrategy must be local-wins or remote-wins" }, 400);
    patch.conflictStrategy = v;
  }
  updateGitHubConfig(cfg.id, patch);
  auditSync({ actor: actorEmail(c), vaultId: cfg.vaultId, kind: "github", configId: cfg.id, action: "update", target: `${cfg.owner}/${cfg.repo}@${cfg.branch}`, status: "ok", detail: { ...patch } });
  refreshGitHubAutoSync();
  return c.json(githubConfigView(getGitHubConfig(cfg.id)!));
});

sync.delete("/github/configs/:id", (c) => {
  const cfg = ownGitHubConfig(c);
  if (!cfg) return c.json({ error: "not_found" }, 404);
  deleteGitHubConfig(cfg.id);
  auditSync({ actor: actorEmail(c), vaultId: cfg.vaultId, kind: "github", configId: cfg.id, action: "remove", target: `${cfg.owner}/${cfg.repo}@${cfg.branch}`, status: "ok" });
  refreshGitHubAutoSync();
  return c.json({ ok: true });
});

// Import the desktop's github-sync-configs.json (SERVER OWNER only). Body: the
// file's JSON as-is, or {configs: <that>, enableAutoSync?: boolean}. No network.
sync.post("/github/import", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner") return c.json({ error: "forbidden", detail: "server owner only" }, 403);
  const b = await body<Record<string, unknown>>(c);
  if (!b || typeof b !== "object") return c.json({ error: "bad_request", detail: "JSON body required (≤1 MB)" }, 400);
  const wrapped = !Array.isArray(b) && "configs" in b;
  const payload = wrapped ? b.configs : b;
  const enable = wrapped && b.enableAutoSync === true;
  try {
    const results = importDesktopGitHubConfigs(actor.vaultId, actor.email, payload, enable);
    return c.json({ results, created: results.filter((r) => r.status === "created").length });
  } catch (e) {
    return syncError(c, e);
  }
});

// ── Notion database sync ──────────────────────────────────────────────────────
sync.get("/notion-db/databases", async (c) => {
  const client = notionDbClient(resolveActor(c).vaultId);
  if (!client) return c.json({ error: "notion_not_configured", detail: "store a Notion integration token in Network → Server" }, 400);
  try {
    return c.json(await client.listDatabases());
  } catch (e) {
    return syncError(c, e);
  }
});

sync.get("/notion-db/databases/:id/schema", async (c) => {
  try {
    return c.json(await notionDbSchema(resolveActor(c).vaultId, c.req.param("id")));
  } catch (e) {
    return syncError(c, e);
  }
});

sync.get("/notion-db/configs", (c) => c.json(listNotionDbConfigs(resolveActor(c).vaultId).map(notionDbConfigView)));

sync.post("/notion-db/configs", async (c) => {
  const b = await body<NotionDbInitInput>(c);
  if (!b) return c.json({ error: "bad_request", detail: "JSON body required" }, 400);
  try {
    const cfg = initNotionDbSync(resolveActor(c).vaultId, actorEmail(c), b);
    return c.json({ id: cfg.id, config: notionDbConfigView(cfg) });
  } catch (e) {
    return syncError(c, e);
  }
});

sync.post("/notion-db/configs/:id/sync", async (c) => {
  const cfg = ownNotionDbConfig(c);
  if (!cfg) return c.json({ error: "not_found" }, 404);
  try {
    return c.json(await runNotionDbConfig(cfg.id, actorEmail(c), "sync"));
  } catch (e) {
    return syncError(c, e);
  }
});

sync.patch("/notion-db/configs/:id", async (c) => {
  const cfg = ownNotionDbConfig(c);
  if (!cfg) return c.json({ error: "not_found" }, 404);
  const b = await body<{ autoSync?: unknown; conflictStrategy?: unknown; syncDirection?: unknown }>(c);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const patch: Parameters<typeof updateNotionDbConfig>[1] = {};
  if (b.autoSync !== undefined) {
    if (typeof b.autoSync !== "boolean") return c.json({ error: "bad_request", detail: "autoSync must be a boolean" }, 400);
    patch.autoSync = b.autoSync;
  }
  if (b.conflictStrategy !== undefined) {
    const v = normNotionConflict(b.conflictStrategy);
    if (!v) return c.json({ error: "bad_request", detail: "conflictStrategy must be notion-wins, parachute-wins or newer-wins" }, 400);
    patch.conflictStrategy = v;
  }
  if (b.syncDirection !== undefined) {
    const v = normDirection(b.syncDirection);
    if (!v) return c.json({ error: "bad_request", detail: "syncDirection must be bidirectional, pull or push" }, 400);
    patch.syncDirection = v;
  }
  updateNotionDbConfig(cfg.id, patch);
  auditSync({ actor: actorEmail(c), vaultId: cfg.vaultId, kind: "notion-db", configId: cfg.id, action: "update", target: cfg.databaseId, status: "ok", detail: { ...patch } });
  return c.json(notionDbConfigView(getNotionDbConfig(cfg.id)!));
});

sync.delete("/notion-db/configs/:id", (c) => {
  const cfg = ownNotionDbConfig(c);
  if (!cfg) return c.json({ error: "not_found" }, 404);
  deleteNotionDbConfig(cfg.id);
  auditSync({ actor: actorEmail(c), vaultId: cfg.vaultId, kind: "notion-db", configId: cfg.id, action: "remove", target: cfg.databaseId, status: "ok" });
  return c.json({ ok: true });
});

// The audit trail of the active vault's folder/database syncs (newest first).
sync.get("/audit", (c) => {
  const kind = c.req.query("kind");
  return c.json(
    listSyncAudit(resolveActor(c).vaultId, {
      kind: kind === "github" || kind === "notion-db" ? kind : undefined,
      configId: c.req.query("config") ?? undefined,
      limit: Number(c.req.query("limit") ?? 50) || 50,
    }),
  );
});

// ── GitHub directory sync (stateless, Phase 3) ────────────────────────────────
sync.post("/github/:dir", async (c) => {
  const dir = c.req.param("dir"); // "push" | "pull"
  const actor = resolveActor(c);
  const gh = cred<{ token: string }>(actor.vaultId, "github");
  if (!gh) return c.json({ error: "github not configured" }, 400);
  const body = await c.req
    .json<{ owner?: string; repo?: string; branch?: string; vaultPath?: string }>()
    .catch(() => ({}) as { owner?: string; repo?: string; branch?: string; vaultPath?: string });
  if (!body.owner || !body.repo || !body.vaultPath) return c.json({ error: "bad_request", detail: "owner, repo, vaultPath required" }, 400);
  // Security review H1: these strings become GitHub API URL segments and the
  // sync scope — validate them all (the client re-validates + encodes too).
  const remote = typeof body.owner === "string" && typeof body.repo === "string" ? parseRemote(`${body.owner}/${body.repo}`) : null;
  if (!remote || remote.owner !== body.owner || remote.repo !== body.repo) return c.json({ error: "bad_request", detail: "invalid owner/repo" }, 400);
  const branch = typeof body.branch === "string" ? body.branch : "main";
  if (!validBranch(branch)) return c.json({ error: "bad_request", detail: "invalid branch" }, 400);
  const vaultPath = typeof body.vaultPath === "string" ? normalizeVaultPath(body.vaultPath) : null;
  if (!vaultPath || vaultPath === "/" || vaultPath.startsWith("/")) return c.json({ error: "bad_request", detail: "vaultPath must be a folder (not the whole vault)" }, 400);
  const cfg = { owner: remote.owner, repo: remote.repo, branch, vaultPath, fileExtension: ".md" };
  const client = new GitHubClient(gh.token);
  try {
    if (dir === "push") return c.json({ pushed: await pushToGitHub(client, vaultClient(actor.vaultId), cfg, viewableBy(actor.kind === "user" ? actor.email : "", actor.vaultId)) });
    if (dir === "pull") return c.json({ pulled: await pullFromGitHub(client, vaultClient(actor.vaultId), cfg) });
    return c.json({ error: "bad_request", detail: "use /github/push or /github/pull" }, 400);
  } catch (e) {
    return syncError(c, e);
  }
});
