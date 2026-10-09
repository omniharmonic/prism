/**
 * Structured property values (`members: [{name, role}]`): the ONE formatter
 * (`@prism/core/database` structured.ts), the query engine on object values, and
 * the write rule — through the REAL gateway app against the fake vault. Proves no
 * surface prints `[object Object]`, nothing throws on a hostile object, and no
 * property route / CSV import ever replaces objects with text.
 */
// Timed in CPU time of this thread (./probe), never on the wall clock: the figure is the work, not the machine's load.
import { threadCpuMs } from "./probe";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  coerceToKind,
  coerceValue,
  compareValues,
  computeAggregates,
  formatValue,
  groupValuesOf,
  isStructuredValue,
  matchesSearch,
  refuseStructuredWrite,
  runQuery,
  scalarText,
  sortRows,
  structuredItems,
  valueText,
  evaluateCondition,
  type QueryInput,
} from "@prism/core/database";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const MEMBERS = [{ name: "Benjamin Life", role: "delegate" }, { name: "Patricia Parkinson", role: "delegate" }];
const BAD = "[object Object]";

// ── the formatter ────────────────────────────────────────────────────────────

test("formatter: objects read as “name — role”, never [object Object]", () => {
  assert.equal(valueText(MEMBERS), "Benjamin Life — delegate, Patricia Parkinson — delegate");
  assert.deepEqual(structuredItems(MEMBERS).map((i) => [i.label, i.detail, i.structured]), [["Benjamin Life", "delegate", true], ["Patricia Parkinson", "delegate", true]]);
  for (const kind of ["text", "multi_select", "person", "relation", "select", "number", "date", "files", "url"] as const) {
    assert.ok(!formatValue({ kind, options: [] }, MEMBERS).includes(BAD), kind);
    assert.ok(!formatValue({ kind, options: [] }, MEMBERS[0]).includes(BAD), kind);
  }
});

test("formatter: label keys, wikilinks, a link to open, and the key: value fallback", () => {
  const [a] = structuredItems([{ person: "[[vault/people/Ada Lovelace]]", role: "chair" }]);
  assert.deepEqual([a!.label, a!.detail, a!.link, a!.text], ["Ada Lovelace", "chair", "[[vault/people/Ada Lovelace]]", "Ada Lovelace — chair"]);
  // A page link among the naming keys is what the chip opens, even when a plain name is the label.
  assert.equal(structuredItems([{ name: "Ada", page: "[[vault/people/Ada Lovelace]]" }])[0]!.link, "[[vault/people/Ada Lovelace]]");
  // A container note's link is named by its folder, like every relation chip.
  assert.equal(valueText({ title: "[[vault/projects/opencivics/PROJECT]]" }), "opencivics");
  assert.equal(valueText({ email: "ada@example.org" }), "ada@example.org");
  assert.equal(valueText({ id: 42 }), "42");
  assert.equal(valueText({ person: { name: "Grace" }, role: "lead" }), "Grace — lead");
  // Nothing names it: a compact summary of what it holds.
  assert.equal(valueText({ amount: 5, currency: "USD", paid: true, extra: "x" }), "amount: 5, currency: USD, paid: Yes, …");
  assert.equal(valueText({}), "");
  // Mixed lists, numbers and booleans inside lists, nested lists.
  assert.equal(valueText([1, true, "x", ["a", "b"], null, ""]), "1, Yes, x, a, b");
  assert.equal(valueText("[[vault/people/Ada|Ada L]]"), "Ada L");
  assert.equal(valueText(null), "");
  assert.equal(isStructuredValue(["a", 1, true]), false);
  assert.equal(isStructuredValue([["a"]]), true);
  assert.equal(isStructuredValue({}), true);
  assert.equal(isStructuredValue("x"), false);
});

test("formatter: hostile and huge values are bounded and never throw", () => {
  // `String()` throws on these; they are plain data here.
  const hostile = JSON.parse('{"toString": 1, "valueOf": 2, "__proto__": {"name": "nope"}, "constructor": "c"}');
  assert.doesNotThrow(() => valueText(hostile));
  assert.doesNotThrow(() => scalarText([hostile]));
  assert.ok(!valueText(hostile).includes(BAD));
  let deep: unknown = { name: "bottom" };
  for (let i = 0; i < 5000; i++) deep = { wrap: deep };
  assert.doesNotThrow(() => valueText(deep));
  const wide = Array.from({ length: 200_000 }, (_, i) => ({ name: `n${i}`, role: "x".repeat(50) }));
  const t0 = threadCpuMs();
  const text = valueText(wide);
  const items = structuredItems(wide);
  assert.ok(threadCpuMs() - t0 < 200, "bounded work on a 200k-item list");
  assert.ok(text.length <= 160 && items.length <= 50);
  const fat = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, { a: i }]));
  assert.ok(valueText(fat).length <= 160);
});

// ── the query engine ─────────────────────────────────────────────────────────

const row = (id: string, members: unknown, extra: Record<string, unknown> = {}): QueryInput =>
  ({ id, path: `Circles/${id}`, tags: ["circle"], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", metadata: { title: id, members, ...extra } });

test("engine: sort, filter, search, group and count over object values do not throw and read the names", () => {
  const hostile = JSON.parse('{"toString": 1}');
  const rows = [
    row("c", [{ name: "Zed", role: "member" }]),
    row("a", MEMBERS),
    row("b", { name: "Mia" }),
    row("d", [hostile]),
    row("e", null),
  ];
  const sorted = sortRows(rows, [{ key: "members", dir: "asc" }]).map((r) => r.id);
  assert.deepEqual(sorted.filter((id) => "abc".includes(id)), ["a", "b", "c"]); // Benjamin, Mia, Zed — by name
  assert.equal(sorted.at(-1), "e"); // empty last
  assert.doesNotThrow(() => compareValues(hostile, MEMBERS[0]));
  const cond = (op: "contains" | "eq" | "ne" | "exists" | "gt", value?: unknown) => rows.filter((r) => evaluateCondition(r, { key: "members", op, value } as never)).map((r) => r.id);
  assert.deepEqual(cond("contains", "patricia"), ["a"]);
  assert.deepEqual(cond("contains", "delegate"), ["a"]);
  assert.deepEqual(cond("exists"), ["c", "a", "b", "d"]);
  assert.doesNotThrow(() => cond("eq", "Mia"));
  assert.doesNotThrow(() => cond("ne", "Mia"));
  assert.doesNotThrow(() => cond("gt", 3));
  assert.equal(matchesSearch(rows[1]!, "parkinson", undefined), true);
  assert.equal(matchesSearch(rows[0]!, "parkinson", undefined), false);
  assert.deepEqual(groupValuesOf(MEMBERS), ["Benjamin Life — delegate", "Patricia Parkinson — delegate"]);
  assert.ok(!groupValuesOf([hostile]).includes(BAD));
  const calc = computeAggregates(rows, [{ key: "members", fn: "count_unique" }, { key: "members", fn: "count_values" }, { key: "members", fn: "sum" }], { key: "members" });
  assert.ok(calc);
  assert.ok(!JSON.stringify(calc).includes(BAD));
  const page = runQuery(rows, { tags: ["circle"], sort: [{ key: "members", dir: "desc" }], search: "mia" }, { limited: false });
  assert.deepEqual(page.rows.map((r) => r.id), ["b"]);
  // The stored objects come back whole.
  assert.deepEqual(runQuery(rows, { tags: ["circle"], filter: { match: "all", conditions: [{ key: "members", op: "contains", value: "Benjamin" }] } }, { limited: false }).rows[0]!.metadata.members, MEMBERS);
});

test("engine: linear on object values", () => {
  const many = Array.from({ length: 20_000 }, (_, i) => row(`r${i}`, [{ name: `Person ${i % 997}`, role: "delegate" }, { name: "Shared", role: "x" }]));
  const t0 = threadCpuMs();
  sortRows(many, [{ key: "members", dir: "asc" }]);
  many.filter((r) => evaluateCondition(r, { key: "members", op: "contains", value: "person 5" }));
  computeAggregates(many, [{ key: "members", fn: "count_unique" }], { key: "members" });
  assert.ok(threadCpuMs() - t0 < 4000, `took ${Math.round(threadCpuMs() - t0)} ms`);
});

// ── the write rule (pure) ────────────────────────────────────────────────────

test("write rule: nothing replaces a structured value, and [object Object] is never written", () => {
  const cur = { members: MEMBERS, status: "active", lead: { name: "Ada" } };
  assert.deepEqual(refuseStructuredWrite({ members: ["Benjamin Life — delegate"] }, cur), ["members"]);
  assert.deepEqual(refuseStructuredWrite({ members: null }, cur), ["members"]); // a clear could not be undone through the property routes
  assert.deepEqual(refuseStructuredWrite({ members: BAD, lead: "Ada" }, cur), ["members", "lead"]);
  assert.deepEqual(refuseStructuredWrite({ members: MEMBERS }, cur), []); // the same value is no change
  assert.deepEqual(refuseStructuredWrite({ status: "paused" }, cur), []);
  assert.deepEqual(refuseStructuredWrite({ status: BAD }, cur), ["status"]);
  assert.deepEqual(refuseStructuredWrite({ topics: ["a", BAD] }, {}), ["topics"]);
  assert.deepEqual(refuseStructuredWrite({ topics: ["a"] }, null), []);
  // The editors' coercion passes objects through untouched instead of stringifying them.
  for (const kind of ["text", "multi_select", "person", "relation", "select"] as const) {
    assert.deepEqual(coerceValue({ kind, multiple: true }, MEMBERS), MEMBERS, kind);
    assert.ok(!JSON.stringify(coerceValue({ kind, multiple: true }, MEMBERS)).includes(BAD), kind);
  }
  // A type conversion never invents a reading for objects (the value stays on the old field).
  for (const kind of ["text", "number", "checkbox", "multi_select", "select", "status", "person", "relation", "date", "url", "email", "phone", "files"] as const) {
    assert.deepEqual(coerceToKind(MEMBERS, kind), { ok: false }, kind);
    assert.deepEqual(coerceToKind(MEMBERS[0], kind), { ok: false }, kind);
    assert.deepEqual(coerceToKind([MEMBERS[0]], kind), { ok: false }, kind);
  }
});

// ── the routes ───────────────────────────────────────────────────────────────

let fv: FakeVault;
let innerFetch: typeof fetch;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") {
      return Response.json([{ name: "circle", count: 2, description: null, fields: { members: { type: "array" }, status: { type: "string" }, cadence: { type: "string" } } }]);
    }
    return innerFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const J = { "content-type": "application/json" };
const cookie = () => sessionCookie(makeSession(OWNER));
const post = (path: string, body: unknown) => {
  const headers = new Headers(J);
  headers.set("cookie", cookie());
  return api.request(path, { method: "POST", headers, body: JSON.stringify(body) });
};
function seed() {
  fv.put({ id: "c1", path: "Circles/Delegate Council", tags: ["circle"], content: "", metadata: { title: "Delegate Council", members: MEMBERS, status: "active", cadence: "monthly" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "c2", path: "Circles/Stewards", tags: ["circle"], content: "", metadata: { title: "Stewards", members: ["[[vault/people/Ada]]"], status: "active" }, updatedAt: "2026-10-01T11:00:00.000Z" });
}
const stored = (id: string) => fv.notes.get(id)!.metadata as Record<string, unknown>;

test("POST /properties/:id refuses any write over a structured value and leaves it whole", async () => {
  seed();
  for (const next of [["Benjamin Life — delegate"], [BAD, BAD], BAD, "x", null, []]) {
    const r = await post("/properties/c1", { set: { members: next }, expect: { members: MEMBERS } });
    assert.equal(r.status, 400, JSON.stringify(next));
    const b = (await r.json()) as { error: string; fields?: string[] };
    assert.equal(b.error, "structured_value");
    assert.deepEqual(b.fields, ["members"]);
    assert.deepEqual(stored("c1").members, MEMBERS);
  }
  // Without `expect` (an offline replay) the STORED value still decides.
  assert.equal((await post("/properties/c1", { set: { members: ["x"] } })).status, 400);
  // Objects are not a property-route value at all.
  assert.equal((await post("/properties/c2", { set: { members: MEMBERS } })).status, 400);
  // Other properties of the same page stay editable, and the objects survive that write.
  const ok = await post("/properties/c1", { set: { status: "paused" }, expect: { status: "active" } });
  assert.equal(ok.status, 200);
  assert.equal(stored("c1").status, "paused");
  assert.deepEqual(stored("c1").members, MEMBERS);
  // The literal text is refused on an ordinary property too.
  assert.equal((await post("/properties/c2", { set: { members: [BAD] } })).status, 400);
  assert.deepEqual(stored("c2").members, ["[[vault/people/Ada]]"]);
  assert.ok(!JSON.stringify([...fv.notes.values()]).includes(BAD));
});

test("POST /properties/batch (bulk edit) skips rows holding a structured value and writes the others", async () => {
  seed();
  const r = await post("/properties/batch", { items: [
    { id: "c1", set: { members: ["[[vault/people/Grace]]"] }, expect: { members: MEMBERS } },
    { id: "c2", set: { members: ["[[vault/people/Grace]]"] }, expect: { members: ["[[vault/people/Ada]]"] } },
  ] });
  assert.equal(r.status, 207);
  const { results } = (await r.json()) as { results: Array<{ id: string; ok: boolean; error?: string }> };
  assert.deepEqual(results.map((x) => [x.id, x.ok, x.error ?? null]), [["c1", false, "structured_value"], ["c2", true, null]]);
  assert.deepEqual(stored("c1").members, MEMBERS);
  assert.deepEqual(stored("c2").members, ["[[vault/people/Grace]]"]);
});

test("CSV import: a cell never replaces a structured value (an export re-imported is a no-op for it)", async () => {
  seed();
  const csv = `Title,Members,Status\nDelegate Council,"${valueText(MEMBERS)}",paused\nStewards,Grace,active\n`;
  const body = { tag: "circle", csv, mapping: { Title: "$title", Members: "members", Status: "status" }, pathPrefix: "Circles" };
  const dry = await post("/databases/import/csv", { ...body, dryRun: true });
  assert.equal(dry.status, 200);
  const plan = (await dry.json()) as { summary: { update: number; structuredKept: number }; sample: Array<{ title: string; changes?: string[]; kept?: string[] }> };
  assert.equal(plan.summary.structuredKept, 1);
  const first = plan.sample.find((s) => s.title === "Delegate Council")!;
  assert.deepEqual(first.changes, ["status"]);
  assert.deepEqual(first.kept, ["members"]);
  const run = await post("/databases/import/csv", { ...body, dryRun: false });
  assert.equal(run.status, 200);
  assert.deepEqual(stored("c1").members, MEMBERS);
  assert.equal(stored("c1").status, "paused");
  assert.deepEqual(stored("c2").members, ["Grace"]);
  assert.ok(!JSON.stringify([...fv.notes.values()]).includes(BAD));
});

test("POST /query over a database whose rows hold objects: sorted, filtered, searched, counted — objects returned whole", async () => {
  seed();
  fv.put({ id: "c3", path: "Circles/Odd", tags: ["circle"], content: "", metadata: { title: "Odd", members: [JSON.parse('{"toString": 1}')] }, updatedAt: "2026-10-01T12:00:00.000Z" });
  const q = await post("/query", { tags: ["circle"], sort: [{ key: "members", dir: "asc" }], search: "patricia" });
  assert.equal(q.status, 200);
  const page = (await q.json()) as { rows: Array<{ id: string; metadata: Record<string, unknown> }> };
  assert.deepEqual(page.rows.map((r) => r.id), ["c1"]);
  assert.deepEqual(page.rows[0]!.metadata.members, MEMBERS);
  const all = await post("/query", { tags: ["circle"], sort: [{ key: "members", dir: "desc" }], filter: { match: "any", conditions: [{ key: "members", op: "contains", value: "delegate" }, { key: "members", op: "exists" }] } });
  assert.equal(all.status, 200);
  assert.equal(((await all.json()) as { rows: unknown[] }).rows.length, 3);
});
