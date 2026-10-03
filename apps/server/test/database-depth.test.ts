/**
 * Database depth (wave 2C): text search + one-level AND/OR groups in
 * `/api/query`, the writer stamp `prism_last_writer`, batched CAS property
 * writes, and the owner/admin CSV import — through the REAL gateway app against
 * the fake vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { validateQuerySpec, runQuery, parseCsv, toCsv, coerceCsvValue, CsvError } from "@prism/core/database";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

let fv: FakeVault;
let innerFetch: typeof fetch;
const vaultTags = () => [
  { name: "task", count: 4, description: "Work", fields: { status: { type: "string", enum: ["todo", "doing", "done"] }, notes: { type: "string" }, points: { type: "number" }, sku: { type: "string" }, labels: { type: "array" } } },
];

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") return Response.json(vaultTags());
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
const post = (path: string, body: unknown, cookie?: string, headers: Record<string, string> = J) =>
  req(path, { method: "POST", cookie, headers, body: JSON.stringify(body) });
const patches = () => fv.calls.filter((c) => c.method === "PATCH");
const creates = () => fv.calls.filter((c) => c.method === "POST" && c.path.endsWith("/notes"));

function seed() {
  fv.put({ id: "t1", path: "Tasks/Alpha", tags: ["task"], content: "", metadata: { title: "Alpha", status: "todo", notes: "Call the printer", points: 3, sku: "A-1", labels: ["Print shop"] }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "t2", path: "Tasks/Beta", tags: ["task"], content: "", metadata: { title: "Beta", status: "doing", notes: "Draft copy", points: 8, sku: "B-2" }, updatedAt: "2026-10-01T11:00:00.000Z" });
  fv.put({ id: "t3", path: "Tasks/Gamma", tags: ["task"], content: "", metadata: { title: "Gamma", status: "done", points: 1, sku: "C-3", prism_creator: "x@test.local", prism_visibility: "private" }, updatedAt: "2026-10-01T12:00:00.000Z" });
  fv.put({ id: "t4", path: "Tasks/Old", tags: ["task", "prism-trashed"], content: "", metadata: { title: "Old printer", status: "todo", sku: "D-4" }, updatedAt: "2026-10-01T09:00:00.000Z" });
}

// ── engine ───────────────────────────────────────────────────────────────────

test("engine: search matches the title or any text property, never system keys", () => {
  const rows = [
    { id: "a", path: "A", tags: ["t"], createdAt: "", updatedAt: "", metadata: { title: "Alpha", notes: "Call the PRINTER" } },
    { id: "b", path: "B", tags: ["t"], createdAt: "", updatedAt: "", metadata: { title: "Beta", owner: "[[People/Printer Pat]]" } },
    { id: "c", path: "C", tags: ["t"], createdAt: "", updatedAt: "", metadata: { title: "Gamma", prism_creator: "printer@x" } },
  ];
  const ids = (search: string, fields?: string[]) => runQuery(rows, { tags: ["t"], search, ...(fields ? { fields } : {}) }, { limited: false }).rows.map((r) => r.id);
  assert.deepEqual(ids("printer"), ["a", "b"], "a text value and a link's target; creator stamps are not searched");
  assert.deepEqual(ids("printer", ["notes"]), ["a"], "with `fields`, only those properties");
  assert.deepEqual(ids("gamm"), ["c"], "the title always counts");
});

test("engine: one level of AND/OR groups combines with the top-level conditions", () => {
  const ok = validateQuerySpec({ tags: ["t"], filter: { match: "all", conditions: [{ key: "points", op: "gt", value: 1 }], groups: [{ match: "any", conditions: [{ key: "status", op: "eq", value: "todo" }, { key: "status", op: "eq", value: "done" }] }] } });
  assert.equal(ok.ok, true);
  const rows = [3, 8, 1].map((p, i) => ({ id: `r${i}`, path: null, tags: ["t"], createdAt: "", updatedAt: "", metadata: { points: p, status: ["todo", "doing", "done"][i] } }));
  const page = runQuery(rows, (ok as any).spec, { limited: false });
  assert.deepEqual(page.rows.map((r) => r.id), ["r0"], "points > 1 AND (todo OR done)");
  // `any` at the top: a group is one OR term.
  const any = validateQuerySpec({ tags: ["t"], filter: { match: "any", conditions: [{ key: "points", op: "eq", value: 8 }], groups: [{ match: "all", conditions: [{ key: "status", op: "eq", value: "done" }, { key: "points", op: "lt", value: 2 }] }] } });
  assert.deepEqual(runQuery(rows, (any as any).spec, { limited: false }).rows.map((r) => r.id).sort(), ["r1", "r2"]);
  // Empty groups are no-ops; nesting and over-budget filters are refused.
  const empty = validateQuerySpec({ tags: ["t"], filter: { match: "all", conditions: [], groups: [{ match: "any", conditions: [] }] } });
  assert.equal(runQuery(rows, (empty as any).spec, { limited: false }).rows.length, 3);
  assert.equal(validateQuerySpec({ tags: ["t"], filter: { match: "all", conditions: [], groups: [{ match: "any", conditions: [], groups: [] }] } }).ok, false);
  const many = Array.from({ length: 13 }, () => ({ key: "a", op: "exists" }));
  assert.equal(validateQuerySpec({ tags: ["t"], filter: { match: "all", conditions: many, groups: [{ match: "any", conditions: many }] } }).ok, false);
  assert.equal(validateQuerySpec({ tags: ["t"], filter: { match: "all", conditions: [], groups: Array.from({ length: 6 }, () => ({ match: "any", conditions: [] })) } }).ok, false);
});

test("csv: RFC 4180 parse, bounded, formula-safe export, schema coercion", () => {
  assert.deepEqual(parseCsv('﻿Name,Notes\r\n"Smith, J","said ""hi""\nthen left"\n\nB,2\n'), [["Name", "Notes"], ["Smith, J", 'said "hi"\nthen left'], ["B", "2"]]);
  assert.throws(() => parseCsv('a\n"open'), CsvError);
  assert.throws(() => parseCsv("a\nb\nc", { maxRows: 2 }), /more than 2 rows/);
  assert.throws(() => parseCsv("a,b,c", { maxCols: 2 }), /columns/);
  assert.equal(toCsv([["=SUM(A1)", "plain", "a,b"]]), "'=SUM(A1),plain,\"a,b\"\r\n");
  assert.deepEqual(coerceCsvValue("1,200", { type: "number" }), { value: 1200 });
  assert.ok("error" in coerceCsvValue("lots", { type: "number" }));
  assert.deepEqual(coerceCsvValue("DONE", { type: "string", enum: ["todo", "done"] }), { value: "done" });
  assert.ok("error" in coerceCsvValue("maybe", { type: "string", enum: ["todo", "done"] }));
  assert.deepEqual(coerceCsvValue("a; b, a", { type: "array" }), { value: ["a", "b"] });
  assert.deepEqual(coerceCsvValue("yes", { type: "boolean" }), { value: true });
});

// ── /api/query ───────────────────────────────────────────────────────────────

test("query: search reaches text properties; groups work end to end; trashed rows never match", async () => {
  seed();
  const r = await post("/query", { tags: ["task"], search: "printer" }, login(OWNER));
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as any).rows.map((x: any) => x.id), ["t1"], "notes text + label; the trashed 'Old printer' is excluded");
  const g = await post("/query", { tags: ["task"], filter: { match: "all", conditions: [], groups: [{ match: "any", conditions: [{ key: "status", op: "eq", value: "doing" }, { key: "points", op: "lt", value: 2 }] }] }, sort: [{ key: "$title", dir: "asc" }] }, login(OWNER));
  assert.deepEqual(((await g.json()) as any).rows.map((x: any) => x.id), ["t2", "t3"]);
  // A non-owner never matches on a row they cannot view (t3 is someone else's private note).
  grantUser("kai@test.local", "tag", "task", "view");
  const k = await post("/query", { tags: ["task"], search: "c-3", fields: ["sku"] }, login("kai@test.local"));
  assert.deepEqual(((await k.json()) as any).rows, []);
  assert.equal((await post("/query", { tags: ["task"], filter: { match: "all", conditions: [], groups: [{ match: "any", conditions: [], groups: [] }] } }, login(OWNER))).status, 400);
});

// ── writer stamp ─────────────────────────────────────────────────────────────

test("writer stamp: property writes, non-owner edits/creates and the owner passthrough all name the writer", async () => {
  seed();
  grantUser("kai@test.local", "tag", "task", "edit");
  assert.equal((await post("/properties/t1", { set: { status: "done" } }, login("kai@test.local"))).status, 200);
  assert.equal(fv.notes.get("t1")!.metadata!.prism_last_writer, "kai@test.local");
  // A client cannot forge it: /properties refuses prism_*; a PATCH has it overwritten.
  assert.equal((await post("/properties/t1", { set: { prism_last_writer: "ceo@test.local" } }, login("kai@test.local"))).status, 400);
  const p = await req("/notes/t2", { method: "PATCH", cookie: login("kai@test.local"), headers: J, body: JSON.stringify({ metadata: { points: 9, prism_last_writer: "ceo@test.local" } }) });
  assert.equal(p.status, 200);
  assert.equal(fv.notes.get("t2")!.metadata!.prism_last_writer, "kai@test.local");
  const created = await post("/notes", { content: "", tags: ["task"], metadata: { title: "New", prism_last_writer: "ceo@test.local" } }, login("kai@test.local"));
  assert.equal(created.status, 200);
  assert.equal(((await created.json()) as any).metadata.prism_last_writer, "kai@test.local");
  // Owner passthrough: the forwarded JSON body is stamped (PATCH and single create).
  assert.equal((await req("/notes/t2", { method: "PATCH", cookie: login(OWNER), headers: J, body: JSON.stringify({ content: "<p>x</p>" }) })).status, 200);
  assert.equal(fv.notes.get("t2")!.metadata!.prism_last_writer, OWNER);
  const oc = await post("/notes", { content: "", tags: ["task"], metadata: { title: "Owner made" } }, login(OWNER));
  assert.equal(((await oc.json()) as any).metadata.prism_last_writer, OWNER);
  // A capability link with edit is stamped "link", never its grant id.
  const cap = makeCapability("note", "t1", "edit");
  const viaLink = await req("/properties/t1", { method: "POST", headers: { ...J, authorization: `Capability ${cap}` }, body: JSON.stringify({ set: { points: 4 } }) });
  assert.equal(viaLink.status, 200);
  assert.equal(fv.notes.get("t1")!.metadata!.prism_last_writer, "link");
  // Owners read it back through /query (it is part of the canonical listing).
  const q = (await (await post("/query", { tags: ["task"], fields: ["prism_last_writer"], sort: [{ key: "prism_last_writer", dir: "asc" }] }, login(OWNER))).json()) as any;
  assert.ok(q.rows.some((r: any) => r.metadata.prism_last_writer === "link"));
});

test("properties: a trashed page's properties are not writable (it is restored, not edited)", async () => {
  seed();
  assert.equal((await post("/properties/t4", { set: { status: "done" } }, login(OWNER))).status, 404);
  assert.equal(patches().length, 0);
});

// ── POST /api/properties/batch ───────────────────────────────────────────────

test("batch: each item is its own CAS write; refusals are per item and indistinguishable from missing", async () => {
  seed();
  grantUser("kai@test.local", "note", "t1", "edit");
  grantUser("kai@test.local", "note", "t2", "view");
  const r = await post("/properties/batch", {
    items: [
      { id: "t1", set: { status: "done" }, expect: { status: "todo" } },
      { id: "t2", set: { status: "done" }, expect: { status: "doing" } },
      { id: "t3", set: { status: "done" } },
      { id: "nope", set: { status: "done" } },
    ],
  }, login("kai@test.local"));
  assert.equal(r.status, 207);
  const { results } = (await r.json()) as any;
  assert.equal(results[0].ok, true);
  assert.equal(results[0].metadata.prism_creator, undefined);
  assert.deepEqual([results[1].ok, results[1].error], [false, "forbidden"]);
  assert.deepEqual(results[2], { id: "t3", ok: false, error: "not_found" }, "a private note reads exactly like a missing one");
  assert.deepEqual(results[3], { id: "nope", ok: false, error: "not_found" });
  assert.equal(fv.notes.get("t1")!.metadata!.status, "done");
  assert.equal(fv.notes.get("t1")!.metadata!.prism_last_writer, "kai@test.local");
  assert.equal(fv.notes.get("t2")!.metadata!.status, "doing");
  assert.equal(patches().length, 1);
});

test("batch: a stale expectation is a conflict with the current value; the rest are written", async () => {
  seed();
  const r = await post("/properties/batch", { items: [
    { id: "t1", set: { points: 5 }, expect: { points: 3 } },
    { id: "t2", set: { points: 5 }, expect: { points: 7 } },
  ] }, login(OWNER));
  assert.equal(r.status, 207);
  const { results } = (await r.json()) as any;
  assert.equal(results[0].ok, true);
  assert.deepEqual([results[1].error, results[1].fields, results[1].current], ["conflict", ["points"], { points: 8 }]);
  // Every item succeeded → 200.
  const ok = await post("/properties/batch", { items: [{ id: "t2", set: { points: 5 }, expect: { points: 8 } }] }, login(OWNER));
  assert.equal(ok.status, 200);
});

test("batch: bounded, validated as a whole, CSRF-guarded, never shadowed by /properties/:id", async () => {
  seed();
  const many = Array.from({ length: 101 }, (_, i) => ({ id: `n${i}`, set: { a: 1 } }));
  assert.equal((await post("/properties/batch", { items: many }, login(OWNER))).status, 400);
  assert.equal((await post("/properties/batch", { items: [] }, login(OWNER))).status, 400);
  assert.equal((await post("/properties/batch", { items: [{ id: "t1", set: { a: 1 } }, { id: "t1", set: { b: 1 } }] }, login(OWNER))).status, 400, "duplicate ids");
  assert.equal((await post("/properties/batch", { items: [{ id: "../t1", set: { a: 1 } }] }, login(OWNER))).status, 400, "strict ids");
  assert.equal((await post("/properties/batch", { items: [{ id: "t1", set: { prism_x: 1 } }] }, login(OWNER))).status, 400);
  assert.equal((await post("/properties/batch", { items: [{ id: "t1", set: { a: 1 } }] })).status, 401);
  assert.equal((await post("/properties/batch", { items: [{ id: "t1", set: { a: 1 } }] }, login(OWNER), { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("/properties/batch", { items: [{ id: "t1", set: { a: 1 } }] }, login(OWNER), { ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(patches().length, 0);
  const big = "x".repeat(600 * 1024);
  assert.equal((await req("/properties/batch", { method: "POST", cookie: login(OWNER), headers: J, body: JSON.stringify({ items: [{ id: "t1", set: { a: big } }] }) })).status, 413);
});

test("batch: items count against a per-actor write rate", async () => {
  seed();
  process.env.PROPERTY_BATCH_ITEMS_PER_MINUTE = "3";
  try {
    grantUser("rate@test.local", "tag", "task", "edit");
    const items = [{ id: "t1", set: { points: 1 } }, { id: "t2", set: { points: 1 } }];
    assert.notEqual((await post("/properties/batch", { items }, login("rate@test.local"))).status, 429);
    assert.equal((await post("/properties/batch", { items }, login("rate@test.local"))).status, 429);
  } finally {
    delete process.env.PROPERTY_BATCH_ITEMS_PER_MINUTE;
  }
});

// ── POST /api/databases/import/csv ───────────────────────────────────────────

const CSV = "Name,Status,Pts,Code,Extra\nAlpha,done,3,A-1,ignored\nNew one,todo,2,N-9,\nBad,maybe,1,X-1,\n";
const mapping = { Name: "$title", Status: "status", Pts: "points", Code: "sku", Extra: "" };
const importCsv = (body: Record<string, unknown>, cookie = login(OWNER)) =>
  post("/databases/import/csv", { tag: "task", csv: CSV, mapping, keyColumn: "Code", pathPrefix: "Projects/Launch", ...body }, cookie);

test("import: owner/admin only, CSRF-guarded, refuses Prism-managed tags", async () => {
  seed();
  grantUser("kai@test.local", "tag", "task", "edit");
  assert.equal((await importCsv({}, login("kai@test.local"))).status, 403);
  assert.equal((await post("/databases/import/csv", { tag: "task" })).status, 401);
  assert.equal((await post("/databases/import/csv", { tag: "task", csv: CSV, mapping, pathPrefix: "P" }, login(OWNER), { ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await importCsv({ tag: "agent-skill" })).status, 403);
  assert.equal((await importCsv({ tag: "prism-trashed" })).status, 403);
  assert.equal((await importCsv({ pathPrefix: "../etc" })).status, 400);
  assert.equal((await importCsv({ mapping: { Status: "status" } })).status, 400, "a title column is required");
  assert.equal((await importCsv({ mapping: { ...mapping, Code: "prism_creator" } })).status, 400);
  assert.equal(creates().length + patches().length, 0);
});

test("import: the dry run (the default) plans by key without writing anything", async () => {
  seed();
  const r = await importCsv({});
  assert.equal(r.status, 200);
  const body = (await r.json()) as any;
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.summary, { create: 1, update: 1, unchanged: 0, error: 1 });
  const alpha = body.sample.find((s: any) => s.title === "Alpha");
  assert.deepEqual([alpha.action, alpha.id, alpha.changes], ["update", "t1", ["status"]]);
  assert.deepEqual(body.errors, [{ row: 4, action: "error", title: "Bad", error: "Status: “maybe” is not an option" }]);
  assert.equal(creates().length + patches().length, 0);
});

test("import: writing creates and updates with CAS + writer stamp, and a re-run converges", async () => {
  seed();
  const r = await importCsv({ dryRun: false });
  assert.equal(r.status, 200);
  const body = (await r.json()) as any;
  assert.deepEqual(body.result, { created: 1, updated: 1, failed: [] });
  const made = [...fv.notes.values()].find((n) => n.metadata?.title === "New one")!;
  assert.equal(made.path, "Projects/Launch/New one");
  assert.deepEqual(made.tags, ["task"]);
  assert.deepEqual({ ...made.metadata }, { title: "New one", status: "todo", points: 2, sku: "N-9", prism_last_writer: OWNER });
  assert.equal(fv.notes.get("t1")!.metadata!.status, "done");
  assert.equal((patches()[0]!.body as any).if_updated_at, "2026-10-01T10:00:00.000Z");
  // Same file again: nothing new, nothing rewritten.
  const again = (await (await importCsv({ dryRun: false })).json()) as any;
  assert.deepEqual(again.summary, { create: 0, update: 0, unchanged: 2, error: 1 });
  assert.deepEqual(again.result, { created: 0, updated: 0, failed: [] });
  assert.equal(creates().length, 1);
  assert.equal(patches().length, 1);
});

test("import: ambiguous keys, repeated keys and the trash are row errors; bounds hold", async () => {
  seed();
  fv.put({ id: "t5", path: "Tasks/Twin", tags: ["task"], content: "", metadata: { title: "Twin", sku: "A-1" } });
  const csv = "Name,Code\nAlpha,A-1\nDup,Z-1\nDup2,Z-1\nOld printer,D-4\n";
  const body = (await (await importCsv({ csv, mapping: { Name: "$title", Code: "sku" } })).json()) as any;
  assert.deepEqual(body.errors.map((e: any) => [e.row, e.error]), [[2, "2 pages already have this Code"], [4, "Code repeats an earlier row"]]);
  // The trashed page is not a match: its key is free, so the row plans a create.
  assert.equal(body.sample.find((s: any) => s.title === "Old printer").action, "create");
  const rows = "Name\n" + Array.from({ length: 2001 }, (_, i) => `r${i}`).join("\n");
  assert.equal((await importCsv({ csv: rows, mapping: { Name: "$title" }, keyColumn: undefined })).status, 400);
  assert.equal((await importCsv({ csv: 'Name\n"open' })).status, 400);
});

test("import: a page changed between plan and write is reported, never overwritten", async () => {
  seed();
  fv.conflictOnNextWrite = true;
  const csv = "Name,Code,Status\nAlpha,A-1,done\n";
  const r = await importCsv({ csv, mapping: { Name: "$title", Code: "sku", Status: "status" }, dryRun: false });
  assert.equal(r.status, 207);
  const body = (await r.json()) as any;
  assert.deepEqual(body.result.failed, [{ row: 2, error: "changed since the preview; run the import again" }]);
  assert.equal(fv.notes.get("t1")!.metadata!.status, "todo");
});
