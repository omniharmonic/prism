/**
 * A published site's password unlock (`POST /api/p/:slug/auth`) is anonymous and each try is an
 * scrypt: it is rate-limited per client like /auth/login (launch security review).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { addGrant, createPublication } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { installFakeVault, resetDb } from "./helpers";

test("password guesses on a published site are limited per client (429 after 20 in ten minutes); another client is not affected", async () => {
  resetDb();
  const fv = installFakeVault();
  try {
    createPublication({ id: "locked", resource_type: "tag", resource: "docs", template: "wiki", title: null, home_note_id: null, password_hash: hashPassword("hunter2"), theme: null, expires_at: null, created_by: "owner@test.local" });
    addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "docs", level: "view", created_by: "test" });
    const app = createApp();
    const guess = (ip: string, password = "nope") =>
      app.request("/api/p/locked/auth", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ password }) });
    for (let i = 0; i < 20; i++) assert.equal((await guess("203.0.113.7")).status, 401);
    const shut = await guess("203.0.113.7", "hunter2");
    assert.equal(shut.status, 429, "even the right password waits once the client is over the limit");
    assert.ok(shut.headers.get("retry-after"));
    assert.equal((await guess("198.51.100.9", "hunter2")).status, 200);
  } finally {
    fv.restore();
  }
});
