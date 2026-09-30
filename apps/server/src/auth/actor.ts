/**
 * Actor resolution — turn an incoming request into "who is this, and what may
 * they touch." Order: a valid session cookie wins (a signed-in person); else a
 * native device token (`Authorization: Bearer pd_…`, same user actor as a
 * session); else the loopback-only owner token; else a capability token (?t= query, or `Authorization: Capability <token>`); else
 * anonymous. The actor carries its grants so the permission layer can compute an
 * effective level per note. The owner (OWNER_EMAIL) is flagged for the "own"
 * short-circuit. Capability/anon actors are never the owner.
 */
import type { Context } from "hono";
import { config } from "../config";
import { readSession } from "./session";
import { verifyCapability } from "./capability";
import { isLocalRequest } from "./local";
import { DEVICE_TOKEN_PREFIX, verifyDeviceToken } from "./device";
import { grantsForUser, grantsForCapability, resolveVaultEntry, type Grant } from "../db";
import { workspaceRole, type Role } from "../roles";

// Every actor carries the vault (tenant) the request is bound to, so the gateway
// reads/writes the RIGHT vault and the permission math uses vault-scoped grants.
export type Actor =
  // `deviceId` is set only when authenticated by a native device token (WP2.1),
  // so credentials minted through it can be tied to — and die with — the device.
  | { kind: "user"; email: string; role: Role; vaultId: string; grants: Grant[]; deviceId?: string }
  | { kind: "link"; capabilityId: string; role: "guest"; vaultId: string; grants: Grant[] }
  | { kind: "anon"; role: "guest"; vaultId: string; grants: Grant[] };

/**
 * In-process actor injection (WP6.1, mcp/dispatch.ts). An MCP tool calls the
 * gateway's own routes IN-PROCESS via `app.request(path, init, env)`, passing the
 * already-authenticated actor in `env` under this module-private symbol. Nothing
 * that arrives over HTTP can set it: `c.env` is populated by the runtime adapter
 * (node-server: `{ incoming, outgoing }`), never from request data, and a unique
 * `Symbol()` (not `Symbol.for`) cannot be named from outside this process. This
 * is what keeps a PAT from becoming a web credential while still letting every
 * tool go through the SAME route handlers — and permission code — as the web app.
 */
export const INPROCESS_ACTOR: unique symbol = Symbol("prism.inprocess-actor");

function injectedActor(c: Context): Actor | null {
  const env = c.env as Record<symbol, unknown> | undefined;
  if (!env || typeof env !== "object") return null;
  const a = env[INPROCESS_ACTOR] as Actor | undefined;
  return a && typeof a === "object" && typeof a.kind === "string" ? a : null;
}

export function resolveActor(c: Context): Actor {
  const injected = injectedActor(c);
  if (injected) return injected;

  // The active vault: the X-Prism-Vault header resolved against the registry
  // (unknown/absent → primary, byte-identical to the single-vault default).
  const vaultId = resolveVaultEntry(c.req.header("x-prism-vault")).id;

  const session = readSession(c);
  if (session) {
    const email = session.email;
    return {
      kind: "user",
      email,
      // The authoritative per-vault role: a membership row, the OWNER_EMAIL
      // bootstrap on primary, else guest. A signed-in non-member sees only what
      // explicit grants in THIS vault allow.
      role: workspaceRole(email, vaultId),
      vaultId,
      grants: grantsForUser(email, vaultId),
    };
  }

  const bearer = bearerToken(c);

  // Native device token (WP2.1): `Authorization: Bearer pd_…` minted by the
  // /auth/device PKCE flow. Resolves to EXACTLY the actor a session for that
  // email would — same per-vault role, same grants — and, unlike the owner-token
  // path below, is honored over the public tunnel (it is a per-user, hashed,
  // revocable credential, not a host secret). The `pd_` prefix is checked first
  // so a device token can never be mistaken for (or fall into) the loopback
  // COLLAB_TOKEN branch; an invalid/revoked one falls through to capability/anon.
  if (bearer?.startsWith(DEVICE_TOKEN_PREFIX)) {
    const dev = verifyDeviceToken(bearer);
    if (dev) {
      return {
        kind: "user",
        email: dev.email,
        role: workspaceRole(dev.email, vaultId),
        vaultId,
        grants: grantsForUser(dev.email, vaultId),
        deviceId: dev.id,
      };
    }
  }

  // Desktop owner path: the trusted Tauri app (talking to localhost) presents the
  // dedicated COLLAB_TOKEN (or vault token) as a Bearer token to authenticate as
  // the owner for HTTP routes (e.g. /acl share-link creation). LOCAL-ONLY: a token
  // presented over the public tunnel is ignored, so even a leaked token can't grant
  // owner access from the internet. The local operator owns every vault they target.
  if (
    bearer &&
    !bearer.startsWith(DEVICE_TOKEN_PREFIX) &&
    isLocalRequest((k) => c.req.header(k)) &&
    ((config.collabToken && bearer === config.collabToken) || (config.parachuteToken && bearer === config.parachuteToken))
  ) {
    return { kind: "user", email: config.ownerEmail, role: "owner", vaultId, grants: grantsForUser(config.ownerEmail, vaultId) };
  }

  const token = c.req.query("t") ?? capabilityHeader(c);
  if (token) {
    const claims = verifyCapability(token);
    if (claims) {
      const grants = grantsForCapability(claims.id);
      // A capability link is bound to one resource in one vault — take the vault
      // from its own grants, not a client-supplied header.
      return {
        kind: "link",
        capabilityId: claims.id,
        role: "guest",
        vaultId: grants[0]?.vault_id ?? vaultId,
        grants,
      };
    }
  }

  return { kind: "anon", role: "guest", vaultId, grants: [] };
}

function capabilityHeader(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Capability ") ? h.slice("Capability ".length) : undefined;
}

function bearerToken(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length) : undefined;
}
