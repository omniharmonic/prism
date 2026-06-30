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

/**
 * Decode a JWT's claims WITHOUT verifying the signature. For logging/routing
 * ONLY — never for authorization (that's verifyVaultToken). Returns null if the
 * string isn't a well-formed 3-part JWT (e.g. a legacy opaque `pvt_*` token).
 */
export function peekTokenClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  } catch {
    return null;
  }
}

/**
 * Is this token issued by THIS server's hub, so verifyVaultToken can validate it
 * against our JWKS? A linked REMOTE-hub vault's token is issued by a different
 * hub and can't be validated locally — callers skip those. Compares the (peeked,
 * unverified) `iss` against our configured hub origins; the signature gate in
 * verifyVaultToken is still the real check.
 */
export function isOurHubToken(token: string): boolean {
  const claims = peekTokenClaims(token);
  const iss = typeof claims?.iss === "string" ? claims.iss.replace(/\/+$/, "") : null;
  if (!iss) return false;
  return new Set([config.hubOrigin, ...config.hubAllowedIssuers]).has(iss);
}

/**
 * Non-blocking, warn-only startup introspection of the registry's vault tokens.
 * Logs each token's scope + expiry date — so an operator SEES an impending
 * expiry instead of hitting silent 401s weeks later (the F2 "tokens expired in
 * 90 days" class of bug) — and hub-validates the ones issued by our own hub,
 * warning (never throwing) on failure so a bad token can't block boot. Remote-hub
 * linked vaults are reported but not validated (their token is issued elsewhere).
 */
export async function reportRegistryTokens(entries: Array<{ id: string; vault: string; token: string }>): Promise<void> {
  for (const entry of entries) {
    const claims = peekTokenClaims(entry.token);
    const scope = (claims?.scope ?? claims?.scopes ?? "(opaque / non-JWT)") as unknown;
    const exp = typeof claims?.exp === "number" ? new Date(claims.exp * 1000).toISOString().slice(0, 10) : "?";
    const ours = isOurHubToken(entry.token);
    console.log(
      `  token[${entry.id}]: scope=${String(scope)} expires=${exp}${ours ? "" : " (remote hub — not validated here)"}`,
    );
    if (ours) {
      try {
        await verifyVaultToken(entry.token, entry.vault);
      } catch (e) {
        const code = e instanceof HubJwtError ? e.code : "error";
        console.warn(`  ⚠ token[${entry.id}] FAILED hub validation (${code}): ${(e as Error).message}`);
      }
    }
  }
}

export { HubJwtError };
export type { HubJwtClaims };
