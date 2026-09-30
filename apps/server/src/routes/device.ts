/**
 * Native sign-in routes (WP2.1) — OAuth 2.0 for native apps (RFC 8252) with
 * PKCE S256 (RFC 7636), mounted under /auth (so the PWA service worker's
 * `/auth/` navigateFallbackDenylist entry already covers every page here).
 *
 *   GET  /auth/device/authorize   start: validate client + redirect_uri + PKCE,
 *                                 park the request server-side, then consent
 *                                 (signed in) or bounce through the web login
 *   GET  /auth/device/continue    return point after login (reads the parked request)
 *   POST /auth/device/approve     consent form (session + CSRF bound) → redirect
 *                                 to redirect_uri?code=&state= (or error=access_denied)
 *   POST /auth/device/token       code + code_verifier → { access_token: pd_…, … }
 *   POST /auth/device/revoke      revoke by token (RFC 7009 style) or by device_id
 *   GET  /auth/devices            list your own live devices (owner: ?all=1)
 *   DELETE /auth/devices/:id      revoke one of your devices (owner: any)
 *
 * Security properties (see docs/native-auth.md):
 *  - redirect_uri is checked against an exact allowlist (+ RFC 8252 loopback IPs)
 *    BEFORE anything else; a bad one gets an error page, never a redirect;
 *  - the authorize params are parked in a server-side row referenced by an
 *    httpOnly cookie, so the login bounce carries no client-controlled URL
 *    (the SPA only ever returns to the fixed path /auth/device/continue);
 *  - approval requires the session AND a CSRF token HMAC-bound to (request id,
 *    session id) AND the parked-request cookie of the same browser;
 *  - codes: ≤5 min, single use (atomic claim), bound to client_id + redirect_uri
 *    + S256 challenge (plain is refused); a replayed code revokes the device
 *    token it already produced (RFC 6749 §4.1.2);
 *  - tokens are stored only as SHA-256; /token is rate-limited in app.ts.
 */
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config";
import { readSession } from "../auth/session";
import {
  AUTH_CODE_TTL_MS,
  AUTH_REQUEST_TTL_MS,
  DEVICE_TOKEN_PREFIX,
  NATIVE_CLIENT_ID,
  bearerFromHeader,
  consentCsrf,
  isAllowedRedirectUri,
  isValidChallenge,
  isValidVerifier,
  issueDeviceToken,
  randomId,
  s256,
  safeEqual,
  sanitizeLabel,
  sha256hex,
  verifyDeviceToken,
  withParams,
} from "../auth/device";
import {
  claimDeviceAuthCode,
  deleteDeviceAuthRequest,
  getDeviceAuthCode,
  getDeviceAuthRequest,
  getDeviceToken,
  getDeviceTokenByHash,
  insertDeviceAuthCode,
  insertDeviceAuthRequest,
  listLiveDeviceTokens,
  revokeDeviceTokenRow,
  setDeviceAuthCodeDevice,
  type DeviceAuthRequestRow,
} from "../db";

export const deviceAuth = new Hono();

const REQ_COOKIE = "prism_device_req";
/** The ONLY place the web login screen will send a user back to after sign-in. */
export const DEVICE_CONTINUE_PATH = "/auth/device/continue";

// ---------------------------------------------------------------- helpers

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function page(c: Context, status: 200 | 400 | 401 | 403, title: string, body: string) {
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e8e8ea;padding:16px;box-sizing:border-box}
@media (prefers-color-scheme: light){body{background:#f5f5f7;color:#1c1c1e}.card{background:#fff!important;border-color:#ddd!important}.muted{color:#666!important}}
.card{max-width:420px;width:100%;background:#1a1d23;border:1px solid #2a2d35;border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 10px}p{font-size:14px;line-height:1.5;margin:8px 0}.muted{color:#9a9aa2;font-size:12.5px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:11px 14px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid #3a3d45;background:transparent;color:inherit}
button.primary{background:#6366f1;border-color:#6366f1;color:#fff}code{word-break:break-all;font-size:12px}
</style></head><body><main class="card">${body}</main></body></html>`,
    status,
  );
}

const errorPage = (c: Context, status: 400 | 401 | 403, msg: string) =>
  page(c, status, "Prism sign-in", `<h1>Can't sign in this app</h1><p>${esc(msg)}</p><p class="muted">Close this window and start again from the Prism app.</p>`);

function setReqCookie(c: Context, id: string) {
  setCookie(c, REQ_COOKIE, id, {
    httpOnly: true,
    secure: config.appOrigin.startsWith("https"),
    // Lax: sent on the top-level GET back from a magic-link email, never on a
    // cross-site POST.
    sameSite: "Lax",
    path: "/auth",
    maxAge: Math.floor(AUTH_REQUEST_TTL_MS / 1000),
  });
}
const clearReqCookie = (c: Context) => deleteCookie(c, REQ_COOKIE, { path: "/auth" });

/** The pending authorize request parked for THIS browser, if any. */
export function pendingDeviceRequest(c: Context): DeviceAuthRequestRow | null {
  const id = getCookie(c, REQ_COOKIE);
  return id ? getDeviceAuthRequest(id) : null;
}

function sessionIdOf(c: Context): string | null {
  return getCookie(c, "prism_session") ?? null;
}

function consentPage(c: Context, req: DeviceAuthRequestRow, email: string, sessionId: string) {
  const csrf = consentCsrf(req.id, sessionId);
  let target = req.redirect_uri;
  try {
    const u = new URL(req.redirect_uri);
    target = u.protocol === "http:" ? `${u.host} (this computer)` : `${u.protocol}//${u.host}`;
  } catch {
    /* keep raw */
  }
  return page(
    c,
    200,
    "Sign in Prism",
    `<h1>Sign in Prism on ${esc(req.label ?? "Prism app")}?</h1>` +
      `<p>This will let the Prism app on <strong>${esc(req.label ?? "this device")}</strong> act as <strong>${esc(email)}</strong> — ` +
      `it will see and edit exactly what you can.</p>` +
      `<p class="muted">Only approve if you just started signing in from the Prism app yourself. The app will receive a sign-in code at <code>${esc(target)}</code>. ` +
      `You can revoke this device anytime in Settings → Account.</p>` +
      `<form method="post" action="/auth/device/approve">` +
      `<input type="hidden" name="req" value="${esc(req.id)}"><input type="hidden" name="csrf" value="${esc(csrf)}">` +
      `<div class="row"><button type="submit" name="decision" value="deny">Deny</button>` +
      `<button class="primary" type="submit" name="decision" value="approve">Approve</button></div></form>`,
  );
}

/** Send a signed-out browser through the existing web login, returning to /continue. */
const toLogin = (c: Context) => c.redirect(`/?next=${encodeURIComponent(DEVICE_CONTINUE_PATH)}`);

/** Who is calling a device-management endpoint: a browser session or a device token. */
function identity(c: Context): { email: string; deviceId: string | null } | null {
  const s = readSession(c);
  if (s) return { email: s.email, deviceId: null };
  const bearer = bearerFromHeader(c.req.header("authorization"));
  const dev = bearer?.startsWith(DEVICE_TOKEN_PREFIX) ? verifyDeviceToken(bearer) : null;
  return dev ? { email: dev.email, deviceId: dev.id } : null;
}

async function readBody(c: Context): Promise<Record<string, string>> {
  const ct = c.req.header("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const j = (await c.req.json()) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    }
    const f = await c.req.parseBody();
    return Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

function oauthError(c: Context, status: 400 | 401, error: string, description?: string) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json(description ? { error, error_description: description } : { error }, status);
}

// ---------------------------------------------------------------- authorize

deviceAuth.get("/device/authorize", (c) => {
  const q = c.req.query();
  // 1. redirect_uri + client first — an invalid one is NEVER redirected to.
  if (!isAllowedRedirectUri(q.redirect_uri)) return errorPage(c, 400, "This app asked to return to an address that isn't registered with this Prism server.");
  if (q.client_id !== NATIVE_CLIENT_ID) return errorPage(c, 400, "Unknown client.");
  const redirectUri = q.redirect_uri;
  const state = q.state;
  const bounce = (error: string, description: string) =>
    c.redirect(withParams(redirectUri, { error, error_description: description, state }));
  if (state !== undefined && state.length > 512) return bounce("invalid_request", "state too long");
  if (q.response_type !== undefined && q.response_type !== "code") return bounce("unsupported_response_type", "only response_type=code");
  // 2. PKCE: S256 only (plain is refused — it offers no protection if the
  //    authorization request is observed).
  if (q.code_challenge_method !== "S256") return bounce("invalid_request", "code_challenge_method must be S256");
  if (!isValidChallenge(q.code_challenge)) return bounce("invalid_request", "invalid code_challenge");

  // 3. Park the request server-side; this browser holds only an opaque id.
  const now = Date.now();
  const req: DeviceAuthRequestRow = {
    id: randomId(24),
    client_id: NATIVE_CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: q.code_challenge,
    state: state ?? null,
    label: sanitizeLabel(q.label),
    created_at: now,
    expires_at: now + AUTH_REQUEST_TTL_MS,
  };
  insertDeviceAuthRequest(req);
  setReqCookie(c, req.id);

  const s = readSession(c);
  const sid = sessionIdOf(c);
  if (s && sid) return consentPage(c, req, s.email, sid);
  return toLogin(c);
});

deviceAuth.get("/device/continue", (c) => {
  const req = pendingDeviceRequest(c);
  if (!req) return errorPage(c, 400, "This sign-in request expired or was already used.");
  const s = readSession(c);
  const sid = sessionIdOf(c);
  if (!s || !sid) return toLogin(c);
  return consentPage(c, req, s.email, sid);
});

deviceAuth.post("/device/approve", async (c) => {
  const s = readSession(c);
  const sid = sessionIdOf(c);
  if (!s || !sid) return errorPage(c, 401, "You're not signed in.");
  const f = await readBody(c);
  const cookieReq = getCookie(c, REQ_COOKIE);
  // The form must name the SAME request this browser parked, carry a CSRF token
  // bound to it + this session, and the request must still be live.
  if (!f.req || !cookieReq || !safeEqual(f.req, cookieReq)) return errorPage(c, 403, "This sign-in request doesn't belong to this browser.");
  if (!f.csrf || !safeEqual(f.csrf, consentCsrf(f.req, sid))) return errorPage(c, 403, "Invalid form token.");
  const req = getDeviceAuthRequest(f.req);
  if (!req) return errorPage(c, 400, "This sign-in request expired or was already used.");
  deleteDeviceAuthRequest(req.id);
  clearReqCookie(c);

  if (f.decision !== "approve") {
    return c.redirect(withParams(req.redirect_uri, { error: "access_denied", state: req.state }));
  }
  const code = randomId(32);
  const now = Date.now();
  insertDeviceAuthCode({
    code_hash: sha256hex(code),
    email: s.email,
    client_id: req.client_id,
    code_challenge: req.code_challenge,
    redirect_uri: req.redirect_uri,
    label: req.label,
    created_at: now,
    expires_at: now + AUTH_CODE_TTL_MS,
  });
  return c.redirect(withParams(req.redirect_uri, { code, state: req.state }));
});

// ---------------------------------------------------------------- token

deviceAuth.post("/device/token", async (c) => {
  const f = await readBody(c);
  if (f.grant_type !== "authorization_code") return oauthError(c, 400, "unsupported_grant_type");
  if (f.client_id !== NATIVE_CLIENT_ID) return oauthError(c, 401, "invalid_client");
  if (!f.code || !f.redirect_uri || !isValidVerifier(f.code_verifier)) return oauthError(c, 400, "invalid_request");

  const hash = sha256hex(f.code);
  const row = getDeviceAuthCode(hash);
  if (!row) return oauthError(c, 400, "invalid_grant");
  if (row.used_at !== null) {
    // Replay of a redeemed code: someone else may hold it — kill what it minted.
    if (row.device_id) revokeDeviceTokenRow(row.device_id);
    return oauthError(c, 400, "invalid_grant", "code already used");
  }
  // Claim BEFORE checking the verifier: any attempt burns the code (no retries).
  if (!claimDeviceAuthCode(hash)) return oauthError(c, 400, "invalid_grant", "code expired");
  if (row.client_id !== f.client_id || row.redirect_uri !== f.redirect_uri) return oauthError(c, 400, "invalid_grant");
  if (!safeEqual(s256(f.code_verifier), row.code_challenge)) return oauthError(c, 400, "invalid_grant", "PKCE verification failed");

  const { token, id, expiresIn } = issueDeviceToken(row.email, row.label ?? "Prism app", row.client_id);
  setDeviceAuthCodeDevice(hash, id);
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({ access_token: token, token_type: "Bearer", expires_in: expiresIn, device_id: id });
});

// ---------------------------------------------------------------- revocation

deviceAuth.post("/device/revoke", async (c) => {
  const f = await readBody(c);
  // RFC 7009 style: possession of the token is authority to revoke it. Always
  // 200, whether or not it existed (no token-validity oracle).
  if (f.token) {
    if (f.token.startsWith(DEVICE_TOKEN_PREFIX)) {
      const row = getDeviceTokenByHash(sha256hex(f.token));
      if (row) revokeDeviceTokenRow(row.id);
    }
    return c.json({ ok: true });
  }
  const who = identity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  // By id (your own, or any as the server owner); with no id, a device token
  // revokes ITSELF (sign out).
  const id = f.device_id ?? who.deviceId;
  if (!id) return c.json({ error: "bad_request" }, 400);
  const row = getDeviceToken(id);
  if (!row || (row.email !== who.email && who.email !== config.ownerEmail)) return c.json({ error: "not_found" }, 404);
  revokeDeviceTokenRow(row.id);
  return c.json({ ok: true });
});

deviceAuth.get("/devices", (c) => {
  const who = identity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const all = c.req.query("all") === "1" && who.email === config.ownerEmail;
  const rows = listLiveDeviceTokens(all ? null : who.email);
  c.header("Cache-Control", "no-store");
  return c.json({
    devices: rows.map((r) => ({
      id: r.id,
      label: r.label,
      email: r.email,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      current: r.id === who.deviceId,
    })),
  });
});

deviceAuth.delete("/devices/:id", (c) => {
  const who = identity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const row = getDeviceToken(c.req.param("id"));
  // 404 (not 403) for someone else's device: don't confirm it exists.
  if (!row || (row.email !== who.email && who.email !== config.ownerEmail)) return c.json({ error: "not_found" }, 404);
  revokeDeviceTokenRow(row.id);
  return c.json({ ok: true });
});
