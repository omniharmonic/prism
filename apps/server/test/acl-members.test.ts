/**
 * Workspace member management + folder sharing + whole-workspace grants (Phase 2),
 * driven through the REAL /acl Hono app with an owner session. These are the
 * endpoints the Members panel calls. All writes are scoped to the active vault
 * (primary here, no X-Prism-Vault header). Admin-gated.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { getMembershipRole, grantsForUser } from "../src/db";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => resetDb());

test("members: owner adds a member with a role, lists, and removes", async () => {
  const cookie = ownerCookie();
  const put = await acl.request("/members", {
    method: "PUT",
    headers: { ...J, cookie },
    body: JSON.stringify({ email: "alice@x.co", role: "member" }),
  });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { role: string }).role, "member");
  assert.equal(getMembershipRole("alice@x.co", "primary"), "member");

  const list = (await (await acl.request("/members", { headers: { cookie } })).json()) as Array<{
    email: string;
    role: string;
  }>;
  assert.ok(list.some((m) => m.email === "alice@x.co" && m.role === "member"));

  const del = await acl.request("/members/alice%40x.co", { method: "DELETE", headers: { cookie } });
  assert.equal(del.status, 200);
  assert.equal(getMembershipRole("alice@x.co", "primary"), null);
});

test("members: an admin upsert changes the role (no duplicate)", async () => {
  const cookie = ownerCookie();
  const body = (r: string) => ({ method: "PUT" as const, headers: { ...J, cookie }, body: JSON.stringify({ email: "bob@x.co", role: r }) });
  await acl.request("/members", body("member"));
  await acl.request("/members", body("admin"));
  assert.equal(getMembershipRole("bob@x.co", "primary"), "admin");
});

test("members: a request with no session is forbidden (admin-gated)", async () => {
  const put = await acl.request("/members", { method: "PUT", headers: J, body: JSON.stringify({ email: "x@y.co", role: "admin" }) });
  assert.equal(put.status, 403);
  const get = await acl.request("/members");
  assert.equal(get.status, 403);
});

test("members: a bad role is rejected", async () => {
  const r = await acl.request("/members", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ email: "x@y.co", role: "superuser" }),
  });
  assert.equal(r.status, 400);
});

test("folder sharing: PUT /tags/:tag/people writes a vault-scoped tag grant", async () => {
  const r = await acl.request("/tags/projects/people", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ email: "carol@x.co", level: "edit" }),
  });
  assert.equal(r.status, 200);
  const grants = grantsForUser("carol@x.co", "primary");
  assert.ok(grants.some((g) => g.resource_type === "tag" && g.resource === "projects" && g.level === "edit"));
  // and nothing leaked into another vault
  assert.equal(grantsForUser("carol@x.co", "other-vault").length, 0);
});

test("whole-workspace grant: PUT /vault/people grants vault-level access", async () => {
  const r = await acl.request("/vault/people", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ email: "dave@x.co", level: "view" }),
  });
  assert.equal(r.status, 200);
  const grants = grantsForUser("dave@x.co", "primary");
  assert.ok(grants.some((g) => g.resource_type === "vault" && g.level === "view"));
});
