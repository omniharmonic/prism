/**
 * Universal links (NP-NA-04): the Apple App Site Association file.
 *
 *   GET /.well-known/apple-app-site-association
 *   GET /apple-app-site-association            (the pre-iOS-9.3 location; same body)
 *
 * It tells iOS/macOS which https paths of THIS host the Prism Client app may open
 * instead of the browser. Apple fetches it (through its CDN) without credentials
 * and without following redirects, so: no auth, no redirect, `application/json`,
 * cacheable. It is public by nature and names nothing but the app id and path
 * patterns.
 *
 * 🔒 What may be captured is an ALLOWLIST of the client routes that open content
 * (`APP_LINK_ROUTES`), preceded by explicit exclusions (first match wins):
 *  - sign-in, invite and device-authorize pages MUST stay in the browser — the
 *    native sign-in opens `/auth/device/authorize` in the SYSTEM browser and
 *    comes back through `prism://auth/callback` or a loopback redirect
 *    (docs/native-auth.md); an app that captured those would break PKCE;
 *  - ANY link with a query stays in the browser: a capability link
 *    (`/collab/<id>?t=…`) carries its own access, which the app (acting as the
 *    signed-in account) would drop; and the app refuses every query, so a
 *    `/page/<id>?utm=…` handed to it would dead-end;
 *  - paths deeper than `/<route>/<id>` stay in the browser too;
 *  - `/p/*` (published wikis) are public web pages and are simply not listed.
 * The app re-validates every link it is handed against the same allowlist
 * (apps/client/src-tauri/src/links.rs) — this file is not a security boundary.
 *
 * `APPLE_APP_ID` = `<TeamID>.<bundle id>` (comma-separated for several apps).
 * Empty → 404: a deploy that sets it to "" advertises nothing. Served only on
 * the public host (`APP_ORIGIN`'s host name): any other Host answers 404.
 */
import type { Hono } from "hono";
import { config } from "../config";

/** `<10-char team id>.<reverse-DNS bundle id>`. */
const APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Client routes that open content in the app. Keep in step with `links.rs` (`ROUTES`) and apps/web `native/appLinks.ts`. */
export const APP_LINK_ROUTES = ["page", "collab", "inbox", "agent"] as const;

/** Server-owned and sign-in paths that must never open in the app. */
export const APP_LINK_EXCLUDED = ["/auth/*", "/api/*", "/acl/*", "/mcp", "/mcp/*", "/health", "/.well-known/*", "/accept-invite", "/accept-invite/*", "/p/*"] as const;

export function parseAppIds(raw: string | undefined | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (id && id.length <= 160 && APP_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

type Component = { "/": string; "?"?: Record<string, string> | string; exclude?: true; comment?: string };

export function appLinkComponents(): Component[] {
  const out: Component[] = APP_LINK_EXCLUDED.map((path) => ({ "/": path, exclude: true as const }));
  // ANY URL with a query stays in the browser. The app refuses every query
  // (a capability link `/collab/<id>?t=…` would lose its access there, and
  // `/page/<id>?utm=…` would dead-end on "can't be opened"), so the OS must
  // not hand such a link over in the first place. `?*` = one character or more.
  out.push({ "/": "*", "?": "?*", exclude: true, comment: "links with a query stay in the browser" });
  // Deeper paths than the app knows (`/page/a/b`, and a trailing slash): the browser's too.
  for (const route of APP_LINK_ROUTES) out.push({ "/": `/${route}/*/*`, exclude: true });
  for (const route of APP_LINK_ROUTES) {
    if (route === "inbox" || route === "agent") out.push({ "/": `/${route}` });
    out.push({ "/": `/${route}/*` });
  }
  return out;
}

/** The association document, or null when no (valid) app id is configured. */
export function appSiteAssociation(appIds: readonly string[] = parseAppIds(config.appleAppId)): Record<string, unknown> | null {
  if (appIds.length === 0) return null;
  return { applinks: { details: [{ appIDs: [...appIds], components: appLinkComponents() }] } };
}

export const APP_SITE_ASSOCIATION_PATHS = ["/.well-known/apple-app-site-association", "/apple-app-site-association"] as const;

/**
 * Is this request addressed to the public host (`APP_ORIGIN`)? The file claims
 * links for ONE host; an alias the server also answers on (a tunnel hostname,
 * `localhost`, an IP) must not serve it — Apple would associate that name too.
 * Host NAME only: a proxy in front may drop or change the port.
 */
export function isAppHost(requestUrl: string, appOrigin: string = config.appOrigin): boolean {
  try {
    return new URL(requestUrl).hostname.toLowerCase() === new URL(appOrigin).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Mount both paths. MUST come before the SPA fallback (it would answer 200 + index.html). */
export function mountAppSiteAssociation(app: Hono): void {
  for (const path of APP_SITE_ASSOCIATION_PATHS) {
    app.get(path, (c) => {
      const body = isAppHost(c.req.url) ? appSiteAssociation() : null;
      if (!body) return c.json({ error: "not_found" }, 404);
      return c.body(JSON.stringify(body), 200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      });
    });
  }
  // Nothing else answers under the association name: `…/apple-app-site-association/x`
  // or `….json` must not fall through to the SPA shell (a 200 HTML page there reads,
  // to a fetcher, like a broken association file).
  app.all("/.well-known/apple-app-site-association/*", (c) => c.json({ error: "not_found" }, 404));
  app.all("/apple-app-site-association/*", (c) => c.json({ error: "not_found" }, 404));
}
