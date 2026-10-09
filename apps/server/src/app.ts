/**
 * Builds the Prism Server Hono app: security headers, CORS (for cross-origin
 * dev only), rate limits on the auth surface, the three route groups
 * (/auth, /api, /acl), and the static web app with SPA fallback. Kept separate
 * from index.ts (process startup: assertConfig + serve + collab) so the full
 * request pipeline can be constructed and tested without binding a port.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config";
import { vault } from "./parachute";
import { auth } from "./routes/auth";
import { api } from "./routes/api";
import { vaults } from "./routes/vaults";
import { acl } from "./routes/acl";
import { rag } from "./routes/rag";
import { publish } from "./routes/publish";
import { federation } from "./routes/federation";
import { federated } from "./routes/federated";
import { governance } from "./routes/governance";
import { agentApi } from "./routes/agent";
import { pushApi } from "./routes/push";
import { integrations } from "./routes/integrations";
import { sync } from "./routes/sync";
import { calendar } from "./routes/calendar";
import { actionsApi } from "./routes/actions";
import { adminApi } from "./routes/admin";
import { mountOmni } from "./routes/omni";
import { mcp } from "./routes/mcp";
import { pats } from "./routes/pats";
import { mountPrismMcp } from "./mcp/router";
import { mountAppSiteAssociation } from "./routes/app-links";
import { media, map as mapProxy } from "./routes/media";
import { rateLimit } from "./middleware/ratelimit";
import { EMBED_FRAME_SOURCES } from "@prism/core/media-embeds";

export function createApp(): Hono {
  const app = new Hono();

  // Dev aid, off unless PRISM_HTTP_ERRLOG=1: one line per refused or failed request — method,
  // path (never the query string), status, origin and whether a bearer was sent. No header
  // value, no body. The server otherwise logs no request outcomes, which leaves a client
  // that is being refused (a native shell, a new route) undiagnosable from this side.
  if (process.env.PRISM_HTTP_ERRLOG === "1") {
    app.use("*", async (c, next) => {
      await next();
      if (c.res.status < 400) return;
      const auth = c.req.header("authorization") ?? "";
      const kind = auth.startsWith("Bearer pd_") ? "device" : auth ? "bearer" : c.req.header("cookie") ? "cookie" : "none";
      // The server's own short error code, when the body is small JSON (never note content: a refusal carries none).
      let code = "";
      try {
        const body = (await c.res.clone().json()) as { error?: unknown; reason?: unknown };
        code = [body.error, body.reason].filter((x) => typeof x === "string").join(" / ").slice(0, 120);
      } catch {
        /* not JSON */
      }
      console.log(`[http] ${c.res.status} ${c.req.method} ${new URL(c.req.url).pathname} origin=${c.req.header("origin") ?? "-"} auth=${kind} vault=${c.req.header("x-prism-vault") ?? "-"}${code ? ` error=${code}` : ""}`);
    });
  }

  // Content-Security-Policy. Scripts are external ES modules (no inline <script>),
  // so script-src stays tight; 'wasm-unsafe-eval' covers editor deps (e.g.
  // Excalidraw) without opening full eval. style-src allows inline styles (the
  // FOUC <style> + runtime <style> injection) + Google Fonts; img/font/worker
  // allow data:/blob: for the canvas; connect-src allows the same-origin collab WS.
  const CSP = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // esm.sh serves Excalidraw's bundled handwriting fonts at runtime (font files
    // only — script-src stays tight, so no code can load from there). Self-hosting
    // these would fully air-gap the canvas; for now this is font-only.
    "font-src 'self' data: https://fonts.gstatic.com https://esm.sh",
    // Published notes legitimately embed external images (Substack/Medium/web
    // clips). Allow any https image source — img-src can't execute code, so this
    // doesn't widen the script attack surface.
    "img-src 'self' data: blob: https:",
    "worker-src 'self' blob:",
    "connect-src 'self' ws: wss: https:",
    // Attachment audio/video: same-origin for signed-in users, blob: for link viewers and the
    // native client (fetched with their credential header, never a token in a URL).
    "media-src 'self' blob:",
    // Embed blocks (wave 2B): ONLY the allowlisted, PATH-SCOPED players (packages/core/src/lib/media/embeds.ts),
    // each framed with a strict sandbox; 'self' for the inline PDF preview of an attachment.
    // Frames are always cross-origin to us and never get our cookies or DOM.
    `frame-src 'self' ${EMBED_FRAME_SOURCES.join(" ")}`,
  ].join("; ");

  app.use("*", async (c, next) => {
    await next();
    // A route that set its OWN (stricter) CSP keeps it — the media/map proxies
    // answer with `default-src 'none'; sandbox`.
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    // A route may allow same-origin framing of its own response (PDF attachment preview).
    if (!c.res.headers.has("X-Frame-Options")) c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    if (config.appOrigin.startsWith("https")) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  // Only needed when the web app is served from a different origin (e.g. Vite dev
  // on :5173 without a proxy). Same-origin production traffic never triggers CORS.
  const credentialedCors = cors({ origin: config.appOrigin, credentials: true });
  // Native shells (WP2.1): the Tauri webview's origin (tauri://localhost,
  // http://tauri.localhost) gets CORS WITHOUT credentials — it authenticates with
  // an `Authorization: Bearer pd_…` device token, never a cookie, so the
  // cookie-bearing CORS rule above is not loosened for it.
  const nativeCors = cors({
    origin: (o) => (config.nativeOrigins.includes(o) ? o : null),
    credentials: false,
    allowMethods: ["GET", "HEAD", "PUT", "POST", "PATCH", "DELETE"],
  });
  const corsMw: MiddlewareHandler = (c, next) => {
    const origin = c.req.header("origin");
    return origin && config.nativeOrigins.includes(origin) ? nativeCors(c, next) : credentialedCors(c, next);
  };
  // Public publications are anonymous, read-only JSON meant for OTHER sites
  // (e.g. the bioregional twin's frontend embedding "field notes") — open CORS,
  // no credentials. Registered BEFORE the credentialed /api/* middleware so the
  // more specific rule wins for /api/p/*. The password-unlock cookie still
  // flows same-origin (cookies are sent same-origin regardless of CORS).
  app.use("/api/p/*", cors({ origin: "*" }));
  app.use("/api/*", corsMw);
  app.use("/auth/*", corsMw);
  app.use("/acl/*", corsMw);

  // Rate-limit the abuse-prone auth surface (password guessing, magic-link spam,
  // invite/token guessing).
  app.use("/auth/login", rateLimit({ max: 10, windowMs: 10 * 60_000, name: "auth-login" }));
  app.use("/auth/register", rateLimit({ max: 10, windowMs: 10 * 60_000, name: "auth-register" }));
  app.use("/auth/request", rateLimit({ max: 5, windowMs: 10 * 60_000, name: "auth-request" }));
  // Native sign-in: code → token exchange (code/verifier guessing), and the
  // anon-reachable authorize/revoke endpoints (row-creation spam).
  app.use("/auth/device/token", rateLimit({ max: 20, windowMs: 10 * 60_000, name: "auth-device-token" }));
  app.use("/auth/device/authorize", rateLimit({ max: 30, windowMs: 10 * 60_000, name: "auth-device-authorize" }));
  app.use("/auth/device/revoke", rateLimit({ max: 30, windowMs: 10 * 60_000, name: "auth-device-revoke" }));
  app.use("/auth/callback", rateLimit({ max: 30, windowMs: 10 * 60_000, name: "auth-callback" }));
  // The peer-pairing endpoint is anon-reachable and consumes a single-use code;
  // the 144-bit code already makes guessing infeasible, but rate-limit it too as
  // defense-in-depth against code-guessing / pairing spam.
  app.use("/api/federation/pair", rateLimit({ max: 20, windowMs: 10 * 60_000, name: "federation-pair" }));
  // /mirror is anon-reachable (peer-token authed in-handler) and writes a pending
  // row; rate-limit it as defense-in-depth against a paired peer flooding requests.
  app.use("/api/federation/mirror", rateLimit({ max: 30, windowMs: 10 * 60_000, name: "federation-mirror" }));

  // Prism MCP access tokens (WP6.1): self-service create/list/revoke under /auth.
  // One shared bucket for the collection AND /auth/pats/:id (revoke). Hono's
  // `/auth/pats/*` matches both, so a single registration covers them.
  app.use("/auth/pats/*", rateLimit({ max: 30, windowMs: 10 * 60_000, name: "auth-pats" }));
  app.route("/auth", pats);
  app.route("/auth", auth);
  // Public, anonymous publication JSON (Horizon B) and peer federation (Horizon
  // C) are mounted under /api but BEFORE the gateway `api` group — like `rag` —
  // so they are handled here and never reach the owner short-circuit / 403
  // catch-all inside `api`. Both are intentionally open to non-owners:
  //   /api/p/*          → read-only published content, guarded by effectiveLevel
  //   /api/federation/* → peer-signed federation surface (pairing, identity)
  // The human-facing published URL /p/:slug is a CLIENT route (SPA fallback);
  // it fetches /api/p/:slug from here.
  app.route("/api/p", publish);
  app.route("/api/federation", federation);
  app.route("/api/federated", federated);
  // RAG owns /api/search/semantic + /api/index/* and must be matched BEFORE the
  // gateway, whose owner short-circuit would otherwise proxy these to the vault
  // (which has no semantic endpoint). Other /api paths fall through to `api`.
  app.route("/api", rag);
  // Owner-only vault registry — mounted BEFORE the gateway so /api/vaults is not
  // proxied to the vault by the owner short-circuit inside `api`.
  app.route("/api", vaults);
  // Commons governance (note-native) — mounted BEFORE the gateway so
  // /api/governance/* is handled here, not proxied to the vault. Member-authed
  // in-handler; inert until an owner enables governance.
  app.route("/api/governance", governance);
  // Server-side agent dispatch + integration config (Phase 3) — admin-only;
  // mounted BEFORE the gateway so /api/agent + /api/integrations aren't proxied
  // to the vault by the owner short-circuit.
  app.route("/api/agent", agentApi);
  app.route("/api/push", pushApi); // WP3.3 Web Push (owner-only), before the gateway
  app.route("/api/integrations", integrations);
  app.route("/api/sync", sync);
  // On-demand Google Calendar range sync (WP1.3, replaces calendar_sync_range) —
  // admin-only, gated by the CALENDAR_* modes; before the gateway like /api/sync.
  app.route("/api/calendar", calendar);
  // Live actions (WP1.5): the server acting AS the owner (email via Proton
  // Bridge, calendar via gog, Matrix). SERVER-OWNER only, flag-gated, audited,
  // idempotent; before the gateway like /api/calendar.
  app.route("/api/actions", actionsApi);
  // Server-owner maintenance jobs (parity A: vault-wide wikilink resolve); before the gateway.
  app.route("/api/admin", adminApi);
  // Member self-serve MCP tokens — role-gated in-handler (member+ on the target
  // vault); mounted BEFORE the gateway so the owner short-circuit never proxies
  // /api/mcp to the vault.
  app.route("/api/mcp", mcp);
  // External image + basemap proxies for the locked-down Prism Client (Client
  // parity C). Signed-in users only, SSRF-guarded; before the gateway so the
  // owner short-circuit never proxies them to the vault.
  app.route("/api/media", media);
  app.route("/api/map", mapProxy);
  // Omni gateway (owner-only bridge to Hermes; OMNI_ENABLED, default off → 404). Before the gateway.
  mountOmni(app);
  app.route("/api", api);
  app.route("/acl", acl);

  // Liveness + vault reachability, for uptime monitors. This MUST be a real route
  // mounted above the SPA fallback: before it existed, GET /health fell through to
  // the catch-all and returned index.html with a 200, so a monitor pointed at it
  // passed while the vault was unreachable (audit 2026-08-13, F8). Unauthenticated
  // on purpose — it discloses one boolean and no vault content. `/api/health` is
  // kept as-is so existing callers don't break.
  //
  // `?live=1` = process liveness only (constant work, no vault call) — what a
  // watchdog deciding whether to restart THIS process should poll. The plain
  // form is bounded by `VAULT_HEALTH_TIMEOUT_MS`: a slow vault is a prompt 503.
  app.get("/health", async (c) => {
    const live = c.req.query("live");
    if (live !== undefined && live !== "0" && live !== "false") return c.json({ ok: true, live: true });
    const ok = await vault.health();
    return c.json({ ok, vault: ok }, ok ? 200 : 503);
  });

  // Prism MCP (WP6.1): stateless Streamable-HTTP at /mcp + its RFC 9728
  // protected-resource metadata under /.well-known/. Bearer-only (PAT, device
  // token, owner hub JWT, loopback COLLAB_TOKEN), rate-limited per credential in
  // the router. MUST be above the SPA fallback, and both prefixes are in the web
  // service worker's navigateFallbackDenylist (apps/web/vite.config.ts).
  mountPrismMcp(app, "/mcp");

  // Universal links (NP-NA-04): the Apple App Site Association file, at both
  // locations Apple reads. Public, no redirect, above the SPA fallback; the
  // root path is in the SW navigateFallbackDenylist beside /.well-known/.
  mountAppSiteAssociation(app);

  // Static web app + SPA fallback (relative to cwd = apps/server).
  // Cache strategy: Vite content-hashes everything under /assets, so those are
  // immutable + cached forever; the SPA entry (index.html) and the service
  // worker must ALWAYS revalidate, or a stale cached index pins old asset hashes
  // and a deploy never takes effect (the "still rendering old code" trap, made
  // worse by an edge/CDN in front).
  const WEB_ROOT = process.env.WEB_ROOT ?? "../web/dist";
  const cacheHeaders = (path: string, c: Context) => {
    if (path.includes("/assets/")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    } else if (/\.(html)$|sw\.js$|workbox-[^/]*\.js$/.test(path)) {
      c.header("Cache-Control", "no-cache");
    }
  };
  app.use("/assets/*", serveStatic({ root: WEB_ROOT, onFound: cacheHeaders }));
  app.get("/*", serveStatic({ root: WEB_ROOT, onFound: cacheHeaders }));
  app.get("*", serveStatic({ path: `${WEB_ROOT}/index.html`, onFound: cacheHeaders }));
  // Reached only when there is no built web app at WEB_ROOT (a fresh checkout): say so in
  // words instead of a bare 404 — the browser sign-in for a native app starts on that page.
  app.get("*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Prism</title><body style="font:15px system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;line-height:1.5">` +
        `<h1 style="font-size:20px">The Prism web app isn't built on this server</h1>` +
        `<p>The server is running, but the web pages (including sign-in) have not been built yet.</p>` +
        `<p>On the machine that runs the server: <code>npm run build -w @prism/web</code>, then reload this page.</p></body>`,
      503,
    );
  });

  return app;
}
