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
  vault_id: "primary",
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

test("an 'own' floor (owner/admin role) yields own regardless of grants", () => {
  assert.equal(effectiveLevel([], { id: "n1", tags: [] }, "own"), "own");
});

test("a null floor (member/guest) with no matching grant gets null (no access)", () => {
  assert.equal(effectiveLevel([g({ resource: "other" })], { id: "n1", tags: [] }, null), null);
});

test("note-id grant matches the note directly", () => {
  assert.equal(
    effectiveLevel([g({ resource_type: "note", resource: "n1", level: "edit" })], { id: "n1", tags: [] }, null),
    "edit",
  );
});

test("tag grant matches any note carrying that tag", () => {
  const grants = [g({ resource_type: "tag", resource: "shared", level: "comment" })];
  assert.equal(effectiveLevel(grants, { id: "n1", tags: ["shared", "x"] }, null), "comment");
  assert.equal(effectiveLevel(grants, { id: "n2", tags: ["other"] }, null), null);
});

test("effective level is the MAX over all matching grants (note + tag)", () => {
  const grants = [
    g({ resource_type: "note", resource: "n1", level: "view" }),
    g({ resource_type: "tag", resource: "team", level: "edit" }),
  ];
  assert.equal(effectiveLevel(grants, { id: "n1", tags: ["team"] }, null), "edit");
});

test("a non-null floor is RAISED by a stronger grant", () => {
  // A member with a tag:team edit grant beats a 'comment' floor on a team note.
  const grants = [g({ resource_type: "tag", resource: "team", level: "edit" })];
  assert.equal(effectiveLevel(grants, { id: "n1", tags: ["team"] }, "comment"), "edit");
  // …but the floor still applies to a note the grants don't match.
  assert.equal(effectiveLevel(grants, { id: "n2", tags: ["other"] }, "comment"), "comment");
});

test("non-matching tag grants never leak (the gateway's core invariant)", () => {
  // A subject granted on tag:team must NOT see a note that lacks tag:team,
  // even if some other grant exists for a different resource.
  const grants = [
    g({ resource_type: "tag", resource: "team", level: "own" }),
    g({ resource_type: "note", resource: "different-note", level: "own" }),
  ];
  assert.equal(effectiveLevel(grants, { id: "secret", tags: ["private"] }, null), null);
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

// ── whole-workspace (vault) grant ────────────────────────────────────────────
test("a vault grant matches every note in the workspace", () => {
  const grants = [g({ resource_type: "vault", resource: "primary", level: "edit" })];
  assert.equal(effectiveLevel(grants, { id: "any", tags: [] }, null), "edit");
  assert.equal(effectiveLevel(grants, { id: "other", tags: ["x", "y"] }, null), "edit");
});

// ── private-to-creator (Notion-style private pages) ──────────────────────────
const priv = (over: Partial<Parameters<typeof effectiveLevel>[1]> = {}) => ({
  id: "p1",
  tags: ["shared"],
  creator: "alice@x",
  visibility: "private" as const,
  ...over,
});

test("private note: the creator gets own (subject matches creator)", () => {
  assert.equal(effectiveLevel([], priv(), null, "alice@x"), "own");
});

test("private note: a non-creator with a TAG grant is denied (tag + floor ignored)", () => {
  const grants = [g({ resource_type: "tag", resource: "shared", level: "edit" })];
  // bob has edit on the folder AND an admin 'own' floor — neither reaches a private note.
  assert.equal(effectiveLevel(grants, priv(), "own", "bob@x"), null);
});

test("private note: an admin floor does NOT override (admins can't see members' private notes)", () => {
  assert.equal(effectiveLevel([], priv(), "own", "admin@x"), null);
});

test("private note: an explicit per-NOTE grant DOES reach it (the creator shared it)", () => {
  const grants = [g({ resource_type: "note", resource: "p1", level: "view" })];
  assert.equal(effectiveLevel(grants, priv(), null, "bob@x"), "view");
});

test("private note: no subject is fail-closed (creator shortcut needs the subject)", () => {
  // Omitting subject can never LEAK — only under-grant the creator.
  assert.equal(effectiveLevel([], priv(), "own"), null);
});

test("a vault grant does NOT override a private note either", () => {
  const grants = [g({ resource_type: "vault", resource: "primary", level: "own" })];
  assert.equal(effectiveLevel(grants, priv(), "own", "bob@x"), null);
});
