/**
 * Capability links — Google-Docs-style "anyone with the link" sharing. A link
 * is a signed bearer of a capability *id*; the actual grants (resource + level)
 * live in the db keyed by that id (subject_type='link'), so a link is revocable
 * by deleting its grants. The token itself only proves "this id + not expired",
 * via HMAC over the payload with CAPABILITY_SECRET. No db lookup is needed to
 * verify the signature; the grants are looked up after.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

const sign = (payload: string): string =>
  createHmac("sha256", config.capabilitySecret).update(payload).digest("base64url");

export interface CapabilityClaims {
  /** Capability id; grants are stored in db with subject_type='link', subject=id. */
  id: string;
  /** Expiry, epoch ms. */
  exp: number;
}

export function signCapability(claims: CapabilityClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyCapability(token: string): CapabilityClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CapabilityClaims;
  } catch {
    return null;
  }
  if (typeof claims.id !== "string" || typeof claims.exp !== "number") return null;
  if (claims.exp < Date.now()) return null;
  return claims;
}
