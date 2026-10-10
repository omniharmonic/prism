import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { addVaultEntry, getVaultEntry, setMembership, listPeers, listSpaces, ensureUser, addGrant } from "../src/db";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
beforeEach(() => resetDb());
const admin = "vault-admin@test.local";
function request(path: string, method = "GET", body?: unknown) {
  return acl.request(path, { method, headers: {
    cookie: sessionCookie(makeSession(admin)), "x-prism-vault": "team-a", "content-type": "application/json",
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function setup() {
  for (const id of ["team-a", "team-b"]) addVaultEntry({ id, label: id, vault: id, url: "http://vault.test", token: "test-only" });
  setMembership("team-a", admin, "admin", config.ownerEmail);
}
test("vault admin cannot remove another vault or register a host-wide vault", async () => {
  setup();
  assert.equal((await request("/vaults/team-b", "DELETE")).status, 403);
  assert.ok(getVaultEntry("team-b"));
  assert.equal((await request("/vaults", "POST", { mode: "link", label: "x", vault: "x", url: "http://127.0.0.1:9", token: "test-only" })).status, 403);
  assert.equal((await request("/vaults", "POST", { mode: "create", name: "x", label: "x" })).status, 403);
});
test("vault admin cannot enumerate or mutate global federation and server management", async () => {
  setup();
  for (const path of ["/peers", "/peers/identity", "/spaces", "/federation/status", "/federation/mirrors", "/mirrors", "/workspace", "/workspaces", "/server", "/workers"]) {
    assert.equal((await request(path)).status, 403, path);
  }
  for (const [path, body] of [["/peers/pair", { label: "escape" }], ["/spaces", { label: "escape" }], ["/federation/enabled", { enabled: false }]] as const) {
    assert.equal((await request(path, "POST", body)).status, 403, path);
  }
  assert.deepEqual(listPeers(), []);assert.deepEqual(listSpaces(), []);
});
test("delegated admin retains membership management only in their own vault", async () => {
  setup();
  assert.equal((await request("/members", "PUT", { email: "member@test.local", role: "member" })).status, 200);
  assert.equal((await request("/members")).status, 200);
  const denied = await acl.request("/members", { headers: { cookie: sessionCookie(makeSession(admin)), "x-prism-vault": "team-b" } });
  assert.equal(denied.status, 403);
});

test("vault admin user picker excludes other tenants' identities", async () => {
  setup();
  for (const email of [admin, "own@test.local", "guest@test.local", "private@test.local"]) ensureUser(email);
  setMembership("team-a", "own@test.local", "member", config.ownerEmail);
  setMembership("team-b", "private@test.local", "member", config.ownerEmail);
  addGrant({ vault_id: "team-a", subject_type: "user", subject: "guest@test.local", resource_type: "note", resource: "a", level: "view", created_by: config.ownerEmail });
  const response = await request("/users");
  assert.equal(response.status, 200);
  const users = await response.json() as { email: string }[];
  assert.deepEqual(users.map((u) => u.email).sort(), [admin, "own@test.local", "guest@test.local"].sort());
});
