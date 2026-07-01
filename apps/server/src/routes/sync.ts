/**
 * Server-side sync surface (Phase 3). Mirrors the desktop sync_cmds: push/pull a
 * note to its configured targets (metadata.sync[] with adapter "google-docs" |
 * "notion"), and push/pull a directory to GitHub. Admin-session only; mounted
 * under /api/sync BEFORE the gateway. Credentials come from the secret store.
 * This is what lets the web/mobile app trigger syncs with no desktop running.
 */
import { Hono } from "hono";
import { resolveActor } from "../auth/actor";
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
        if (res.created) { sc.remote_id = res.docId; mutated = true; }
        results.push({ adapter: sc.adapter, remote_id: res.docId, pushed: true });
      } else if (sc.adapter === "notion") {
        const n = cred<{ apiKey: string }>(actor.vaultId, "notion");
        if (!n) { results.push({ adapter: sc.adapter, error: "notion not configured" }); continue; }
        if (!sc.remote_id) { results.push({ adapter: sc.adapter, error: "no page id — link a Notion page first" }); continue; }
        await pushNotionPage(new NotionClient(n.apiKey), sc.remote_id!, note.content);
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

// ── GitHub directory sync ─────────────────────────────────────────────────────
sync.post("/github/:dir", async (c) => {
  const dir = c.req.param("dir"); // "push" | "pull"
  const actor = resolveActor(c);
  const gh = cred<{ token: string }>(actor.vaultId, "github");
  if (!gh) return c.json({ error: "github not configured" }, 400);
  const body = await c.req
    .json<{ owner?: string; repo?: string; branch?: string; vaultPath?: string }>()
    .catch(() => ({}) as { owner?: string; repo?: string; branch?: string; vaultPath?: string });
  if (!body.owner || !body.repo || !body.vaultPath) return c.json({ error: "bad_request", detail: "owner, repo, vaultPath required" }, 400);
  const cfg = { owner: body.owner!, repo: body.repo!, branch: body.branch ?? "main", vaultPath: body.vaultPath!, fileExtension: ".md" };
  const client = new GitHubClient(gh.token);
  try {
    if (dir === "push") return c.json({ pushed: await pushToGitHub(client, vaultClient(actor.vaultId), cfg) });
    if (dir === "pull") return c.json({ pulled: await pullFromGitHub(client, vaultClient(actor.vaultId), cfg) });
    return c.json({ error: "bad_request", detail: "use /github/push or /github/pull" }, 400);
  } catch (e) {
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 502);
  }
});
