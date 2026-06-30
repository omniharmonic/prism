/**
 * Actor resolution — turn an incoming request into "who is this, and what may
 * they touch." Order: a valid session cookie wins (a signed-in person); else a
 * capability token (?t= query, or `Authorization: Capability <token>`); else
 * anonymous. The actor carries its grants so the permission layer can compute an
 * effective level per note. The owner (OWNER_EMAIL) is flagged for the "own"
 * short-circuit. Capability/anon actors are never the owner.
 */
import type { Context } from "hono";
import { config } from "../config";
import { readSession } from "./session";
import { verifyCapability } from "./capability";
import { isLocalRequest } from "./local";
import { grantsForUser, grantsForCapability, resolveVaultEntry, type Grant } from "../db";
import { workspaceRole, type Role } from "../roles";

// Every actor carries the vault (tenant) the request is bound to, so the gateway
// reads/writes the RIGHT vault and the permission math uses vault-scoped grants.
export type Actor =
  | { kind: "user"; email: string; role: Role; vaultId: string; grants: Grant[] }
  | { kind: "link"; capabilityId: string; role: "guest"; vaultId: string; grants: Grant[] }
  | { kind: "anon"; role: "guest"; vaultId: string; grants: Grant[] };

export function resolveActor(c: Context): Actor {
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

  // Desktop owner path: the trusted Tauri app (talking to localhost) presents the
  // dedicated COLLAB_TOKEN (or vault token) as a Bearer token to authenticate as
  // the owner for HTTP routes (e.g. /acl share-link creation). LOCAL-ONLY: a token
  // presented over the public tunnel is ignored, so even a leaked token can't grant
  // owner access from the internet. The local operator owns every vault they target.
  const bearer = bearerToken(c);
  if (
    bearer &&
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
