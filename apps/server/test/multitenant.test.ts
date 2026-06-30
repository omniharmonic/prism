/**
 * Multi-tenant isolation (Phase 1) — the load-bearing invariant: a tenant = a
 * vault, and NOTHING crosses between vaults. Grants, "anyone" grants, and
 * workspace roles are all scoped by vault_id; a subject's access in vault A says
 * nothing about vault B. Tested at the db + roles layer (the authoritative
 * isolation primitives); the gateway wires these per-request via the actor's
 * vaultId. See docs/roadmap/platform-roadmap.md Phase 1.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  addGrant,
  grantsForUser,
  upsertGrant,
  setMembership,
  getMembershipRole,
  removeMembership,
  listMemberships,
  membershipsForUser,
} from "../src/db";
import { workspaceRole } from "../src/roles";
import { config } from "../src/config";
import { resetDb } from "./helpers";

beforeEach(() => resetDb());

test("user grants are isolated per vault: a grant in A is invisible from B", () => {
  addGrant({ vault_id: "A", subject_type: "user", subject: "alice@x", resource_type: "tag", resource: "projects", level: "edit", created_by: null });
  addGrant({ vault_id: "B", subject_type: "user", subject: "alice@x", resource_type: "tag", resource: "secret", level: "view", created_by: null });

  assert.deepEqual(grantsForUser("alice@x", "A").map((g) => g.resource), ["projects"]);
  assert.deepEqual(grantsForUser("alice@x", "B").map((g) => g.resource), ["secret"]);
  // The primary vault (the default) sees neither.
  assert.equal(grantsForUser("alice@x").length, 0);
});

test("'anyone' grants are also per-vault (a public slice in A doesn't leak into B)", () => {
  addGrant({ vault_id: "A", subject_type: "anyone", subject: "*", resource_type: "tag", resource: "public", level: "view", created_by: null });
  assert.equal(grantsForUser("anybody@x", "A").length, 1);
  assert.equal(grantsForUser("anybody@x", "B").length, 0);
});

test("upsertGrant is keyed by (vault, subject, resource) — same resource in two vaults stays distinct", () => {
  upsertGrant({ vault_id: "A", subject_type: "user", subject: "bob@x", resource_type: "tag", resource: "docs", level: "view", created_by: null });
  upsertGrant({ vault_id: "B", subject_type: "user", subject: "bob@x", resource_type: "tag", resource: "docs", level: "edit", created_by: null });
  // Raising A's level must not touch B's.
  upsertGrant({ vault_id: "A", subject_type: "user", subject: "bob@x", resource_type: "tag", resource: "docs", level: "own", created_by: null });

  assert.equal(grantsForUser("bob@x", "A").find((g) => g.resource === "docs")?.level, "own");
  assert.equal(grantsForUser("bob@x", "B").find((g) => g.resource === "docs")?.level, "edit");
  assert.equal(grantsForUser("bob@x", "A").length, 1, "A still has exactly one grant (upsert, not insert)");
});

test("workspaceRole is per-vault; membership in A is not a role in B", () => {
  setMembership("A", "carol@x", "admin", "owner@x");
  assert.equal(workspaceRole("carol@x", "A"), "admin");
  assert.equal(workspaceRole("carol@x", "B"), "guest"); // no membership in B → guest
});

test("OWNER_EMAIL is the bootstrap owner of the PRIMARY vault only", () => {
  assert.equal(workspaceRole(config.ownerEmail, "primary"), "owner");
  // The env owner has NO automatic role in a different tenant — they'd need a
  // membership row there too (so one operator hosting many tenants is explicit).
  assert.equal(workspaceRole(config.ownerEmail, "tenant-b"), "guest");
});

test("membership lifecycle: upsert (role change), list, per-user view, remove", () => {
  setMembership("A", "m1@x", "member", "o");
  setMembership("A", "m2@x", "guest", "o");
  setMembership("A", "m1@x", "admin", "o"); // upsert: role change, not a duplicate

  assert.equal(getMembershipRole("m1@x", "A"), "admin");
  assert.equal(listMemberships("A").length, 2);

  setMembership("B", "m1@x", "member", "o");
  assert.deepEqual(
    membershipsForUser("m1@x").map((m) => `${m.vault_id}:${m.role}`).sort(),
    ["A:admin", "B:member"],
  );

  removeMembership("A", "m1@x");
  assert.equal(getMembershipRole("m1@x", "A"), null);
  assert.equal(getMembershipRole("m1@x", "B"), "member", "removing A's membership leaves B's intact");
});

test("an unknown membership role string falls back to guest (never silently elevates)", () => {
  setMembership("A", "weird@x", "superuser" as never, "o"); // not in the Role ladder
  assert.equal(workspaceRole("weird@x", "A"), "guest");
});
