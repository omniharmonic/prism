/**
 * Is this request from the local machine (NOT the public internet)?
 *
 * The only public entrypoint is the Cloudflare tunnel, which always stamps
 * `CF-Connecting-IP` (and `X-Forwarded-For`) on every proxied request. A request
 * that reaches the server with NEITHER header therefore came straight from
 * loopback — i.e. the trusted desktop app talking to localhost:8787.
 *
 * We use this to gate the powerful owner-token auth (COLLAB_TOKEN / vault token):
 * those tokens authenticate the local desktop as the owner, but must be INERT if
 * presented over the tunnel — so even a leaked token can't grant owner access
 * from the internet. Session cookies and note-scoped capability links are the
 * only credentials honored over the public path.
 *
 * Deployment invariant: the public entrypoint MUST be a proxy that sets a
 * forwarding header (Cloudflare tunnel does). Never expose the raw port to the
 * internet without one, or this check would treat external traffic as local.
 *
 * P5.2 hardening — FAIL CLOSED: the header heuristic alone can't tell a raw
 * exposed port (no proxy) from loopback, so the whole path is gated behind
 * `config.trustLocal` (default OFF for a public https server; a tunneled deploy
 * opts in with TRUST_LOCAL=true). With it off, isLocalRequest is ALWAYS false and
 * only session cookies + capability links authenticate — no token-as-owner path.
 */
import { config } from "../config";

type HeaderGet = (key: string) => string | null | undefined;

export function isLocalRequest(get: HeaderGet): boolean {
  if (!config.trustLocal) return false;
  const cf = get("cf-connecting-ip");
  const xff = get("x-forwarded-for");
  const real = get("x-real-ip");
  return !cf && !xff && !real;
}
