/**
 * Whole-app wiring (createApp): the security headers are applied to every
 * response, the route groups are mounted at the right prefixes, deny-by-default
 * holds for non-owners, and the REAL auth-request rate limit (max 5 / window)
 * blocks the 6th magic-link request — exercised through the actual middleware
 * stack, not a hand-built mount.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
const realLog = console.log;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  console.log = () => {}; // silence dev magic-link logging
});
afterEach(() => {
  fv.restore();
  console.log = realLog;
});

test("security headers are present on every response", async () => {
  const app = createApp();
  const r = await app.request("/auth/me");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  // CSP locks scripts to self (no inline-script) and forbids framing.
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  // appOrigin is http in the test env → HSTS must NOT be set (https-only).
  assert.equal(r.headers.get("strict-transport-security"), null);
});

test("routes are mounted at their prefixes (/auth, /api, /acl)", async () => {
  const app = createApp();
  // /auth/me → 401 (auth app reached)
  assert.equal((await app.request("/auth/me")).status, 401);
  // /api/notes → 200 [] for anon (gateway reached, NOT a 404)
  const notes = await app.request("/api/notes");
  assert.equal(notes.status, 200);
  assert.deepEqual(await notes.json(), []);
  // /acl is owner-only → 403 for anon (acl app reached)
  assert.equal((await app.request("/acl/users")).status, 403);
});

test("deny-by-default: an unlisted /api path is 403 for a non-owner", async () => {
  const app = createApp();
  assert.equal((await app.request("/api/internal/secret")).status, 403);
});

test("the auth-request rate limit blocks the 6th magic-link request", async () => {
  const app = createApp();
  const send = () =>
    app.request("/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ email: "spammer@test.local" }),
    });
  for (let i = 1; i <= 5; i++) assert.equal((await send()).status, 200, `request ${i}`);
  assert.equal((await send()).status, 429, "6th request should be rate-limited");
});

test("GET /api/vaults: owner sees the single primary vault (no token); anon denied", async () => {
  const app = createApp();

  // anon → denied (registry not enumerable)
  assert.equal((await app.request("/api/vaults")).status, 403);

  // owner (session cookie for OWNER_EMAIL=owner@test.local) → the primary vault
  const r = await app.request("/api/vaults", {
    headers: { cookie: sessionCookie(makeSession("owner@test.local")) },
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as Array<Record<string, unknown>>;
  assert.equal(body.length, 1);
  assert.deepEqual(body[0], { id: "primary", label: "default", vault: "default", active: true });
  // tokens / upstream urls must never be serialized
  assert.equal("token" in body[0]!, false);
  assert.equal("url" in body[0]!, false);
});
