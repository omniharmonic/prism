/**
 * Federation — the PEER-facing surface of Parachute-to-Parachute trust. Unlike
 * /acl (owner-session gated) these routes are called by ANOTHER hub, not by a
 * browser: a pairing peer fetches our identity and redeems a one-time pairing
 * code to register its public key. Authorization for everything that follows is
 * the peer's Ed25519 pubkey (subject_type='peer' grants); the only secret that
 * gatekeeps registration is the single-use pairing code the owner handed over
 * out-of-band. The integrator mounts this at /api/federation.
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { consumePairing, upsertPeer } from "../db";
import { serverKeyPair, fingerprint, isValidPeerPublicKey } from "../auth/peer";

export const federation = new Hono();

/** Our public identity, so a pairing peer can record + human-verify our key. */
federation.get("/identity", (c) => {
  const { publicKeyB64url } = serverKeyPair();
  return c.json({ publicKey: publicKeyB64url, fingerprint: fingerprint(publicKeyB64url) });
});

/**
 * Redeem a one-time pairing code and register the calling peer's public key.
 * The code (sha256-hashed for lookup) is single-use and TTL'd; on success we
 * store the peer and hand back OUR identity so the handshake is mutual.
 */
federation.post("/pair", async (c) => {
  let body: { code?: unknown; pubkey?: unknown; label?: unknown; email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }

  const { code, pubkey, label, email } = body;
  if (typeof code !== "string" || code.length === 0) return c.json({ error: "bad_request" }, 400);
  if (!isValidPeerPublicKey(typeof pubkey === "string" ? pubkey : "")) {
    return c.json({ error: "bad_pubkey" }, 400);
  }

  const codeHash = createHash("sha256").update(code).digest("hex");
  const pairing = consumePairing(codeHash);
  if (!pairing) return c.json({ error: "invalid_or_expired_code" }, 403);

  upsertPeer({
    pubkey: pubkey as string,
    label: typeof label === "string" ? label : pairing.label,
    email: typeof email === "string" ? email : undefined,
    paired_at: Date.now(),
  });

  const { publicKeyB64url } = serverKeyPair();
  return c.json({ ok: true, serverPublicKey: publicKeyB64url, fingerprint: fingerprint(publicKeyB64url) });
});
