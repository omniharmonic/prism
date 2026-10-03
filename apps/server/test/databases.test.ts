/**
 * Typed properties + database views (routes/databases.ts) through the REAL
 * gateway app against the fake vault: schema visibility, owner-only additive
 * schema writes, the lean permission-filtered query, and per-field CAS writes.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { addGrant } from "../src/db";
import type { Cap } from "../src/permissions";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

let fv: FakeVault;
/** Vault tag schemas served by GET /tags?include_schema=true and written by PUT /tags/:name. */
let vaultTags: Array<{ name: string; count: number; description: string | null; fields: Record<string, unknown> }>;
let tagPuts: Array<{ tag: string; auth: string | null; body: any }>;
let innerFetch: typeof fetch;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  vaultTags = [
    { name: "task", count: 4, description: "Work items", fields: { status: { type: "string", enum: ["todo", "doing", "done"], default: "todo" }, due: { type: "string" }, points: { type: "number", indexed: true } } },
    { name: "secret", count: 1, description: "Hidden", fields: { codename: { type: "string" } } },
    { name: "confidential", count: 1, description: null, fields: { level: { type: "integer" } } },
    { name: "plain", count: 9, description: null, fields: {} },
  ];
  tagPuts = [];
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const m = url.pathname.match(/^\/vault\/default\/api\/tags(?:\/([^/]+))?$/);
    if (m && !m[1] && (init?.method ?? "GET") === "GET") return Response.json(vaultTags);
    if (m && m[1] && init?.method === "PUT") {
      const tag = decodeURIComponent(m[1]);
      const body = JSON.parse(String(init.body));
      const headers = init.headers as Record<string, string>;
      tagPuts.push({ tag, auth: headers.Authorization ?? null, body });
      const row = vaultTags.find((t) => t.name === tag);
      if (row) Object.assign(row, { description: body.description, fields: body.fields });
      else vaultTags.push({ name: tag, count: 0, description: body.description, fields: body.fields });
      return Response.json({ ok: true });
    }
    return innerFetch(input, init);
  }) as typeof fetch;
  setSchemaAdminMinter(async () => "admin-jwt-for-test");
});
afterEach(() => {
  setSchemaAdminMinter(null);
  fv.restore();
});

const OWNER = "owner@test.local";
const login = (email: string) => sessionCookie(makeSession(email));
const J = { "content-type": "application/json" };
function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const grantCaps = (email: string, tag: string, caps: Cap[]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: "tag", resource: tag, level: "view", created_by: "test", caps });

function seedTasks() {
  fv.put({ id: "t1", path: "Tasks/Alpha", tags: ["task"], content: "BODY-ALPHA", metadata: { title: "Alpha", status: "todo", due: "2026-10-05", points: 3, prism_creator: "a@test.local" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "t2", path: "Tasks/Beta", tags: ["task"], content: "BODY-BETA", metadata: { title: "Beta", status: "doing", due: "2026-10-03", points: 8 }, updatedAt: "2026-10-01T11:00:00.000Z" });
  fv.put({ id: "t3", path: "Tasks/Gamma", tags: ["task", "secret"], content: "BODY-GAMMA", metadata: { title: "Gamma", status: "done", points: 1 }, updatedAt: "2026-10-01T12:00:00.000Z" });
  fv.put({ id: "t4", path: "Tasks/Delta", tags: ["task", "confidential"], content: "", metadata: { title: "Delta", status: "todo", prism_creator: "someone@test.local", prism_visibility: "private" }, updatedAt: "2026-10-01T13:00:00.000Z" });
}

// ── GET /api/schemas ────────────────────────────────────────────────────────

test("schemas: the owner sees every schema with hints merged and no counts", async () => {
  const r = await req("/schemas", { cookie: login(OWNER) });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { schemas: Record<string, any> };
  assert.deepEqual(Object.keys(body.schemas).sort(), ["confidential", "secret", "task"]);
  assert.deepEqual(body.schemas.task.fields.status, { type: "string", enum: ["todo", "doing", "done"], default: "todo" });
  assert.equal(body.schemas.task.fields.points.indexed, true);
  assert.equal(JSON.stringify(body).includes("count"), false, "tag counts never leave the server");
  const filtered = (await (await req("/schemas?tags=task", { cookie: login(OWNER) })).json()) as { schemas: Record<string, unknown> };
  assert.deepEqual(Object.keys(filtered.schemas), ["task"]);
});

test("schemas: a non-owner learns only tags of notes they can view (or tags they were granted)", async () => {
  seedTasks();
  grantUser("kai@test.local", "tag", "task", "view");
  const r = await req("/schemas", { cookie: login("kai@test.local") });
  assert.equal(r.status, 200);
  const names = Object.keys(((await r.json()) as { schemas: object }).schemas).sort();
  // task: granted. secret: carried by t3, which kai can view via the task grant.
  // confidential: only on t4, someone else's PRIVATE note → never learned.
  assert.deepEqual(names, ["secret", "task"]);
});

test("schemas: a caps grant without view reveals its own tag name only, never co-tags", async () => {
  fv.put({ id: "d1", tags: ["intake", "secret"], metadata: {} });
  grantCaps("drop@test.local", "intake", ["create"]);
  const body = (await (await req("/schemas", { cookie: login("drop@test.local") })).json()) as { schemas: object };
  assert.deepEqual(Object.keys(body.schemas), [], "intake has no schema; secret is on a note they cannot view");
});

test("schemas: anon is refused", async () => {
  assert.equal((await req("/schemas")).status, 401);
});

// ── PUT /api/schemas/:tag ───────────────────────────────────────────────────

const put = (tag: string, body: unknown, cookie: string, headers: Record<string, string> = J) =>
  req(`/schemas/${encodeURIComponent(tag)}`, { method: "PUT", cookie, headers, body: JSON.stringify(body) });

test("schema write: owner-only, JSON-only, same-origin only", async () => {
  grantUser("kai@test.local", "tag", "task", "edit");
  assert.equal((await put("task", { fields: { size: { type: "number" } } }, login("kai@test.local"))).status, 403);
  assert.equal((await put("task", { fields: { size: { type: "number" } } }, login(OWNER), { "content-type": "text/plain" })).status, 415);
  assert.equal((await put("task", { fields: { size: { type: "number" } } }, login(OWNER), { ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await put("task", { fields: { size: { type: "number" } } }, login(OWNER), { ...J, origin: "https://evil.example" })).status, 403);
  assert.equal(tagPuts.length, 0);
});

test("schema write: adding a field merges into the vault schema with a minted admin token", async () => {
  const r = await put("task", { fields: { size: { type: "number", description: "Estimate" } }, ui: { size: { label: "Size (pts)" }, status: { colors: { doing: "blue" } } } }, login(OWNER));
  assert.equal(r.status, 200);
  assert.equal(tagPuts.length, 1);
  assert.equal(tagPuts[0]!.auth, "Bearer admin-jwt-for-test", "the admin token is used for the vault write only");
  assert.deepEqual(Object.keys(tagPuts[0]!.body.fields).sort(), ["due", "points", "size", "status"], "existing fields are echoed, never dropped");
  assert.equal(tagPuts[0]!.body.fields.points.indexed, undefined, "indexed is not echoed on a non-indexable type");
  const body = (await r.json()) as { schema: { fields: Record<string, any> } };
  assert.equal(JSON.stringify(body).includes("admin-jwt"), false);
  assert.equal(body.schema.fields.size.label, "Size (pts)");
  const after = (await (await req("/schemas?tags=task", { cookie: login(OWNER) })).json()) as { schemas: Record<string, any> };
  assert.deepEqual(after.schemas.task.fields.status.colors, { doing: "blue" });
  assert.equal(after.schemas.task.fields.size.type, "number");
});

test("schema write: refuses edits that could orphan values", async () => {
  const typeChange = await put("task", { fields: { due: { type: "number" } } }, login(OWNER));
  assert.equal(typeChange.status, 409);
  assert.equal(((await typeChange.json()) as { error: string }).error, "not_additive");
  assert.equal((await put("task", { fields: { status: { enum: ["todo", "done"] } } }, login(OWNER))).status, 409, "removing an option");
  assert.equal((await put("task", { fields: { due: { enum: ["soon"] } } }, login(OWNER))).status, 409, "options on free text");
  assert.equal((await put("task", { fields: { prism_creator: { type: "string" } } }, login(OWNER))).status, 400, "system keys");
  assert.equal(tagPuts.length, 0);
  const extend = await put("task", { fields: { status: { enum: ["todo", "doing", "done", "blocked"] } } }, login(OWNER));
  assert.equal(extend.status, 200, "appending an option is additive");
  assert.deepEqual(tagPuts[0]!.body.fields.status.enum, ["todo", "doing", "done", "blocked"]);
});

test("schema write: hint-only edits never touch the vault; a missing admin token is a 503", async () => {
  assert.equal((await put("task", { ui: { due: { kind: "date", label: "Due date" } } }, login(OWNER))).status, 200);
  assert.equal(tagPuts.length, 0);
  setSchemaAdminMinter(async () => {
    throw new Error("no CLI");
  });
  const r = await put("task", { fields: { size: { type: "number" } } }, login(OWNER));
  assert.equal(r.status, 503);
  assert.equal(tagPuts.length, 0);
});

// ── POST /api/query ─────────────────────────────────────────────────────────

const query = (body: unknown, cookie?: string) =>
  req("/query", { method: "POST", cookie, headers: J, body: JSON.stringify(body) });

test("query: owner filters, sorts and pages over a lean single-tag listing", async () => {
  seedTasks();
  const cookie = login(OWNER);
  const first = await query({ tags: ["task"], filter: { match: "all", conditions: [{ key: "status", op: "ne", value: "done" }] }, sort: [{ key: "due", dir: "asc" }], fields: ["status", "due"], limit: 2 }, cookie);
  assert.equal(first.status, 200);
  const p1 = (await first.json()) as any;
  assert.deepEqual(p1.rows.map((r: any) => r.id), ["t2", "t1"], "earliest due first");
  assert.equal(p1.total, 3);
  assert.equal(p1.limited, false);
  assert.ok(p1.next);
  assert.equal(JSON.stringify(p1).includes("BODY-"), false, "no content");
  assert.deepEqual(p1.rows[0].metadata, { title: "Beta", status: "doing", due: "2026-10-03" });
  const p2 = (await (await query({ tags: ["task"], filter: { match: "all", conditions: [{ key: "status", op: "ne", value: "done" }] }, sort: [{ key: "due", dir: "asc" }], fields: ["status", "due"], limit: 2, cursor: p1.next }, cookie)).json()) as any;
  assert.deepEqual(p2.rows.map((r: any) => r.id), ["t4"], "missing due sorts last");
  assert.equal(p2.next, null);
  const listing = fv.calls.filter((call) => call.method === "GET" && call.path.endsWith("/notes"));
  assert.equal(listing.length, 1, "the second page reused the coalesced listing");
  assert.match(listing[0]!.search, /include_metadata=/);
  assert.doesNotMatch(listing[0]!.search, /include_content=true/);
  assert.match(listing[0]!.search, /tag=task/);
});

test("query: OR filters, multi-tag AND, search, and bad requests", async () => {
  seedTasks();
  const cookie = login(OWNER);
  const any = (await (await query({ tags: ["task"], filter: { match: "any", conditions: [{ key: "points", op: "gt", value: 5 }, { key: "status", op: "eq", value: "DONE" }] } }, cookie)).json()) as any;
  assert.deepEqual(any.rows.map((r: any) => r.id).sort(), ["t2", "t3"]);
  const both = (await (await query({ tags: ["task", "secret"] }, cookie)).json()) as any;
  assert.deepEqual(both.rows.map((r: any) => r.id), ["t3"]);
  const search = (await (await query({ tags: ["task"], search: "alp" }, cookie)).json()) as any;
  assert.deepEqual(search.rows.map((r: any) => r.id), ["t1"]);
  assert.equal((await query({ tags: ["task"], limit: 501 }, cookie)).status, 400);
  assert.equal((await query({ tags: [] }, cookie)).status, 400);
  assert.equal((await query({ tags: ["task"], filter: { match: "all", conditions: [{ key: "__proto__", op: "eq", value: 1 }] } }, cookie)).status, 400);
  const p1 = (await (await query({ tags: ["task"], limit: 1 }, cookie)).json()) as any;
  assert.equal((await query({ tags: ["task"], limit: 1, search: "x", cursor: p1.next }, cookie)).status, 400, "a cursor is bound to its query");
  assert.equal((await query({ tags: ["task"] })).status, 401);
});

test("query: non-owners get only what they can view, annotated, and `limited`", async () => {
  seedTasks();
  grantUser("kai@test.local", "tag", "task", "edit");
  const r = (await (await query({ tags: ["task"], fields: ["status"] }, login("kai@test.local"))).json()) as any;
  assert.deepEqual(r.rows.map((x: any) => x.id).sort(), ["t1", "t2", "t3"], "someone else's private note never appears");
  assert.equal(r.total, 3, "hidden notes are not counted");
  assert.equal(r.limited, true);
  assert.ok(r.rows.every((x: any) => Array.isArray(x._caps) && x._caps.includes("edit")));
  assert.equal(JSON.stringify(r).includes("prism_creator"), false, "permission keys are read, not returned");

  grantCaps("drop@test.local", "task", ["create"]);
  const blind = (await (await query({ tags: ["task"] }, login("drop@test.local"))).json()) as any;
  assert.deepEqual(blind.rows, [], "a caps grant without view sees no rows");
  assert.equal(blind.total, 0);

  addGrant({ subject_type: "user", subject: "nina@test.local", resource_type: "note", resource: "t2", level: "view", created_by: "test" });
  const one = (await (await query({ tags: ["task"] }, login("nina@test.local"))).json()) as any;
  assert.deepEqual(one.rows.map((x: any) => x.id), ["t2"], "a single-note grant shows just that row");
});

// ── POST /api/properties/:id ────────────────────────────────────────────────

const setProps = (id: string, body: unknown, cookie: string) =>
  req(`/properties/${id}`, { method: "POST", cookie, headers: J, body: JSON.stringify(body) });

test("properties: an editor's write merges only the changed keys", async () => {
  seedTasks();
  grantUser("kai@test.local", "tag", "task", "edit");
  const r = await setProps("t1", { set: { status: "done", due: null }, expect: { status: "todo", due: "2026-10-05" } }, login("kai@test.local"));
  assert.equal(r.status, 200);
  const n = fv.notes.get("t1")!;
  assert.equal(n.metadata!.status, "done");
  assert.equal("due" in n.metadata!, false, "null clears the property");
  assert.equal(n.metadata!.points, 3, "other properties are preserved");
  assert.equal(n.content, "BODY-ALPHA", "content is never written");
  const patch = fv.calls.find((call) => call.method === "PATCH")!;
  assert.deepEqual((patch.body as any).metadata, { status: "done", due: null });
  assert.equal((patch.body as any).if_updated_at, "2026-10-01T10:00:00.000Z", "CAS against the version just read");
  assert.equal((patch.body as any).content, undefined);
  const body = (await r.json()) as any;
  assert.equal(body.metadata.prism_creator, undefined);
});

test("properties: a field changed elsewhere is a conflict carrying the current value", async () => {
  seedTasks();
  const r = await setProps("t2", { set: { status: "done" }, expect: { status: "todo" } }, login(OWNER));
  assert.equal(r.status, 409);
  const body = (await r.json()) as any;
  assert.deepEqual(body.fields, ["status"]);
  assert.deepEqual(body.current, { status: "doing" });
  assert.equal(fv.notes.get("t2")!.metadata!.status, "doing", "nothing written");
  // An expectation on a DIFFERENT field than the one now stale is fine: points unchanged.
  assert.equal((await setProps("t2", { set: { points: 9 }, expect: { points: 8 } }, login(OWNER))).status, 200);
});

test("properties: a concurrent body write between read and write is retried once, not lost", async () => {
  seedTasks();
  fv.conflictOnNextWrite = true;
  const r = await setProps("t1", { set: { status: "doing" }, expect: { status: "todo" } }, login(OWNER));
  assert.equal(r.status, 200);
  assert.equal(fv.notes.get("t1")!.metadata!.status, "doing");
  assert.equal(fv.calls.filter((call) => call.method === "PATCH").length, 2);
});

test("properties: access rules", async () => {
  seedTasks();
  grantUser("viewer@test.local", "tag", "task", "view");
  assert.equal((await setProps("t1", { set: { status: "done" } }, login("viewer@test.local"))).status, 403, "view is not edit");
  assert.equal((await setProps("t1", { set: { status: "done" } }, login("stranger@test.local"))).status, 404, "no view → not found");
  grantUser("kai@test.local", "tag", "task", "edit");
  assert.equal((await setProps("t4", { set: { status: "done" } }, login("kai@test.local"))).status, 404, "someone else's private note");
  assert.equal((await setProps("t1", { set: { prism_visibility: "workspace" } }, login("kai@test.local"))).status, 400);
  assert.equal((await setProps("t1", { set: { gov_sig: "x" } }, login(OWNER))).status, 400);
  assert.equal((await setProps("t1", { set: { blob: { nested: true } } }, login(OWNER))).status, 400);
  assert.equal((await setProps("t1", { set: {} }, login(OWNER))).status, 400);
  assert.equal((await req("/properties/t1", { method: "POST", headers: J, body: JSON.stringify({ set: { a: 1 } }) })).status, 401);
  assert.equal(fv.calls.filter((call) => call.method === "PATCH").length, 0);
});
