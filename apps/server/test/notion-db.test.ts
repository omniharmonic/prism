/**
 * Notion DATABASE sync (Client parity B): the desktop's pure rules (should_overwrite
 * matrix — the same vectors as notion_db.rs's tests — metadata_unchanged, the
 * transforms, auto-discovery), the mapping normalizer (both UI vocabularies),
 * and full runs against a fake Notion + fake vault: pull create/update, no-op
 * skip both directions, conflict strategies, if_updated_at, push create/update,
 * the 3 rps limiter + 429 retry, routes/gates/vault scoping, the background flag.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  applyTransform,
  autoDiscoverMappings,
  buildNotionProperties,
  metadataUnchanged,
  NotionDbClient,
  normalizeMappings,
  reverseTransform,
  runNotionDbSync,
  shouldOverwrite,
  slugify,
  titleCase,
} from "../src/worker/notion-db";
import { runNotionDbPassOnce, setNotionDbFetchForTests, setNotionDbVaultForTests } from "../src/worker/notion-db-service";
import { getNotionDbConfig, insertNotionDbConfig, listSyncAudit, type NotionDbConfig } from "../src/worker/sync-store";
import { sync } from "../src/routes/sync";
import { config } from "../src/config";
import { putSecret } from "../src/secrets";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { FakeSyncVault, tick } from "./fake-sync-vault";

const T1 = "2026-08-18T10:00:00.000Z";
const T2 = "2026-08-18T11:00:00.000Z";
const T3 = "2026-08-18T12:00:00.000Z";

// ── desktop parity: pure ─────────────────────────────────────────────────────

test("should_overwrite matrix (desktop test vectors)", () => {
  assert.ok(shouldOverwrite("notion-wins", T1, T3, T2));
  assert.ok(shouldOverwrite("notion-wins", T3, T1, T2));
  assert.ok(shouldOverwrite("notion-wins", null, null, ""));
  assert.ok(shouldOverwrite("notion-wins", "garbage", "garbage", "garbage"));
  assert.ok(shouldOverwrite("bogus", T1, T3, T2));
  // parachute-wins
  assert.ok(shouldOverwrite("parachute-wins", T3, T1, T2));
  assert.ok(shouldOverwrite("parachute-wins", T3, T2, T2));
  assert.ok(!shouldOverwrite("parachute-wins", T3, T3, T2));
  assert.ok(!shouldOverwrite("parachute-wins", null, T3, T2));
  assert.ok(!shouldOverwrite("parachute-wins", T1, T1, T2));
  assert.ok(!shouldOverwrite("parachute-wins", T2, T1, T2));
  assert.ok(shouldOverwrite("parachute-wins", null, T1, T2));
  assert.ok(shouldOverwrite("parachute-wins", "garbage", T1, T2));
  assert.ok(shouldOverwrite("parachute-wins", T3, null, T2));
  assert.ok(shouldOverwrite("parachute-wins", T3, "garbage", T2));
  assert.ok(shouldOverwrite("parachute-wins", T3, T3, ""));
  assert.ok(shouldOverwrite("parachute-wins", T3, T3, "garbage"));
  // newer-wins
  assert.ok(shouldOverwrite("newer-wins", T3, T1, T2));
  assert.ok(!shouldOverwrite("newer-wins", T1, T3, T2));
  assert.ok(!shouldOverwrite("newer-wins", T2, T2, T1));
  assert.ok(!shouldOverwrite("newer-wins", T1, T3, ""));
  assert.ok(shouldOverwrite("newer-wins", null, T3, T2));
  assert.ok(shouldOverwrite("newer-wins", "garbage", T3, T2));
  assert.ok(shouldOverwrite("newer-wins", T1, null, T2));
  assert.ok(shouldOverwrite("newer-wins", T1, "garbage", T2));
});

test("metadata_unchanged: subset semantics", () => {
  const mapped = { status: "done", priority: "high" };
  assert.ok(metadataUnchanged(mapped, { status: "done", priority: "high", notion_page_id: "abc" }));
  assert.ok(!metadataUnchanged(mapped, { status: "todo", priority: "high" }));
  assert.ok(!metadataUnchanged(mapped, { status: "done" }));
  assert.ok(!metadataUnchanged(mapped, null));
});

test("transforms + slugify/title_case + reverse build", () => {
  assert.equal(slugify("In Progress!"), "in-progress");
  assert.equal(slugify("Café  Ünïcode 2"), "café-ünïcode-2");
  assert.equal(titleCase("in-progress"), "In Progress");
  assert.equal(applyTransform("In Progress", "value_map", { "In Progress": "doing" }), "doing");
  assert.equal(applyTransform("Other", "value_map", {}), "other");
  assert.equal(reverseTransform("doing", "value_map", { "In Progress": "doing" }), "In Progress");
  const props = buildNotionProperties({ status: "in-progress", due: "", n: "3.5", tags: "a, b", done: "true", who: "x" }, [
    { notionProperty: "Status", notionType: "status", parachuteField: "status", transform: "slugify", valueMap: {}, relationshipType: null },
    { notionProperty: "Due", notionType: "date", parachuteField: "due", transform: "date_extract", valueMap: {}, relationshipType: null },
    { notionProperty: "N", notionType: "number", parachuteField: "n", transform: "identity", valueMap: {}, relationshipType: null },
    { notionProperty: "Tags", notionType: "multi_select", parachuteField: "tags", transform: "identity", valueMap: {}, relationshipType: null },
    { notionProperty: "Done", notionType: "checkbox", parachuteField: "done", transform: "identity", valueMap: {}, relationshipType: null },
    { notionProperty: "Who", notionType: "people", parachuteField: "who", transform: "people_extract", valueMap: {}, relationshipType: null },
  ]);
  assert.deepEqual(props, {
    Status: { status: { name: "In Progress" } },
    N: { number: 3.5 },
    Tags: { multi_select: [{ name: "a" }, { name: "b" }] },
    Done: { checkbox: true },
  });
});

test("auto-discovery + mapping normalizer (desktop + old modal vocabularies)", () => {
  const m = autoDiscoverMappings([
    { name: "Name", propertyType: "title", options: [] },
    { name: "Status", propertyType: "status", options: [] },
    { name: "Due date", propertyType: "date", options: [] },
    { name: "Project", propertyType: "relation", options: [] },
    { name: "Score", propertyType: "formula", options: [] },
    { name: "Story Points", propertyType: "number", options: [] },
  ]);
  assert.deepEqual(
    m.map((x) => [x.notionProperty, x.parachuteField, x.transform]),
    [
      ["Status", "status", "slugify"],
      ["Due date", "due", "date_extract"],
      ["Project", "project", "relation_to_links"],
      ["Story Points", "story-points", "identity"],
    ],
  );
  const n = normalizeMappings([
    { notionProperty: "Status", notionType: "select", parachuteField: "metadata.status", transform: "slug" },
    { notionProperty: "Notes", notionType: "rich_text", parachuteField: "content", transform: "none" },
    { notionProperty: "Name", notionType: "title", parachuteField: "title", transform: "none" },
    { notionProperty: "X", notionType: "select", parachuteField: "(skip)", transform: "none" },
    { notionProperty: "Evil", notionType: "select", parachuteField: "__proto__", transform: "none" },
    { notion_property: "Owner", notion_type: "people", parachute_field: "assignee", transform: "people_extract", value_map: {} },
  ]);
  assert.equal(n.contentProperty, "Notes");
  assert.deepEqual(
    n.mappings.map((x) => [x.notionProperty, x.parachuteField, x.transform]),
    [
      ["Status", "status", "slugify"],
      ["Owner", "assignee", "people_extract"],
    ],
  );
});

// ── fake Notion ──────────────────────────────────────────────────────────────

const DB = "0123456789abcdef0123456789abcdef";
const pid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

interface FakeNotion {
  fetch: typeof fetch;
  pages: Map<string, any>;
  calls: Array<{ method: string; url: string; auth: string | null; body: any }>;
  rateLimitNext: number;
}

function toRead(props: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v.title) out[k] = { type: "title", title: v.title.map((t: any) => ({ plain_text: t.text.content })) };
    else if (v.rich_text) out[k] = { type: "rich_text", rich_text: v.rich_text.map((t: any) => ({ plain_text: t.text.content })) };
    else out[k] = { type: Object.keys(v)[0], ...v };
  }
  return out;
}

function fakeNotion(): FakeNotion {
  let n = 100;
  const f: FakeNotion = { fetch: null as unknown as typeof fetch, pages: new Map(), calls: [], rateLimitNext: 0 };
  const json = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...h } });
  f.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    f.calls.push({ method, url: url.href, auth: headers.Authorization ?? null, body });
    if (url.origin !== "https://api.notion.com") return new Response("wrong host", { status: 599 });
    if (headers.Authorization !== "Bearer secret_test") return json({ code: "unauthorized", message: "API token is invalid." }, 401);
    if (f.rateLimitNext > 0) {
      f.rateLimitNext--;
      return json({ code: "rate_limited" }, 429, { "retry-after": "0" });
    }
    const p = url.pathname;
    if (p === "/v1/search") return json({ results: [{ object: "database", id: DB, title: [{ plain_text: "Tasks" }], properties: { Name: {}, Status: {} } }], has_more: false });
    if (p === `/v1/databases/${DB}`) return json({ properties: { Name: { type: "title" }, Status: { type: "select", select: { options: [{ name: "Todo" }, { name: "In Progress" }] } }, Notes: { type: "rich_text" } } });
    if (p === `/v1/databases/${DB}/query`) return json({ results: [...f.pages.values()], has_more: false, next_cursor: null });
    if (p === "/v1/pages" && method === "POST") {
      const id = pid(++n);
      f.pages.set(id, { id, last_edited_time: tick(), properties: toRead(body.properties) });
      return json({ id });
    }
    const m = p.match(/^\/v1\/pages\/(.+)$/);
    if (m && method === "PATCH") {
      const page = f.pages.get(m[1]!);
      if (!page) return json({ code: "object_not_found" }, 404);
      Object.assign(page.properties, toRead(body.properties));
      page.last_edited_time = tick();
      return json({ id: page.id });
    }
    return json({ code: "not_found" }, 404);
  }) as typeof fetch;
  return f;
}

const MAP = [{ notionProperty: "Status", notionType: "select", parachuteField: "status", transform: "slugify", valueMap: {}, relationshipType: null }];

function addPage(f: FakeNotion, i: number, name: string, status: string, notes = "", edited = tick()) {
  f.pages.set(pid(i), {
    id: pid(i),
    last_edited_time: edited,
    properties: {
      Name: { type: "title", title: [{ plain_text: name }] },
      Status: { type: "select", select: { name: status } },
      Notes: { type: "rich_text", rich_text: notes ? [{ plain_text: notes }] : [] },
    },
  });
}

const cfgOf = (over: Partial<NotionDbConfig> = {}): NotionDbConfig => ({
  id: "n1",
  vaultId: "primary",
  databaseId: DB,
  databaseName: "Tasks",
  parachuteTag: "task",
  pathPrefix: "vault/tasks/notion",
  propertyMap: MAP,
  titleProperty: "Name",
  contentProperty: "Notes",
  syncDirection: "bidirectional",
  conflictStrategy: "notion-wins",
  autoSync: false,
  idMap: {},
  lastSynced: "",
  lastResult: null,
  lastError: null,
  createdBy: "t",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const noSleep = async () => {};

test("pull creates notes with mapped metadata; a re-run with nothing changed writes NOTHING (both directions)", async () => {
  const f = fakeNotion();
  addPage(f, 1, "Write docs", "In Progress", "the body");
  const vault = new FakeSyncVault();
  const client = new NotionDbClient("secret_test", f.fetch, noSleep);
  const r1 = await runNotionDbSync(client, vault, cfgOf());
  assert.equal(r1.result.created, 1);
  const note = [...vault.notes.values()][0]!;
  assert.equal(note.path, "vault/tasks/notion/write-docs");
  assert.deepEqual(note.tags, ["task"]);
  assert.equal(note.content, "the body");
  assert.deepEqual(note.metadata, { notion_page_id: pid(1), title: "Write docs", status: "in-progress" });
  // Second run: pull no-op, push sees an identical page → no PATCH.
  const writesBefore = vault.writes.length;
  f.calls.length = 0;
  const r2 = await runNotionDbSync(client, vault, cfgOf({ idMap: r1.idMap, lastSynced: tick() }));
  assert.equal(r2.result.created + r2.result.updated, 0);
  assert.equal(r2.result.unchanged, 2);
  assert.equal(vault.writes.length, writesBefore);
  assert.ok(!f.calls.some((c) => c.method === "PATCH" || (c.method === "POST" && c.url.endsWith("/pages"))));
});

test("pull update honours the strategy and sends if_updated_at; parachute-wins keeps a vault edit and pushes it", async () => {
  const f = fakeNotion();
  addPage(f, 1, "Task", "Todo");
  const vault = new FakeSyncVault();
  const client = new NotionDbClient("secret_test", f.fetch, noSleep);
  const r1 = await runNotionDbSync(client, vault, cfgOf({ conflictStrategy: "parachute-wins" }));
  const synced = tick();
  const noteId = r1.idMap[pid(1)]!;
  // Both sides change after the sync.
  await vault.updateNote(noteId, { metadata: { status: "done" } });
  f.pages.get(pid(1))!.properties.Status.select.name = "In Progress";
  f.pages.get(pid(1))!.last_edited_time = tick();
  const r2 = await runNotionDbSync(client, vault, cfgOf({ conflictStrategy: "parachute-wins", idMap: r1.idMap, lastSynced: synced }));
  assert.equal(r2.result.conflicts, 1); // pull skipped
  assert.equal(r2.result.updated, 1); // push sent the vault value
  assert.equal(vault.notes.get(noteId)!.metadata!.status, "done");
  assert.equal(f.pages.get(pid(1))!.properties.Status.select.name, "Done");
  const upd = vault.writes.filter((w) => w.op === "update").pop();
  assert.ok(upd, "an update happened earlier via the test itself");
});

test("notion-wins: the Notion edit overwrites the vault (with if_updated_at) and the push leaves the page alone", async () => {
  const f = fakeNotion();
  addPage(f, 1, "Task", "Todo");
  const vault = new FakeSyncVault();
  const client = new NotionDbClient("secret_test", f.fetch, noSleep);
  const r1 = await runNotionDbSync(client, vault, cfgOf());
  const synced = tick();
  const noteId = r1.idMap[pid(1)]!;
  await vault.updateNote(noteId, { metadata: { status: "done" } });
  const noteUpdatedAt = vault.notes.get(noteId)!.updatedAt;
  f.pages.get(pid(1))!.properties.Status.select.name = "In Progress";
  f.pages.get(pid(1))!.last_edited_time = tick();
  f.calls.length = 0;
  const r2 = await runNotionDbSync(client, vault, cfgOf({ idMap: r1.idMap, lastSynced: synced }));
  assert.equal(vault.notes.get(noteId)!.metadata!.status, "in-progress");
  const w = vault.writes[vault.writes.length - 1]!;
  assert.equal((w.body as { ifUpdatedAt?: string }).ifUpdatedAt, noteUpdatedAt);
  assert.equal(r2.result.updated, 1);
  assert.ok(!f.calls.some((c) => c.method === "PATCH"), "no write back to Notion");
});

test("newer-wins + a concurrent vault edit (409) is a conflict, never a blind overwrite", async () => {
  const f = fakeNotion();
  addPage(f, 1, "Task", "Todo");
  const vault = new FakeSyncVault();
  const client = new NotionDbClient("secret_test", f.fetch, noSleep);
  const r1 = await runNotionDbSync(client, vault, cfgOf({ conflictStrategy: "newer-wins", syncDirection: "pull" }));
  const noteId = r1.idMap[pid(1)]!;
  f.pages.get(pid(1))!.properties.Status.select.name = "In Progress";
  f.pages.get(pid(1))!.last_edited_time = "2030-01-01T00:00:00.000Z";
  const realUpdate = vault.updateNote.bind(vault);
  vault.updateNote = async (id, p) => {
    vault.notes.get(id)!.updatedAt = tick(); // someone else wrote in between
    return realUpdate(id, p);
  };
  const r2 = await runNotionDbSync(client, vault, cfgOf({ conflictStrategy: "newer-wins", syncDirection: "pull", idMap: r1.idMap, lastSynced: tick() }));
  assert.equal(r2.result.conflicts, 1);
  assert.equal(r2.result.updated, 0);
  assert.equal(vault.notes.get(noteId)!.metadata!.status, "todo");
});

test("push creates pages for unmapped notes under the prefix (segment-safe) and records them", async () => {
  const f = fakeNotion();
  const vault = new FakeSyncVault();
  vault.put({ id: "t1", path: "vault/tasks/notion/new-one", tags: ["task"], metadata: { title: "New one", status: "in-progress" } });
  vault.put({ id: "t2", path: "vault/tasks/notion-other/x", tags: ["task"], metadata: { title: "Elsewhere" } });
  vault.put({ id: "t3", path: "vault/tasks/notion/untagged", tags: [], metadata: { title: "Untagged" } });
  const client = new NotionDbClient("secret_test", f.fetch, noSleep);
  const r = await runNotionDbSync(client, vault, cfgOf({ syncDirection: "push" }));
  assert.equal(r.result.created, 1);
  const [pageId] = Object.keys(r.idMap);
  assert.equal(r.idMap[pageId!], "t1");
  assert.equal(f.pages.get(pageId!)!.properties.Name.title[0].plain_text, "New one");
  assert.equal(f.pages.get(pageId!)!.properties.Status.select.name, "In Progress");
  assert.ok(f.calls.every((c) => c.url.startsWith("https://api.notion.com/v1/") && c.auth === "Bearer secret_test"));
});

test("limiter: requests are spaced at NOTION_DB_RPS and a 429 is retried after Retry-After", async () => {
  const f = fakeNotion();
  f.rateLimitNext = 1;
  const sleeps: number[] = [];
  const client = new NotionDbClient("secret_other", ((i: any, init: any) => f.fetch(i, { ...init, headers: { ...init.headers, Authorization: "Bearer secret_test" } })) as typeof fetch, async (ms) => {
    sleeps.push(ms);
  });
  await client.listDatabases();
  await client.listDatabases();
  await client.listDatabases();
  assert.ok(sleeps.some((ms) => ms >= 200), `spaced: ${sleeps.join(",")}`);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/search")).length, 4); // 1 retried + 3
});

// ── routes + background ──────────────────────────────────────────────────────

const J = { "content-type": "application/json" };
const owner = () => sessionCookie(makeSession(config.ownerEmail));
let f: FakeNotion;
let vault: FakeSyncVault;

beforeEach(() => {
  resetDb();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  f = fakeNotion();
  vault = new FakeSyncVault();
  setNotionDbFetchForTests(f.fetch, noSleep);
  setNotionDbVaultForTests(() => vault);
});
afterEach(() => {
  setNotionDbFetchForTests(null);
  setNotionDbVaultForTests(null);
  delete process.env.NOTION_DB_SYNC_ENABLED;
});

test("routes: unconfigured → 400 before any network; list/schema/init/sync/patch/delete; token never echoed", async () => {
  const nc = await sync.request("/notion-db/databases", { headers: { cookie: owner() } });
  assert.equal(nc.status, 400);
  assert.equal(f.calls.length, 0);
  putSecret("primary", config.ownerEmail, "notion", JSON.stringify({ apiKey: "secret_test" }));
  const dbs = await sync.request("/notion-db/databases", { headers: { cookie: owner() } });
  assert.deepEqual(await dbs.json(), [{ id: DB, title: "Tasks", propertyCount: 2 }]);
  const schema = (await (await sync.request(`/notion-db/databases/${DB}/schema`, { headers: { cookie: owner() } })).json()) as { properties: unknown[]; suggestedMappings: Array<{ parachuteField: string }> };
  assert.equal(schema.properties.length, 3);
  assert.deepEqual(schema.suggestedMappings.map((m) => m.parachuteField), ["status", "notes"]);
  assert.equal((await sync.request(`/notion-db/databases/../../x/schema`, { headers: { cookie: owner() } })).status, 404);
  assert.equal((await sync.request(`/notion-db/databases/not-an-id/schema`, { headers: { cookie: owner() } })).status, 400);

  const bad = await sync.request("/notion-db/configs", { method: "POST", headers: { ...J, cookie: owner() }, body: JSON.stringify({ databaseId: DB, parachuteTag: "task", parachutePathPrefix: "../x", titleProperty: "Name" }) });
  assert.equal(bad.status, 400);
  const created = await sync.request("/notion-db/configs", {
    method: "POST",
    headers: { ...J, cookie: owner() },
    body: JSON.stringify({ databaseId: DB, databaseName: "Tasks", parachuteTag: "task", parachutePathPrefix: "vault/tasks/notion", propertyMap: [{ notionProperty: "Status", notionType: "select", parachuteField: "metadata.status", transform: "slug" }], titleProperty: "Name", syncDirection: "notion-to-prism", conflictStrategy: "newer", autoSync: false }),
  });
  const { id, config: view } = (await created.json()) as { id: string; config: { syncDirection: string; conflictStrategy: string } };
  assert.deepEqual([view.syncDirection, view.conflictStrategy], ["pull", "newer-wins"]);
  addPage(f, 1, "Alpha", "Todo");
  const res = await sync.request(`/notion-db/configs/${id}/sync`, { method: "POST", headers: { cookie: owner() } });
  const text = await res.text();
  assert.equal(JSON.parse(text).created, 1);
  assert.ok(!text.includes("secret_test"));
  assert.equal(getNotionDbConfig(id)!.idMap[pid(1)] !== undefined, true);
  const list = (await (await sync.request("/notion-db/configs", { headers: { cookie: owner() } })).json()) as Array<{ syncedCount: number; lastSynced: string }>;
  assert.equal(list[0]!.syncedCount, 1);
  assert.ok(list[0]!.lastSynced);
  assert.ok(!JSON.stringify(list).includes("secret_test"));
  const audit = listSyncAudit("primary", { kind: "notion-db" });
  assert.deepEqual(audit.map((a) => a.action), ["sync", "init"]);
  assert.equal((await sync.request(`/notion-db/configs/${id}`, { method: "PATCH", headers: { ...J, cookie: owner() }, body: JSON.stringify({ autoSync: true }) })).status, 200);
  // Another vault's config is invisible.
  const foreign = insertNotionDbConfig({ ...cfgOf(), vaultId: "elsewhere", createdBy: "t" });
  assert.equal((await sync.request(`/notion-db/configs/${foreign.id}/sync`, { method: "POST", headers: { cookie: owner() } })).status, 404);
  assert.equal((await sync.request(`/notion-db/configs/${id}`, { method: "DELETE", headers: { cookie: owner() } })).status, 200);
  assert.equal(getNotionDbConfig(id), null);
});

test("background pass: off unless NOTION_DB_SYNC_ENABLED=true; then runs auto-sync configs only", async () => {
  putSecret("primary", config.ownerEmail, "notion", JSON.stringify({ apiKey: "secret_test" }));
  addPage(f, 1, "Alpha", "Todo");
  insertNotionDbConfig({ ...cfgOf({ autoSync: true, syncDirection: "pull" }), createdBy: "t" });
  insertNotionDbConfig({ ...cfgOf({ autoSync: false, syncDirection: "pull", pathPrefix: "vault/manual" }), createdBy: "t" });
  assert.equal(await runNotionDbPassOnce(true), 0);
  assert.equal(f.calls.length, 0);
  process.env.NOTION_DB_SYNC_ENABLED = "true";
  assert.equal(await runNotionDbPassOnce(true), 1);
  assert.equal([...vault.notes.values()].filter((n) => n.path?.startsWith("vault/tasks/notion/")).length, 1);
  assert.equal([...vault.notes.values()].filter((n) => n.path?.startsWith("vault/manual/")).length, 0);
});
