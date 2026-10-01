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
import { streamSSE, setServerFetch as installCoreFetch, setMapProxyFetch, type StreamSSEOptions } from "@prism/core";
import { clearReadCache } from "./offline/readCache";

/** The contract a native shell implements and injects BEFORE the app boots. */
export interface PrismHost {
  /** Prism Server origin, e.g. "https://prism.example.com" (no trailing slash).
   *  Falls back to VITE_PRISM_API_ORIGIN baked in at build time. */
  apiOrigin?: string;
  /** The device token (`pd_…`) from the Keychain/Keystore, or null when signed out. */
  getToken(): string | null | undefined | Promise<string | null | undefined>;
  /** The server rejected the token (401). The shell should drop it (and may
   *  restart sign-in). Called at most once per 2s. */
  onUnauthorized?(): void | Promise<void>;
  /** Start the PKCE sign-in flow (system browser). Falls back to onUnauthorized. */
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

let lastUnauthorizedAt = 0;
/** A token was rejected: drop cached data, tell the shell. Debounced. */
export function notifyUnauthorized(): void {
  if (!isNative) return;
  const now = Date.now();
  if (now - lastUnauthorizedAt < 2000) return;
  lastUnauthorizedAt = now;
  void clearReadCache();
  try {
    void Promise.resolve(getHost()?.onUnauthorized?.()).catch(() => {});
  } catch {
    /* host hook must never break the app */
  }
}

/** Start native sign-in (the "Sign in to Prism" button). */
export function startNativeSignIn(): void {
  const h = getHost();
  try {
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
 *    link), `credentials: "omit"`, and a 401 is routed to the host's
 *    onUnauthorized. The token never goes to any other origin.
 * `input` is a server path ("/api/notes") or an absolute URL.
 */
export async function serverFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = serverUrl(input);
  if (!isNative) {
    return fetch(url, { ...init, credentials: init.credentials ?? "include" });
  }
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization") && isOurServer(url)) {
    const token = await getDeviceToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const resp = await fetch(url, { ...init, headers, credentials: "omit" });
  if (resp.status === 401 && headers.get("Authorization")?.startsWith("Bearer ")) notifyUnauthorized();
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
