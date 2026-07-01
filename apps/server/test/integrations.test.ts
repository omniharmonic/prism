/**
 * Integration config endpoints (Phase 3): store/check/remove a workspace's
 * Matrix credential. Admin-gated; the credential is encrypted via the secret
 * store and never returned. (The /matrix/sync trigger hits the live homeserver —
 * covered by scripts/verify-matrix-ingest.ts, not here.)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { integrations } from "../src/routes/integrations";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => {
  resetDb();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
});

test("matrix config: no session → 403", async () => {
  assert.equal((await integrations.request("/matrix")).status, 403);
  assert.equal((await integrations.request("/matrix", { method: "PUT", headers: J, body: "{}" })).status, 403);
});

test("matrix config: a capability link is forbidden (admin session only)", async () => {
  const tok = makeCapability("note", "n1", "edit");
  const r = await integrations.request("/matrix", { headers: { authorization: `Capability ${tok}` } });
  assert.equal(r.status, 403);
});

test("matrix config: store → status configured → delete → status unconfigured", async () => {
  const cookie = ownerCookie();
  // initially not configured
  assert.equal(((await (await integrations.request("/matrix", { headers: { cookie } })).json()) as { configured: boolean }).configured, false);

  const put = await integrations.request("/matrix", {
    method: "PUT",
    headers: { ...J, cookie },
    body: JSON.stringify({ homeserver: "http://localhost:8008", accessToken: "syt_token" }),
  });
  assert.equal(put.status, 200);

  const status = (await (await integrations.request("/matrix", { headers: { cookie } })).json()) as {
    secretsAvailable: boolean;
    configured: boolean;
  };
  assert.equal(status.secretsAvailable, true);
  assert.equal(status.configured, true);

  await integrations.request("/matrix", { method: "DELETE", headers: { cookie } });
  assert.equal(((await (await integrations.request("/matrix", { headers: { cookie } })).json()) as { configured: boolean }).configured, false);
});

test("matrix config: missing fields → 400", async () => {
  const r = await integrations.request("/matrix", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ homeserver: "http://localhost:8008" }), // no token
  });
  assert.equal(r.status, 400);
});

test("matrix config: no SECRETS_KEY → 400 secrets_unconfigured (never stores plaintext)", async () => {
  delete process.env.SECRETS_KEY;
  const r = await integrations.request("/matrix", {
    method: "PUT",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ homeserver: "http://localhost:8008", accessToken: "x" }),
  });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "secrets_unconfigured");
});

test("fathom config: gating + store→status→delete round-trip", async () => {
  const cookie = ownerCookie();
  assert.equal((await integrations.request("/fathom")).status, 403); // no session
  assert.equal((await integrations.request("/fathom", { method: "PUT", headers: { ...J, cookie }, body: "{}" })).status, 400); // no apiKey

  const put = await integrations.request("/fathom", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ apiKey: "fk_test" }) });
  assert.equal(put.status, 200);
  assert.equal(((await (await integrations.request("/fathom", { headers: { cookie } })).json()) as { configured: boolean }).configured, true);
  await integrations.request("/fathom", { method: "DELETE", headers: { cookie } });
  assert.equal(((await (await integrations.request("/fathom", { headers: { cookie } })).json()) as { configured: boolean }).configured, false);
});
