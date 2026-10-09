/**
 * Device tokens — native sign-in (Architecture v2 WP2.1).
 *
 * Native clients (the Tauri laptop/iPhone shells) authenticate to the Prism
 * Server over the public tunnel WITHOUT a vault token and WITHOUT the
 * loopback-only COLLAB_TOKEN owner path. The flow is OAuth 2.0 for native apps
 * (RFC 8252) with PKCE S256 (RFC 7636): the app opens the system browser at
 * /auth/device/authorize, the user signs in with the EXISTING web login (owner
 * magic link, email + password, or an account created from an invite), approves
 * the device, and the browser is redirected to the app with a one-time code that
 * the app exchanges (with its PKCE verifier) for an opaque bearer token.
 *
 * Token design:
 *  - format `pd_` + 32 random bytes base64url; ONLY its SHA-256 is stored;
 *  - it resolves to the same user actor a session for that email would (role and
 *    grants are recomputed per request, so a revoked grant bites immediately);
 *  - sliding idle expiry (DEVICE_TOKEN_IDLE_DAYS, default 90) refreshed on use
 *    (throttled), hard-capped at DEVICE_TOKEN_MAX_DAYS (default 365) after issue,
 *    so an actively used device stays signed in but a stolen, idle, or
 *    long-lived token dies; revocation is a row update and immediate.
 *
 * This module is pure logic + storage; the HTTP surface is routes/device.ts.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { omniConfig } from "../omni/config";
import {
  insertDeviceToken,
  getDeviceTokenByHash,
  touchDeviceToken,
  revokeDeviceTokenRow,
  listLiveDeviceTokens,
  liveMcpTokensForDevice,
  setMcpTokenRevoked,
  type DeviceTokenRow,
} from "../db";
import { revokeVaultToken } from "../mcp-token";
import { revokePatsForDevice } from "./pat";
import { removeApnsTokenForDevice } from "../apns";

export const DEVICE_TOKEN_PREFIX = "pd_";
export const NATIVE_CLIENT_ID = "prism-native";
/**
 * The Omni app's client id (docs/native-auth.md "Clients"; docs/omni-module.md). The
 * SAME flow and the same `pd_` token as `prism-native` — a second id only so the device
 * list says which app a device is. Accepted only while the Omni module is on
 * (`OMNI_ENABLED=true`): with it off the server knows one client, exactly as before.
 */
export const OMNI_CLIENT_ID = "omni-native";
/** The custom-scheme redirects, each owned by ONE client (see `redirectAllowedForClient`). */
export const PRISM_REDIRECT_URI = "prism://auth/callback";
export const OMNI_REDIRECT_URI = "omni://auth/callback";

/** Is `id` a client this server signs in? Strict equality against the fixed ids. */
export function isKnownClientId(id: unknown): id is string {
  return id === NATIVE_CLIENT_ID || (id === OMNI_CLIENT_ID && omniConfig.enabled());
}

/** The label a device gets when the client sent none. */
export const defaultLabelFor = (clientId: string): string => (clientId === OMNI_CLIENT_ID ? "Omni app" : "Prism app");
/** Authorization codes live at most this long (RFC 6749 recommends ≤ 10 min). */
export const AUTH_CODE_TTL_MS = 5 * 60_000;
/** A pending authorize request (the login bounce) lives this long. */
export const AUTH_REQUEST_TTL_MS = 15 * 60_000;
/** last_seen_at / sliding expiry are written at most this often per device. */
export const TOUCH_THROTTLE_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;
const idleMs = () => Math.max(1, config.deviceTokenIdleDays) * DAY_MS;
const maxMs = () => Math.max(1, config.deviceTokenMaxDays) * DAY_MS;

export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
export const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

/** RFC 7636 §4.1: 43–128 chars of [A-Z a-z 0-9 - . _ ~]. */
export const isValidVerifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
/** An S256 challenge is base64url(sha256) = exactly 43 chars, no padding. */
export const isValidChallenge = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);

/** Constant-time compare of two strings (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Is `uri` an allowed native redirect? Either an EXACT match against
 * DEVICE_REDIRECT_URIS (default `prism://auth/callback,omni://auth/callback`), or — for desktop
 * clients, RFC 8252 §7.3 — an http loopback IP literal (127.0.0.1 / [::1]) on an
 * explicit unprivileged port (≥ 1024) with path exactly `/callback` or `/`, and
 * no query, userinfo or fragment. `localhost` is deliberately NOT accepted
 * (§8.3). Anything else is refused BEFORE any login happens and is never
 * redirected to — not even with an error.
 */
const LOOPBACK_PATHS = new Set(["/callback", "/"]);
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || !uri || uri.length > 512) return false;
  if (config.deviceRedirectUris.includes(uri)) return true;
  if (!config.deviceAllowLoopback) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.hostname !== "127.0.0.1" && u.hostname !== "[::1]") return false;
  if (u.username || u.password || u.hash || uri.includes("#") || uri.includes("?") || u.search) return false;
  const port = Number(u.port);
  if (!u.port || !Number.isInteger(port) || port < 1024 || port > 65535) return false;
  if (!LOOPBACK_PATHS.has(u.pathname)) return false;
  // Reject anything the URL parser normalized (e.g. `/./callback`, `%2f`): the
  // string must be exactly what we'd build from the parts.
  return uri === `http://${u.host}${u.pathname}`;
}

/**
 * A second, NARROWING check applied after `isAllowedRedirectUri`: an app's custom scheme
 * belongs to that app. A `prism://…` redirect is honoured only for `prism-native` and an
 * `omni://…` one only for `omni-native`, so neither app can be handed a code that was
 * requested in the other's name. Loopback and any other allowlisted URI (a universal
 * link) are not tied to a client. It never allows a URI the allowlist refused.
 */
export function redirectAllowedForClient(clientId: string, uri: string): boolean {
  if (!isKnownClientId(clientId) || !isAllowedRedirectUri(uri)) return false;
  const scheme = uri.slice(0, uri.indexOf(":") + 1).toLowerCase();
  if (scheme === "omni:") return clientId === OMNI_CLIENT_ID;
  if (scheme === "prism:") return clientId === NATIVE_CLIENT_ID;
  return true;
}

/** Clamp a client-supplied device label to something safe to store + display. */
export function sanitizeLabel(label: unknown, fallback = "Prism app"): string {
  const s = typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return (s || fallback).slice(0, 80);
}

/** Append OAuth response params to a redirect URI, preserving any existing query. */
export function withParams(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** CSRF token for the consent form: bound to the pending request AND the session. */
export function consentCsrf(requestId: string, sessionId: string): string {
  // No fallback key: a constant would make the CSRF token forgeable.
  if (!config.sessionSecret) throw new Error("SESSION_SECRET is not set — device consent is unavailable");
  return createHmac("sha256", config.sessionSecret).update(`device-consent:${requestId}:${sessionId}`).digest("base64url");
}

export const randomId = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Mint a device token. The plaintext is returned exactly once and never stored. */
export function issueDeviceToken(email: string, label: string, clientId: string): { token: string; id: string; expiresIn: number } {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const id = `dev_${randomBytes(12).toString("base64url")}`;
  const t = Date.now();
  const maxAt = t + maxMs();
  const expiresAt = Math.min(t + idleMs(), maxAt);
  insertDeviceToken({
    id,
    token_hash: sha256hex(token),
    email: email.trim().toLowerCase(),
    label,
    client_id: clientId,
    created_at: t,
    expires_at: expiresAt,
    max_expires_at: maxAt,
  });
  return { token, id, expiresIn: Math.floor((expiresAt - t) / 1000) };
}

/**
 * Resolve a presented bearer to its live device row, or null (unknown, revoked,
 * expired, or not a `pd_` token at all). A hit slides the idle expiry and stamps
 * last_seen_at — throttled so a busy client doesn't write on every request.
 */
export function verifyDeviceToken(token: string | null | undefined): DeviceTokenRow | null {
  if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 200) return null;
  const row = getDeviceTokenByHash(sha256hex(token));
  if (!row) return null;
  const t = Date.now();
  if (row.revoked_at !== null || row.expires_at <= t || row.max_expires_at <= t) return null;
  if (row.last_seen_at === null || t - row.last_seen_at >= TOUCH_THROTTLE_MS) {
    const nextExpiry = Math.min(t + idleMs(), row.max_expires_at);
    touchDeviceToken(row.id, t, nextExpiry);
    row.last_seen_at = t;
    row.expires_at = nextExpiry;
  }
  return row;
}

/** The authenticated email behind a device token, or null. */
export function deviceEmail(token: string | null | undefined): string | null {
  return verifyDeviceToken(token)?.email ?? null;
}

/** `Authorization: Bearer <x>` → x. */
export function bearerFromHeader(h: string | null | undefined): string | undefined {
  return h?.startsWith("Bearer ") ? h.slice("Bearer ".length).trim() : undefined;
}

/**
 * Revoke a device AND every credential minted through it (WP2.1 L3): Prism MCP
 * PATs minted via the device (WP6.1), its APNs push registration, and MCP hub
 * tokens recorded with this device_id are revoked via the mcp-token revoker
 * seam (the hub enforces within ~60s). The device row is revoked first and
 * unconditionally; a failed hub revoke is logged and left unmarked, so it stays
 * visible (and revocable) in the MCP token list. Capability links created via
 * the device are NOT revoked — like a session's, they are standalone shares.
 */
export async function revokeDevice(id: string): Promise<boolean> {
  const changed = revokeDeviceTokenRow(id);
  // Prism MCP PATs minted through this device (WP6.1) die with it — a local row
  // update, immediate.
  revokePatsForDevice(id);
  // Its APNs registration (iOS push) goes too: a signed-out / revoked device is
  // never notified again.
  removeApnsTokenForDevice(id);
  for (const t of liveMcpTokensForDevice(id)) {
    try {
      await revokeVaultToken(t.jti);
      setMcpTokenRevoked(t.jti);
    } catch (e) {
      console.error(`[device] revoking MCP token ${t.jti} of device ${id} failed:`, (e as Error).message);
    }
  }
  return changed;
}

/** Revoke all of an account's devices except `keepId` (e.g. after a password change). */
export async function revokeOtherDevices(email: string, keepId: string | null): Promise<number> {
  let n = 0;
  for (const d of listLiveDeviceTokens(email)) {
    if (d.id === keepId) continue;
    await revokeDevice(d.id);
    n++;
  }
  return n;
}
