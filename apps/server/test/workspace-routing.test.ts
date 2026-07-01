/**
 * Workspace routing (Stage 2): the active workspace is resolved per-request from
 * the X-Prism-Workspace header (owner switcher) or the Host subdomain, and it
 * SCOPES the vault list — so a subdomain only ever exposes its own workspace's
 * vaults. Backward-compatible: no header + no host match → the default workspace,
 * which owns every unassigned vault (unchanged behavior).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { vaults } from "../src/routes/vaults";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { addVaultEntry, ensureDefaultWorkspace, createWorkspace, assignVaultToWorkspace, resolveWorkspaceId } from "../src/db";

const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => {
  resetDb();
  ensureDefaultWorkspace();
  addVaultEntry({ id: "frc", label: "Front Range", url: "http://vault.test", vault: "frc", token: "t" });
  createWorkspace({ id: "sotfr", name: "SotFR", hostname: "sotfr.example.com" });
  assignVaultToWorkspace("frc", "sotfr");
});

const list = async (headers: Record<string, string>) => {
  const r = await vaults.request("/vaults", { headers: { cookie: ownerCookie(), ...headers } });
  return ((await r.json()) as Array<{ id: string }>).map((v) => v.id).sort();
};

test("resolveWorkspaceId: header wins, then Host subdomain, then default", () => {
  assert.equal(resolveWorkspaceId({ workspaceHeader: "sotfr" }), "sotfr");
  assert.equal(resolveWorkspaceId({ hostHeader: "sotfr.example.com" }), "sotfr");
  assert.equal(resolveWorkspaceId({ hostHeader: "sotfr.example.com:8787" }), "sotfr", "port is stripped");
  assert.equal(resolveWorkspaceId({ hostHeader: "unknown.example.com" }), "default");
  assert.equal(resolveWorkspaceId({}), "default");
  assert.equal(resolveWorkspaceId({ workspaceHeader: "ghost" }), "default", "unknown id → default");
});

test("the vault list is scoped to the active workspace (by header)", async () => {
  assert.deepEqual(await list({ "x-prism-workspace": "sotfr" }), ["frc"], "SotFR sees only its vault");
  assert.deepEqual(await list({ "x-prism-workspace": "default" }), ["primary"], "default no longer owns the moved vault");
});

test("the Host subdomain scopes the vault list (how a subdomain serves its workspace)", async () => {
  assert.deepEqual(await list({ host: "sotfr.example.com" }), ["frc"]);
  // The main origin (no matching workspace hostname) → default workspace.
  assert.deepEqual(await list({ host: "prism.example.com" }), ["primary"]);
});

test("no header + no host → default workspace = all unassigned vaults (backward-compatible)", async () => {
  // With nothing assigned away, default still owns everything.
  resetDb();
  ensureDefaultWorkspace();
  addVaultEntry({ id: "frc", label: "FRC", url: "http://vault.test", vault: "frc", token: "t" });
  assert.deepEqual(await list({}), ["frc", "primary"]);
});
