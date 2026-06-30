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
import { grantsForUser, grantsForCapability, type Grant } from "../db";
import type { Role } from "../roles";

export type Actor =
  | { kind: "user"; email: string; role: Role; grants: Grant[] }
  | { kind: "link"; capabilityId: string; role: "guest"; grants: Grant[] }
  | { kind: "anon"; role: "guest"; grants: Grant[] };

export function resolveActor(c: Context): Actor {
  const session = readSession(c);
  if (session) {
    const email = session.email;
    return {
      kind: "user",
      email,
      // Phase 0: role derived from OWNER_EMAIL (byte-identical to the old
      // isOwner). Phase 1 replaces this with workspaceRole(email, activeVault),
      // backed by the memberships table + hub user_vaults.
      role: email === config.ownerEmail ? "owner" : "member",
      grants: grantsForUser(email),
    };
  }

  // Desktop owner path: the trusted Tauri app (talking to localhost) presents the
  // dedicated COLLAB_TOKEN (or vault token) as a Bearer token to authenticate as
  // the owner for HTTP routes (e.g. /acl share-link creation). LOCAL-ONLY: a token
  // presented over the public tunnel is ignored, so even a leaked token can't grant
  // owner access from the internet.
  const bearer = bearerToken(c);
  if (
    bearer &&
    isLocalRequest((k) => c.req.header(k)) &&
    ((config.collabToken && bearer === config.collabToken) || (config.parachuteToken && bearer === config.parachuteToken))
  ) {
    return { kind: "user", email: config.ownerEmail, role: "owner", grants: grantsForUser(config.ownerEmail) };
  }

  const token = c.req.query("t") ?? capabilityHeader(c);
  if (token) {
    const claims = verifyCapability(token);
    if (claims) {
      return {
        kind: "link",
        capabilityId: claims.id,
        role: "guest",
        grants: grantsForCapability(claims.id),
      };
    }
  }

  return { kind: "anon", role: "guest", grants: [] };
}

function capabilityHeader(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Capability ") ? h.slice("Capability ".length) : undefined;
}

function bearerToken(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length) : undefined;
}
