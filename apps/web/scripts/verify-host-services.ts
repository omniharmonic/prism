/**
 * Behavioral check for the WP4.3 host-services seam (the thin client's
 * replacements for the legacy desktop's host commands):
 *   - createHttpHostServices (packages/core/src/lib/host/services.ts) against a
 *     fake server: exact paths/methods/bodies, the read-only `vault-ro` dispatch
 *     profile, polling to a terminal state, cancel on timeout/abort, error
 *     mapping (push results, pull errors, 403 rethrown);
 *   - vaultOps (packages/core/src/lib/host/vaultOps.ts) against a fake vault:
 *     metadata.sync[] add/remove/status (desktop parity), wikilink extraction +
 *     matching + link creation, queueSkillRun;
 *   - roomsFromThreadNotes (Matrix rooms from message-thread notes);
 *   - the edit/transform prompts carry the read-only rule and fence the content.
 *
 * Run: npm run verify:host -w @prism/web   (no network, no server)
 */
import assert from "node:assert/strict";
import {
  createHttpHostServices,
  HostServiceError,
  hostServiceErrorText,
  buildEditPrompt,
  buildTransformPrompt,
  cleanAgentText,
} from "../../../packages/core/src/lib/host/services.ts";
import {
  addSyncConfig,
  removeSyncConfig,
  syncStatusFromNote,
  extractWikilinks,
  matchWikilink,
  resolveWikilinks,
  queueSkillRun,
  type VaultOpsClient,
} from "../../../packages/core/src/lib/host/vaultOps.ts";
import { roomsFromThreadNotes } from "../../../packages/core/src/lib/matrix/vaultRooms.ts";
import type { Note, NoteTreeEntry, UpdateNoteParams } from "../../../packages/core/src/lib/types.ts";

let passed = 0;
const ok = (m: string) => {
  passed++;
  console.log(`✓ ${m}`);
};

type Call = { path: string; method: string; body: unknown; headers: Record<string, string> };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeServer(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    const c: Call = {
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(c);
    return handler(c);
  };
  return { calls, fetch };
}
const noSleep = async () => {};

// ── createHttpHostServices ────────────────────────────────────────────────────
{
  const s = fakeServer((c) => json(200, { synced: 3, errors: 0, total: 3, from: "2026-10-01", to: "2026-10-31" }));
  const h = createHttpHostServices({ fetch: s.fetch, headers: () => ({ "X-Prism-Vault": "v2" }) });
  const r = await h.calendarSyncRange("2026-10-01", "2026-10-31");
  assert.equal(r.synced, 3);
  assert.equal(s.calls[0]!.method, "POST");
  assert.equal(s.calls[0]!.path, "/api/calendar/sync?from=2026-10-01&to=2026-10-31");
  assert.equal(s.calls[0]!.headers["X-Prism-Vault"], "v2", "active vault header rides along");
  await assert.rejects(h.calendarSyncRange("2026-10-01T00:00", "x"), (e: unknown) => e instanceof HostServiceError && e.code === "bad_request");
  assert.equal(s.calls.length, 1, "a malformed date never reaches the server");
  ok("calendarSyncRange → POST /api/calendar/sync?from&to (+ vault header; bad dates refused locally)");
}
{
  const s = fakeServer((c) =>
    c.path.endsWith("/push")
      ? json(200, { results: [{ adapter: "google-docs", remote_id: "doc1", pushed: true }, { adapter: "notion", error: "no page id — link a Notion page first" }] })
      : json(400, { error: "no_pullable_target" }),
  );
  const h = createHttpHostServices({ fetch: s.fetch });
  const out = await h.notePush("n/1");
  assert.equal(s.calls[0]!.path, "/api/sync/note/n%2F1/push", "note id is path-encoded");
  assert.deepEqual(out, [
    { adapter: "google-docs", status: "pushed", remote_id: "doc1" },
    { adapter: "notion", status: "error", message: "no page id — link a Notion page first" },
  ]);
  const pull = await h.notePull("n1");
  assert.equal(pull.status, "error");
  assert.match(pull.message!, /push the note once/);
  ok("notePush maps per-adapter results; notePull turns a 400 into a readable error outcome");
}
{
  const s = fakeServer(() => json(403, { error: "forbidden" }));
  const h = createHttpHostServices({ fetch: s.fetch });
  await assert.rejects(h.notePull("n1"), (e: unknown) => e instanceof HostServiceError && e.status === 403);
  assert.equal(hostServiceErrorText(new HostServiceError(403, "forbidden")), "Only the server owner can do this.");
  ok("a 403 is thrown (not swallowed) and gets owner-only copy");
}
{
  const s = fakeServer(() => json(200, [{ id: "p1", title: "Roadmap", url: "u", icon: null }]));
  const h = createHttpHostServices({ fetch: s.fetch });
  const pages = await h.notionPages("road map");
  assert.equal(s.calls[0]!.path, "/api/sync/notion/pages?q=road%20map");
  assert.equal(pages[0]!.title, "Roadmap");
  ok("notionPages → GET /api/sync/notion/pages?q=");
}
{
  let polls = 0;
  const s = fakeServer((c) => {
    if (c.path === "/api/agent/dispatch") return json(200, { id: "d1", status: "queued" });
    polls++;
    return json(200, polls < 3 ? { status: "running", output: "" } : { status: "done", output: "```\nShorter text.\n```\n" });
  });
  const h = createHttpHostServices({ fetch: s.fetch, sleep: noSleep });
  const text = await h.agentText("PROMPT", { noteId: "n1" });
  assert.equal(text, "Shorter text.", "fence stripped, trimmed");
  assert.deepEqual(s.calls[0]!.body, { prompt: "PROMPT", noteId: "n1", profile: "vault-ro" }, "always asks for the READ-ONLY profile");
  assert.equal(s.calls[1]!.path, "/api/agent/dispatches/d1");
  assert.equal(polls, 3);
  ok("agentText dispatches with profile vault-ro and polls to done");
}
{
  const s = fakeServer((c) => (c.path === "/api/agent/dispatch" ? json(200, { id: "d2", status: "queued" }) : json(200, { status: "error", error: "boom" })));
  const h = createHttpHostServices({ fetch: s.fetch, sleep: noSleep });
  await assert.rejects(h.agentText("x"), (e: unknown) => e instanceof HostServiceError && e.code === "agent_failed" && e.detail === "boom");
  ok("agentText: a failed run rejects with agent_failed");
}
{
  const s = fakeServer((c) => (c.path === "/api/agent/dispatch" ? json(200, { id: "d3", status: "queued" }) : c.path.endsWith("/cancel") ? json(200, { ok: true }) : json(200, { status: "queued" })));
  const h = createHttpHostServices({ fetch: s.fetch, sleep: noSleep });
  await assert.rejects(h.agentText("x", { timeoutMs: -1 }), (e: unknown) => e instanceof HostServiceError && e.code === "agent_timeout");
  assert.ok(s.calls.some((c) => c.method === "POST" && c.path === "/api/agent/dispatches/d3/cancel"), "the run is cancelled, freeing the slot");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(h.agentText("x", { signal: ac.signal }), (e: unknown) => e instanceof HostServiceError && e.code === "aborted");
  ok("agentText: timeout and abort both cancel the server run");
}
{
  const s = fakeServer(() => json(503, { error: "busy", detail: "queue full" }));
  const h = createHttpHostServices({ fetch: s.fetch });
  await assert.rejects(h.agentText("x"), (e: unknown) => e instanceof HostServiceError && e.status === 503 && e.code === "busy");
  assert.match(hostServiceErrorText(new HostServiceError(503, "busy")), /queue is full/);
  assert.equal(cleanAgentText("  plain  "), "plain");
  ok("agentText: a full queue surfaces as busy");
}

// ── vaultOps ──────────────────────────────────────────────────────────────────
function fakeVault(notes: Note[], tree: NoteTreeEntry[] = []) {
  const updates: Array<{ id: string; params: UpdateNoteParams }> = [];
  const links: Array<{ s: string; t: string; rel: string; meta: unknown }> = [];
  const byId = new Map(notes.map((n) => [n.id, n]));
  const vc: VaultOpsClient = {
    getNote: async (id) => {
      const n = byId.get(id);
      if (!n) throw new Error("404");
      return n;
    },
    updateNote: async (id, params) => {
      updates.push({ id, params });
      const n = { ...byId.get(id)!, metadata: params.metadata ?? byId.get(id)!.metadata, updatedAt: "t2" };
      byId.set(id, n);
      return n;
    },
    listTree: async () => tree,
    createLink: async (s, t, rel, meta) => {
      links.push({ s, t, rel, meta });
      return {};
    },
  };
  return { vc, updates, links };
}
const note = (id: string, over: Partial<Note> = {}): Note =>
  ({ id, path: `vault/${id}`, content: "", tags: [], metadata: {}, createdAt: "t0", updatedAt: "t1", ...over }) as unknown as Note;

{
  const fv = fakeVault([note("n1", { metadata: { title: "x" } })]);
  assert.equal(await addSyncConfig(fv.vc, "n1", "google-docs"), true);
  assert.equal(fv.updates[0]!.params.ifUpdatedAt, "t1", "writes carry the read updatedAt");
  assert.equal((fv.updates[0]!.params.metadata as Record<string, unknown>).title, "x", "other metadata kept");
  assert.equal(await addSyncConfig(fv.vc, "n1", "google-docs"), false, "no duplicate adapter");
  await addSyncConfig(fv.vc, "n1", "notion", { remote_id: "page1", direction: "push" });
  const n1 = await fv.vc.getNote("n1");
  const st = syncStatusFromNote(n1);
  assert.deepEqual(st.map((x) => [x.adapter, x.remote_id, x.state]), [["google-docs", "", "never_synced"], ["notion", "page1", "never_synced"]]);
  await removeSyncConfig(fv.vc, "n1", "notion", "page1");
  assert.deepEqual(syncStatusFromNote(await fv.vc.getNote("n1")).map((x) => x.adapter), ["google-docs"]);
  assert.equal(syncStatusFromNote(note("z", { metadata: { sync: [{ adapter: "notion", remote_id: "p", last_synced: "2026-10-01T00:00:00Z" }, null, { nope: 1 }] } }))[0]!.state, "synced");
  ok("sync config: add (no dup, remote id replaces) / remove / status from last_synced, ignoring junk entries");
}
{
  assert.deepEqual(extractWikilinks("see [[Alpha]] and [[vault/b/Beta|the beta]], again [[Alpha]] and [[ ]]"), ["Alpha", "vault/b/Beta"]);
  const tree = [
    { id: "a", path: "vault/notes/alpha", tags: [], metadata: null },
    { id: "b", path: "vault/b/Beta", tags: [], metadata: null },
  ];
  assert.equal(matchWikilink("ALPHA", tree)?.id, "a", "filename, case-insensitive");
  assert.equal(matchWikilink("b/Beta", tree)?.id, "b", "vault/ prefix stripped");
  assert.equal(matchWikilink("nope", tree), null);
  const fv = fakeVault([note("src", { content: "[[alpha]] [[vault/b/Beta|B]] [[missing]] [[src]]" })], [...tree, { id: "src", path: "vault/src", tags: [], metadata: null }]);
  const r = await resolveWikilinks(fv.vc, "src");
  assert.deepEqual([r.resolved, r.total], [2, 4]);
  assert.deepEqual(fv.links.map((l) => [l.s, l.t, l.rel]), [["src", "a", "references"], ["src", "b", "references"]]);
  assert.deepEqual(fv.links[0]!.meta, { source: "wikilink", original: "alpha" });
  assert.equal(r.links.find((l) => l.wikilink === "src")!.status, "unresolved", "never links a note to itself");
  ok("wikilinks: extract (dedupe, |label), match (path/filename/vault-stripped), resolve → references links");
}
{
  const fv = fakeVault([note("s1", { tags: ["agent-skill"], metadata: { skillName: "triage", lastRun: "2026-10-01T08:00:00Z", enabled: true } }), note("x")]);
  await queueSkillRun(fv.vc, "s1");
  const m = fv.updates[0]!.params.metadata as Record<string, unknown>;
  assert.equal(m.lastRun, "", "lastRun cleared → due on the server's next tick");
  assert.equal(m.skillName, "triage");
  await assert.rejects(queueSkillRun(fv.vc, "x"), /not an agent-skill note/);
  ok("queueSkillRun clears lastRun on agent-skill notes only");
}

// ── Matrix rooms from thread notes ───────────────────────────────────────────
{
  const rooms = roomsFromThreadNotes([
    { path: "vault/messages/telegram/Jane-Doe", tags: ["message-thread"], metadata: { platform: "telegram", matrixRoomId: "!a:hs", participants: ["@me", "@jane"], lastMessageAt: "2026-09-01T00:00:00Z" } },
    { path: "vault/messages/telegram/Group", tags: ["message-thread"], metadata: { platform: "telegram", matrixRoomId: "!b:hs", participants: ["1", "2", "3"], lastMessageAt: "2026-10-01T00:00:00Z" } },
    { path: "vault/messages/x/archive/001", tags: ["message-archive"], metadata: { matrixRoomId: "!c:hs" } },
    { path: "vault/messages/x/dup", tags: ["message-thread"], metadata: { matrixRoomId: "!a:hs" } },
    { path: "vault/messages/x/bad", tags: ["message-thread"], metadata: { matrixRoomId: "not-a-room" } },
  ]);
  assert.deepEqual(rooms.map((r) => [r.room_id, r.name, r.platform, r.is_dm]), [
    ["!b:hs", "Group", "telegram", false],
    ["!a:hs", "Jane Doe", "telegram", true],
  ]);
  ok("roomsFromThreadNotes: threads only (no archives), deduped, newest first, DM by participant count");
}

// ── prompts ──────────────────────────────────────────────────────────────────
{
  const n = { id: "n1", path: "vault/doc", tags: ["document"], content: "Body ".repeat(2000) };
  const e = buildEditPrompt(n, "sel", "make it shorter");
  assert.match(e, /Do NOT create, update or delete any note/);
  assert.match(e, /<<<SELECTION\nsel\nSELECTION>>>/);
  assert.ok(e.length < 4000 + 1200, "the document is capped at 4000 chars like the desktop");
  const t = buildTransformPrompt(n, "presentation");
  assert.match(t, /into a presentation/);
  assert.match(t, /Return ONLY the converted content/);
  ok("edit/transform prompts: read-only rule, fenced data, desktop caps");
}

// ── folder / database sync (Client parity B) ─────────────────────────────────
{
  const s = fakeServer((c) => {
    if (c.path === "/api/sync/github/auth") return json(200, { authenticated: true, configured: true, username: "octo", message: "Authenticated as @octo" });
    if (c.path === "/api/sync/github/configs" && c.method === "POST") return json(200, { id: "g1", config: {}, result: { pushed: ["a.md"] } });
    if (c.path === "/api/sync/github/configs") return json(200, [{ id: "g1", vaultPath: "vault/docs", remoteUrl: "https://github.com/acme/notes", branch: "main", lastSynced: "", autoSync: false }]);
    if (c.path.endsWith("/push-file")) return json(400, { error: "push_refused", detail: "note is not under the sync folder" });
    if (c.path.endsWith("/push")) return json(200, { pushed: ["a.md"], pulled: [], conflicts: [], errors: [], unchanged: 1, commit: "abc" });
    if (c.method === "PATCH") return json(200, { id: "g1", autoSync: true });
    if (c.method === "DELETE") return json(200, { ok: true });
    return json(404, { error: "not_found" });
  });
  const h = createHttpHostServices({ fetch: s.fetch, headers: () => ({ "X-Prism-Vault": "v2" }) });
  const gs = h.githubSync!;
  assert.equal((await gs.checkAuth()).username, "octo");
  const id = await gs.init({ vaultPath: "vault/docs", remoteUrl: "acme/notes", branch: "main", commitStrategy: "batched", conflictStrategy: "local_wins", autoSync: false });
  assert.equal(id, "g1");
  assert.deepEqual(s.calls[1]!.body, { vaultPath: "vault/docs", remoteUrl: "acme/notes", branch: "main", commitStrategy: "batched", conflictStrategy: "local_wins", autoSync: false });
  assert.equal((await gs.push("g1")).commit, "abc");
  assert.equal(s.calls[2]!.path, "/api/sync/github/configs/g1/push");
  await assert.rejects(gs.pushFile("g1", "n9"), (e: unknown) => e instanceof HostServiceError && e.code === "push_refused");
  assert.deepEqual(s.calls[3]!.body, { noteId: "n9" });
  assert.equal((await gs.status())[0]!.vaultPath, "vault/docs");
  await gs.update!("g 1", { autoSync: true });
  assert.equal(s.calls[5]!.path, "/api/sync/github/configs/g%201");
  assert.equal(s.calls[5]!.method, "PATCH");
  await gs.remove("g1");
  assert.equal(s.calls[6]!.method, "DELETE");
  assert.ok(s.calls.every((c) => c.headers["X-Prism-Vault"] === "v2"));
  ok("githubSync → /api/sync/github/{auth,configs,…/push,…/push-file} (+ vault header, error codes mapped)");
}
{
  const s = fakeServer((c) => {
    if (c.path === "/api/sync/notion-db/databases") return json(200, [{ id: "d1", title: "Tasks", propertyCount: 3 }]);
    if (c.path.endsWith("/schema")) return json(200, { properties: [{ name: "Name", propertyType: "title", options: [] }], suggestedMappings: [] });
    if (c.path === "/api/sync/notion-db/configs" && c.method === "POST") return json(200, { id: "n1" });
    if (c.path.endsWith("/sync")) return json(200, { created: 1, updated: 0, deleted: 0, conflicts: 0, unchanged: 0, errors: [] });
    if (c.path === "/api/sync/notion-db/configs") return json(200, []);
    return json(400, { error: "notion_not_configured" });
  });
  const nd = createHttpHostServices({ fetch: s.fetch }).notionDbSync!;
  assert.equal((await nd.listDatabases())[0]!.title, "Tasks");
  await nd.getSchema("d/1");
  assert.equal(s.calls[1]!.path, "/api/sync/notion-db/databases/d%2F1/schema", "ids are path-encoded");
  assert.equal(await nd.init({ databaseId: "d1", databaseName: "Tasks", parachuteTag: "task", parachutePathPrefix: "vault/tasks", propertyMap: [], titleProperty: "Name", syncDirection: "pull", conflictStrategy: "newer-wins", autoSync: false }), "n1");
  assert.equal((await nd.sync("n1")).created, 1);
  assert.deepEqual(await nd.status(), []);
  await assert.rejects(nd.update!("n1", { autoSync: true }), (e: unknown) => e instanceof HostServiceError && hostServiceErrorText(e).includes("no credential"));
  ok("notionDbSync → /api/sync/notion-db/{databases,…/schema,configs,…/sync} (+ not-configured copy)");
}

console.log(`\nverify-host-services: ${passed} checks passed`);
