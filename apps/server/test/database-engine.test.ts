/**
 * The pure database engine shared by the server route and the client fallback
 * (`@prism/core/database`): comparison semantics, sorting, cursors, property-kind
 * inference and the additive schema-merge rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCondition,
  sortRows,
  runQuery,
  validateQuerySpec,
  CursorMismatchError,
  inferKind,
  resolveProperties,
  coerceValue,
  formatValue,
  mergeSchemaFields,
  validateSchemaPatch,
  optionColor,
  type QueryInput,
} from "@prism/core/database";

const n = (id: string, metadata: Record<string, unknown>, extra: Partial<QueryInput> = {}): QueryInput => ({
  id, path: `Notes/${id}`, tags: ["task"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", metadata, ...extra,
});

test("conditions: lenient strings, wikilinks, arrays, numbers, dates and existence", () => {
  const a = n("a", { status: "In-Progress", project: "[[vault/projects/Prism]]", tags2: ["x", "Y"], points: "8", due: "2026-10-05" });
  assert.ok(evaluateCondition(a, { key: "status", op: "eq", value: "in-progress" }));
  assert.ok(evaluateCondition(a, { key: "project", op: "eq", value: "vault/projects/prism" }));
  assert.ok(evaluateCondition(a, { key: "tags2", op: "eq", value: "y" }));
  assert.ok(evaluateCondition(a, { key: "tags2", op: "contains", value: "x" }));
  assert.ok(evaluateCondition(a, { key: "points", op: "gt", value: 5 }), "numeric strings compare as numbers");
  assert.ok(!evaluateCondition(a, { key: "points", op: "lt", value: 10 - 3 }));
  assert.ok(evaluateCondition(a, { key: "due", op: "lt", value: "2026-10-05T12:00:00Z" }) === false, "same day is not before");
  assert.ok(evaluateCondition(a, { key: "due", op: "gte", value: "@today-1" }, new Date("2026-10-05T09:00:00Z")));
  assert.ok(!evaluateCondition(a, { key: "missing", op: "eq", value: "x" }));
  assert.ok(evaluateCondition(a, { key: "missing", op: "ne", value: "x" }), "missing is ≠ anything");
  assert.ok(evaluateCondition(a, { key: "missing", op: "not_exists" }));
  assert.ok(evaluateCondition(a, { key: "$title", op: "eq", value: "a" }), "title falls back to the path leaf");
  assert.ok(evaluateCondition(a, { key: "status", op: "in", value: ["done", "in-progress"] }));
});

test("sorting: missing values last in both directions, ids break ties", () => {
  const rows = [n("b", { due: "2026-10-02" }), n("c", {}), n("a", { due: "2026-10-02" }), n("d", { due: "2026-09-01" })];
  assert.deepEqual(sortRows(rows, [{ key: "due", dir: "asc" }]).map((r) => r.id), ["d", "a", "b", "c"]);
  assert.deepEqual(sortRows(rows, [{ key: "due", dir: "desc" }]).map((r) => r.id), ["a", "b", "d", "c"]);
});

test("paging: cursors resume and are bound to their query", () => {
  const rows = Array.from({ length: 7 }, (_, i) => n(`n${i}`, { rank: i }));
  const spec = { tags: ["task"], sort: [{ key: "rank", dir: "asc" as const }], limit: 3 };
  const p1 = runQuery(rows, spec, { limited: false });
  const p2 = runQuery(rows, { ...spec, cursor: p1.next }, { limited: false });
  const p3 = runQuery(rows, { ...spec, cursor: p2.next }, { limited: false });
  assert.deepEqual([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id), rows.map((r) => r.id));
  assert.equal(p3.next, null);
  assert.equal(p1.total, 7);
  assert.throws(() => runQuery(rows, { ...spec, sort: [{ key: "rank", dir: "desc" }], cursor: p1.next }, { limited: false }), CursorMismatchError);
});

test("spec validation bounds every list", () => {
  assert.equal(validateQuerySpec({ tags: ["a", "b", "c", "d", "e", "f"] }).ok, false);
  assert.equal(validateQuerySpec({ tags: ["a"], fields: Array.from({ length: 41 }, (_, i) => `f${i}`) }).ok, false);
  assert.equal(validateQuerySpec({ tags: ["a"], filter: { match: "all", conditions: [{ key: "x", op: "in", value: "nope" }] } }).ok, false);
  assert.equal(validateQuerySpec({ tags: ["a"], filter: { match: "xor", conditions: [] } }).ok, false);
  assert.equal(validateQuerySpec({ tags: ["a"], sort: [{ key: "$updatedAt", dir: "desc" }] }).ok, true);
});

test("property kinds come from hints, then vault type, then the key name", () => {
  assert.equal(inferKind("status", { type: "string", enum: ["a"] }), "status");
  assert.equal(inferKind("priority", { type: "string", enum: ["a"] }), "select");
  assert.equal(inferKind("priority", { type: "string", enum: ["a"], kind: "status" }), "status");
  assert.equal(inferKind("attendees", { type: "array" }), "person");
  assert.equal(inferKind("labels", { type: "array" }), "multi_select");
  assert.equal(inferKind("done", { type: "boolean" }), "checkbox");
  assert.equal(inferKind("due", { type: "string" }), "date");
  assert.equal(inferKind("website", { type: "string" }), "url");
  assert.equal(inferKind("assigned", { type: "string" }), "person");
  assert.equal(inferKind("estimate", {}, 3), "number", "free keys infer from their value");
});

test("resolveProperties: schema fields first, then free keys; system keys never", () => {
  const props = resolveProperties(["task"], { task: { description: null, fields: { status: { type: "string", enum: ["todo", "done"] }, secret: { type: "string", hidden: true } } } }, { status: "done", owner: "Ada", prism_creator: "x", title: "T", icon: "🙂" });
  assert.deepEqual(props.map((p) => p.key), ["status", "owner"]);
  assert.deepEqual(props[0]!.options.map((o) => o.value), ["todo", "done"]);
  assert.equal(props[0]!.options[1]!.color, "green");
});

test("value coercion and formatting", () => {
  assert.equal(coerceValue({ kind: "number", multiple: false }, "1,250"), 1250);
  assert.equal(coerceValue({ kind: "number", multiple: false }, ""), null);
  assert.deepEqual(coerceValue({ kind: "multi_select", multiple: true }, ["a", "a", " b "]), ["a", "b"]);
  assert.equal(coerceValue({ kind: "relation", multiple: false }, ["[[x]]", "[[y]]"]), "[[x]]");
  assert.equal(coerceValue({ kind: "text", multiple: false }, "  "), null);
  assert.equal(formatValue({ kind: "person" }, "[[vault/people/Ada Lovelace]]"), "Ada Lovelace");
  assert.equal(formatValue({ kind: "checkbox" }, false), "No");
  assert.equal(optionColor("whatever", { whatever: "pink" }), "pink");
  assert.equal(optionColor("x"), optionColor("x"), "stable");
});

test("schema merge: additive only", () => {
  const cur = { status: { type: "string", enum: ["a", "b"] }, note: { type: "string" } };
  assert.equal(mergeSchemaFields(cur, { status: { enum: ["a"] } }).ok, false);
  assert.equal(mergeSchemaFields(cur, { status: { type: "number" } }).ok, false);
  assert.equal(mergeSchemaFields(cur, { note: { enum: ["x"] } }).ok, false);
  assert.equal(mergeSchemaFields(cur, { fresh: {} }).ok, false, "a new field needs a type");
  assert.equal(mergeSchemaFields(cur, { tags2: { type: "array", enum: ["x"] } }).ok, false, "array options live in hints");
  const ok = mergeSchemaFields(cur, { status: { enum: ["a", "b", "c"] }, size: { type: "number" } });
  assert.ok(ok.ok && ok.changed && ok.fields.size!.type === "number" && ok.fields.status!.enum!.length === 3);
  const noop = mergeSchemaFields(cur, { status: { enum: ["a", "b"] } });
  assert.ok(noop.ok && !noop.changed);
  assert.equal(validateSchemaPatch({ ui: { x: { colors: { a: "chartreuse" } } } }).ok, false);
  assert.equal(validateSchemaPatch({ fields: { estimate_hours: { type: "number" } } }).ok, true);
  assert.equal(validateSchemaPatch({ fields: { _hidden: { type: "string" } } }).ok, false);
  assert.equal(validateSchemaPatch({}).ok, false);
});
