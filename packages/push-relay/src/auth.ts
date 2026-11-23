/**
 * Server identity and request signing.
 *
 * A self-hosted Prism server generates an Ed25519 keypair ONCE (the private key
 * stays in a 0600 file beside its database) and registers the public key. Its
 * relay id is derived from the key (`serverIdFor`), so an id can never be
 * re-pointed at another key. Every request is signed:
 *
 *   X-Relay-Server:    <server id>
 *   X-Relay-Timestamp: <unix milliseconds>
 *   X-Relay-Nonce:     <16-43 base64url chars, fresh per request>
 *   X-Relay-Signature: base64url(Ed25519(canonical))
 *
 *   canonical = "prism-push-relay-v1\n" + METHOD + "\n" + PATH + "\n" +
 *               TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(body))
 *
 * The relay accepts a timestamp within ±SKEW_MS and each nonce once (the server's
 * shard remembers nonces for NONCE_TTL_MS > 2 × SKEW_MS), so a captured request
 * cannot be replayed. The relay stores public keys only: a leak of its storage
 * lets nobody send as a server.
 *
 * This file is plain WebCrypto (Workers and Node ≥ 22 both implement Ed25519), so
 * the Prism Server's tests can run the real verifier against the server's signer.
 */

export const SIGNING_CONTEXT = "prism-push-relay-v1";
export const SKEW_MS = 5 * 60_000;
export const NONCE_TTL_MS = 15 * 60_000;
export const HEADER = {
  server: "x-relay-server",
  timestamp: "x-relay-timestamp",
  nonce: "x-relay-nonce",
  signature: "x-relay-signature",
} as const;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The relay id of a public key: the first 22 base64url chars (132 bits) of SHA-256(raw key). */
export async function serverIdFor(publicKeyB64url: string): Promise<string | null> {
  const raw = fromB64url(publicKeyB64url);
  if (!raw || raw.length !== 32) return null;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return b64url(d).slice(0, 22);
}
export const isServerId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{22}$/.test(s);
export const isNonce = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{16,43}$/.test(s);

export async function canonicalString(method: string, path: string, timestamp: string, nonce: string, body: string): Promise<string> {
  return [SIGNING_CONTEXT, method.toUpperCase(), path, timestamp, nonce, await sha256Hex(body)].join("\n");
}

export interface SignedParts {
  serverId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

/** Read the four signing headers; null when any is missing or malformed. */
export function signedParts(headers: Headers): SignedParts | null {
  const serverId = headers.get(HEADER.server);
  const ts = headers.get(HEADER.timestamp);
  const nonce = headers.get(HEADER.nonce);
  const signature = headers.get(HEADER.signature);
  if (!isServerId(serverId) || !isNonce(nonce) || !signature || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
  if (!ts || !/^\d{13}$/.test(ts)) return null;
  return { serverId, timestamp: Number(ts), nonce, signature };
}

/** Verify an Ed25519 signature over `message` with a raw base64url public key. Never throws. */
export async function verifySignature(publicKeyB64url: string, message: string, signatureB64url: string): Promise<boolean> {
  const raw = fromB64url(publicKeyB64url);
  const sig = fromB64url(signatureB64url);
  if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, enc.encode(message));
  } catch {
    return false;
  }
}
