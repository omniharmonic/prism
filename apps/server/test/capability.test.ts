/**
 * Capability tokens are HMAC-signed bearers ("anyone with the link"). The whole
 * security of link-sharing rests on: a tampered payload or signature is
 * rejected, an expired token is rejected, and a well-formed token verifies back
 * to its claims. These tests target the signature/expiry boundary directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { signCapability, verifyCapability } from "../src/auth/capability";

test("a freshly signed token verifies back to its claims", () => {
  const exp = Date.now() + 60_000;
  const token = signCapability({ id: "cap-123", exp });
  const claims = verifyCapability(token);
  assert.ok(claims);
  assert.equal(claims!.id, "cap-123");
  assert.equal(claims!.exp, exp);
});

test("an expired token is rejected", () => {
  const token = signCapability({ id: "cap-x", exp: Date.now() - 1 });
  assert.equal(verifyCapability(token), null);
});

test("a token with a tampered payload is rejected", () => {
  const token = signCapability({ id: "cap-victim", exp: Date.now() + 60_000 });
  const [, mac] = token.split(".");
  // Forge a payload that grants a different capability id, keep the old MAC.
  const forgedBody = Buffer.from(JSON.stringify({ id: "cap-attacker", exp: Date.now() + 60_000 })).toString("base64url");
  assert.equal(verifyCapability(`${forgedBody}.${mac}`), null);
});

test("a token with a tampered signature is rejected", () => {
  const token = signCapability({ id: "cap-1", exp: Date.now() + 60_000 });
  const [body] = token.split(".");
  assert.equal(verifyCapability(`${body}.deadbeef`), null);
});

test("structurally invalid tokens are rejected, not thrown", () => {
  for (const bad of ["", "no-dot", ".onlymac", "body.", "a.b.c", "💥.💥"]) {
    assert.equal(verifyCapability(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("a token signed for one id cannot be replayed as another (signature binds payload)", () => {
  const a = signCapability({ id: "A", exp: Date.now() + 60_000 });
  const b = signCapability({ id: "B", exp: Date.now() + 60_000 });
  const [bodyA, macA] = a.split(".");
  const [bodyB, macB] = b.split(".");
  // Cross the wires: each body only verifies with its own mac.
  assert.equal(verifyCapability(`${bodyA}.${macB}`), null);
  assert.equal(verifyCapability(`${bodyB}.${macA}`), null);
  assert.ok(verifyCapability(`${bodyA}.${macA}`));
});
