/**
 * Workspaces (one server, many workspaces) — the server-owner CRUD that groups
 * vaults + a subdomain into a workspace. Backward-compatible: a 'default'
 * workspace always exists and owns every unassigned vault. Driven through the
 * real /acl app; server-owner-gated.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { addVaultEntry, ensureDefaultWorkspace, workspaceForVault, vaultsForWorkspace, setMembership } from "../src/db";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => {
  resetDb();
  ensureDefaultWorkspace(); // resetDb clears it; boot normally recreates it
  addVaultEntry({ id: "frc", label: "Front Range", url: "http://vault.test", vault: "frc", token: "t" });
});

test("the default workspace exists and owns every unassigned vault", async () => {
  const list = (await (await acl.request("/workspaces", { headers: { cookie: ownerCookie() } })).json()) as Array<{
    id: string; isDefault: boolean; vaults: Array<{ id: string }>;
  }>;
  const def = list.find((w) => w.id === "default");
  assert.ok(def?.isDefault, "default workspace present");
  const vaultIds = def!.vaults.map((v) => v.id).sort();
  assert.deepEqual(vaultIds, ["frc", "primary"], "unassigned vaults belong to default");
});

test("create a workspace, set a hostname, assign a vault — it moves out of default", async () => {
  const cookie = ownerCookie();
  const created = (await (await acl.request("/workspaces", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ name: "Spirit of the Front Range", hostname: "sotfr.example.com" }) })).json()) as { id: string; hostname: string };
  assert.ok(created.id);
  assert.equal(created.hostname, "sotfr.example.com");

  // Assign the frc vault to it.
  const r = await acl.request(`/workspaces/${created.id}/vaults`, { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ vaultId: "frc" }) });
  assert.equal(r.status, 200);
  assert.equal(workspaceForVault("frc"), created.id);
  // …and it left the default workspace.
  assert.ok(!vaultsForWorkspace("default").includes("frc"));
  assert.deepEqual(vaultsForWorkspace(created.id), ["frc"]);
});

test("hostname is validated; the default workspace cannot be deleted", async () => {
  const cookie = ownerCookie();
  assert.equal((await acl.request("/workspaces", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ name: "Bad", hostname: "http://nope/x" }) })).status, 400);
  assert.equal((await acl.request("/workspaces/default", { method: "DELETE", headers: { cookie } })).status, 400);
  // Unknown vault → 400.
  const w = (await (await acl.request("/workspaces", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ name: "W" }) })).json()) as { id: string };
  assert.equal((await acl.request(`/workspaces/${w.id}/vaults`, { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ vaultId: "ghost" }) })).status, 400);
});

test("deleting a workspace returns its vaults to default", async () => {
  const cookie = ownerCookie();
  const w = (await (await acl.request("/workspaces", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ name: "Temp" }) })).json()) as { id: string };
  await acl.request(`/workspaces/${w.id}/vaults`, { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ vaultId: "frc" }) });
  assert.equal((await acl.request(`/workspaces/${w.id}`, { method: "DELETE", headers: { cookie } })).status, 200);
  assert.equal(workspaceForVault("frc"), "default", "vault falls back to default");
});

test("workspace CRUD is server-owner only", async () => {
  setMembership("primary", "admin@x.co", "admin", config.ownerEmail);
  const adminCookie = sessionCookie(makeSession("admin@x.co"));
  assert.equal((await acl.request("/workspaces", { headers: { cookie: adminCookie } })).status, 403);
  assert.equal((await acl.request("/workspaces", { method: "POST", headers: { ...J, cookie: adminCookie }, body: JSON.stringify({ name: "X" }) })).status, 403);
  assert.equal((await acl.request("/workspaces")).status, 403);
});
