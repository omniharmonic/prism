/**
 * /api/sync gating (Phase 3): admin-session only, and validation before any
 * external call. The live adapter round-trips are in the verify-*-sync scripts.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sync } from "../src/routes/sync";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => {
  resetDb();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
});

test("sync routes require an admin session", async () => {
  assert.equal((await sync.request("/note/abc/push", { method: "POST" })).status, 403);
  assert.equal((await sync.request("/github/push", { method: "POST" })).status, 403);
  const tok = makeCapability("note", "n1", "edit");
  assert.equal((await sync.request("/note/abc/push", { method: "POST", headers: { authorization: `Capability ${tok}` } })).status, 403);
});

test("github sync: not configured → 400 (before any network)", async () => {
  const r = await sync.request("/github/push", { method: "POST", headers: { ...J, cookie: ownerCookie() }, body: JSON.stringify({ owner: "o", repo: "r", vaultPath: "vault/x" }) });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /github not configured/);
});
