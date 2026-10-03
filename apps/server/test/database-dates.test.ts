/**
 * Date values in the shared query engine (NP-DB-08 / NP-DB-07): a day, a time,
 * and a range `start/end`. A range sorts by its start, "is" any day inside it,
 * and a window filter keeps every range that overlaps the window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, buildDateValue, dateRange, dayDiff, daySpan, evaluateCondition, parseDateParts, runQuery, shiftDateValue, type QueryInput } from "@prism/core/database";

const note = (id: string, due: unknown): QueryInput => ({ id, path: `T/${id}`, tags: ["task"], metadata: { title: id, due }, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
const cond = (due: unknown, op: string, value: unknown) => evaluateCondition(note("x", due), { key: "due", op: op as never, value }, new Date("2026-10-10T12:00:00Z"), 0);

test("dateRange recognises only `start/end` of two ISO dates", () => {
  assert.deepEqual(dateRange("2026-10-03/2026-10-05"), ["2026-10-03", "2026-10-05"]);
  assert.deepEqual(dateRange("2026-10-03T09:00:00.000Z/2026-10-03T17:30:00.000Z"), ["2026-10-03T09:00:00.000Z", "2026-10-03T17:30:00.000Z"]);
  for (const s of ["2026-10-03", "a/b", "2026-10-03/", "/2026-10-03", "2026-10-03/2026-10-05/2026-10-07", "https://example.test/2026-10-03", "x".repeat(200)]) assert.equal(dateRange(s), null, s);
});

test("a range is equal to every day inside it, and compares by the right end", () => {
  const r = "2026-10-03/2026-10-05";
  assert.equal(cond(r, "eq", "2026-10-03"), true);
  assert.equal(cond(r, "eq", "2026-10-04"), true);
  assert.equal(cond(r, "eq", "2026-10-06"), false);
  assert.equal(cond(r, "ne", "2026-10-04"), false);
  // "on or after" looks at the end, "on or before" at the start: overlap semantics.
  assert.equal(cond(r, "gte", "2026-10-05"), true);
  assert.equal(cond(r, "gte", "2026-10-06"), false);
  assert.equal(cond(r, "gt", "2026-10-05"), false);
  assert.equal(cond(r, "lte", "2026-10-03"), true);
  assert.equal(cond(r, "lte", "2026-10-02"), false);
  assert.equal(cond(r, "lt", "2026-10-03"), false);
  assert.equal(cond(r, "exists", null), true);
});

test("a window filter keeps ranges that overlap it; sorting uses the start", () => {
  const notes = [
    note("before", "2026-09-20/2026-09-25"),
    note("into", "2026-09-28/2026-10-02"),
    note("inside", "2026-10-10"),
    note("timed", "2026-10-12T15:00:00.000Z"),
    note("out-of", "2026-10-30/2026-11-04"),
    note("after", "2026-11-05/2026-11-06"),
    note("none", null),
  ];
  const page = runQuery(notes, { tags: ["task"], filter: { match: "all", conditions: [{ key: "due", op: "gte", value: "2026-10-01" }, { key: "due", op: "lte", value: "2026-10-31" }] }, sort: [{ key: "due", dir: "asc" }], limit: 50 }, { limited: false });
  assert.deepEqual(page.rows.map((r) => r.id), ["into", "inside", "timed", "out-of"]);
  const desc = runQuery(notes, { tags: ["task"], sort: [{ key: "due", dir: "desc" }], limit: 50 }, { limited: false });
  assert.deepEqual(desc.rows.map((r) => r.id).slice(0, 3), ["after", "out-of", "timed"]);
});

test("ordinary strings with a slash are untouched by range handling", () => {
  assert.equal(cond("docs/readme", "eq", "docs/readme"), true);
  assert.equal(cond("a/b", "contains", "/b"), true);
  const big = `${"1/".repeat(50_000)}`;
  const t0 = Date.now();
  assert.equal(cond(big, "eq", "2026-10-03"), false);
  assert.equal(typeof cond(big, "gte", "2026-10-03"), "boolean"); // compares as text, in linear time
  assert.ok(Date.now() - t0 < 500, "linear on pathological input");
});

test("moving a value by days keeps its shape, time of day and length", () => {
  assert.equal(shiftDateValue("2026-10-03", 4), "2026-10-07");
  assert.equal(shiftDateValue("2026-10-30/2026-11-02", 3), "2026-11-02/2026-11-05");
  assert.equal(shiftDateValue("2026-10-03T09:30", -2), "2026-10-01T09:30");
  const moved = shiftDateValue("2026-10-03T09:30:00.000Z", 1);
  assert.equal(Date.parse(moved) - Date.parse("2026-10-03T09:30:00.000Z"), 86_400_000);
  assert.equal(shiftDateValue("2026-10-03", 0), "2026-10-03");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(dayDiff("2026-10-03", "2026-10-01"), -2);
  assert.deepEqual(daySpan("2026-10-03/2026-10-05"), ["2026-10-03", "2026-10-05"]);
  assert.deepEqual(daySpan("2026-10-03"), ["2026-10-03", "2026-10-03"]);
  assert.equal(daySpan("soon"), null);
});

test("editor parts round-trip", () => {
  assert.equal(buildDateValue({ date: "2026-10-03", time: null, endDate: null, endTime: null }), "2026-10-03");
  assert.equal(buildDateValue({ date: "2026-10-03", time: null, endDate: "2026-10-05", endTime: null }), "2026-10-03/2026-10-05");
  const timed = buildDateValue({ date: "2026-10-03", time: "09:30", endDate: null, endTime: null })!;
  assert.match(timed, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  assert.deepEqual(parseDateParts(timed), { date: "2026-10-03", time: "09:30", endDate: null, endTime: null });
  const span = buildDateValue({ date: "2026-10-03", time: "09:30", endDate: "2026-10-03", endTime: "17:00" })!;
  assert.deepEqual(parseDateParts(span), { date: "2026-10-03", time: "09:30", endDate: "2026-10-03", endTime: "17:00" });
  assert.equal(buildDateValue({ date: "nope", time: null, endDate: null, endTime: null }), null);
  assert.equal(parseDateParts("someday"), null);
});
