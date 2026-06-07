/**
 * The permission algebra. This is the authoritative guard for the whole
 * gateway, so the level ordering, owner short-circuit, tag-vs-note matching, and
 * "max over grants" semantics are tested exhaustively here in isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEVELS,
  levelRank,
  atLeast,
  maxLevel,
  effectiveLevel,
  grantedTags,
} from "../src/permissions";
import type { Grant } from "../src/db";

const g = (over: Partial<Grant>): Grant => ({
  id: "g",
  subject_type: "user",
  subject: "a@b.co",
  resource_type: "note",
  resource: "n1",
  level: "view",
  created_by: null,
  created_at: 0,
  ...over,
});

test("LEVELS are ordered weakest → strongest", () => {
  assert.deepEqual([...LEVELS], ["view", "comment", "suggest", "edit", "own"]);
  assert.ok(levelRank("view") < levelRank("comment"));
  assert.ok(levelRank("edit") < levelRank("own"));
});

test("atLeast compares by rank and treats null as no access", () => {
  assert.equal(atLeast("edit", "view"), true);
  assert.equal(atLeast("view", "edit"), false);
  assert.equal(atLeast("view", "view"), true); // equal meets the bar
  assert.equal(atLeast(null, "view"), false);
});

test("maxLevel returns the stronger level, null-safe", () => {
  assert.equal(maxLevel("view", "edit"), "edit");
  assert.equal(maxLevel("own", "comment"), "own");
  assert.equal(maxLevel(null, "view"), "view");
  assert.equal(maxLevel("suggest", null), "suggest");
  assert.equal(maxLevel(null, null), null);
});

test("owner short-circuits to own regardless of grants", () => {
  assert.equal(effectiveLevel([], { id: "n1", tags: [] }, true), "own");
});

test("a non-owner with no matching grant gets null (no access)", () => {
  assert.equal(effectiveLevel([g({ resource: "other" })], { id: "n1", tags: [] }, false), null);
});

test("note-id grant matches the note directly", () => {
  assert.equal(
    effectiveLevel([g({ resource_type: "note", resource: "n1", level: "edit" })], { id: "n1", tags: [] }, false),
    "edit",
  );
});

test("tag grant matches any note carrying that tag", () => {
  const grants = [g({ resource_type: "tag", resource: "shared", level: "comment" })];
  assert.equal(effectiveLevel(grants, { id: "n1", tags: ["shared", "x"] }, false), "comment");
  assert.equal(effectiveLevel(grants, { id: "n2", tags: ["other"] }, false), null);
});

test("effective level is the MAX over all matching grants (note + tag)", () => {
  const grants = [
    g({ resource_type: "note", resource: "n1", level: "view" }),
    g({ resource_type: "tag", resource: "team", level: "edit" }),
  ];
  assert.equal(effectiveLevel(grants, { id: "n1", tags: ["team"] }, false), "edit");
});

test("non-matching tag grants never leak (the gateway's core invariant)", () => {
  // A subject granted on tag:team must NOT see a note that lacks tag:team,
  // even if some other grant exists for a different resource.
  const grants = [
    g({ resource_type: "tag", resource: "team", level: "own" }),
    g({ resource_type: "note", resource: "different-note", level: "own" }),
  ];
  assert.equal(effectiveLevel(grants, { id: "secret", tags: ["private"] }, false), null);
});

test("grantedTags returns the unique set of tag resources", () => {
  const grants = [
    g({ resource_type: "tag", resource: "a" }),
    g({ resource_type: "tag", resource: "a" }),
    g({ resource_type: "tag", resource: "b" }),
    g({ resource_type: "note", resource: "n1" }),
  ];
  assert.deepEqual(grantedTags(grants).sort(), ["a", "b"]);
});
