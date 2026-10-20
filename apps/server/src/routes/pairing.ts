/**
 * QR pairing routes (D-G), mounted under /auth (the PWA service worker's `/auth/` denylist
 * entry already covers them). The rules live in auth/pairing.ts; this file is the HTTP shape.
 *
 *   POST /auth/pair/start           owner, person (session | pd_), CSRF → {pairingId, link, expiresAt}
 *   GET  /auth/pair/:id             owner (the pairing's creator) → {status, label?, platform?, approveNeedsDevice}
 *   POST /auth/pair/:id/approve     owner, CSRF, {checkCode} — from a DEVICE once the owner has one
 *   POST /auth/pair/:id/deny        owner, CSRF
 *   POST /auth/pair/claim           anyone holding the code (the phone): {code, code_challenge, label, platform}
 *   POST /auth/pair/token           the claimer: {claim_id, code_verifier} → OAuth-style errors | {access_token: pd_…}
 *
 * Every step writes one `action_audit` row with ids only (never the code, a claim id, a
 * challenge or a token).
 */
import { Hono, type Context } from "hono";
import { config } from "../config";
import { requestVia } from "../auth/actor";
import { readSession } from "../auth/session";
import { DEVICE_TOKEN_PREFIX, bearerFromHeader, isValidChallenge, isValidVerifier, issueDeviceTokenClaimed, revokeDevice, verifyDeviceToken } from "../auth/device";
import { needsDeviceConfirmation } from "../auth/device-confirm";
import {
  PAIR_POLL_INTERVAL_S,
  claimPairing,
  completePairingClaim,
  pairingDevice,
  decidePairing,
  isPairingCode,
  pairingFor,
  pairingLink,
  redeemPairing,
  startPairing,
} from "../auth/pairing";
import { reachableOrigin } from "../setup-status";
import { consumeRateLimit, rateLimitClientKey, rateLimited } from "../middleware/ratelimit";
import { recordAction } from "../actions/store";
import { csrfRefusal } from "./actions";

export const pairing = new Hono();

/** Wrong codes one client may send before it is shut out (on top of the route's own limit). */
const CLAIM_FAILURES_PER_10MIN = 10;
const TEN_MIN = 10 * 60_000;

/** The owner as a PERSON: a browser session or a native device token. Never an agent, a PAT, a link or the loopback token. */
function ownerPerson(c: Context): { email: string; via: "session" | "device" } | null {
  const s = readSession(c);
  if (s) return s.email === config.ownerEmail ? { email: s.email, via: "session" } : null;
  const b = bearerFromHeader(c.req.header("authorization"));
  const dev = b?.startsWith(DEVICE_TOKEN_PREFIX) ? verifyDeviceToken(b) : null;
  // requestVia also refuses an in-process MCP dispatch, which can never carry a device token anyway.
  if (dev && requestVia(c) === "device" && dev.email === config.ownerEmail) return { email: dev.email, via: "device" };
  return null;
}

function audit(email: string, via: string, action: string, target: Record<string, unknown>, status: "ok" | "refused" | "failed") {
  recordAction({ actorEmail: email, via, origin: via === "session" || via === "device" ? "human" : "agent", action, vaultId: "primary", target, status });
}

const noStore = (c: Context) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
};

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return null;
  try {
    const raw = await c.req.text();
    if (raw.length > 4096) return null;
    const j = JSON.parse(raw || "{}") as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the owner's side

pairing.post("/pair/start", async (c) => {
  const who = ownerPerson(c);
  if (!who) return c.json({ error: "forbidden" }, 403);
  const csrf = csrfRefusal(c, who.via);
  if (csrf) return csrf;
  // A QR names the server the phone will talk to: only an address it can reach.
  if (!reachableOrigin(config.appOrigin)) {
    audit(who.email, who.via, "auth.pair.start", {}, "refused");
    return c.json({ error: "not_reachable", detail: "This server answers on this computer only. Give it an https address first (the “Reachable from other devices” step)." }, 409);
  }
  const retry = consumeRateLimit(`pair-start:${who.email}`, 10, TEN_MIN);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited", retryAfter: retry }, 429);
  }
  const p = startPairing(who.email);
  audit(who.email, who.via, "auth.pair.start", { pairingId: p.id }, "ok");
  noStore(c);
  return c.json({ pairingId: p.id, link: pairingLink(config.appOrigin, p.code), origin: config.appOrigin, expiresAt: p.expiresAt, approveNeedsDevice: who.via !== "device" && needsDeviceConfirmation(who.email) });
});

pairing.get("/pair/:id", (c) => {
  const who = ownerPerson(c);
  if (!who) return c.json({ error: "forbidden" }, 403);
  const view = pairingFor(who.email, c.req.param("id"));
  if (!view) return c.json({ error: "not_found" }, 404);
  noStore(c);
  return c.json({ ...view, approveNeedsDevice: who.via !== "device" && needsDeviceConfirmation(who.email) });
});

for (const decision of ["approve", "deny"] as const) {
  pairing.post(`/pair/:id/${decision}`, async (c) => {
    const who = ownerPerson(c);
    if (!who) return c.json({ error: "forbidden" }, 403);
    const csrf = csrfRefusal(c, who.via);
    if (csrf) return csrf;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const id = c.req.param("id");
    // One door: with a live device on the account, only an existing device adds another.
    if (decision === "approve" && who.via !== "device" && needsDeviceConfirmation(who.email)) {
      audit(who.email, who.via, "auth.pair.approve", { pairingId: id }, "refused");
      return c.json({ error: "device_required", detail: "Approve this phone from the Prism app on a device you already use." }, 403);
    }
    const r = decidePairing(who.email, id, decision, body.checkCode);
    audit(who.email, who.via, `auth.pair.${decision}`, { pairingId: id }, r.ok ? "ok" : "refused");
    if (r.ok) return c.json({ ok: true });
    if (r.error === "not_found") return c.json({ error: "not_found" }, 404);
    return c.json({ error: r.error, ...(r.triesLeft !== undefined ? { triesLeft: r.triesLeft } : {}) }, r.error === "wrong_check_code" ? 400 : 409);
  });
}

// ---------------------------------------------------------------- the phone's side

pairing.post("/pair/claim", async (c) => {
  noStore(c);
  const key = `pair-claim-fail:${rateLimitClientKey(c)}`;
  const shut = rateLimited(key, CLAIM_FAILURES_PER_10MIN);
  if (shut !== null) {
    c.header("Retry-After", String(shut));
    return c.json({ error: "rate_limited", retryAfter: shut }, 429);
  }
  const global = consumeRateLimit("pair-claim-global", 300, TEN_MIN);
  if (global !== null) {
    c.header("Retry-After", String(global));
    return c.json({ error: "rate_limited", retryAfter: global }, 429);
  }
  const body = await jsonBody(c);
  if (!body || !isPairingCode(body.code) || !isValidChallenge(body.code_challenge)) {
    consumeRateLimit(key, 1_000_000, TEN_MIN);
    return c.json({ error: "invalid_request" }, 400);
  }
  const r = claimPairing(body.code, body.code_challenge, body.label, body.platform);
  if (!r.ok) {
    if (r.error === "invalid_code") consumeRateLimit(key, 1_000_000, TEN_MIN);
    if (r.email && r.pairingId) audit(r.email, "anon", "auth.pair.claim", { pairingId: r.pairingId, reason: r.error }, "refused");
    return c.json({ error: r.error }, r.error === "invalid_code" ? 400 : 409);
  }
  audit(r.email, "anon", "auth.pair.claim", { pairingId: r.pairingId }, "ok");
  return c.json({ claimId: r.claimId, checkCode: r.checkCode, interval: PAIR_POLL_INTERVAL_S, expiresIn: r.expiresIn });
});

function oauthError(c: Context, status: 400 | 401, error: string, description?: string) {
  noStore(c);
  return c.json(description ? { error, error_description: description } : { error }, status);
}

pairing.post("/pair/token", async (c) => {
  const body = await jsonBody(c);
  if (!body || !isValidVerifier(body.code_verifier)) return oauthError(c, 400, "invalid_request");
  const step = redeemPairing(body.claim_id, body.code_verifier);
  switch (step.kind) {
    case "pending":
      return oauthError(c, 400, "authorization_pending");
    case "denied":
      return oauthError(c, 400, "access_denied");
    case "expired":
      return oauthError(c, 400, "expired_token");
    case "invalid":
      return oauthError(c, 400, "invalid_grant");
    case "replay":
      if (step.deviceId) await revokeDevice(step.deviceId, "replay");
      audit(step.email, "anon", "auth.pair.token", { pairingId: step.pairingId, reason: "replay" }, "refused");
      return oauthError(c, 400, "invalid_grant", "already used");
    case "issue": {
      // Claim + mint + device record in one transaction (auth/device.ts issueDeviceTokenClaimed).
      const minted = issueDeviceTokenClaimed(step.email, step.label, step.clientId, (deviceId) => completePairingClaim(step.pairingId, deviceId));
      if (!minted) {
        // Another poll won the claim: this one is a replay of it.
        const winner = pairingDevice(step.pairingId);
        if (winner) await revokeDevice(winner, "replay");
        audit(step.email, "anon", "auth.pair.token", { pairingId: step.pairingId, reason: "replay" }, "refused");
        return oauthError(c, 400, "invalid_grant", "already used");
      }
      const { token, id, expiresIn } = minted;
      audit(step.email, "anon", "auth.pair.token", { pairingId: step.pairingId, deviceId: id }, "ok");
      noStore(c);
      return c.json({ access_token: token, token_type: "Bearer", expires_in: expiresIn, device_id: id });
    }
  }
});
