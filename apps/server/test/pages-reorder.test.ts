/** NP-SB-04: the pure favorites reorder (`@prism/core/pages` moveWithin / preferenceOps.moveFavorite). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveWithin, preferenceOps, EMPTY_PREFERENCES } from "@prism/core/pages";

test("moveWithin: moves within the list, clamps, and returns the same array when nothing moves", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(moveWithin(list, "a", 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveWithin(list, "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveWithin(list, "b", 99), ["a", "c", "d", "b"]);
  assert.deepEqual(moveWithin(list, "b", -5), ["b", "a", "c", "d"]);
  assert.equal(moveWithin(list, "b", 1), list);
  assert.equal(moveWithin(list, "zz", 0), list);
});

test("moveWithin: ids hidden from the caller are never lost and keep following the id before them", () => {
  // h1 is first (hidden), h2 follows b. The caller sees a, b, c.
  const list = ["h1", "a", "b", "h2", "c"];
  const visible = ["a", "b", "c"];
  assert.deepEqual(moveWithin(list, "c", 0, visible), ["h1", "c", "a", "b", "h2"]);
  assert.deepEqual(moveWithin(list, "b", 2, visible), ["h1", "a", "c", "b", "h2"]);
  assert.deepEqual(moveWithin(list, "a", 1, visible), ["h1", "b", "h2", "a", "c"]);
  for (const out of [moveWithin(list, "c", 0, visible), moveWithin(list, "a", 2, visible)]) assert.deepEqual([...out].sort(), [...list].sort());
  // A hidden id is not a movable row.
  assert.equal(moveWithin(list, "h2", 0, visible), list);
});

test("preferenceOps.moveFavorite leaves everything else alone", () => {
  const p = { ...EMPTY_PREFERENCES, favorites: ["a", "b", "c"], recents: ["r"] };
  const next = preferenceOps.moveFavorite(p, "c", 0);
  assert.deepEqual(next.favorites, ["c", "a", "b"]);
  assert.deepEqual(next.recents, ["r"]);
  assert.equal(preferenceOps.moveFavorite(p, "a", 0), p);
});
