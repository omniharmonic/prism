/**
 * Builds the Prism Server Hono app: security headers, CORS (for cross-origin
 * dev only), rate limits on the auth surface, the three route groups
 * (/auth, /api, /acl), and the static web app with SPA fallback. Kept separate
 * from index.ts (process startup: assertConfig + serve + collab) so the full
 * request pipeline can be constructed and tested without binding a port.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config";
import { auth } from "./routes/auth";
import { api } from "./routes/api";
import { acl } from "./routes/acl";
import { rag } from "./routes/rag";
import { publish } from "./routes/publish";
import { federation } from "./routes/federation";
import { rateLimit } from "./middleware/ratelimit";

export function createApp(): Hono {
  const app = new Hono();

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
    "img-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' ws: wss: https:",
  ].join("; ");

  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    if (config.appOrigin.startsWith("https")) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  // Only needed when the web app is served from a different origin (e.g. Vite dev
  // on :5173 without a proxy). Same-origin production traffic never triggers CORS.
  const corsMw = cors({ origin: config.appOrigin, credentials: true });
  app.use("/api/*", corsMw);
  app.use("/auth/*", corsMw);
  app.use("/acl/*", corsMw);

  // Rate-limit the abuse-prone auth surface (password guessing, magic-link spam,
  // invite/token guessing).
  app.use("/auth/login", rateLimit({ max: 10, windowMs: 10 * 60_000, name: "auth-login" }));
  app.use("/auth/register", rateLimit({ max: 10, windowMs: 10 * 60_000, name: "auth-register" }));
  app.use("/auth/request", rateLimit({ max: 5, windowMs: 10 * 60_000, name: "auth-request" }));
  app.use("/auth/callback", rateLimit({ max: 30, windowMs: 10 * 60_000, name: "auth-callback" }));
  // The peer-pairing endpoint is anon-reachable and consumes a single-use code;
  // the 144-bit code already makes guessing infeasible, but rate-limit it too as
  // defense-in-depth against code-guessing / pairing spam.
  app.use("/api/federation/pair", rateLimit({ max: 20, windowMs: 10 * 60_000, name: "federation-pair" }));

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
  // RAG owns /api/search/semantic + /api/index/* and must be matched BEFORE the
  // gateway, whose owner short-circuit would otherwise proxy these to the vault
  // (which has no semantic endpoint). Other /api paths fall through to `api`.
  app.route("/api", rag);
  app.route("/api", api);
  app.route("/acl", acl);

  // Static web app + SPA fallback (relative to cwd = apps/server).
  const WEB_ROOT = process.env.WEB_ROOT ?? "../web/dist";
  app.use("/assets/*", serveStatic({ root: WEB_ROOT }));
  app.get("/*", serveStatic({ root: WEB_ROOT }));
  app.get("*", serveStatic({ path: `${WEB_ROOT}/index.html` }));

  return app;
}
