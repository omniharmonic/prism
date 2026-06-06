/**
 * Prism Server entry. Fails fast if misconfigured, then serves:
 *   /auth/*  — sign-in (magic link), logout, identity
 *   /api/*   — the permission gateway (authorizes every vault read/write)
 *   /*       — the built web app (apps/web/dist), with SPA fallback
 * One origin → session cookies are first-party and no CORS is needed in
 * production. The Parachute token never leaves this process.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config, assertConfig, emailEnabled } from "./config";
import { auth } from "./routes/auth";
import { api } from "./routes/api";
import { acl } from "./routes/acl";
import { attachCollab } from "./collab";
import { rateLimit } from "./middleware/ratelimit";

assertConfig();

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

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Prism Server → http://localhost:${info.port}`);
  console.log(`  vault:  ${config.parachuteUrl} (vault=${config.parachuteVault})`);
  console.log(`  owner:  ${config.ownerEmail}`);
  console.log(`  email:  ${emailEnabled() ? "Resend" : "DISABLED (dev: links logged to console)"}`);
  console.log(`  collab: ws://localhost:${info.port}/collab (Hocuspocus)`);
});

// Real-time collaboration shares this HTTP server (WebSocket upgrades on /collab).
attachCollab(server as unknown as import("node:http").Server);
