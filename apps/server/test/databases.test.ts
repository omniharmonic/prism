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
import { resetDatabaseCachesForTests, setSchemaAdminMinter, setQueryCacheLimitsForTests } from "../src/routes/databases";
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
  assert.deepEqual((patch.body as any).metadata, { status: "done", due: null, prism_last_writer: "kai@test.local" }, "+ the writer stamp");
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

test("query: without `fields` rows carry whole metadata (never content); non-owners lose creator stamps", async () => {
  seedTasks();
  const owner = (await (await query({ tags: ["task"], search: "alpha" }, login(OWNER))).json()) as any;
  assert.deepEqual(Object.keys(owner.rows[0].metadata).sort(), ["due", "points", "prism_creator", "status", "title"]);
  const listing = fv.calls.find((call) => call.method === "GET" && call.path.endsWith("/notes"))!;
  assert.match(listing.search, /include_metadata=/, "a tag with a schema lists its canonical keys");
  assert.doesNotMatch(listing.search, /include_content=true/);
  fv.put({ id: "f1", tags: ["plain"], metadata: { title: "Free", mood: "calm" } });
  const free = (await (await query({ tags: ["plain"] }, login(OWNER))).json()) as any;
  assert.deepEqual(free.rows[0].metadata, { title: "Free", mood: "calm" }, "no schema → whole metadata");
  const plainListing = fv.calls.filter((call) => call.method === "GET" && /tag=plain/.test(call.search)).at(-1)!;
  assert.doesNotMatch(plainListing.search, /include_metadata=/);
  assert.equal(JSON.stringify(owner).includes("BODY-"), false);
  grantUser("kai@test.local", "tag", "task", "view");
  const member = (await (await query({ tags: ["task"], search: "alpha" }, login("kai@test.local"))).json()) as any;
  assert.equal(member.rows[0].metadata.prism_creator, undefined);
  assert.equal(member.rows[0].metadata.points, 3);
});

// ── review fixes (H1, M1, M2, L1, L5, L6) ───────────────────────────────────

/** Query listings (tag-filtered); the tree projection's own build is not one. */
const listings = () => fv.calls.filter((call) => call.method === "GET" && call.path.endsWith("/notes") && /[?&]tag=/.test(call.search));

test("H1: a non-admin querying a tag they cannot see gets nothing and costs no vault listing", async () => {
  seedTasks();
  fv.put({ id: "e1", tags: ["email"], metadata: { title: "Secret mail" } });
  addGrant({ subject_type: "user", subject: "nina@test.local", resource_type: "note", resource: "t2", level: "view", created_by: "test" });
  const r = await query({ tags: ["email"] }, login("nina@test.local"));
  assert.equal(r.status, 200);
  const body = (await r.json()) as any;
  assert.deepEqual(body.rows, []);
  assert.equal(body.total, 0);
  assert.equal(body.limited, true);
  assert.equal(listings().length, 0, "no vault listing for an unseen tag");
  // A capability link for an unrelated note: same.
  const { makeCapability } = await import("./helpers");
  const cap = makeCapability("note", "t2", "view");
  const viaLink = await req("/query", { method: "POST", headers: { ...J, authorization: `Capability ${cap}` }, body: JSON.stringify({ tags: ["email"] }) });
  assert.deepEqual(((await viaLink.json()) as any).rows, []);
  assert.equal(listings().length, 0);
  // The tag of a note they CAN view is allowed.
  const ok = (await (await query({ tags: ["task"] }, login("nina@test.local"))).json()) as any;
  assert.deepEqual(ok.rows.map((x: any) => x.id), ["t2"]);
});

test("H1: varying `fields` reuses ONE canonical listing per tag; projection happens per response", async () => {
  seedTasks();
  const cookie = login(OWNER);
  await query({ tags: ["task"], fields: ["status"] }, cookie);
  await query({ tags: ["task"], fields: ["due"] }, cookie);
  const third = (await (await query({ tags: ["task"], fields: ["points"], search: "alpha" }, cookie)).json()) as any;
  assert.equal(listings().length, 1);
  assert.deepEqual(third.rows[0].metadata, { title: "Alpha", points: 3 });
  assert.match(listings()[0]!.search, /order_by=updated_at/, "deterministic order from the vault");
});

test("H1: the listing cache is LRU-bounded", async () => {
  seedTasks();
  fv.put({ id: "x1", tags: ["alpha"], metadata: {} });
  fv.put({ id: "x2", tags: ["beta"], metadata: {} });
  setQueryCacheLimitsForTests({ entries: 2, rows: 1000 });
  try {
    const cookie = login(OWNER);
    await query({ tags: ["task"] }, cookie);
    await query({ tags: ["alpha"] }, cookie);
    await query({ tags: ["beta"] }, cookie); // evicts task
    await query({ tags: ["beta"] }, cookie);
    await query({ tags: ["task"] }, cookie);
    assert.equal(listings().length, 4);
  } finally {
    setQueryCacheLimitsForTests(null);
  }
});

test("H1: /query is rate limited per actor", async () => {
  seedTasks();
  grantUser("rate@test.local", "tag", "task", "view");
  process.env.QUERY_RATE_PER_MINUTE = "3";
  try {
    const cookie = login("rate@test.local");
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await query({ tags: ["task"] }, cookie)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    delete process.env.QUERY_RATE_PER_MINUTE;
  }
});

test("M1: property writes and queries refuse non-JSON and cross-site requests", async () => {
  seedTasks();
  const cookie = login(OWNER);
  const form = await req("/properties/t1", { method: "POST", cookie, headers: { "content-type": "text/plain" }, body: JSON.stringify({ set: { status: "done" } }) });
  assert.equal(form.status, 415);
  const cross = await req("/properties/t1", { method: "POST", cookie, headers: { ...J, "sec-fetch-site": "cross-site" }, body: JSON.stringify({ set: { status: "done" } }) });
  assert.equal(cross.status, 403);
  const evil = await req("/properties/t1", { method: "POST", cookie, headers: { ...J, origin: "https://evil.example" }, body: JSON.stringify({ set: { status: "done" } }) });
  assert.equal(evil.status, 403);
  assert.equal((await req("/query", { method: "POST", cookie, headers: { "content-type": "text/plain" }, body: JSON.stringify({ tags: ["task"] }) })).status, 415);
  assert.equal(fv.calls.filter((call) => call.method === "PATCH").length, 0);
  assert.equal(fv.notes.get("t1")!.metadata!.status, "todo");
});

test("M2: the scan cap applies AFTER permission filtering; truncated never reveals hidden notes", async () => {
  for (let i = 0; i < 6; i++) fv.put({ id: `h${i}`, tags: ["task"], metadata: { title: `Hidden ${i}`, prism_creator: "x@test.local", prism_visibility: "private" }, updatedAt: `2026-10-0${i + 1}T00:00:00.000Z` });
  fv.put({ id: "v1", tags: ["task"], metadata: { title: "Visible" }, updatedAt: "2026-01-01T00:00:00.000Z" });
  grantUser("kai@test.local", "tag", "task", "view");
  process.env.QUERY_SCAN_MAX = "3";
  try {
    const member = (await (await query({ tags: ["task"] }, login("kai@test.local"))).json()) as any;
    assert.deepEqual(member.rows.map((x: any) => x.id), ["v1"], "a visible row past the raw cut still appears");
    assert.equal(member.truncated, false, "hidden notes never make a non-owner's view 'truncated'");
    const owner = (await (await query({ tags: ["task"] }, login(OWNER))).json()) as any;
    assert.equal(owner.truncated, true);
    assert.equal(owner.total, 3);
  } finally {
    delete process.env.QUERY_SCAN_MAX;
  }
});

test("L1: property writes take a strict note id and refuse aliases the vault would resolve", async () => {
  seedTasks();
  const cookie = login(OWNER);
  assert.equal((await setProps(encodeURIComponent("Tasks/Alpha"), { set: { status: "done" } }, cookie)).status, 404);
  assert.equal((await setProps("Alpha", { set: { status: "done" } }, cookie)).status, 404, "a title alias resolves to t1 — refused");
  assert.equal(fv.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("L5: query rows say whether the caller can edit them", async () => {
  seedTasks();
  grantUser("viewer@test.local", "tag", "task", "view");
  grantUser("kai@test.local", "tag", "task", "edit");
  const v = (await (await query({ tags: ["task"], search: "alpha" }, login("viewer@test.local"))).json()) as any;
  assert.equal(v.rows[0].canEdit, false);
  const k = (await (await query({ tags: ["task"], search: "alpha" }, login("kai@test.local"))).json()) as any;
  assert.equal(k.rows[0].canEdit, true);
  const o = (await (await query({ tags: ["task"], search: "alpha" }, login(OWNER))).json()) as any;
  assert.equal(o.rows[0].canEdit, true);
  const { makeCapability } = await import("./helpers");
  const cap = makeCapability("tag", "task", "view");
  const l = (await (await req("/query", { method: "POST", headers: { ...J, authorization: `Capability ${cap}` }, body: JSON.stringify({ tags: ["task"], search: "alpha" }) })).json()) as any;
  assert.equal(l.rows[0].canEdit, false);
  assert.equal(l.rows[0]._caps, undefined);
});

test("L6: system and ingest tags are protected from risky schema edits", async () => {
  seedTasks();
  const cookie = login(OWNER);
  vaultTags.push({ name: "governance-role", count: 1, description: null, fields: { name: { type: "string" } } });
  assert.equal((await put("governance-role", { fields: { extra: { type: "string" } } }, cookie)).status, 403);
  assert.equal((await put("agent-skill", { fields: { extra: { type: "string" } } }, cookie)).status, 403);
  const dflt = await put("task", { fields: { size: { type: "number", default: 1 } } }, cookie);
  assert.equal(dflt.status, 409);
  assert.equal(((await dflt.json()) as any).error, "protected_tag");
  fv.put({ id: "t9", tags: ["task"], metadata: { title: "Odd", effort: "three" } });
  const clash = await put("task", { fields: { effort: { type: "number" } } }, cookie);
  assert.equal(clash.status, 409);
  assert.equal(((await clash.json()) as any).error, "type_conflict");
  assert.equal(tagPuts.length, 0);
  assert.equal((await put("task", { fields: { size: { type: "number" } } }, cookie)).status, 200, "a new, unused field is still fine");
});

test("L6: concurrent schema edits serialise; neither field is lost", async () => {
  const cookie = login(OWNER);
  const [a, b] = await Promise.all([
    put("task", { fields: { alpha_f: { type: "string" } } }, cookie),
    put("task", { fields: { beta_f: { type: "string" } } }, cookie),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const fields = vaultTags.find((t) => t.name === "task")!.fields;
  assert.ok("alpha_f" in fields && "beta_f" in fields);
});

test("L5: GET /schemas says whether the caller may change schemas", async () => {
  seedTasks();
  grantUser("kai@test.local", "tag", "task", "edit");
  assert.equal(((await (await req("/schemas", { cookie: login(OWNER) })).json()) as any).canEdit, true);
  assert.equal(((await (await req("/schemas", { cookie: login("kai@test.local") })).json()) as any).canEdit, false);
});
