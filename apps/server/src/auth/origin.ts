/**
 * THE one origin rule (launch: `prism signin` signs the owner in at this computer's own
 * address while APP_ORIGIN is a remote https one, and setup writes from there must work).
 *
 * A browser `Origin` is allowed when it is
 *   - APP_ORIGIN,
 *   - a NATIVE_ORIGINS entry, or
 *   - this server's OWN loopback origin — `http://localhost:<port>`, `http://127.0.0.1:<port>`
 *     or `http://[::1]:<port>` on exactly the port it listens on — and only when the request
 *     itself passes the strict loopback test of local sign-in (`loopbackRefusal`: the TCP
 *     peer is loopback, read from the socket, never a header; no proxy/forwarding header;
 *     the Host names a loopback address on this port) AND the Origin is the very origin the
 *     request was made to (a page on `localhost:<port>` posting to `127.0.0.1:<port>` is
 *     another origin and stays refused).
 *
 * A page on another localhost port is a different origin and is refused; a request that
 * came through the tunnel, Tailscale serve or any proxy is refused a loopback Origin even if
 * it names one. Every Origin comparison in the server goes through `allowedOrigin` — do not
 * write another `origin !== config.appOrigin` check.
 *
 * Cookies follow the same line: `cookieSecure(c)` is false only for a strict-loopback request
 * over plain http (WebKit drops a Secure cookie set by http://localhost); everywhere else it is
 * "APP_ORIGIN is https", as before.
 */
import type { IncomingMessage } from "node:http";
import type { Context } from "hono";
import { config } from "../config";
import { loopbackRefusal } from "./local-signin";

/** This server's own loopback origins (exactly its listening port). */
export function loopbackSelfOrigins(port: number = config.port): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

/** The origin this request was made to (from its URL), or null. */
function requestOrigin(c: Context): string | null {
  try {
    return new URL(c.req.url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is a browser-sent `Origin` one this server accepts for a credentialed write?
 * (A trailing slash is tolerated, as every former copy of this check did.)
 */
export function allowedOrigin(c: Context, origin: string): boolean {
  const o = origin.replace(/\/+$/, "");
  if (o === config.appOrigin || config.nativeOrigins.includes(o)) return true;
  if (!loopbackSelfOrigins().includes(o)) return false;
  if (requestOrigin(c) !== o) return false;
  return loopbackRefusal(c) === null;
}

/**
 * `allowedOrigin` for a raw Node request (the collab WebSocket upgrade, which never passes
 * through Hono). Same rule: the request URL is built from its Host, the socket is its own.
 */
export function allowedOriginForRequest(req: IncomingMessage, origin: string): boolean {
  const header = (k: string): string | undefined => {
    const v = req.headers[k.toLowerCase()];
    return Array.isArray(v) ? v.join(", ") : v;
  };
  const shim = { req: { url: `http://${req.headers.host ?? "invalid.invalid"}${req.url ?? "/"}`, header }, env: { incoming: req } } as unknown as Context;
  return allowedOrigin(shim, origin);
}

/** The `Secure` flag for a cookie set on this response. */
export function cookieSecure(c: Context): boolean {
  if (loopbackRefusal(c) === null && requestOrigin(c)?.startsWith("http:")) return false;
  return config.appOrigin.startsWith("https");
}
