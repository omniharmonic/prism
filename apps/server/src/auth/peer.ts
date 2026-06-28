/**
 * Peer identity & trust — the Ed25519 analog of capability.ts. Where a
 * capability link is an HMAC bearer of a *grant id* (symmetric, our secret on
 * both ends), a peer hub is an *asymmetric* identity: each Parachute hub holds
 * an Ed25519 keypair and shares only its PUBLIC key. We sign federation
 * payloads with our private key; a peer verifies against the public key it
 * recorded at pairing time, and we verify a peer's signatures against the
 * pubkey stored in the `peers` table. No shared secret crosses the boundary —
 * the pubkey IS the peer's identity, and grants are looked up by it
 * (subject_type='peer'), exactly as capability grants are looked up by id.
 */
import crypto, { type KeyObject } from "node:crypto";
import { config } from "../config";

const b64url = (buf: Buffer): string => buf.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** Import an Ed25519 public key from its SPKI DER, base64url-encoded. */
function importPublicKeyB64url(spkiDerB64url: string): KeyObject {
  return crypto.createPublicKey({
    key: fromB64url(spkiDerB64url),
    format: "der",
    type: "spki",
  });
}

/** base64url of a public key's SPKI DER — the canonical wire form we share. */
export function peerPublicKeyToB64url(publicKey: KeyObject): string {
  return b64url(publicKey.export({ format: "der", type: "spki" }) as Buffer);
}

// ── This server's federation identity ──────────────────────────────────────
// Resolved once, lazily, and cached as a module singleton. If config.peerSigningKey
// is set we derive a STABLE identity from it; otherwise we generate an ephemeral
// keypair and warn (federation works in-process but the identity is not stable
// across restarts).
let cachedKeyPair: { publicKey: KeyObject; privateKey: KeyObject; publicKeyB64url: string } | null = null;

function resolveServerKeyPair(): { publicKey: KeyObject; privateKey: KeyObject; publicKeyB64url: string } {
  let privateKey: KeyObject;
  if (config.peerSigningKey) {
    privateKey = crypto.createPrivateKey({
      key: fromB64url(config.peerSigningKey),
      format: "der",
      type: "pkcs8",
    });
  } else {
    const pair = crypto.generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    console.warn(
      "[federation] PEER_SIGNING_KEY not set — using an EPHEMERAL Ed25519 identity. " +
        "It will change on every restart; set PEER_SIGNING_KEY for a stable federation identity.",
    );
  }
  const publicKey = crypto.createPublicKey(privateKey);
  return { publicKey, privateKey, publicKeyB64url: peerPublicKeyToB64url(publicKey) };
}

/** This server's Ed25519 keypair (stable if PEER_SIGNING_KEY is set, else ephemeral). */
export function serverKeyPair(): { publicKey: KeyObject; privateKey: KeyObject; publicKeyB64url: string } {
  if (!cachedKeyPair) cachedKeyPair = resolveServerKeyPair();
  return cachedKeyPair;
}

/**
 * Generate a fresh Ed25519 keypair as base64url DER strings — a setup helper
 * for provisioning PEER_SIGNING_KEY (privateKeyB64url) and documenting the
 * resulting public identity (publicKeyB64url). Not used at request time.
 */
export function generateKeyPairB64url(): { privateKeyB64url: string; publicKeyB64url: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyB64url: b64url(privateKey.export({ format: "der", type: "pkcs8" }) as Buffer),
    publicKeyB64url: b64url(publicKey.export({ format: "der", type: "spki" }) as Buffer),
  };
}

/** Sign a message with this server's private key. Ed25519 → algorithm MUST be null. */
export function signPayload(message: string): string {
  const sig = crypto.sign(null, Buffer.from(message, "utf8"), serverKeyPair().privateKey);
  return b64url(sig);
}

/**
 * Verify a signature against a peer's public key (SPKI DER, base64url). Returns
 * false on ANY parse/import/verify error — never throws, so a malformed pubkey
 * or signature is just a failed verification, not a crash.
 */
export function verifyPeerSignature(
  peerPublicKeyB64url: string,
  message: string,
  signatureB64url: string,
): boolean {
  try {
    const pub = importPublicKeyB64url(peerPublicKeyB64url);
    return crypto.verify(null, Buffer.from(message, "utf8"), pub, fromB64url(signatureB64url));
  } catch {
    return false;
  }
}

/**
 * Whether a string parses as an Ed25519 SPKI public key — used to reject a bad
 * pubkey before storing a peer. Never throws.
 */
export function isValidPeerPublicKey(peerPublicKeyB64url: string): boolean {
  if (typeof peerPublicKeyB64url !== "string" || peerPublicKeyB64url.length === 0) return false;
  try {
    const pub = importPublicKeyB64url(peerPublicKeyB64url);
    return pub.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * Human-verifiable fingerprint of a public key: sha256 of the RAW public key
 * bytes, first 16 hex chars grouped in pairs (e.g. "a1:b2:c3:d4:e5:f6:07:18").
 * Deterministic and stable, so two operators can read it aloud to confirm they
 * paired the right hub.
 */
export function fingerprint(publicKeyB64url: string): string {
  const raw = fromB64url(publicKeyB64url);
  const hex = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return (hex.match(/.{2}/g) ?? []).join(":");
}
