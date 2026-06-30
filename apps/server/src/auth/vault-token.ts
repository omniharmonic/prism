/**
 * Hub-issued vault-token validation (Phase 0 of the multi-tenant platform —
 * docs/roadmap/platform-roadmap.md). Prism becomes a Parachute *resource
 * server*: instead of trusting a single static god-token, it VALIDATES the
 * hub-signed `vault:<name>:<verb>` JWTs it holds (and, in later phases, the
 * per-actor tokens the hub mints) against the hub's JWKS.
 *
 * The trust kernel — JWKS fetch + verify, issuer pin, audience strict-check,
 * RFC 7519 `aud` handling, 60s revocation cache — lives in
 * `@openparachute/scope-guard` (the same library vault/scribe use, so we can't
 * silently drift on the worst place to drift). This file is the Prism-side
 * adapter: a process-wide guard wired to our config, plus `verifyVaultToken`,
 * which layers the per-vault scope + audience checks Prism needs.
 *
 * Mirrors `@openparachute/vault/src/hub-jwt.ts` (the canonical reference) with
 * the iss/jwks split + the 0.5.0 multi-origin `allowedIssuers`.
 */
import {
  createScopeGuard,
  HubJwtError,
  hasScope,
  enforceVaultScope,
  type HubJwtClaims,
  type ScopeGuard,
} from "@openparachute/scope-guard";
import { config } from "../config";

// Process-wide guard — holds the JWKS + revocation caches, so instantiate once
// and reuse. Resolver form re-reads config per call (tests can flip origins).
//   hubOrigin       → validates the token `iss` (the hub's public FQDN)
//   jwksOrigin      → fetches keys from the LOCAL hub (loopback; no tunnel hairpin)
//   allowedIssuers  → additive iss allowlist (hub's own origins only — never
//                     request-derived; the signature gate runs first regardless)
const guard: ScopeGuard = createScopeGuard({
  hubOrigin: () => config.hubOrigin,
  jwksOrigin: () => config.hubJwksOrigin,
  allowedIssuers: () => config.hubAllowedIssuers,
});

/**
 * Verify a hub-issued JWT for `vaultName`. Returns the surfaced claims on
 * success; throws `HubJwtError` (branch on `.code`) on ANY failure — bad
 * signature, wrong issuer, expired, missing kid, JWKS unreachable, revoked, or
 * (here) a scope/audience that doesn't authorize this vault.
 *
 * Three independent gates, all must pass:
 *   1. `validateHubJwt` — signature + iss + jti + revocation, and a strict
 *      `aud === vault.<name>` check (the resource-server backstop).
 *   2. `hasScope` — the token carries at least `vault:<name>:read` (admin ⊇
 *      write ⊇ read inheritance is handled by scope-guard).
 *   3. `enforceVaultScope` — the per-user `vault_scope` pin (Phase-1 multi-user)
 *      doesn't EXCLUDE this vault. Empty pin → unrestricted (admin/legacy).
 */
export async function verifyVaultToken(token: string, vaultName: string): Promise<HubJwtClaims> {
  const claims = await guard.validateHubJwt(token, { expectedAudience: `vault.${vaultName}` });
  if (!hasScope(claims.scopes, `vault:${vaultName}:read`)) {
    throw new HubJwtError("shape", `token does not carry a vault:${vaultName}:<verb> scope`);
  }
  if (!enforceVaultScope(claims, vaultName)) {
    throw new HubJwtError("shape", `token vault_scope is pinned away from ${vaultName}`);
  }
  return claims;
}

/** Reset cached JWKS + revocation lists (tests / forced rotation). */
export function resetVaultTokenCaches(): void {
  guard.resetJwksCache();
  guard.resetRevocationCache();
}

export { HubJwtError };
export type { HubJwtClaims };
