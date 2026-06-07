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
import { rateLimit } from "./middleware/ratelimit";

export function createApp(): Hono {
  const app = new Hono();

  // Conservative security headers (no CSP — the SPA uses inline element styles;
  // a CSP would need careful tuning and is better added once with full testing).
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Frame-Options", "SAMEORIGIN");
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

  // Rate-limit the abuse-prone auth surface (magic-link spam, token guessing).
  app.use("/auth/request", rateLimit({ max: 5, windowMs: 10 * 60_000, name: "auth-request" }));
  app.use("/auth/callback", rateLimit({ max: 30, windowMs: 10 * 60_000, name: "auth-callback" }));

  app.route("/auth", auth);
  app.route("/api", api);
  app.route("/acl", acl);

  // Static web app + SPA fallback (relative to cwd = apps/server).
  const WEB_ROOT = process.env.WEB_ROOT ?? "../web/dist";
  app.use("/assets/*", serveStatic({ root: WEB_ROOT }));
  app.get("/*", serveStatic({ root: WEB_ROOT }));
  app.get("*", serveStatic({ path: `${WEB_ROOT}/index.html` }));

  return app;
}
