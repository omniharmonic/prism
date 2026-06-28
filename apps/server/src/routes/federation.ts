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
import type { Context } from "hono";
import { createHash } from "node:crypto";
import { consumePairing, upsertPeer, getPeer, upsertMirrorRequest } from "../db";
import { serverKeyPair, fingerprint, isValidPeerPublicKey } from "../auth/peer";
import { verifyPeerConnToken } from "../auth/peer-conn";

export const federation = new Hono();

const COLLAB_KINDS = new Set(["document", "code", "spreadsheet", "canvas"]);
function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length) : undefined;
}

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
  let body: { code?: unknown; pubkey?: unknown; label?: unknown; email?: unknown; collabUrl?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }

  const { code, pubkey, label, email, collabUrl } = body;
  if (typeof code !== "string" || code.length === 0) return c.json({ error: "bad_request" }, 400);
  if (!isValidPeerPublicKey(typeof pubkey === "string" ? pubkey : "")) {
    return c.json({ error: "bad_pubkey" }, 400);
  }
  // Optional: the redeeming peer advertises its own /collab WS URL so this hub's
  // FederationManager can later open the outbound binding without an out-of-band
  // step (gap #1). Accept only a ws(s):// URL; ignore anything else.
  const peerCollabUrl =
    typeof collabUrl === "string" && /^wss?:\/\//.test(collabUrl) ? collabUrl : undefined;

  const codeHash = createHash("sha256").update(code).digest("hex");
  const pairing = consumePairing(codeHash);
  if (!pairing) return c.json({ error: "invalid_or_expired_code" }, 403);

  upsertPeer({
    pubkey: pubkey as string,
    label: typeof label === "string" ? label : pairing.label,
    email: typeof email === "string" ? email : undefined,
    paired_at: Date.now(),
    collab_url: peerCollabUrl,
  });

  const { publicKeyB64url } = serverKeyPair();
  return c.json({ ok: true, serverPublicKey: publicKeyB64url, fingerprint: fingerprint(publicKeyB64url) });
});

/**
 * Mirror a shared space's notes onto THIS hub. A paired peer pushes the space id
 * + the note manifest (space_note_key + kind per note) it wants both hubs to hold
 * under the same keys. Authenticated by a peer-conn token (the caller's Ed25519
 * pubkey + the space). We do NOT apply it here — a peer must not silently write
 * into our vault — it lands as a PENDING request for the owner to accept/reject
 * (`/acl/federation/mirrors`). Idempotent per (peer, space): re-pushing refreshes
 * the manifest. This replaces the manual B-side SQLite insert the harness used.
 */
federation.post("/mirror", async (c) => {
  const token = c.req.query("t") ?? bearer(c);
  const claims = token ? verifyPeerConnToken(token) : null;
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  const peer = getPeer(claims.pubkey);
  if (!peer || !peer.paired_at) return c.json({ error: "unknown_peer" }, 403);

  let body: { spaceId?: unknown; spaceTitle?: unknown; notes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
  // The token is bound to a space; it must match the body so a token for space X
  // can't be replayed to mirror into space Y.
  if (!spaceId || spaceId !== claims.spaceId) return c.json({ error: "space_mismatch" }, 400);

  const notes = (Array.isArray(body.notes) ? body.notes : [])
    .filter(
      (n): n is { spaceNoteKey: string; kind: string; title?: string } =>
        !!n && typeof (n as { spaceNoteKey?: unknown }).spaceNoteKey === "string" &&
        typeof (n as { kind?: unknown }).kind === "string" &&
        COLLAB_KINDS.has((n as { kind: string }).kind),
    )
    .map((n) => ({ spaceNoteKey: n.spaceNoteKey, kind: n.kind, title: typeof n.title === "string" ? n.title : undefined }));
  if (notes.length === 0) return c.json({ error: "no_valid_notes" }, 400);

  const req = upsertMirrorRequest({
    peer_pubkey: claims.pubkey,
    space_id: spaceId,
    space_title: typeof body.spaceTitle === "string" ? body.spaceTitle : null,
    payload: JSON.stringify(notes),
  });
  return c.json({ ok: true, requestId: req.id, status: req.status, noteCount: notes.length });
});
