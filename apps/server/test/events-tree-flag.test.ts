/**
 * M1 — `tree: true` on invalidation events: set only when the note's SIDEBAR ROW
 * changed for THIS viewer (created, removed, became visible / hidden, or its
 * path / tags / type / icon / order / trash state changed) — never for a plain
 * content edit, which only moves `updatedAt`. Pure: `eventFor` + `treeRowChanged`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventFor } from "../src/events";
import { treeRowChanged, type TreeRow } from "../src/tree";

const row = (over: Partial<TreeRow> = {}): TreeRow => ({ id: "n1", path: "docs/n1", tags: ["doc"], updatedAt: "2026-06-01T00:00:00Z", creator: null, visibility: "workspace", ...over });
const all = () => true;

test("a content edit (only updatedAt moved) is not a tree change", () => {
  const prev = row();
  const next = row({ updatedAt: "2026-06-02T00:00:00Z" });
  assert.equal(treeRowChanged(prev, next), false);
  assert.deepEqual(eventFor({ kind: "upsert", row: next, prev }, all), { type: "note", id: "n1", op: "upsert" });
});

test("created, removed, and every emitted row field mark the tree", () => {
  assert.deepEqual(eventFor({ kind: "upsert", row: row(), prev: undefined }, all), { type: "note", id: "n1", op: "upsert", tree: true });
  assert.deepEqual(eventFor({ kind: "remove", id: "n1", prev: row() }, all), { type: "note", id: "n1", op: "remove", tree: true });
  const changes: Array<Partial<TreeRow>> = [{ path: "docs/renamed" }, { tags: ["doc", "x"] }, { tags: [] }, { type: "code" }, { prismType: "database" }, { icon: "🌱" }, { order: 5 }, { trashedAt: "2026-06-02T00:00:00Z" }];
  for (const change of changes) {
    assert.equal(treeRowChanged(row(), row(change)), true, JSON.stringify(change));
    assert.deepEqual(eventFor({ kind: "upsert", row: row(change), prev: row() }, all), { type: "note", id: "n1", op: "upsert", tree: true });
  }
  // Tag ORDER is not a change; internal keys that are never emitted are not either.
  assert.equal(treeRowChanged(row({ tags: ["a", "b"] }), row({ tags: ["b", "a"] })), false);
  assert.equal(treeRowChanged(row(), row({ trashedBy: "someone@x" } as Partial<TreeRow>)), false);
});

test("per viewer: computed after the same view filter — nothing for a note they cannot see, tree:true when it appears or disappears for them", () => {
  const canView = (r: { tags: string[] }) => r.tags.includes("shared");
  const hidden = row({ tags: ["private"] });
  const shared = row({ tags: ["shared"], updatedAt: "2026-06-02T00:00:00Z" });
  // Never viewable: no frame at all (so no flag either), even though the row's shape changed.
  assert.equal(eventFor({ kind: "upsert", row: row({ tags: ["private"], path: "docs/moved" }), prev: hidden }, canView), null);
  assert.equal(eventFor({ kind: "remove", id: "n1", prev: hidden }, canView), null);
  // Became visible / stopped being visible to this viewer: their tree changes.
  assert.deepEqual(eventFor({ kind: "upsert", row: shared, prev: hidden }, canView), { type: "note", id: "n1", op: "upsert", tree: true });
  assert.deepEqual(eventFor({ kind: "upsert", row: row({ tags: ["private"], updatedAt: "2026-06-03T00:00:00Z" }), prev: shared }, canView), { type: "note", id: "n1", op: "upsert", tree: true });
  // Visible before and after, content edit only: no flag.
  assert.deepEqual(eventFor({ kind: "upsert", row: row({ tags: ["shared"], updatedAt: "2026-06-04T00:00:00Z" }), prev: shared }, canView), { type: "note", id: "n1", op: "upsert" });
  // The event carries ids + op + the flag only.
  assert.deepEqual(Object.keys(eventFor({ kind: "upsert", row: shared, prev: hidden }, canView)!).sort(), ["id", "op", "tree", "type"]);
});
