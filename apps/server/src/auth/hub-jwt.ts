/**
 * Hub-issued JWT validation — Prism's own implementation of the Parachute hub's
 * PUBLIC token contract, on `jose` (MIT). It replaces `@openparachute/scope-guard`
 * (AGPL-3.0), which Prism used to link in-process: Prism is PolyForm Shield, and
 * the AGPL does not allow linking it into a program under added restrictions.
 * Written from the contract, not from scope-guard's source:
 *
 *   - keys:        GET <hub>/.well-known/jwks.json (RS256, `kid` in the header)
 *   - revocation:  GET <hub>/.well-known/parachute-revocation.json → {jtis: [...]}
 *                  (public; the hub publishes a 60 s convergence target)
 *   - claims:      iss, aud ("vault.<name>"), jti, exp, scope ("a b c"),
 *                  vault_scope ([] = unpinned), permissions (optional)
 *
 * Every check fails closed. The issuer is matched against the configured hub
 * origins only (never anything derived from the request).
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

export type HubJwtErrorCode =
  | "shape" // not a JWT, a missing claim, or a scope/audience that does not authorize the target
  | "signature" // bad signature, unknown key, disallowed algorithm
  | "issuer"
  | "audience"
  | "expired"
  | "revoked"
  | "unavailable"; // keys or revocation list could not be read

export class HubJwtError extends Error {
  constructor(
    readonly code: HubJwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HubJwtError";
  }
}

export interface HubJwtClaims {
  iss: string;
  sub?: string;
  aud: string | string[];
  jti: string;
  exp: number;
  iat?: number;
  /** The space-separated `scope` claim, split. */
  scopes: string[];
  /** The `vault_scope` pin; empty = unrestricted. */
  vaultScope: string[];
  permissions?: unknown;
  [claim: string]: unknown;
}

const VERBS = ["read", "write", "admin"] as const;

/**
 * Does `granted` satisfy `required`? Vault scopes (`vault:<name>:<verb>`)
 * inherit admin ⊇ write ⊇ read within the SAME vault only; any other scope
 * must match exactly.
 */
export function hasScope(granted: readonly string[], required: string): boolean {
  const want = parseVaultScope(required);
  for (const g of granted) {
    if (g === required) return true;
    if (!want) continue;
    const have = parseVaultScope(g);
    if (have && have.vault === want.vault && VERBS.indexOf(have.verb) >= VERBS.indexOf(want.verb)) return true;
  }
  return false;
}

function parseVaultScope(s: string): { vault: string; verb: (typeof VERBS)[number] } | null {
  const parts = s.split(":");
  if (parts.length !== 3 || parts[0] !== "vault" || !parts[1]) return null;
  const verb = parts[2] as (typeof VERBS)[number];
  return VERBS.includes(verb) ? { vault: parts[1], verb } : null;
}

/** The per-user vault pin: empty = unrestricted, else it must name the vault. */
export function enforceVaultScope(claims: Pick<HubJwtClaims, "vaultScope">, vaultName: string): boolean {
  return claims.vaultScope.length === 0 || claims.vaultScope.includes(vaultName);
}

export interface HubJwtVerifierOptions {
  /** The hub's public origin (the token `iss`). Resolved per call. */
  hubOrigin: () => string;
  /** Where keys and the revocation list are FETCHED from (loopback by default). */
  jwksOrigin: () => string;
  /** Additional accepted issuers (the hub's own other origins). */
  allowedIssuers: () => readonly string[];
  /** Tests: a key set instead of the remote JWKS. */
  keys?: JWTVerifyGetKey;
  /** Tests: the revocation list instead of the hub's endpoint. */
  fetchRevoked?: () => Promise<string[]>;
  /** Clock for the revocation cache (tests). */
  now?: () => number;
}

/** Re-read the revocation list after this long. */
const REVOCATION_TTL_MS = 60_000;
/** A list older than this is not trusted when the hub cannot be reached: reject. */
const REVOCATION_STALE_LIMIT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export interface HubJwtVerifier {
  validate(token: string, opts: { expectedAudience: string }): Promise<HubJwtClaims>;
  resetKeys(): void;
  resetRevocations(): void;
}

export function createHubJwtVerifier(opts: HubJwtVerifierOptions): HubJwtVerifier {
  const now = opts.now ?? Date.now;
  let remote: { origin: string; keys: JWTVerifyGetKey } | null = null;
  let revoked: { at: number; jtis: Set<string> } | null = null;
  let inflight: Promise<Set<string>> | null = null;

  const keysFor = (): JWTVerifyGetKey => {
    if (opts.keys) return opts.keys;
    const origin = trimSlash(opts.jwksOrigin());
    if (!remote || remote.origin !== origin) {
      remote = {
        origin,
        keys: createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`), { timeoutDuration: FETCH_TIMEOUT_MS }),
      };
    }
    return remote.keys;
  };

  const fetchRevoked =
    opts.fetchRevoked ??
    (async () => {
      const res = await fetch(`${trimSlash(opts.jwksOrigin())}/.well-known/parachute-revocation.json`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`revocation list HTTP ${res.status}`);
      const body = (await res.json()) as { jtis?: unknown };
      if (!Array.isArray(body.jtis)) throw new Error("revocation list has no jtis");
      return body.jtis.filter((j): j is string => typeof j === "string");
    });

  const revokedJtis = async (): Promise<Set<string>> => {
    const t = now();
    if (revoked && t - revoked.at < REVOCATION_TTL_MS) return revoked.jtis;
    inflight ??= fetchRevoked()
      .then((list) => {
        revoked = { at: now(), jtis: new Set(list) };
        return revoked.jtis;
      })
      .finally(() => {
        inflight = null;
      });
    try {
      return await inflight;
    } catch (e) {
      if (revoked && t - revoked.at < REVOCATION_STALE_LIMIT_MS) return revoked.jtis;
      throw new HubJwtError("unavailable", `revocation list unavailable: ${(e as Error).message}`);
    }
  };

  return {
    async validate(token, { expectedAudience }) {
      if (typeof token !== "string" || token.split(".").length !== 3) {
        throw new HubJwtError("shape", "not a JWT");
      }
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, keysFor(), {
          algorithms: ["RS256"],
          audience: expectedAudience,
          requiredClaims: ["iss", "jti", "exp"],
        }));
      } catch (e) {
        throw mapJoseError(e);
      }
      const iss = typeof payload.iss === "string" ? trimSlash(payload.iss) : "";
      const issuers = new Set([trimSlash(opts.hubOrigin()), ...opts.allowedIssuers().map(trimSlash)]);
      if (!iss || !issuers.has(iss)) throw new HubJwtError("issuer", "token issuer is not this hub");
      const jti = payload.jti;
      if (typeof jti !== "string" || !jti) throw new HubJwtError("shape", "token has no jti");
      if ((await revokedJtis()).has(jti)) throw new HubJwtError("revoked", "token has been revoked");
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
      const pin = payload.vault_scope;
      if (pin !== undefined && !(Array.isArray(pin) && pin.every((v) => typeof v === "string"))) {
        throw new HubJwtError("shape", "token vault_scope is malformed");
      }
      return {
        ...payload,
        iss,
        jti,
        exp: payload.exp as number,
        aud: payload.aud as string | string[],
        scopes,
        vaultScope: (pin as string[] | undefined) ?? [],
      };
    },
    resetKeys() {
      remote = null;
    },
    resetRevocations() {
      revoked = null;
    },
  };
}

function mapJoseError(e: unknown): HubJwtError {
  if (e instanceof errors.JWTExpired) return new HubJwtError("expired", "token has expired");
  if (e instanceof errors.JWTClaimValidationFailed) {
    return e.claim === "aud"
      ? new HubJwtError("audience", "token audience does not match")
      : new HubJwtError("shape", `token claim ${e.claim} is invalid`);
  }
  if (e instanceof errors.JWKSTimeout) return new HubJwtError("unavailable", "hub keys timed out");
  if (
    e instanceof errors.JWSSignatureVerificationFailed ||
    e instanceof errors.JWKSNoMatchingKey ||
    e instanceof errors.JOSEAlgNotAllowed
  ) {
    return new HubJwtError("signature", "token signature is not valid");
  }
  if (e instanceof errors.JWTInvalid || e instanceof errors.JWSInvalid) return new HubJwtError("shape", "malformed token");
  return new HubJwtError("unavailable", `token could not be verified: ${(e as Error)?.message ?? "unknown"}`);
}
