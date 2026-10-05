/**
 * Database calculations (NP-DB-26): the pure aggregate engine in
 * `@prism/core/database` and `/api/query {aggregates, groupBy}` through the REAL
 * gateway app against the fake vault. A figure covers every matching row the
 * CALLER may see — never the loaded page, never a hidden row.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
import { AGGREGATE_FNS, computeAggregates, groupValuesOf, numericValue, runQuery, validateQuerySpec, type AggregateFn, type QueryInput } from "@prism/core/database";
import { readDatabaseConfig } from "../../../packages/core/src/components/database/config";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

let fv: FakeVault;
let innerFetch: typeof fetch;
const vaultTags = () => [
  { name: "deal", count: 5, description: "Deals", fields: { stage: { type: "string", enum: ["lead", "won", "lost"] }, amount: { type: "number" }, close: { type: "string" }, paid: { type: "boolean" }, labels: { type: "array" } } },
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
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const login = (email: string) => sessionCookie(makeSession(email));
const J = { "content-type": "application/json" };
const query = (body: unknown, cookie?: string) => {
  const headers = new Headers(J);
  if (cookie) headers.set("cookie", cookie);
  return api.request("/query", { method: "POST", headers, body: JSON.stringify(body) });
};
const ask = async (body: unknown, cookie?: string) => (await (await query(body, cookie)).json()) as any;

const n = (id: string, metadata: Record<string, unknown>, extra: Partial<QueryInput> = {}): QueryInput => ({
  id, path: `Deals/${id}`, tags: ["deal"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", metadata, ...extra,
});
const ROWS: QueryInput[] = [
  n("a", { stage: "lead", amount: 100, close: "2026-03-01", paid: true, labels: ["x", "y"] }),
  n("b", { stage: "won", amount: "40", close: "2026-03-10/2026-03-20", paid: false, labels: ["x"] }),
  n("c", { stage: "won", amount: 60.5, close: "2026-02-15T10:00:00Z", labels: [] }),
  n("d", { stage: "", amount: "n/a", paid: true }),
  n("e", { amount: -0.5, close: "not a date" }),
];
const one = (key: string, fn: AggregateFn, rows = ROWS) => computeAggregates(rows, [{ key, fn }]).aggregates[key]![fn];

// ── engine ───────────────────────────────────────────────────────────────────

test("engine: the count family counts rows, values, distinct values and emptiness", () => {
  assert.equal(one("stage", "count_all"), 5);
  assert.equal(one("stage", "count_values"), 3, "an empty string is not a value");
  assert.equal(one("stage", "count_unique"), 2);
  assert.equal(one("stage", "count_empty"), 2);
  assert.equal(one("stage", "count_not_empty"), 3);
  assert.equal(one("stage", "percent_empty"), 0.4);
  assert.equal(one("stage", "percent_not_empty"), 0.6);
  // A multi-value property: every value counts, an empty list is empty.
  assert.equal(one("labels", "count_values"), 3);
  assert.equal(one("labels", "count_unique"), 2);
  assert.equal(one("labels", "count_empty"), 3);
  // Distinct like a filter compares: case and [[link]] brackets do not make a new value.
  assert.equal(one("who", "count_unique", [n("1", { who: "[[People/Ada]]" }), n("2", { who: "people/ada" }), n("3", { who: "Bo" })]), 2);
});

test("engine: number figures parse like the sort does and ignore what is not a number", () => {
  assert.equal(one("amount", "sum"), 200, "a numeric string is a number; 'n/a' is not");
  assert.equal(one("amount", "average"), 50);
  assert.equal(one("amount", "median"), 50.25);
  assert.equal(one("amount", "min"), -0.5);
  assert.equal(one("amount", "max"), 100);
  assert.equal(one("amount", "range"), 100.5);
  assert.equal(one("amount", "count_values"), 5, "count values still counts the text");
  assert.equal(one("amount", "median", ROWS.slice(0, 3)), 60.5, "an odd count takes the middle number");
  for (const fn of ["sum", "average", "median", "min", "max", "range"] as const) assert.equal(one("stage", fn), null, `${fn} of text is nothing, not 0`);
  assert.equal(numericValue(" 12.5 "), 12.5);
  assert.equal(numericValue(""), null);
  assert.equal(numericValue("1e999"), null);
  assert.equal(numericValue(true), null);
});

test("engine: dates read a range from its start to its end; the range is whole days", () => {
  assert.equal(one("close", "earliest"), "2026-02-15T10:00:00Z");
  assert.equal(one("close", "latest"), "2026-03-20", "the END of a range");
  assert.equal(one("close", "date_range"), 33);
  assert.equal(one("close", "date_range", [ROWS[0]!]), 0);
  assert.equal(one("close", "earliest", [ROWS[4]!]), null, "text that is not a date is skipped");
  assert.equal(one("$createdAt", "earliest"), "2026-01-01T00:00:00Z", "note columns are dates too");
  // The viewer's zone decides which day an instant falls on (23:30Z is the next day at UTC+2).
  const late = [n("x", { close: "2026-03-01T23:30:00Z" }), n("y", { close: "2026-03-01" })];
  assert.equal(computeAggregates(late, [{ key: "close", fn: "date_range" }], undefined, 0).aggregates.close!.date_range, 0);
  assert.equal(computeAggregates(late, [{ key: "close", fn: "date_range" }], undefined, -120).aggregates.close!.date_range, 1);
});

test("engine: checkbox figures; a missing value is unchecked", () => {
  assert.equal(one("paid", "checked"), 2);
  assert.equal(one("paid", "unchecked"), 3);
  assert.equal(one("paid", "percent_checked"), 0.4);
  assert.equal(one("paid", "percent_checked", []), null, "no rows: no share");
  assert.equal(one("paid", "count_all", []), 0);
});

test("engine: groups get the same figures and a count; multi-values join every group", () => {
  const r = computeAggregates(ROWS, [{ key: "amount", fn: "sum" }, { key: "amount", fn: "count_all" }], { key: "stage" });
  assert.deepEqual(r.aggregates, { amount: { sum: 200, count_all: 5 } }, "the grand total");
  const g = Object.fromEntries(r.groups!.map((x) => [String(x.value), x]));
  assert.deepEqual(g.lead, { value: "lead", count: 1, aggregates: { amount: { sum: 100, count_all: 1 } } });
  assert.deepEqual(g.won, { value: "won", count: 2, aggregates: { amount: { sum: 100.5, count_all: 2 } } });
  assert.deepEqual(g.null, { value: null, count: 2, aggregates: { amount: { sum: -0.5, count_all: 2 } } });
  const multi = computeAggregates(ROWS, [{ key: "amount", fn: "sum" }], { key: "labels" });
  assert.deepEqual(multi.groups!.map((x) => [x.value, x.count, x.aggregates.amount!.sum]), [["x", 2, 140], ["y", 1, 100], [null, 3, 60]]);
  const check = computeAggregates(ROWS, [], { key: "paid", checkbox: true });
  assert.deepEqual(check.groups!.map((x) => [x.value, x.count]), [["true", 2], ["false", 3]], "a checkbox has no empty group");
  assert.deepEqual(groupValuesOf(undefined), [null]);
  assert.deepEqual(groupValuesOf(7), ["7"]);
  // A grouping property with very many distinct values is cut, and says so.
  const many = Array.from({ length: 700 }, (_, i) => n(`m${i}`, { owner: `p${i}` }));
  const capped = computeAggregates(many, [], { key: "owner" });
  assert.equal(capped.groups!.length, 500);
  assert.equal(capped.groupsCapped, true);
});

test("engine: figures cover every MATCHING row — filter and search apply, the page size does not", () => {
  const page = runQuery(ROWS, { tags: ["deal"], limit: 1, filter: { match: "all", conditions: [{ key: "stage", op: "eq", value: "won" }] }, aggregates: [{ key: "amount", fn: "sum" }], groupBy: { key: "stage" } }, { limited: false });
  assert.equal(page.rows.length, 1);
  assert.equal(page.total, 2);
  assert.deepEqual(page.aggregates, { amount: { sum: 100.5 } });
  assert.deepEqual(page.groups, [{ value: "won", count: 2, aggregates: { amount: { sum: 100.5 } } }]);
  const none = runQuery(ROWS, { tags: ["deal"] }, { limited: false });
  assert.equal("aggregates" in none, false, "nothing is computed unless asked for");
  // A page template is not a row, so it is not in a figure either.
  const withTemplate = [...ROWS, n("t", { amount: 1000 }, { tags: ["deal", "template"] })];
  assert.equal(runQuery(withTemplate, { tags: ["deal"], aggregates: [{ key: "amount", fn: "sum" }] }, { limited: false }).aggregates!.amount!.sum, 200);
});

test("engine: bad aggregate requests are refused", () => {
  const bad = (extra: Record<string, unknown>) => assert.equal(validateQuerySpec({ tags: ["deal"], ...extra }).ok, false, JSON.stringify(extra));
  bad({ aggregates: "sum" });
  bad({ aggregates: [{ key: "amount", fn: "total" }] });
  bad({ aggregates: [{ key: "amount" }] });
  bad({ aggregates: [{ key: "__proto__", fn: "sum" }] });
  bad({ aggregates: [{ key: "a b", fn: "sum" }] });
  bad({ aggregates: [{ key: "amount", fn: "sum", extra: 1 }] });
  bad({ aggregates: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, fn: "sum" })) });
  bad({ groupBy: "stage" });
  bad({ groupBy: { key: "constructor" } });
  bad({ groupBy: { key: "stage", checkbox: "yes" } });
  bad({ groupBy: { key: "stage", limit: 5 } });
  const ok = validateQuerySpec({ tags: ["deal"], aggregates: [{ key: "amount", fn: "sum" }, { key: "amount", fn: "sum" }, { key: "$createdAt", fn: "earliest" }], groupBy: { key: "paid", checkbox: true } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.spec.aggregates, [{ key: "amount", fn: "sum" }, { key: "$createdAt", fn: "earliest" }], "duplicates collapse");
  assert.deepEqual(ok.ok && ok.spec.groupBy, { key: "paid", checkbox: true });
  assert.ok(validateQuerySpec({ tags: ["deal"], aggregates: AGGREGATE_FNS.map((fn) => ({ key: "amount", fn })) }).ok, "every function is a valid request");
});

test("engine: 20,000 rows, every function, grouped — within the budget", () => {
  const stages = ["lead", "won", "lost", "", "hold"];
  const rows: QueryInput[] = Array.from({ length: 20_000 }, (_, i) => n(`r${i}`, {
    stage: stages[i % 5], amount: i % 7 === 0 ? `${i}` : i * 1.5, close: i % 3 ? `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}` : `2026-01-0${(i % 9) + 1}T08:00:00Z/2026-02-1${i % 9}`,
    paid: i % 2 === 0, labels: [`l${i % 40}`, `m${i % 3}`], owner: `[[People/P${i % 300}]]`,
  }));
  const requests = [
    ...(["count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"] as const).map((fn) => ({ key: "owner", fn })),
    ...(["sum", "average", "median", "min", "max", "range"] as const).map((fn) => ({ key: "amount", fn })),
    ...(["earliest", "latest", "date_range"] as const).map((fn) => ({ key: "close", fn })),
    ...(["checked", "unchecked", "percent_checked"] as const).map((fn) => ({ key: "paid", fn })),
    { key: "labels", fn: "count_unique" as const },
  ];
  assert.equal(requests.length, 20);
  assert.equal(new Set(requests.map((r) => r.fn)).size, AGGREGATE_FNS.length, "every function is exercised");
  computeAggregates(rows.slice(0, 2000), requests, { key: "stage" }); // warm the JIT
  let best = Infinity;
  let out: ReturnType<typeof computeAggregates> | null = null;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    out = computeAggregates(rows, requests, { key: "stage" });
    best = Math.min(best, performance.now() - t0);
  }
  assert.equal(out!.aggregates.owner!.count_all, 20_000);
  assert.equal(out!.aggregates.owner!.count_unique, 300);
  assert.equal(out!.aggregates.paid!.checked, 10_000);
  assert.equal(out!.groups!.length, 5);
  assert.equal(out!.groups!.reduce((s, g) => s + g.count, 0), 20_000);
  assert.ok(best < 50, `all aggregates over 20k rows took ${best.toFixed(1)} ms (budget 50)`);
});

test("config: a view's calculations are validated; an unknown function fails closed", () => {
  const cfg = (view: Record<string, unknown>) => ({ prism_database: { version: 1, source: { tags: ["deal"] }, views: [{ id: "t", name: "Table", type: "table", ...view }] } });
  assert.deepEqual(readDatabaseConfig(cfg({ calculations: { amount: "sum", $createdAt: "earliest" }, wrap: true }))!.views[0]!.calculations, { amount: "sum", $createdAt: "earliest" });
  for (const bad of [{ calculations: { amount: "total" } }, { calculations: ["sum"] }, { calculations: { "a b": "sum" } }, { calculations: { amount: 1 } }, { calculations: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "sum"])) }, { wrap: "yes" }]) {
    assert.throws(() => readDatabaseConfig(cfg(bad)), /does not understand/, JSON.stringify(bad));
  }
});

// ── POST /api/query ──────────────────────────────────────────────────────────

function seed() {
  fv.put({ id: "d1", path: "Deals/One", tags: ["deal"], content: "", metadata: { title: "One", stage: "lead", amount: 100, close: "2026-03-01", paid: true }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "d2", path: "Deals/Two", tags: ["deal"], content: "", metadata: { title: "Two", stage: "won", amount: 40, close: "2026-03-10", paid: false }, updatedAt: "2026-10-01T11:00:00.000Z" });
  fv.put({ id: "d3", path: "Deals/Three", tags: ["deal"], content: "", metadata: { title: "Three", stage: "won", amount: 60 }, updatedAt: "2026-10-01T12:00:00.000Z" });
  // Someone else's private page, a trashed page and a template: never rows, never in a figure.
  fv.put({ id: "d4", path: "Deals/Secret", tags: ["deal"], content: "", metadata: { title: "Secret", stage: "won", amount: 5000, close: "2030-01-01", paid: true, prism_creator: "x@test.local", prism_visibility: "private" }, updatedAt: "2026-10-01T13:00:00.000Z" });
  fv.put({ id: "d5", path: "Deals/Old", tags: ["deal", "prism-trashed"], content: "", metadata: { title: "Old", stage: "lost", amount: 900 }, updatedAt: "2026-10-01T09:00:00.000Z" });
  fv.put({ id: "d6", path: "Templates/Deal", tags: ["deal", "template"], content: "", metadata: { title: "Deal template", amount: 7000 }, updatedAt: "2026-10-01T08:00:00.000Z" });
}
const CALC = [{ key: "amount", fn: "sum" }, { key: "amount", fn: "count_all" }, { key: "amount", fn: "max" }, { key: "close", fn: "latest" }, { key: "paid", fn: "checked" }, { key: "stage", fn: "count_unique" }];

test("query: the owner's figures cover the whole view, not the page", async () => {
  seed();
  const r = await ask({ tags: ["deal"], limit: 1, fields: ["stage"], aggregates: CALC }, login(OWNER));
  assert.equal(r.rows.length, 1);
  assert.equal(r.total, 4, "the owner sees the private page; trash and templates are not rows");
  assert.deepEqual(r.aggregates, { amount: { sum: 5200, count_all: 4, max: 5000 }, close: { latest: "2030-01-01" }, paid: { checked: 2 }, stage: { count_unique: 2 } });
  assert.equal("groups" in r, false);
  // Filter + search narrow the figure exactly as they narrow the rows.
  const won = await ask({ tags: ["deal"], filter: { match: "all", conditions: [{ key: "stage", op: "eq", value: "won" }] }, search: "t", aggregates: [{ key: "amount", fn: "sum" }] }, login(OWNER));
  assert.deepEqual(won.rows.map((x: any) => x.id).sort(), ["d2", "d3", "d4"]);
  assert.equal(won.aggregates.amount.sum, 5100);
  const plain = await ask({ tags: ["deal"] }, login(OWNER));
  assert.equal("aggregates" in plain, false, "no calculation unless one is asked for");
});

test("query: a row the caller cannot view never changes a figure", async () => {
  seed();
  grantUser("kai@test.local", "tag", "deal", "view");
  const kai = login("kai@test.local");
  const r = await ask({ tags: ["deal"], fields: ["stage"], aggregates: CALC, groupBy: { key: "stage" } }, kai);
  assert.equal(r.total, 3);
  assert.equal(r.limited, true);
  assert.deepEqual(r.aggregates, { amount: { sum: 200, count_all: 3, max: 100 }, close: { latest: "2026-03-10" }, paid: { checked: 1 }, stage: { count_unique: 2 } });
  assert.deepEqual(r.groups.map((g: any) => [g.value, g.count, g.aggregates.amount.sum]).sort(), [["lead", 1, 100], ["won", 2, 100]], "the hidden 'won' deal is in no group");
  assert.equal(JSON.stringify(r).includes("5000"), false);
  assert.equal(JSON.stringify(r).includes("2030"), false);
  // The hidden page changing changes nothing for this caller.
  resetDatabaseCachesForTests();
  fv.put({ ...fv.notes.get("d4")!, metadata: { ...fv.notes.get("d4")!.metadata, amount: 1, stage: "lead", paid: false } });
  assert.deepEqual((await ask({ tags: ["deal"], aggregates: CALC, groupBy: { key: "stage" } }, kai)).aggregates, r.aggregates);

  // One page shared with one person: every figure is that page.
  const { addGrant } = await import("../src/db");
  addGrant({ subject_type: "user", subject: "nina@test.local", resource_type: "note", resource: "d2", level: "view", created_by: "test" });
  const nina = await ask({ tags: ["deal"], aggregates: CALC }, login("nina@test.local"));
  assert.deepEqual(nina.aggregates, { amount: { sum: 40, count_all: 1, max: 40 }, close: { latest: "2026-03-10" }, paid: { checked: 0 }, stage: { count_unique: 1 } });

  // No view at all: an empty answer with no figures and no vault listing.
  const listings = () => fv.calls.filter((call) => call.method === "GET" && call.path.endsWith("/notes") && /[?&]tag=/.test(call.search)).length;
  const before = listings();
  const blind = await ask({ tags: ["deal"], aggregates: CALC }, login("nobody@test.local"));
  assert.deepEqual(blind.rows, []);
  assert.equal("aggregates" in blind, false);
  assert.equal(listings(), before);
  assert.equal((await query({ tags: ["deal"], aggregates: CALC })).status, 401);
});

test("query: the access keys are no calculation oracle; a link sees no identity figure", async () => {
  seed();
  fv.put({ id: "d7", path: "Deals/Mine", tags: ["deal"], content: "", metadata: { title: "Mine", amount: 1, prism_creator: "kai@test.local", prism_visibility: "private" }, updatedAt: "2026-10-01T14:00:00.000Z" });
  grantUser("kai@test.local", "tag", "deal", "view");
  const probe = [{ key: "prism_visibility", fn: "count_unique" }, { key: "prism_creator", fn: "count_values" }, { key: "amount", fn: "count_all" }];
  const kai = await ask({ tags: ["deal"], fields: ["stage"], aggregates: probe, groupBy: { key: "prism_visibility" } }, login("kai@test.local"));
  assert.deepEqual(kai.aggregates, { amount: { count_all: 4 } }, "keys a row would not carry are not aggregated");
  assert.equal("groups" in kai, false);
  const owner = await ask({ tags: ["deal"], aggregates: probe }, login(OWNER));
  assert.equal(owner.aggregates.prism_creator.count_values, 2, "the owner receives them in rows, so may count them");

  fv.put({ ...fv.notes.get("d1")!, metadata: { ...fv.notes.get("d1")!.metadata, prism_last_writer: "u_0123456789abcdef" } });
  resetDatabaseCachesForTests();
  const cap = makeCapability("tag", "deal", "view");
  const viaLink = (await (await api.request("/query", { method: "POST", headers: { ...J, authorization: `Capability ${cap}` }, body: JSON.stringify({ tags: ["deal"], aggregates: [...probe, { key: "prism_last_writer", fn: "count_unique" }] }) })).json()) as any;
  assert.equal(viaLink.total, 3, "a link never sees a private page");
  assert.equal(viaLink.aggregates.amount.count_all, 3);
  assert.equal("prism_creator" in viaLink.aggregates, false);
  assert.equal(viaLink.aggregates.prism_last_writer.count_unique, 0, "identity keys are stripped before the engine");
});

test("query: a truncated scan says so, and hidden rows never make it truncated", async () => {
  for (let i = 0; i < 6; i++) fv.put({ id: `h${i}`, tags: ["deal"], metadata: { title: `Hidden ${i}`, amount: 1000, prism_creator: "x@test.local", prism_visibility: "private" }, updatedAt: `2026-10-0${i + 1}T00:00:00.000Z` });
  fv.put({ id: "v1", tags: ["deal"], metadata: { title: "Visible", amount: 7 }, updatedAt: "2026-01-01T00:00:00.000Z" });
  grantUser("kai@test.local", "tag", "deal", "view");
  process.env.QUERY_SCAN_MAX = "3";
  try {
    const member = await ask({ tags: ["deal"], aggregates: [{ key: "amount", fn: "sum" }] }, login("kai@test.local"));
    assert.equal(member.truncated, false);
    assert.equal(member.aggregates.amount.sum, 7, "the visible row past the raw cut is the whole figure");
    const owner = await ask({ tags: ["deal"], aggregates: [{ key: "amount", fn: "sum" }, { key: "amount", fn: "count_all" }] }, login(OWNER));
    assert.equal(owner.truncated, true, "the figure is partial and the response says so");
    assert.deepEqual(owner.aggregates.amount, { sum: 3000, count_all: 3 });
  } finally {
    delete process.env.QUERY_SCAN_MAX;
  }
});

test("query: bad calculation requests are 400; a calculation costs no extra vault call", async () => {
  seed();
  const owner = login(OWNER);
  for (const body of [{ aggregates: [{ key: "amount", fn: "total" }] }, { aggregates: {} }, { aggregates: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, fn: "sum" })) }, { groupBy: "stage" }, { groupBy: { key: "a.b" } }]) {
    const res = await query({ tags: ["deal"], ...body }, owner);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(((await res.json()) as any).error, "bad_request");
  }
  const lists = () => fv.calls.filter((call) => call.method === "GET" && call.path.endsWith("/notes") && /[?&]tag=/.test(call.search)).length;
  await ask({ tags: ["deal"], fields: ["stage"] }, owner);
  const after = lists();
  await ask({ tags: ["deal"], fields: ["stage"], limit: 1, aggregates: CALC, groupBy: { key: "stage" } }, owner);
  assert.equal(lists(), after, "the figures come from the listing the rows came from");
  // A cursor belongs to its query, calculations included.
  const p1 = await ask({ tags: ["deal"], limit: 1, aggregates: [{ key: "amount", fn: "sum" }] }, owner);
  const p2 = await ask({ tags: ["deal"], limit: 1, cursor: p1.next, aggregates: [{ key: "amount", fn: "sum" }] }, owner);
  assert.equal(p2.aggregates.amount.sum, 5200, "every page carries the same whole-view figure");
});
