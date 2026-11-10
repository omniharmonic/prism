/**
 * Parachute 0.9 gives each note `types` beside `tags` (packages/core
 * lib/schemas/names.ts). Kind is read from the types first, then the tags; database
 * and dashboard membership reads both. A 0.8 note (no `types`) reads exactly as
 * before — the first two assertions of each test are that case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferContentType, getStructuralTag } from "@prism/core/content-types";
import { runQuery } from "@prism/core/database";
import { filterNotes } from "@prism/core/dashboard-engine";
type Note = Parameters<typeof filterNotes>[0][number];

const note = (id: string, tags: string[], types?: string[]): Note => ({
  id, content: "", path: `Notes/${id}`, metadata: {}, createdAt: "2026-11-01T00:00:00Z", updatedAt: null, tags, ...(types ? { types } : {}),
});

test("kind: a note's types decide before its plain tags; with no types, the old tag precedence", () => {
  // 0.8: `task` outranks `project` in tag-schemas.json.
  assert.equal(inferContentType(note("a", ["project", "task"])), "task");
  assert.equal(getStructuralTag(note("a", ["project", "task"])), "task");
  // 0.9: the same names, but the vault says the note IS a project (a type) and only labelled `task`.
  assert.equal(inferContentType(note("b", ["project", "task"], ["project"])), "project");
  assert.equal(getStructuralTag(note("b", ["project", "task"], ["project"])), "project");
  // The record door's own shape (tags hold plain labels only) still finds the kind.
  assert.equal(inferContentType(note("c", ["idea"], ["task"])), "task");
  // Types the table doesn't know fall back to the tags.
  assert.equal(inferContentType(note("d", ["task"], ["invoice"])), "task");
});

test("membership: a database or a dashboard row answers to a type as to a tag", () => {
  const rows = [note("old", ["meeting", "idea"]), note("new", ["idea"], ["meeting"]), note("other", ["idea"])];
  const ids = (spec: string[]) => runQuery(rows, { tags: spec }, { limited: false }).rows.map((r) => r.id).sort();
  assert.deepEqual(ids(["idea"]), ["new", "old", "other"]);
  assert.deepEqual(ids(["meeting"]), ["new", "old"]);
  assert.deepEqual(ids(["meeting", "idea"]), ["new", "old"]);
  assert.deepEqual(runQuery([note("t", ["x"], ["task"])], { tags: ["task"], includeTypedTasks: true }, { limited: false }).rows.length, 1);
  assert.deepEqual(filterNotes(rows, { tags: ["meeting"] } as never).map((n) => n.id).sort(), ["new", "old"]);
  assert.deepEqual(filterNotes([{ ...note("none", []), tags: null }], { tags: ["meeting"] } as never), []);
});
