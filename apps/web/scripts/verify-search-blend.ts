/**
 * NP-SR-05: the pure ranked + keyword blend (packages/core/src/lib/search/blend.ts).
 * Run: npm run verify:search -w @prism/web
 */
import assert from "node:assert/strict";
import { blendResults } from "../../../packages/core/src/lib/search/blend.ts";

const r = (id: string, path: string, extra: Record<string, unknown> = {}) => ({ id, path, ...extra });
const ranked = [r("a", "Notes/Budget thoughts"), r("b", "Notes/Workshop agenda", { passage: 1 }), r("c", "Journal/Monday")];
const keyword = [r("d", "Library/Agenda template", { k: 1 }), r("b", "Notes/Workshop agenda", { k: 1 }), r("e", "Journal/Tuesday", { k: 1 })];

// Title matches lead in keyword order; then ranked; then the remaining keyword hits.
assert.deepEqual(blendResults(ranked, keyword, ["agenda"]).map((x) => x.id), ["d", "b", "a", "c", "e"]);
// A page found by both appears once, as the ranked row (its matching passage).
assert.equal((blendResults(ranked, keyword, ["agenda"]).find((x) => x.id === "b") as { passage?: number }).passage, 1);
assert.equal(blendResults(ranked, keyword, ["agenda"]).filter((x) => x.id === "b").length, 1);
// Every term must be in the title to lead.
assert.deepEqual(blendResults(ranked, keyword, ["agenda", "workshop"]).map((x) => x.id), ["b", "a", "c", "d", "e"]);
// Case-insensitive; no terms = ranked then keyword.
assert.deepEqual(blendResults(ranked, keyword, ["AGENDA"]).map((x) => x.id)[0], "d");
assert.deepEqual(blendResults(ranked, keyword, []).map((x) => x.id), ["a", "b", "c", "d", "e"]);
// Either side empty; limit respected; null paths tolerated.
assert.deepEqual(blendResults([], keyword, ["x"]).map((x) => x.id), ["d", "b", "e"]);
assert.deepEqual(blendResults(ranked, [], ["x"]).map((x) => x.id), ["a", "b", "c"]);
assert.equal(blendResults(ranked, keyword, ["agenda"], 2).length, 2);
assert.deepEqual(blendResults([{ id: "n", path: null }], [{ id: "m" }], ["x"]).map((x) => x.id), ["n", "m"]);
console.log("verify-search-blend: OK");
