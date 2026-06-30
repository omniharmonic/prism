/**
 * Workspace role algebra (roles.ts). These pure functions back the gateway's
 * owner/admin short-circuit and the per-note effectiveLevel floor, so the
 * ordering + floor mapping are pinned here. (Phase 0 of the multi-tenant
 * platform roadmap — see docs/roadmap/platform-roadmap.md.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES, roleRank, roleAtLeast, roleFloor } from "../src/roles";

test("ROLES are ordered weakest → strongest", () => {
  assert.deepEqual([...ROLES], ["guest", "member", "admin", "owner"]);
  assert.ok(roleRank("guest") < roleRank("member"));
  assert.ok(roleRank("member") < roleRank("admin"));
  assert.ok(roleRank("admin") < roleRank("owner"));
});

test("roleAtLeast compares by rank and treats null as below everything", () => {
  assert.equal(roleAtLeast("owner", "admin"), true);
  assert.equal(roleAtLeast("admin", "admin"), true); // equal meets the bar
  assert.equal(roleAtLeast("member", "admin"), false);
  assert.equal(roleAtLeast("guest", "member"), false);
  assert.equal(roleAtLeast(null, "guest"), false);
});

test("roleFloor: owner/admin → own, member/guest → null", () => {
  // This is the exact mapping that replaced the old `isOwner ? "own" : (no floor)`
  // short-circuit. owner+admin manage the whole workspace; member/guest are
  // scoped purely by their grants.
  assert.equal(roleFloor("owner"), "own");
  assert.equal(roleFloor("admin"), "own");
  assert.equal(roleFloor("member"), null);
  assert.equal(roleFloor("guest"), null);
  assert.equal(roleFloor(null), null);
});
