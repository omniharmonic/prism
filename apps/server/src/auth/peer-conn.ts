/**
 * Peer CONNECTION tokens — the federation analog of a capability link, but for
 * the WebSocket handshake between two hubs (not a browser share link).
 *
 * Where capability.ts proves "this grant id, not expired" via a symmetric HMAC,
 * a peer-conn token proves "I am the holder of THIS Ed25519 pubkey and I want
 * space X until exp" via an *asymmetric* signature: the connecting hub signs the
 * body with ITS private key (signPayload, our key), and the receiving hub
 * verifies against the pubkey carried in the claims (verifyPeerSignature). The
 * receiver then checks that pubkey is a paired peer with a grant on the space —
 * the signature only authenticates the identity, authorization is still
 * effectiveLevel over the peer's space grants (see collab.resolveLevel).
 *
 * Wire form mirrors capability.ts: `${base64url(JSON claims)}.${signature}`.
 */
import { signPayload, verifyPeerSignature, serverKeyPair } from "./peer";

export interface PeerConnClaims {
  /** The connecting hub's Ed25519 public key (base64url SPKI DER). */
  pubkey: string;
  /** The shared space this connection is scoped to. */
  spaceId: string;
  /** Expiry, epoch ms. */
  exp: number;
}

/** Default connection-token lifetime — short, since a new one is minted per
 *  (re)connect. Long enough to survive transient reconnect storms. */
const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Outbound: sign an assertion proving "I (my pubkey) want `spaceId` until exp".
 * The body is signed with THIS server's private key; the peer verifies against
 * the pubkey we embed (which it already recorded at pairing time).
 */
export function signPeerConnToken(spaceId: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const claims: PeerConnClaims = {
    pubkey: serverKeyPair().publicKeyB64url,
    spaceId,
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${signPayload(body)}`;
}

/**
 * Inbound: parse → verify → check expiry. Returns the claims, or null on ANY
 * problem (malformed, bad signature, expired). Never throws, so a bad token is
 * just a rejected connection.
 */
export function verifyPeerConnToken(token: string): PeerConnClaims | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let claims: PeerConnClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PeerConnClaims;
  } catch {
    return null;
  }
  if (typeof claims.pubkey !== "string" || typeof claims.spaceId !== "string" || typeof claims.exp !== "number") {
    return null;
  }
  // Authenticate the identity: the body must be signed by the claimed pubkey.
  if (!verifyPeerSignature(claims.pubkey, body, sig)) return null;
  if (claims.exp < Date.now()) return null;
  return claims;
}
