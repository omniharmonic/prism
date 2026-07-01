/**
 * Server settings + Cloudflare tunnel management (server-owner only). The
 * operator surface: a config snapshot that NEVER leaks a secret value, tunnel
 * controls (pm2 `prism-tunnel`), and a narrow editable-.env allowlist. These
 * tests cover the gating + validation (rejection) paths — they deliberately do
 * NOT exercise the success write/pm2 paths (those touch the real host).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { setMembership } from "../src/db";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => resetDb());

test("GET /acl/server returns a snapshot to the owner and NEVER a secret value", async () => {
  const r = await acl.request("/server", { headers: { cookie: ownerCookie() } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, unknown>;
  assert.equal(body.appOrigin, config.appOrigin);
  assert.ok("integrations" in body && "tunnel" in body);
  // The whole serialized snapshot must not contain any token/secret material.
  const serialized = JSON.stringify(body);
  assert.ok(!/parachuteToken|sessionSecret|capabilitySecret|Bearer /.test(serialized), "no secret material in snapshot");
});

test("server endpoints are SERVER-owner only (a per-vault admin is rejected)", async () => {
  // A delegated admin passes the /acl admin gate but must NOT reach server settings.
  setMembership("primary", "admin@x.co", "admin", config.ownerEmail);
  const adminCookie = sessionCookie(makeSession("admin@x.co"));
  assert.equal((await acl.request("/server", { headers: { cookie: adminCookie } })).status, 403);
  assert.equal((await acl.request("/server/tunnel", { headers: { cookie: adminCookie } })).status, 403);
  assert.equal((await acl.request("/server/tunnel", { method: "POST", headers: { ...J, cookie: adminCookie }, body: JSON.stringify({ action: "restart" }) })).status, 403);
  assert.equal((await acl.request("/server/config", { method: "PUT", headers: { ...J, cookie: adminCookie }, body: JSON.stringify({ key: "APP_ORIGIN", value: "https://x.io" }) })).status, 403);
  // No session at all → 403 (group gate).
  assert.equal((await acl.request("/server")).status, 403);
});

test("tunnel control validates the action", async () => {
  const r = await acl.request("/server/tunnel", { method: "POST", headers: { ...J, cookie: ownerCookie() }, body: JSON.stringify({ action: "nuke" }) });
  assert.equal(r.status, 400);
});

test("config editor refuses keys outside the curated allowlist", async () => {
  for (const key of ["OWNER_EMAIL", "PARACHUTE_TOKEN", "SESSION_SECRET", "DB_PATH"]) {
    const r = await acl.request("/server/config", { method: "PUT", headers: { ...J, cookie: ownerCookie() }, body: JSON.stringify({ key, value: "whatever" }) });
    assert.equal(r.status, 400, `${key} must be rejected`);
    assert.equal(((await r.json()) as { error: string }).error, "not_editable");
  }
});

test("config editor validates the value (bad APP_ORIGIN → 400, no write)", async () => {
  const r = await acl.request("/server/config", { method: "PUT", headers: { ...J, cookie: ownerCookie() }, body: JSON.stringify({ key: "APP_ORIGIN", value: "not-a-url" }) });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "bad_value");
});
