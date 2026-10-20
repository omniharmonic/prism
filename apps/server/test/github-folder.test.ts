/**
 * GitHub folder sync routes + service (Client parity B): admin/owner gates,
 * vault scoping, no token in any response, init → initial push, push / push-file,
 * PATCH (re-enable auto-sync), remove, the desktop-config IMPORT mapping, the
 * audit trail, and AUTO-SYNC driven by a fake tree change feed (debounced into
 * one commit; resync → full push; out-of-folder changes ignored).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sync } from "../src/routes/sync";
import { config } from "../src/config";
import { putSecret } from "../src/secrets";
import { setMembership } from "../src/db";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import { createFakeGitHub, type FakeGitHub } from "./fake-github";
import { FakeSyncVault } from "./fake-sync-vault";
import {
  flushGitHubAutoSync,
  githubAutoSyncState,
  refreshGitHubAutoSync,
  resetGitHubAutoSync,
  setGitHubFeedForTests,
  setGitHubFetchForTests,
  setGitHubVaultForTests,
} from "../src/worker/github-folder";
import { getGitHubConfig, insertGitHubConfig, listSyncAudit } from "../src/worker/sync-store";
import type { TreeChange, TreeRow } from "../src/tree";

const J = { "content-type": "application/json" };
const owner = () => sessionCookie(makeSession(config.ownerEmail));
let gh: FakeGitHub;
let vault: FakeSyncVault;
let feedListener: ((c: TreeChange) => void) | null;

beforeEach(async () => {
  resetDb();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  process.env.GITHUB_AUTOSYNC_DEBOUNCE_MS = "40";
  process.env.GITHUB_AUTOSYNC_MAX_WAIT_MS = "1000";
  gh = createFakeGitHub();
  vault = new FakeSyncVault();
  vault.put({ id: "a", path: "vault/docs/alpha", content: "Alpha", metadata: { title: "Alpha" } });
  vault.put({ id: "b", path: "vault/docs/beta", content: "Beta" });
  setGitHubFetchForTests(gh.fetch);
  setGitHubVaultForTests(() => vault);
  feedListener = null;
  setGitHubFeedForTests(async (_entry, l) => {
    feedListener = l;
    return () => {
      if (feedListener === l) feedListener = null;
    };
  });
  putSecret("primary", config.ownerEmail, "github", JSON.stringify({ token: gh.tokenOk }));
});

afterEach(async () => {
  await resetGitHubAutoSync();
  setGitHubFetchForTests(null);
  setGitHubVaultForTests(null);
  setGitHubFeedForTests(null);
});

async function init(body: Record<string, unknown> = {}, cookie = owner()) {
  return sync.request("/github/configs", {
    method: "POST",
    headers: { ...J, cookie },
    body: JSON.stringify({ vaultPath: "vault/docs", remoteUrl: "https://github.com/acme/notes", branch: "main", commitStrategy: "batched", conflictStrategy: "local_wins", autoSync: false, ...body }),
  });
}

const row = (id: string, path: string): TreeRow => ({ id, path, tags: [], updatedAt: new Date().toISOString(), creator: null, visibility: "workspace" });

test("gates: no session / capability / plain member → 403 on every folder + database route", async () => {
  setMembership("primary", "member@x.co", "member", config.ownerEmail);
  const member = sessionCookie(makeSession("member@x.co"));
  const cap = makeCapability("note", "a", "edit");
  const routes: Array<[string, string]> = [
    ["GET", "/github/auth"],
    ["GET", "/github/configs"],
    ["POST", "/github/configs"],
    ["POST", "/github/configs/x/push"],
    ["POST", "/github/configs/x/push-file"],
    ["PATCH", "/github/configs/x"],
    ["DELETE", "/github/configs/x"],
    ["POST", "/github/import"],
    ["GET", "/notion-db/databases"],
    ["GET", "/notion-db/configs"],
    ["POST", "/notion-db/configs"],
    ["POST", "/notion-db/configs/x/sync"],
    ["GET", "/audit"],
  ];
  for (const [method, path] of routes) {
    for (const headers of [{}, { cookie: member }, { authorization: `Capability ${cap}` }] as Array<Record<string, string>>) {
      const r = await sync.request(path, { method, headers: { ...J, ...headers }, body: method === "GET" ? undefined : "{}" });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  }
  assert.equal(gh.calls.length, 0);
});

test("H2: a VAULT ADMIN gets only the status reads; every outbound / token-using route is server-owner only", async () => {
  const { id } = (await (await init()).json()) as { id: string };
  setMembership("primary", "admin@x.co", "admin", config.ownerEmail);
  const admin = sessionCookie(makeSession("admin@x.co"));
  for (const path of ["/github/configs", "/notion-db/configs", "/audit"]) {
    assert.equal((await sync.request(path, { headers: { cookie: admin } })).status, 200, path);
  }
  gh.calls.length = 0;
  const denied: Array<[string, string]> = [
    ["GET", "/github/auth"],
    ["POST", "/github/configs"],
    ["POST", `/github/configs/${id}/push`],
    ["POST", `/github/configs/${id}/push-file`],
    ["PATCH", `/github/configs/${id}`],
    ["DELETE", `/github/configs/${id}`],
    ["POST", "/github/import"],
    ["POST", "/github/push"],
    ["POST", "/github/pull"],
    ["GET", "/notion-db/databases"],
    ["GET", "/notion-db/databases/0123456789abcdef0123456789abcdef/schema"],
    ["POST", "/notion-db/configs"],
    ["POST", "/notion-db/configs/x/sync"],
    ["PATCH", "/notion-db/configs/x"],
    ["DELETE", "/notion-db/configs/x"],
    ["GET", "/github/configs/../auth"],
  ];
  for (const [method, path] of denied) {
    const r = await sync.request(path, { method, headers: { ...J, cookie: admin }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ owner: "acme", repo: "notes", vaultPath: "vault/docs", noteId: "a" }) });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  assert.equal(gh.calls.length, 0, "an admin never reaches GitHub");
  assert.ok(getGitHubConfig(id), "and can't delete the owner's config");
});

test("H1: the stateless /github/push|pull validates owner/repo/branch/vaultPath (no API-path injection) and encodes segments", async () => {
  const bad: Array<Record<string, string>> = [
    { owner: "acme", repo: "secret/collaborators/attacker?x=", vaultPath: "vault/docs" },
    { owner: "acme", repo: "..", vaultPath: "vault/docs" },
    { owner: "../orgs/x", repo: "notes", vaultPath: "vault/docs" },
    { owner: "acme", repo: "notes#frag", vaultPath: "vault/docs" },
    { owner: "acme", repo: "notes", branch: "../../collaborators/x", vaultPath: "vault/docs" },
    { owner: "acme", repo: "notes", vaultPath: "/" },
    { owner: "acme", repo: "notes", vaultPath: "" },
    { owner: "acme", repo: "notes", vaultPath: "vault/../.." },
  ];
  for (const b of bad) {
    for (const dir of ["push", "pull"]) {
      const r = await sync.request(`/github/${dir}`, { method: "POST", headers: { ...J, cookie: owner() }, body: JSON.stringify(b) });
      assert.equal(r.status, 400, `${dir} ${JSON.stringify(b)}`);
    }
  }
  assert.equal(gh.calls.length, 0, "nothing reached GitHub");
});

test("H1: the stateless GitHubClient refuses an injected repo even when called directly, and sends redirect:error", async () => {
  const { GitHubClient } = await import("../src/worker/github");
  const seen: RequestInit[] = [];
  const client = new GitHubClient(gh.tokenOk, (async (u: string, init: RequestInit) => {
    seen.push(init);
    return gh.fetch(u, init);
  }) as unknown as typeof fetch);
  await assert.rejects(client.putFile("acme", "secret/collaborators/attacker?x=", "a.md", "x", "m", "main"), /invalid GitHub owner\/repo/);
  await assert.rejects(client.getFile("acme", "notes", "../x.md", "main"));
  await assert.rejects(client.listTree("acme", "notes", "main/../../x"), /invalid branch/);
  await client.listTree("acme", "notes", "main");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.redirect, "error");
});

test("form CSRF: owner write routes require application/json", async () => {
  const r = await sync.request("/github/configs", { method: "POST", headers: { cookie: owner(), "content-type": "application/x-www-form-urlencoded" }, body: "vaultPath=vault/docs" });
  assert.equal(r.status, 415);
});

test("M1: public repository — auto-sync refused without allowPublic (init, PATCH, and at auto-push time)", async () => {
  gh.isPrivate = false;
  const r = await init({ autoSync: true });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "public_repo");
  const ok = (await (await init({ autoSync: false })).json()) as { id: string; config: { repoPrivate: boolean } };
  assert.equal(ok.config.repoPrivate, false);
  const p = await sync.request(`/github/configs/${ok.id}`, { method: "PATCH", headers: { ...J, cookie: owner() }, body: JSON.stringify({ autoSync: true }) });
  assert.equal(((await p.json()) as { error: string }).error, "public_repo");
  const p2 = await sync.request(`/github/configs/${ok.id}`, { method: "PATCH", headers: { ...J, cookie: owner() }, body: JSON.stringify({ autoSync: true, allowPublic: true }) });
  assert.equal(p2.status, 200);
  // Revoke the opt-in behind the PATCH (stored flag) → the auto-push itself refuses.
  const { updateGitHubConfig } = await import("../src/worker/sync-store");
  updateGitHubConfig(ok.id, { allowPublic: false });
  const before = gh.commitCount("main");
  vault.notes.get("a")!.content = "changed";
  const { runGitHubPush } = await import("../src/worker/github-folder");
  await assert.rejects(runGitHubPush(ok.id, { kind: "all" }, "auto-sync", "auto-push"), /public/);
  assert.equal(gh.commitCount("main"), before);
});

test("M1: configs push only what their creator may see — another user's private note stays home", async () => {
  vault.put({ id: "priv", path: "vault/docs/diary", content: "secret diary", metadata: { prism_visibility: "private", prism_creator: "someone@x.co" } });
  vault.put({ id: "mine", path: "vault/docs/owner-private", content: "owner private", metadata: { prism_visibility: "private", prism_creator: config.ownerEmail } });
  const j = (await (await init()).json()) as { result: { pushed: string[] } };
  assert.ok(j.result.pushed.includes("owner-private.md"));
  assert.ok(!j.result.pushed.includes("diary.md"));
  assert.ok(!JSON.stringify(gh.calls.map((c) => c.body)).includes("secret diary"));
});

test("check-auth: reports the account, never the token; unconfigured → configured:false with no network", async () => {
  const r = await sync.request("/github/auth", { headers: { cookie: owner() } });
  const text = await r.text();
  assert.equal(JSON.parse(text).username, "octo");
  assert.ok(!text.includes(gh.tokenOk));
  resetDb();
  gh.calls.length = 0;
  const r2 = (await (await sync.request("/github/auth", { headers: { cookie: owner() } })).json()) as { configured: boolean; authenticated: boolean };
  assert.deepEqual([r2.configured, r2.authenticated], [false, false]);
  assert.equal(gh.calls.length, 0);
});

test("init: validates, checks push access, creates the config and pushes the folder in one commit", async () => {
  for (const bad of [{ vaultPath: "vault/../x" }, { remoteUrl: "https://evil.example/acme/notes" }, { branch: "../main" }, { commitStrategy: "sometimes" }, { conflictStrategy: "ask" }]) {
    assert.equal((await init(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(gh.calls.length, 0, "validation happens before any network");
  const r = await init();
  assert.equal(r.status, 200);
  const j = (await r.json()) as { id: string; config: Record<string, unknown>; result: { pushed: string[] } };
  assert.deepEqual(j.result.pushed.sort(), ["alpha.md", "beta.md"]);
  assert.equal(j.config.conflictStrategy, "local-wins"); // the desktop UI's underscore spelling is normalized
  assert.equal(j.config.remoteUrl, "https://github.com/acme/notes");
  assert.ok(!JSON.stringify(j).includes(gh.tokenOk));
  // duplicate → 409
  assert.equal((await init()).status, 409);
  const list = (await (await sync.request("/github/configs", { headers: { cookie: owner() } })).json()) as Array<{ id: string; syncedCount: number }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.syncedCount, 2);
  const audit = listSyncAudit("primary", { kind: "github" });
  assert.equal(audit[0]!.action, "init");
  assert.equal(audit[0]!.status, "ok");
  assert.ok(!JSON.stringify(audit).includes("Alpha"), "no note content in the audit");
});

test("init: read-only token or missing repo → 400 and no config is kept", async () => {
  gh.canPush = false;
  const r = await init();
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "repo_read_only");
  const r2 = await init({ remoteUrl: "acme/missing" });
  assert.equal(((await r2.json()) as { error: string }).error, "repo_not_found");
  assert.equal(((await (await sync.request("/github/configs", { headers: { cookie: owner() } })).json()) as unknown[]).length, 0);
});

test("push / push-file / patch / delete; other vault's config is a 404", async () => {
  const { id } = (await (await init()).json()) as { id: string };
  vault.notes.get("a")!.content = "Alpha v2";
  const p = (await (await sync.request(`/github/configs/${id}/push`, { method: "POST", headers: { ...J, cookie: owner() } })).json()) as { pushed: string[]; unchanged: number };
  assert.deepEqual(p.pushed, ["alpha.md"]);
  assert.equal(p.unchanged, 1);
  vault.notes.get("b")!.content = "Beta v2";
  const pf = await sync.request(`/github/configs/${id}/push-file`, { method: "POST", headers: { ...J, cookie: owner() }, body: JSON.stringify({ noteId: "b" }) });
  assert.deepEqual(((await pf.json()) as { pushed: string[] }).pushed, ["beta.md"]);
  vault.put({ id: "o", path: "vault/elsewhere/x", content: "x" });
  const refused = await sync.request(`/github/configs/${id}/push-file`, { method: "POST", headers: { ...J, cookie: owner() }, body: JSON.stringify({ noteId: "o" }) });
  assert.equal(refused.status, 400);
  // A config bound to another vault is invisible from this one.
  const foreign = insertGitHubConfig({ ...getGitHubConfig(id)!, id: undefined, vaultId: "other-vault", branch: "other" });
  assert.equal((await sync.request(`/github/configs/${foreign.id}/push`, { method: "POST", headers: { ...J, cookie: owner() } })).status, 404);
  assert.equal((await sync.request(`/github/configs/${foreign.id}`, { method: "DELETE", headers: { cookie: owner() } })).status, 404);
  const listed = (await (await sync.request("/github/configs", { headers: { cookie: owner() } })).json()) as Array<{ id: string }>;
  assert.ok(!listed.some((x) => x.id === foreign.id));
  const patched = await sync.request(`/github/configs/${id}`, { method: "PATCH", headers: { ...J, cookie: owner() }, body: JSON.stringify({ autoSync: true, conflictStrategy: "remote-wins" }) });
  assert.equal(((await patched.json()) as { autoSync: boolean }).autoSync, true);
  assert.equal(getGitHubConfig(id)!.conflictStrategy, "remote-wins");
  assert.equal((await sync.request(`/github/configs/${id}`, { method: "PATCH", headers: { ...J, cookie: owner() }, body: JSON.stringify({ autoSync: "yes" }) })).status, 400);
  assert.equal((await sync.request(`/github/configs/${id}`, { method: "DELETE", headers: { cookie: owner() } })).status, 200);
  assert.equal(getGitHubConfig(id), null);
  assert.equal((await sync.request(`/github/configs/${id}/push`, { method: "POST", headers: { ...J, cookie: owner() } })).status, 404);
});

test("import: maps the desktop file, keeps id_map, ignores local_clone_path, forces auto-sync OFF, idempotent; owner only", async () => {
  const desktopFile = {
    "11111111-1111-4111-8111-111111111111": {
      id: "11111111-1111-4111-8111-111111111111",
      vault_path: "vault/research/topic",
      remote_url: "https://github.com/acme/topic",
      branch: "main",
      local_clone_path: "/Users/someone/Library/Application Support/prism/sync/github/topic",
      commit_strategy: "per_save",
      conflict_strategy: "local-wins",
      last_synced: "2026-07-10T12:00:00+00:00",
      auto_sync: true,
      file_extension: "md",
      id_map: { "note-1": "people/someone.md" },
    },
    bad: { id: "bad", vault_path: "../../etc", remote_url: "https://github.com/acme/x", branch: "main" },
  };
  setMembership("primary", "admin@x.co", "admin", config.ownerEmail);
  const admin = sessionCookie(makeSession("admin@x.co"));
  assert.equal((await sync.request("/github/import", { method: "POST", headers: { ...J, cookie: admin }, body: JSON.stringify(desktopFile) })).status, 403);
  const r = await sync.request("/github/import", { method: "POST", headers: { ...J, cookie: owner() }, body: JSON.stringify(desktopFile) });
  const j = (await r.json()) as { results: Array<{ status: string; id?: string; desktopAutoSync?: boolean }>; created: number };
  assert.equal(j.created, 1);
  const created = j.results.find((x) => x.status === "created")!;
  assert.equal(created.desktopAutoSync, true);
  assert.equal(j.results.find((x) => x.status === "invalid") !== undefined, true);
  const cfg = getGitHubConfig(created.id!)!;
  assert.equal(cfg.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(cfg.autoSync, false);
  assert.equal(cfg.commitStrategy, "per_save");
  assert.equal(cfg.fileExtension, ".md");
  assert.deepEqual(cfg.idMap, { "note-1": "people/someone.md" });
  assert.equal(cfg.lastSynced, "2026-07-10T12:00:00+00:00");
  assert.ok(!JSON.stringify(cfg).includes("Library"));
  // idempotent
  const again = (await (await sync.request("/github/import", { method: "POST", headers: { ...J, cookie: owner() }, body: JSON.stringify(desktopFile) })).json()) as { created: number; results: Array<{ status: string }> };
  assert.equal(again.created, 0);
  assert.ok(again.results.some((x) => x.status === "exists"));
  assert.equal(gh.calls.length, 0, "import never calls GitHub");
});

test("auto-sync: changes under the folder debounce into ONE commit; outside changes and removes are ignored", async () => {
  const { id } = (await (await init({ autoSync: true })).json()) as { id: string };
  await new Promise((r) => setTimeout(r, 5));
  refreshGitHubAutoSync();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(feedListener, "subscribed to the change feed");
  const commits = gh.commitCount("main");
  vault.notes.get("a")!.content = "Alpha auto 1";
  feedListener!({ kind: "upsert", row: row("a", "vault/docs/alpha"), prev: row("a", "vault/docs/alpha") });
  vault.notes.get("b")!.content = "Beta auto 1";
  feedListener!({ kind: "upsert", row: row("b", "vault/docs/beta"), prev: undefined });
  vault.put({ id: "z", path: "vault/other/z", content: "z" });
  feedListener!({ kind: "upsert", row: row("z", "vault/other/z"), prev: undefined });
  feedListener!({ kind: "remove", id: "b", prev: row("b", "vault/docs/beta") });
  assert.deepEqual(githubAutoSyncState().pending, [{ id, notes: 2, full: false }]);
  await new Promise((r) => setTimeout(r, 80));
  await resetGitHubAutoSync(); // waits for the in-flight push
  assert.equal(gh.commitCount("main"), commits + 1);
  assert.match(gh.file("main", "alpha.md")!, /Alpha auto 1/);
  assert.match(gh.file("main", "beta.md")!, /Beta auto 1/);
  assert.equal(gh.file("main", "z.md"), undefined);
  assert.equal(listSyncAudit("primary", { kind: "github" })[0]!.action, "auto-push");
});

test("auto-sync: a resync schedules a full push; manual strategy and auto_sync=false never auto-push", async () => {
  const { id } = (await (await init({ autoSync: true })).json()) as { id: string };
  refreshGitHubAutoSync();
  await new Promise((r) => setTimeout(r, 5));
  feedListener!({ kind: "resync" });
  assert.deepEqual(githubAutoSyncState().pending, [{ id, notes: 0, full: true }]);
  gh.calls.length = 0;
  const r = await flushGitHubAutoSync(id);
  assert.equal(r, null, "M5: nothing updated since the last sync → no push at all");
  assert.equal(gh.calls.length, 0, "and GitHub is not even contacted");
  // A note updated after the last sync IS pushed on the next resync — only that one.
  const n = vault.notes.get("a")!;
  n.content = "Alpha after resync";
  n.updatedAt = new Date(Date.now() + 60_000).toISOString();
  feedListener!({ kind: "resync" });
  const r2 = await flushGitHubAutoSync(id);
  assert.deepEqual(r2!.pushed, ["alpha.md"]);
  assert.equal(r2!.unchanged, 0);
  // manual: changes are ignored by the listener
  await sync.request(`/github/configs/${id}`, { method: "PATCH", headers: { ...J, cookie: owner() }, body: JSON.stringify({ commitStrategy: "manual" }) });
  feedListener?.({ kind: "upsert", row: row("a", "vault/docs/alpha"), prev: undefined });
  assert.deepEqual(githubAutoSyncState().pending, []);
  assert.deepEqual(githubAutoSyncState().vaults, [], "no auto config left → feed detached");
});

test("kill switch: GITHUB_AUTOSYNC_ENABLED=false attaches no feed", async () => {
  await init({ autoSync: true });
  await resetGitHubAutoSync();
  process.env.GITHUB_AUTOSYNC_ENABLED = "false";
  try {
    refreshGitHubAutoSync();
    assert.deepEqual(githubAutoSyncState().vaults, []);
  } finally {
    delete process.env.GITHUB_AUTOSYNC_ENABLED;
  }
});
