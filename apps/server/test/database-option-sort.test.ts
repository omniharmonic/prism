/**
 * A select / status column sorts by the order of its OPTIONS, not by its stored text.
 *
 *  - the pure engine (`sortRows` / `runQuery` with `optionOrders`, `sortOptionOrders`),
 *    which the client fallback runs too;
 *  - `POST /api/query` through the real gateway app against the fake vault: the order
 *    comes from the vault enum, and from the `optionOrder` hint once an owner reorders.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runQuery, sortOptionOrders, sortRows, type QueryInput, type SchemaMap } from "@prism/core/database";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const n = (id: string, metadata: Record<string, unknown>): QueryInput => ({
  id, path: `Notes/${id}`, tags: ["task"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", metadata,
});
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

// ── the pure engine ──────────────────────────────────────────────────────────

const ROWS = [
  n("a", { status: "done" }),
  n("b", { status: "todo" }),
  n("c", { status: "in-progress" }),
  n("d", {}),
  n("e", { status: "todo" }),
  n("f", { status: "zebra" }),
  n("g", { status: "archived" }),
];
const ORDER = { status: ["todo", "in-progress", "done"] };

test("engine: a key with an option order sorts by option position, not A→Z", () => {
  // Without an order: the stored text, A→Z (what every such column did before).
  assert.deepEqual(ids(sortRows(ROWS, [{ key: "status", dir: "asc" }])), ["g", "a", "c", "b", "e", "f", "d"]);
  // With one: first option first; values that are no option after every option (A→Z among themselves); missing last.
  assert.deepEqual(ids(sortRows(ROWS, [{ key: "status", dir: "asc" }], 0, ORDER)), ["b", "e", "c", "a", "g", "f", "d"]);
});

test("engine: descending reverses the options; unknown values and missing values stay last", () => {
  assert.deepEqual(ids(sortRows(ROWS, [{ key: "status", dir: "desc" }], 0, ORDER)), ["a", "c", "b", "e", "f", "g", "d"]);
});

test("engine: the sort is stable — equal options keep the next key's order, then the id", () => {
  const rows = [n("z", { status: "todo", points: 1 }), n("y", { status: "todo", points: 9 }), n("x", { status: "done", points: 5 }), n("w", { status: "todo", points: 9 })];
  assert.deepEqual(ids(sortRows(rows, [{ key: "status", dir: "asc" }, { key: "points", dir: "desc" }], 0, ORDER)), ["w", "y", "z", "x"]);
  // Only the key that HAS an order uses it: `points` is still a number.
  assert.deepEqual(ids(sortRows(rows, [{ key: "points", dir: "asc" }, { key: "status", dir: "desc" }], 0, ORDER)), ["z", "x", "w", "y"]);
});

test("engine: a multi-value cell sorts by its first value's option; case and [[ ]] do not hide an option", () => {
  const rows = [n("a", { labels: ["low", "high"] }), n("b", { labels: ["High"] }), n("c", { labels: ["[[medium]]"] }), n("d", { labels: [] })];
  assert.deepEqual(ids(sortRows(rows, [{ key: "labels", dir: "asc" }], 0, { labels: ["high", "medium", "low"] })), ["b", "c", "a", "d"]);
});

test("engine: runQuery pages in option order and an order for another key changes nothing", () => {
  const spec = { tags: ["task"], sort: [{ key: "status", dir: "asc" as const }], limit: 3 };
  const p1 = runQuery(ROWS, spec, { limited: false, optionOrders: ORDER });
  const p2 = runQuery(ROWS, { ...spec, cursor: p1.next }, { limited: false, optionOrders: ORDER });
  assert.deepEqual([...ids(p1.rows), ...ids(p2.rows)], ["b", "e", "c", "a", "g", "f"]);
  assert.deepEqual(ids(runQuery(ROWS, { ...spec, limit: 10 }, { limited: false, optionOrders: { priority: ["x"] } }).rows), ["g", "a", "c", "b", "e", "f", "d"]);
  // A hostile / odd order object is data: prototype names and non-lists are ignored.
  const odd = JSON.parse('{"__proto__": ["x"], "status": "todo"}') as Record<string, string[]>;
  assert.deepEqual(ids(runQuery(ROWS, { ...spec, limit: 10 }, { limited: false, optionOrders: odd }).rows), ["g", "a", "c", "b", "e", "f", "d"]);
});

test("engine: the option order is read ONCE per sort (a rank map), never scanned per comparison", () => {
  const options = Array.from({ length: 400 }, (_, i) => `opt-${String(i).padStart(3, "0")}`);
  // Count every read of an option out of the order list: a per-comparison `indexOf` would read
  // it hundreds of times per comparison (millions here); building the map reads each option once.
  let reads = 0;
  const counted = new Proxy([...options].reverse(), {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const rows = Array.from({ length: 5_000 }, (_, i) => n(`r${String(i).padStart(5, "0")}`, { status: options[(i * 7919) % options.length] }));
  const sorted = sortRows(rows, [{ key: "status", dir: "asc" }], 0, { status: counted });
  assert.equal(sorted[0]!.metadata!.status, "opt-399");
  assert.equal(sorted[sorted.length - 1]!.metadata!.status, "opt-000");
  assert.ok(reads <= options.length * 2, `the order list was read ${reads} times for ${rows.length} rows`);
  // And the same count whatever the number of rows.
  const before = reads;
  sortRows(rows.slice(0, 50), [{ key: "status", dir: "desc" }], 0, { status: counted });
  assert.equal(reads - before, before);
});

test("sortOptionOrders: the optionOrder hint, then the enum; hidden options after; a status by its groups; only option properties", () => {
  const schemas: SchemaMap = {
    task: {
      description: null,
      fields: {
        status: { type: "string", enum: ["done", "in-progress", "todo", "wontfix"], optionOrder: ["todo", "in-progress"], hiddenOptions: ["wontfix"] },
        priority: { type: "string", enum: ["low", "high"] },
        // A SELECT whose options are status words keeps its plain option order (groups are a status thing).
        stage: { type: "string", enum: ["done", "todo", "doing"], kind: "select" },
        labels: { type: "array", enum: ["b", "a"] },
        due: { type: "string" },
        gone: { type: "string", enum: ["x", "y"], deleted: true },
        free: { kind: "select", colors: { later: "gray", now: "red" }, optionOrder: ["now", "later"] },
      },
    },
    other: { description: null, fields: { gone: { type: "string", enum: ["p", "q"] }, status: { type: "string", enum: ["never", "used"] } } },
  };
  const out = sortOptionOrders(["task", "other"], schemas, ["status", "priority", "stage", "labels", "due", "gone", "free", "missing", "$title", "__proto__", "status"]);
  assert.deepEqual(out, {
    // To-do → In progress → Complete; "wontfix" (no longer offered) reads as in progress and sorts with that group, after its shown options.
    status: ["todo", "in-progress", "wontfix", "done"],
    priority: ["low", "high"],
    stage: ["done", "todo", "doing"],
    labels: ["b", "a"],
    gone: ["p", "q"], // deleted on `task`, live on `other`
    free: ["now", "later"],
  });
  assert.deepEqual(sortOptionOrders(["task"], new Map(Object.entries(schemas)), ["priority"]), { priority: ["low", "high"] });
});

test("sortOptionOrders: a status sorts To-do → In progress → Complete, option order inside a group — by the statusGroups hint, else the word", () => {
  const status = (extra: Record<string, unknown>): SchemaMap => ({ task: { description: null, fields: { status: { type: "string", enum: ["shipped", "review", "backlog", "building", "idea", "cancelled"], ...extra } } } });
  // No hints: the words decide (backlog = to-do; shipped / cancelled = complete; the rest in progress), enum order inside each.
  assert.deepEqual(sortOptionOrders(["task"], status({}), ["status"]).status, ["backlog", "review", "building", "idea", "shipped", "cancelled"]);
  // The owner's groups win over the words, and the owner's option order holds INSIDE each group.
  const hinted = status({ statusGroups: { idea: "todo", review: "complete", cancelled: "todo" }, optionOrder: ["cancelled", "building", "shipped", "idea"] });
  assert.deepEqual(sortOptionOrders(["task"], hinted, ["status"]).status, ["cancelled", "idea", "backlog", "building", "shipped", "review"]);
  // The same options as a plain select: option order only.
  assert.deepEqual(sortOptionOrders(["task"], status({ kind: "select", optionOrder: ["cancelled", "building", "shipped", "idea"] }), ["status"]).status, ["cancelled", "building", "shipped", "idea", "review", "backlog"]);
  // A bad group name in a hint is ignored (the word decides); every option is still in the order exactly once.
  const odd = sortOptionOrders(["task"], status({ statusGroups: { idea: "nonsense" } as never }), ["status"]).status!;
  assert.deepEqual([...odd].sort(), ["backlog", "building", "cancelled", "idea", "review", "shipped"]);
  // End to end through the engine: grouped ascending, reversed descending, a non-option and an empty value last both ways.
  const rows = [n("a", { status: "shipped" }), n("b", { status: "idea" }), n("c", { status: "backlog" }), n("d", { status: "mystery" }), n("e", {}), n("f", { status: "review" }), n("g", { status: "backlog" })];
  const orders = sortOptionOrders(["task"], status({}), ["status"]);
  assert.deepEqual(ids(sortRows(rows, [{ key: "status", dir: "asc" }], 0, orders)), ["c", "g", "f", "b", "a", "d", "e"]);
  assert.deepEqual(ids(sortRows(rows, [{ key: "status", dir: "desc" }], 0, orders)), ["a", "b", "f", "c", "g", "d", "e"]);
});

// ── POST /api/query ──────────────────────────────────────────────────────────

let fv: FakeVault;
let vaultTags: Array<{ name: string; description: string | null; fields: Record<string, unknown> }>;
let innerFetch: typeof fetch;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  // The status enum is deliberately neither alphabetical nor in workflow order: done, todo, in-progress.
  vaultTags = [{ name: "task", description: "Work", fields: { status: { type: "string", enum: ["done", "todo", "in-progress"] }, priority: { type: "string", enum: ["urgent", "normal", "low"] }, note: { type: "string" } } }];
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") return Response.json(vaultTags);
    return innerFetch(input, init);
  }) as typeof fetch;
  setSchemaAdminMinter(async () => "admin-jwt-for-test");
  fv.put({ id: "t1", path: "Tasks/One", tags: ["task"], content: "", metadata: { title: "One", status: "done", priority: "low", note: "b" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "t2", path: "Tasks/Two", tags: ["task"], content: "", metadata: { title: "Two", status: "todo", priority: "normal", note: "c" }, updatedAt: "2026-10-01T11:00:00.000Z" });
  fv.put({ id: "t3", path: "Tasks/Three", tags: ["task"], content: "", metadata: { title: "Three", status: "in-progress", priority: "urgent", note: "a" }, updatedAt: "2026-10-01T12:00:00.000Z" });
  fv.put({ id: "t4", path: "Tasks/Four", tags: ["task"], content: "", metadata: { title: "Four", status: "someday" }, updatedAt: "2026-10-01T13:00:00.000Z" });
  fv.put({ id: "t5", path: "Tasks/Five", tags: ["task"], content: "", metadata: { title: "Five" }, updatedAt: "2026-10-01T14:00:00.000Z" });
});
afterEach(() => {
  setSchemaAdminMinter(null);
  globalThis.fetch = innerFetch;
  fv.restore();
});

const OWNER = "owner@test.local";
const J = { "content-type": "application/json" };
const login = (email: string) => sessionCookie(makeSession(email));
const post = (path: string, body: unknown, cookie: string, method = "POST") => {
  const headers = new Headers(J);
  headers.set("cookie", cookie);
  return api.request(path, { method, headers, body: JSON.stringify(body) });
};
const sortedIds = async (sort: Array<{ key: string; dir: "asc" | "desc" }>, cookie = login(OWNER)) => {
  const r = await post("/query", { tags: ["task"], sort, fields: ["status", "priority", "note"] }, cookie);
  assert.equal(r.status, 200);
  return ((await r.json()) as { rows: Array<{ id: string }> }).rows.map((x) => x.id);
};

test("query: a status column sorts by its groups (To-do → In progress → Complete), a select by its option order; unknown then missing last", async () => {
  assert.deepEqual(await sortedIds([{ key: "status", dir: "asc" }]), ["t2", "t3", "t1", "t4", "t5"]);
  assert.deepEqual(await sortedIds([{ key: "status", dir: "desc" }]), ["t1", "t3", "t2", "t4", "t5"]);
  assert.deepEqual(await sortedIds([{ key: "priority", dir: "asc" }]), ["t3", "t2", "t1", "t4", "t5"], "a select too: urgent → normal → low");
  assert.deepEqual(await sortedIds([{ key: "note", dir: "asc" }]), ["t3", "t1", "t2", "t4", "t5"], "plain text still sorts A→Z");
});

test("query: an owner's status groups and option order (hints) change the sort at once; a select follows its reorder", async () => {
  // "done" is moved to the To-do group, and the options are listed in-progress, done, todo:
  // To-do (done, todo — their option order) comes before In progress whatever the list says.
  const r = await post("/schemas/task", { ui: { status: { statusGroups: { done: "todo" }, optionOrder: ["in-progress", "done", "todo"] }, priority: { optionOrder: ["low", "urgent", "normal"] } } }, login(OWNER), "PUT");
  assert.equal(r.status, 200);
  assert.deepEqual(await sortedIds([{ key: "status", dir: "asc" }]), ["t1", "t2", "t3", "t4", "t5"]);
  assert.deepEqual(await sortedIds([{ key: "status", dir: "desc" }]), ["t3", "t2", "t1", "t4", "t5"]);
  assert.deepEqual(await sortedIds([{ key: "priority", dir: "asc" }]), ["t1", "t3", "t2", "t4", "t5"]);
  // Shown as a plain select instead, the same property follows its option order alone.
  assert.equal((await post("/schemas/task", { ui: { status: { kind: "select" } } }, login(OWNER), "PUT")).status, 200);
  assert.deepEqual(await sortedIds([{ key: "status", dir: "asc" }]), ["t3", "t1", "t2", "t4", "t5"]);
});

test("query: a member's view sorts by the same option order", async () => {
  grantUser("kai@test.local", "tag", "task", "view");
  assert.deepEqual(await sortedIds([{ key: "status", dir: "asc" }], login("kai@test.local")), ["t2", "t3", "t1", "t4", "t5"]);
});
