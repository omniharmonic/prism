/**
 * Workspace management (server-owner only) — the cross-vault surface where the
 * server owner administers every vault ("workspace = the server, grouping many
 * vaults") and each person's access/role per vault. Driven through the real /acl
 * Hono app. A WORKSPACE spans all vaults, so these are gated on the SERVER owner
 * (config.ownerEmail), NOT merely a per-vault admin.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { addVaultEntry, setMembership, getMembershipRole, grantsForUser } from "../src/db";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => {
  resetDb();
  // A second vault in the registry so "workspace" is genuinely multi-vault.
  addVaultEntry({ id: "team-b", label: "Team B", url: "http://vault.test", vault: "team-b", token: "t" });
});

test("GET /acl/workspace lists all vaults + the owner as owner of each", async () => {
  const body = (await (await acl.request("/workspace", { headers: { cookie: ownerCookie() } })).json()) as {
    vaults: Array<{ id: string }>;
    people: Array<{ email: string; isServerOwner: boolean; access: Record<string, { role?: string; level?: string }> }>;
  };
  assert.deepEqual(body.vaults.map((v) => v.id).sort(), ["primary", "team-b"]);
  const owner = body.people.find((p) => p.email === config.ownerEmail);
  assert.ok(owner?.isServerOwner, "owner is flagged as the server owner");
  assert.equal(owner!.access["primary"]?.role, "owner");
  assert.equal(owner!.access["team-b"]?.role, "owner", "server owner owns every vault");
});

test("PUT /acl/workspace/access grants a person access to a CHOSEN vault at a level", async () => {
  const cookie = ownerCookie();
  const r = await acl.request("/workspace/access", {
    method: "PUT",
    headers: { ...J, cookie },
    body: JSON.stringify({ email: "alice@x.co", vaultId: "team-b", level: "edit" }),
  });
  assert.equal(r.status, 200);
  // The grant landed in team-b, NOT primary (per-vault isolation).
  assert.ok(grantsForUser("alice@x.co", "team-b").some((g) => g.resource_type === "vault" && g.level === "edit"));
  assert.equal(grantsForUser("alice@x.co", "primary").length, 0);

  // …and it shows up in the workspace matrix.
  const body = (await (await acl.request("/workspace", { headers: { cookie } })).json()) as {
    people: Array<{ email: string; access: Record<string, { level?: string }> }>;
  };
  assert.equal(body.people.find((p) => p.email === "alice@x.co")?.access["team-b"]?.level, "edit");
});

test("PUT /acl/workspace/members sets a management role in a chosen vault", async () => {
  const r = await acl.request("/workspace/members", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ email: "bob@x.co", vaultId: "team-b", role: "admin" }),
  });
  assert.equal(r.status, 200);
  assert.equal(getMembershipRole("bob@x.co", "team-b"), "admin");
  assert.equal(getMembershipRole("bob@x.co", "primary"), null);
});

test("DELETE removes access / membership for a chosen vault", async () => {
  const cookie = ownerCookie();
  await acl.request("/workspace/access", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ email: "carol@x.co", vaultId: "team-b", level: "view" }) });
  await acl.request("/workspace/members", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ email: "carol@x.co", vaultId: "team-b", role: "member" }) });

  assert.equal((await acl.request("/workspace/access/team-b/carol%40x.co", { method: "DELETE", headers: { cookie } })).status, 200);
  assert.equal(grantsForUser("carol@x.co", "team-b").length, 0);
  assert.equal((await acl.request("/workspace/members/team-b/carol%40x.co", { method: "DELETE", headers: { cookie } })).status, 200);
  assert.equal(getMembershipRole("carol@x.co", "team-b"), null);
});

test("workspace endpoints reject a bad/unknown vault and non-server-owners", async () => {
  const cookie = ownerCookie();
  // Unknown vault id → 400.
  const bad = await acl.request("/workspace/access", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ email: "x@y.co", vaultId: "nope", level: "view" }) });
  assert.equal(bad.status, 400);

  // A delegated per-vault ADMIN (not the server owner) cannot reach the workspace
  // surface — even though they pass the /acl admin gate for their own vault.
  setMembership("primary", "admin@x.co", "admin", config.ownerEmail);
  const adminCookie = sessionCookie(makeSession("admin@x.co"));
  assert.equal((await acl.request("/workspace", { headers: { cookie: adminCookie } })).status, 403);
  assert.equal((await acl.request("/workspace/access", { method: "PUT", headers: { ...J, cookie: adminCookie }, body: JSON.stringify({ email: "z@y.co", vaultId: "team-b", level: "view" }) })).status, 403);

  // No session at all → 403 (the group gate).
  assert.equal((await acl.request("/workspace")).status, 403);
});
