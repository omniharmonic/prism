/**
 * Hub vault-token validation — the SCOPE semantics Prism's verifyVaultToken
 * relies on (auth/vault-token.ts). These are scope-guard's pure matchers, tested
 * here offline (no hub/JWKS network) to lock the exact contract Prism builds on:
 * verb inheritance, per-vault isolation, and the vault_scope pin. The full
 * signature/JWKS/audience path is exercised live by scripts/verify-vault-token.ts
 * (needs a running hub) — kept out of the unit suite so CI stays offline.
 *
 * Phase 0.1 of the multi-tenant platform — docs/roadmap/platform-roadmap.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasScope, enforceVaultScope } from "@openparachute/scope-guard";
import { peekTokenClaims, isOurHubToken } from "../src/auth/vault-token";
import { config } from "../src/config";

/** Build an UNSIGNED jwt-shaped string with the given claims (sig is junk — these
 *  helpers peek, they don't verify). */
const jwt = (claims: Record<string, unknown>): string => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
};

test("hasScope: a narrowed vault token satisfies a read check via verb inheritance", () => {
  assert.equal(hasScope(["vault:default:read"], "vault:default:read"), true);
  assert.equal(hasScope(["vault:default:write"], "vault:default:read"), true); // write ⊇ read
  assert.equal(hasScope(["vault:default:admin"], "vault:default:read"), true); // admin ⊇ read
});

test("hasScope: a read-only token does NOT satisfy a write check", () => {
  assert.equal(hasScope(["vault:default:read"], "vault:default:write"), false);
});

test("hasScope: a token scoped to a DIFFERENT vault never authorizes this one", () => {
  // The core multi-tenant isolation guarantee at the scope layer.
  assert.equal(hasScope(["vault:other:read"], "vault:default:read"), false);
  assert.equal(hasScope(["vault:other:admin"], "vault:default:read"), false);
});

test("enforceVaultScope: empty pin is unrestricted; a non-empty pin must include the target", () => {
  assert.equal(enforceVaultScope({ vaultScope: [] }, "default"), true); // admin / legacy / unpinned
  assert.equal(enforceVaultScope({ vaultScope: ["default"] }, "default"), true);
  assert.equal(enforceVaultScope({ vaultScope: ["other"] }, "default"), false); // pinned away → refuse
  assert.equal(enforceVaultScope({ vaultScope: ["work", "default"] }, "default"), true);
});

test("peekTokenClaims decodes a JWT payload and returns null for non-JWTs", () => {
  const claims = peekTokenClaims(jwt({ iss: "https://h", scope: "vault:default:read", exp: 123 }));
  assert.equal(claims?.iss, "https://h");
  assert.equal(claims?.scope, "vault:default:read");
  // A legacy opaque pvt_* token or junk is not a 3-part JWT → null (not a throw).
  assert.equal(peekTokenClaims("pvt_opaque_legacy_token"), null);
  assert.equal(peekTokenClaims("a.b"), null);
  assert.equal(peekTokenClaims(""), null);
});

test("isOurHubToken: true only when iss matches a configured hub origin", () => {
  // config.hubOrigin is our hub; a token stamped by it is locally validatable.
  assert.equal(isOurHubToken(jwt({ iss: config.hubOrigin })), true);
  assert.equal(isOurHubToken(jwt({ iss: `${config.hubOrigin}/` })), true); // trailing slash tolerated
  // A token from a DIFFERENT hub (a linked remote vault) can't be validated here.
  assert.equal(isOurHubToken(jwt({ iss: "https://some-other-hub.example" })), false);
  // No iss / non-JWT → not ours.
  assert.equal(isOurHubToken(jwt({ sub: "x" })), false);
  assert.equal(isOurHubToken("pvt_opaque"), false);
});
