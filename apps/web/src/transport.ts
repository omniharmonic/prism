/**
 * Prism Server transport — the ONE place apps/web decides HOW it reaches the
 * server. Two modes, chosen at build time:
 *
 *   PWA (default)  same-origin (or VITE_GATEWAY_URL in dev), `credentials:
 *                  "include"` — the httpOnly session cookie. Unchanged behavior.
 *   native         `VITE_PRISM_NATIVE=1` (`npm run build:native`). The app is
 *                  served from tauri://localhost, so the server lives at a
 *                  configured origin and the user is identified by a device
 *                  bearer token (docs/native-auth.md) — no cookies, ever.
 *
 * The native shell supplies the origin + token through `window.__PRISM_HOST__`
 * (see PrismHost). Every server call in apps/web and @prism/core goes through
 * `serverFetch` / `streamServerSSE` / `collabWsUrl` here.
 */
import { streamSSE, setServerFetch as installCoreFetch, setMapProxyFetch, COLLAB_SCHEMA_VERSION, type StreamSSEOptions } from "@prism/core/shell";
import { clearReadCache } from "./offline/readCache";
import { createSessionGuard, type Verdict } from "./native/sessionGuard";

/** The contract a native shell implements and injects BEFORE the app boots. */
export interface PrismHost {
  /** Prism Server origin, e.g. "https://prism.example.com" (no trailing slash).
   *  Falls back to VITE_PRISM_API_ORIGIN baked in at build time. */
  apiOrigin?: string;
  /** The device token (`pd_…`) from the Keychain/Keystore, or null when signed out. */
  getToken(): string | null | undefined | Promise<string | null | undefined>;
  /** The token is DEAD (a 401, confirmed by /auth/me for the same token): forget it.
   *  Must not start a sign-in. Called at most once per page load. */
  onUnauthorized?(): void | Promise<void>;
  /** Start the PKCE sign-in flow (system browser). Only ever called for a person's press. */
  signIn?(): void | Promise<void>;
  /** The user signed out here (the token was revoked server-side): forget it. */
  onSignedOut?(): void | Promise<void>;
}

declare global {
  interface Window {
    __PRISM_HOST__?: PrismHost;
  }
}

/** True in the native build. A build-time constant so the PWA bundle carries none of it. */
export const isNative: boolean = import.meta.env.VITE_PRISM_NATIVE === "1";

export function getHost(): PrismHost | undefined {
  return typeof window === "undefined" ? undefined : window.__PRISM_HOST__;
}

const PWA_ORIGIN = (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

/** Server origin, no trailing slash. PWA: "" (same-origin) unless VITE_GATEWAY_URL. */
export function gatewayOrigin(): string {
  if (!isNative) return PWA_ORIGIN;
  const fromHost = getHost()?.apiOrigin;
  // The iOS shell starts with no server (first run) and owns the origin entirely:
  // never fall back to a build-time one there.
  const iosShell = (window as unknown as { __PRISM_SHELL__?: { platform?: string } }).__PRISM_SHELL__?.platform === "ios";
  if (iosShell) return (fromHost || "").replace(/\/+$/, "");
  const fromBuild = import.meta.env.VITE_PRISM_API_ORIGIN as string | undefined;
  return (fromHost || fromBuild || "").replace(/\/+$/, "");
}

/** The current device token (native only). */
export async function getDeviceToken(): Promise<string | null> {
  if (!isNative) return null;
  try {
    return (await getHost()?.getToken()) || null;
  } catch {
    return null;
  }
}

// ---- when a native session ends (the rule: native/sessionGuard.ts) -----------------------
// A 401 is confirmed with ONE `GET /auth/me` for the same token before anything is dropped;
// a session that really ended forgets the token and reloads into the sign-in screen; nothing
// here ever starts a sign-in; and no request leaves without a token once one was sent.

/** Set across the reload so the sign-in screen can say why it is showing. */
export const SESSION_ENDED_KEY = "prism:session-ended";
const RELOADED_AT_KEY = "prism:session-reload-at";

/** What the server says about ONE token. Deliberately not `serverFetch`: this is the question
 *  the guard asks, so it must not re-enter the guard. Only Prism's own /auth/me answers count:
 *  a 401 or a 200 from anything in between (a proxy, a captive portal) is "unknown". */
async function probeToken(token: string): Promise<Verdict> {
  const origin = gatewayOrigin();
  if (!origin) return "unknown";
  try {
    const r = await fetch(`${origin}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, credentials: "omit", cache: "no-store" });
    if (r.status !== 401 && r.status !== 200) return "unknown";
    const body = (await r.json().catch(() => null)) as { authenticated?: unknown } | null;
    if (r.status === 401) return body?.authenticated === false ? "dead" : "unknown";
    return body?.authenticated === true ? "alive" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Reload into the sign-in screen — at most once per 10 s, so a shell that cannot forget its
 *  token can never turn this into a reload loop (the requests stay blocked either way). */
function reloadSignedOut(rejected: boolean): void {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT_KEY) ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
    // Only a token the SERVER refused is news to the person (not their own sign-out).
    if (rejected) sessionStorage.setItem(SESSION_ENDED_KEY, "1");
  } catch {
    /* no storage: reload anyway */
  }
  window.location.reload();
}

const guard = createSessionGuard({
  getToken: () => getDeviceToken(),
  probe: probeToken,
  // The host hook must never break the app, and it only ever FORGETS (host.js: sign_out).
  forget: async () => { await getHost()?.onUnauthorized?.(); },
  clearCache: () => clearReadCache(),
  reload: reloadSignedOut,
});

/** The server's verdict on the current token after a 401 (joins the question `serverFetch`
 *  already asked). "dead" = the session has ended and the page is on its way to sign-in. */
export async function confirmUnauthorized(): Promise<Verdict> {
  if (!isNative) return "dead";
  return guard.unauthorized(await getDeviceToken());
}

/** The person is signing out here: stop sending authenticated requests now. The sign-out
 *  path reloads by itself when its own clean-up is done. */
export function markSigningOut(): void {
  if (isNative) guard.closing();
}

/** What a request that may not be sent answers: the same status the server would give. */
function signedOutResponse(): Response {
  return new Response(JSON.stringify({ error: "signed_out", authenticated: false }), { status: 401, headers: { "Content-Type": "application/json" } });
}

/** Start native sign-in. ONLY the "Sign in to Prism" button calls this — never a 401.
 *  (One at a time is the shell's rule: host.js `signIn`.) */
export function startNativeSignIn(): void {
  const h = getHost();
  try {
    // An older host with no signIn can only forget its token.
    void Promise.resolve(h?.signIn ? h.signIn() : h?.onUnauthorized?.()).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Absolute URL for a server path. Absolute inputs pass through untouched. */
export function serverUrl(input: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `${gatewayOrigin()}${input}`;
}

/** Does `url` point at our own server? (The bearer token is ONLY ever sent there.) */
function isOurServer(url: string): boolean {
  const origin = gatewayOrigin();
  if (!origin) return !/^[a-z][a-z0-9+.-]*:/i.test(url); // relative = same-origin
  return url === origin || url.startsWith(origin + "/");
}

/**
 * fetch() for the Prism Server.
 *  - PWA: prefixes the gateway origin (usually ""), `credentials: "include"`.
 *  - native: prefixes the configured origin, `Authorization: Bearer <device
 *    token>` (unless the caller set its own Authorization, e.g. a capability
 *    link), `credentials: "omit"`. A 401 is CONFIRMED before the session ends, and no
 *    request leaves without a token once one was sent (native/sessionGuard.ts states
 *    the rule). The token never goes to any other origin.
 * `input` is a server path ("/api/notes") or an absolute URL.
 */
export async function serverFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = serverUrl(input);
  const headers = new Headers(init.headers);
  // Editor-schema handshake (C1): the server refuses content writes from an
  // editor older than the stored note's schema. Only to our own server.
  if ((isOurServer(url) || url.startsWith(`${location.origin}/`)) && !headers.has("X-Prism-Editor-Schema")) headers.set("X-Prism-Editor-Schema", String(COLLAB_SCHEMA_VERSION));
  if (!isNative) {
    return fetch(url, { ...init, headers, credentials: init.credentials ?? "include" });
  }
  // `sent` = OUR device token rode this request (a caller's own Authorization, e.g. a
  // capability link, is the caller's business and never touches the session).
  let sent: string | null = null;
  if (!headers.has("Authorization") && isOurServer(url)) {
    if (guard.over()) return signedOutResponse();
    const token = await getDeviceToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
      sent = token;
      guard.sent();
    } else if (guard.missing()) {
      // Signed out under a running page: this request is NOT sent without a bearer.
      return signedOutResponse();
    }
  }
  const resp = await fetch(url, { ...init, headers, credentials: "omit" });
  // A 401 is only a suspicion: the guard asks /auth/me before the session is treated as over.
  if (resp.status === 401 && sent) void guard.unauthorized(sent);
  return resp;
}

/** Fetch-based SSE against the Prism Server (auth + origin handled like serverFetch). */
export function streamServerSSE(path: string, opts: Omit<StreamSSEOptions, "fetch">): Promise<void> {
  return streamSSE(serverUrl(path), { ...opts, fetch: (u, i) => serverFetch(u, i) });
}

/** The collab WebSocket URL on the configured server. */
export function collabWsUrl(): string {
  const base = gatewayOrigin() || location.origin;
  return base.replace(/^http/, "ws") + "/collab";
}

/** Hocuspocus `token` value: capability token wins; native uses the device token
 *  (resolved per (re)connect, so a rotated token is picked up); PWA sends the
 *  "session" placeholder (the cookie authenticates the upgrade). */
export function collabToken(capability: string | null): string | (() => Promise<string>) {
  if (capability) return capability;
  if (!isNative) return "session";
  return async () => (await getDeviceToken()) ?? "";
}

// @prism/core's governance/review clients use the core seam — point it here.
// PWA keeps core's default (same-origin + cookie) untouched.
// Native also routes the OpenFreeMap basemap through the server's /api/map proxy
// (Client parity C): the client CSP allows only its server; the PWA loads tiles directly.
export function initializeTransport(): void {
  // Call after module evaluation. @prism/core imports the web command shim,
  // which imports this module: calling its setters at module scope accesses
  // their still-uninitialized bindings in the bundled native build.
  if (isNative) {
    installCoreFetch(serverFetch);
    setMapProxyFetch(serverFetch);
  }
}
