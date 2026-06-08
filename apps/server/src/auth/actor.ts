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
import { grantsForUser, grantsForCapability, type Grant } from "../db";

export type Actor =
  | { kind: "user"; email: string; isOwner: boolean; grants: Grant[] }
  | { kind: "link"; capabilityId: string; isOwner: false; grants: Grant[] }
  | { kind: "anon"; isOwner: false; grants: Grant[] };

export function resolveActor(c: Context): Actor {
  const session = readSession(c);
  if (session) {
    const email = session.email;
    return {
      kind: "user",
      email,
      isOwner: email === config.ownerEmail,
      grants: grantsForUser(email),
    };
  }

  // Desktop owner path: the trusted Tauri app presents the dedicated COLLAB_TOKEN
  // (or the vault token) as a Bearer token. This authenticates it as the owner for
  // HTTP routes (e.g. /acl share-link creation) the same way it joins /collab —
  // no new exposure (the token-holder already has full vault access).
  const bearer = bearerToken(c);
  if (bearer && ((config.collabToken && bearer === config.collabToken) || (config.parachuteToken && bearer === config.parachuteToken))) {
    return { kind: "user", email: config.ownerEmail, isOwner: true, grants: grantsForUser(config.ownerEmail) };
  }

  const token = c.req.query("t") ?? capabilityHeader(c);
  if (token) {
    const claims = verifyCapability(token);
    if (claims) {
      return {
        kind: "link",
        capabilityId: claims.id,
        isOwner: false,
        grants: grantsForCapability(claims.id),
      };
    }
  }

  return { kind: "anon", isOwner: false, grants: [] };
}

function capabilityHeader(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Capability ") ? h.slice("Capability ".length) : undefined;
}

function bearerToken(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length) : undefined;
}
