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

assertConfig();

const app = new Hono();

// Only needed when the web app is served from a different origin (e.g. Vite dev
// on :5173 without a proxy). Same-origin production traffic never triggers CORS.
const corsMw = cors({ origin: config.appOrigin, credentials: true });
app.use("/api/*", corsMw);
app.use("/auth/*", corsMw);
app.use("/acl/*", corsMw);

app.route("/auth", auth);
app.route("/api", api);
app.route("/acl", acl);

// Static web app + SPA fallback (relative to cwd = apps/server).
const WEB_ROOT = process.env.WEB_ROOT ?? "../web/dist";
app.use("/assets/*", serveStatic({ root: WEB_ROOT }));
app.get("/*", serveStatic({ root: WEB_ROOT }));
app.get("*", serveStatic({ path: `${WEB_ROOT}/index.html` }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Prism Server → http://localhost:${info.port}`);
  console.log(`  vault:  ${config.parachuteUrl} (vault=${config.parachuteVault})`);
  console.log(`  owner:  ${config.ownerEmail}`);
  console.log(`  email:  ${emailEnabled() ? "Resend" : "DISABLED (dev: links logged to console)"}`);
});
