/**
 * Prism MCP authentication (Architecture v2 WP6.1): turn an MCP HTTP request into
 * an `McpPrincipal` — the ordinary `Actor` the gateway already understands, plus
 * which credential produced it and the ceiling it carries. Tools never see a
 * token; they see the actor, and permission checks go through the SAME code as
 * the gateway (`effectiveCaps` / `roleFloor`, see tools and dispatch.ts).
 *
 * Accepted credentials (all as `Authorization: Bearer <x>`; nothing else):
 *
 *  | bearer            | actor                                  | vault                   | ceiling        |
 *  |-------------------|----------------------------------------|-------------------------|----------------|
 *  | `pp_…` PAT        | the PAT's account (role+grants live)   | the PAT's bound vault   | PAT scope      |
 *  | `pd_…` device     | the device's account (as a session)    | X-Prism-Vault (strict)  | none           |
 *  | hub JWT (opt-in)  | the OWNER, primary vault only          | primary                 | JWT write verb |
 *  | COLLAB_TOKEN      | the OWNER — loopback only (TRUST_LOCAL) | X-Prism-Vault (strict)  | none           |
 *
 * Deliberately NOT accepted:
 *  - session cookies — /mcp is a bearer-only endpoint, so a browser's ambient
 *    credentials can never drive it (no CSRF surface);
 *  - capability links (`?t=` / `Authorization: Capability …`) and anonymous
 *    callers — MCP needs an account;
 *  - COLLAB_TOKEN over the tunnel (inert exactly as in resolveActor);
 *  - ANY hub JWT unless the operator opts in with MCP_OWNER_HUB_SUBS (default:
 *    hub JWTs are not accepted on /mcp at all). When set, a hub JWT is the owner
 *    only if it carries `vault:<primary>:admin` AND its `sub` exactly matches an
 *    allowlisted subject. A `vault.<primary>` token is ALSO what vault members,
 *    member-minted agents (`sub = mcp:<email>`) and tag-scoped workers hold, so
 *    audience alone never makes a caller the owner. Member-minted tokens
 *    (registered in `mcp_tokens`, or `sub` starting `mcp:`) and `scoped_tags`
 *    tokens are refused outright.
 *    Why accept a hub JWT at all: Parachute's own backed-surface kit accepts the
 *    operator's vault token the same way (per-surface `aud` does not exist on
 *    the hub yet), and the owner already holds whole-vault access at the vault —
 *    so this adds no power, it only lets the operator's existing agent config
 *    reach Prism-only data (comments, grants, governance) without a second
 *    secret. The token is VALIDATED here and never forwarded anywhere (no token
 *    passthrough — the gateway talks to the vault with its own server token).
 *
 * A PAT is recognised ONLY here, never by resolveActor(), so it cannot become a
 * general web credential.
 */
import type { Context } from "hono";
import { hasScope } from "@openparachute/scope-guard";
import { config } from "../config";
import { getVaultRegistry, grantsForUser, getMcpToken, getUser } from "../db";
import { workspaceRole } from "../roles";
import type { Actor } from "../auth/actor";
import { isLocalRequest } from "../auth/local";
import { DEVICE_TOKEN_PREFIX, verifyDeviceToken, safeEqual } from "../auth/device";
import { PAT_PREFIX, verifyPat } from "../auth/pat";
import { verifyVaultToken, peekTokenClaims, type HubJwtClaims } from "../auth/vault-token";

export type UserActor = Extract<Actor, { kind: "user" }>;
export type McpVia = "pat" | "device" | "hub-jwt" | "local";

export interface McpPrincipal {
  actor: UserActor;
  via: McpVia;
  /** Stable, NON-secret id of the credential (pat_…, dev_…, jwt:<jti>, local). For audit + rate limits. */
  credentialId: string;
  /** true → only tools annotated readOnlyHint are listed or callable. */
  readOnly: boolean;
  /** Credential expiry (ms since epoch), when known. */
  expiresAt: number | null;
  /** true when the credential pins the vault (PAT, hub JWT) rather than following X-Prism-Vault. */
  vaultBound: boolean;
}

export type McpAuthFailure = {
  ok: false;
  status: 400 | 401 | 403;
  /** RFC 6750 error code for the WWW-Authenticate challenge (absent = no credentials presented). */
  error?: "invalid_request" | "invalid_token" | "insufficient_scope";
  description: string;
};
export type McpAuthResult = { ok: true; principal: McpPrincipal } | McpAuthFailure;

/** Hub-JWT verifier seam (tests inject; prod = scope-guard via verifyVaultToken). */
export type HubJwtVerifier = (token: string, vaultName: string) => Promise<HubJwtClaims>;
let hubJwtVerifier: HubJwtVerifier = verifyVaultToken;
export function setHubJwtVerifier(v: HubJwtVerifier | undefined): void {
  hubJwtVerifier = v ?? verifyVaultToken;
}

const fail = (status: McpAuthFailure["status"], error: McpAuthFailure["error"], description: string): McpAuthFailure => ({
  ok: false,
  status,
  error,
  description,
});

function userActor(email: string, vaultId: string, deviceId?: string): UserActor {
  return {
    kind: "user",
    email,
    role: workspaceRole(email, vaultId),
    vaultId,
    grants: grantsForUser(email, vaultId),
    ...(deviceId ? { deviceId } : {}),
  };
}

const looksLikeJwt = (t: string): boolean => t.length < 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);

/**
 * The vault a header-following credential targets. STRICT, unlike the gateway's
 * resolveVaultEntry: an unknown `X-Prism-Vault` is an error here, not a silent
 * fall back to primary — an agent that names the wrong vault should hear so.
 */
function headerVault(c: Context): { id: string } | McpAuthFailure {
  const registry = getVaultRegistry();
  const h = c.req.header("x-prism-vault");
  if (!h) return { id: registry[0]!.id };
  const found = registry.find((v) => v.id === h);
  return found ? { id: found.id } : fail(400, "invalid_request", "unknown vault in X-Prism-Vault");
}

/** A pinned credential may not be pointed at another vault by header. */
function pinnedVault(c: Context, vaultId: string): McpAuthFailure | null {
  const h = c.req.header("x-prism-vault");
  return h && h !== vaultId ? fail(403, "invalid_request", "this credential is bound to a different vault") : null;
}

export async function authenticateMcp(c: Context): Promise<McpAuthResult> {
  const h = c.req.header("authorization");
  if (!h || !/^Bearer\s+/i.test(h)) return fail(401, undefined, "a Bearer token is required");
  const bearer = h.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return fail(401, undefined, "a Bearer token is required");

  // (a) Prism personal access token.
  if (bearer.startsWith(PAT_PREFIX)) {
    const pat = verifyPat(bearer);
    if (!pat) return fail(401, "invalid_token", "the token is invalid, expired or revoked");
    // The account must still exist (the env owner always does), and so must the vault.
    if (pat.email !== config.ownerEmail && !getUser(pat.email)) return fail(401, "invalid_token", "the token's account no longer exists");
    if (!getVaultRegistry().some((v) => v.id === pat.vault_id)) return fail(401, "invalid_token", "the token's vault no longer exists");
    const mismatch = pinnedVault(c, pat.vault_id);
    if (mismatch) return mismatch;
    return {
      ok: true,
      principal: {
        actor: userActor(pat.email, pat.vault_id),
        via: "pat",
        credentialId: pat.id,
        readOnly: pat.scope !== "write",
        expiresAt: pat.expires_at,
        vaultBound: true,
      },
    };
  }

  // (b) Native device token (WP2.1) — the same account a session would be.
  if (bearer.startsWith(DEVICE_TOKEN_PREFIX)) {
    const dev = verifyDeviceToken(bearer);
    if (!dev) return fail(401, "invalid_token", "the token is invalid, expired or revoked");
    const v = headerVault(c);
    if ("ok" in v) return v;
    return {
      ok: true,
      principal: {
        actor: userActor(dev.email, v.id, dev.id),
        via: "device",
        credentialId: dev.id,
        readOnly: false,
        expiresAt: dev.expires_at,
        vaultBound: false,
      },
    };
  }

  // (d) The desktop owner token — loopback only, exactly as resolveActor gates it.
  // Checked before the JWT branch so an opaque COLLAB_TOKEN never reaches the hub
  // verifier. Only COLLAB_TOKEN: the vault token is a hub JWT and takes branch (c).
  if (config.collabToken && isLocalRequest((k) => c.req.header(k)) && safeEqual(bearer, config.collabToken)) {
    if (!config.ownerEmail) return fail(401, "invalid_token", "no owner is configured");
    const v = headerVault(c);
    if ("ok" in v) return v;
    return {
      ok: true,
      principal: { actor: userActor(config.ownerEmail, v.id), via: "local", credentialId: "local", readOnly: false, expiresAt: null, vaultBound: false },
    };
  }

  // (c) The owner's hub JWT for the PRIMARY vault.
  if (looksLikeJwt(bearer)) return hubJwtOwner(c, bearer);

  return fail(401, "invalid_token", "unrecognised token");
}

async function hubJwtOwner(c: Context, token: string): Promise<McpAuthResult> {
  // OPT-IN (WP6.1 review M2): with no MCP_OWNER_HUB_SUBS, hub JWTs are not
  // accepted on /mcp at all — and the verifier (JWKS fetch) is never reached.
  if (config.mcpOwnerHubSubs.length === 0) return fail(401, "invalid_token", "hub tokens are not accepted on this endpoint; use a Prism access token");
  const primary = getVaultRegistry()[0]!;
  let claims: HubJwtClaims;
  try {
    // Signature + issuer + expiry + revocation + strict aud = vault.<primary> +
    // a vault:<primary>:<verb> scope + no vault_scope pin away from it.
    claims = await hubJwtVerifier(token, primary.vault);
  } catch {
    return fail(401, "invalid_token", "the token is invalid, expired, revoked or not issued for this vault");
  }
  if (!config.ownerEmail) return fail(401, "invalid_token", "no owner is configured");
  // Member-minted whole-vault agent tokens (routes/mcp.ts) are never the owner.
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (sub.startsWith("mcp:") || (claims.jti && getMcpToken(claims.jti))) {
    return fail(403, "insufficient_scope", "member agent tokens are not accepted here; use a Prism access token");
  }
  // A tag-narrowed (scoped_tags) token is a worker/agent credential, not the operator.
  const perms = claims.permissions as { scoped_tags?: unknown } | undefined;
  if (perms && Array.isArray(perms.scoped_tags) && perms.scoped_tags.length > 0) {
    return fail(403, "insufficient_scope", "tag-scoped tokens are not accepted here");
  }
  // BOTH gates: the admin scope AND an exactly-allowlisted subject.
  const admin = hasScope(claims.scopes, `vault:${primary.vault}:admin`);
  const allowlisted = !!sub && config.mcpOwnerHubSubs.includes(sub);
  if (!admin || !allowlisted) {
    return fail(403, "insufficient_scope", `a hub token must carry vault:${primary.vault}:admin AND an allowlisted subject to act as the owner`);
  }
  const mismatch = pinnedVault(c, primary.id);
  if (mismatch) return mismatch;
  return {
    ok: true,
    principal: {
      actor: userActor(config.ownerEmail, primary.id),
      via: "hub-jwt",
      credentialId: claims.jti ? `jwt:${claims.jti}` : "jwt",
      readOnly: !hasScope(claims.scopes, `vault:${primary.vault}:write`),
      // The verified token's own exp (the signature was checked above, so peeking is safe).
      expiresAt: typeof peekTokenClaims(token)?.exp === "number" ? (peekTokenClaims(token)!.exp as number) * 1000 : null,
      vaultBound: true,
    },
  };
}
