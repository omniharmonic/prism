/**
 * Per-tenant secret store (Phase 3) — encrypt-at-rest round-trip + tenant
 * isolation + tamper/key safety. The store is the gate on server-side
 * multi-tenant ingest/agent: one tenant's credential must never be readable by
 * another, and a wrong/missing master key must fail closed.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { putSecret, getSecret, deleteSecret, listSecretKinds, secretsConfigured } from "../src/secrets";
import { resetDb } from "./helpers";

beforeEach(() => {
  resetDb();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
});

test("round-trips a secret for a tenant", () => {
  putSecret("A", "alice@x", "matrix", "syt_secret_token");
  assert.equal(getSecret("A", "alice@x", "matrix"), "syt_secret_token");
});

test("secrets are isolated per (vault, owner, kind)", () => {
  putSecret("A", "alice@x", "notion", "ntn_A");
  putSecret("B", "alice@x", "notion", "ntn_B");
  putSecret("A", "bob@x", "notion", "ntn_bob");
  assert.equal(getSecret("A", "alice@x", "notion"), "ntn_A");
  assert.equal(getSecret("B", "alice@x", "notion"), "ntn_B"); // different vault
  assert.equal(getSecret("A", "bob@x", "notion"), "ntn_bob"); // different owner
  assert.equal(getSecret("A", "alice@x", "fathom"), null); // different kind → absent
});

test("upsert overwrites; delete removes; listSecretKinds never leaks values", () => {
  putSecret("A", "alice@x", "matrix", "v1");
  putSecret("A", "alice@x", "matrix", "v2");
  assert.equal(getSecret("A", "alice@x", "matrix"), "v2");
  putSecret("A", "alice@x", "notion", "n1");
  assert.deepEqual(listSecretKinds("A", "alice@x").sort(), ["matrix", "notion"]);
  deleteSecret("A", "alice@x", "matrix");
  assert.equal(getSecret("A", "alice@x", "matrix"), null);
  assert.deepEqual(listSecretKinds("A", "alice@x"), ["notion"]);
});

test("a different master key cannot decrypt (fail-closed on key rotation/compromise)", () => {
  putSecret("A", "alice@x", "matrix", "topsecret");
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64"); // rotate to a WRONG key
  assert.throws(() => getSecret("A", "alice@x", "matrix")); // GCM auth fails
});

test("missing SECRETS_KEY fails closed (never stores plaintext)", () => {
  delete process.env.SECRETS_KEY;
  assert.equal(secretsConfigured(), false);
  assert.throws(() => putSecret("A", "alice@x", "matrix", "x"), /SECRETS_KEY/);
});

test("an invalid SECRETS_KEY length is rejected", () => {
  process.env.SECRETS_KEY = Buffer.from("too-short").toString("base64");
  assert.equal(secretsConfigured(), false);
  assert.throws(() => putSecret("A", "alice@x", "matrix", "x"), /32 bytes/);
});
