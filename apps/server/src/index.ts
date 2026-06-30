/**
 * Prism Server entry. Fails fast if misconfigured, then serves:
 *   /auth/*  — sign-in (magic link), logout, identity
 *   /api/*   — the permission gateway (authorizes every vault read/write)
 *   /*       — the built web app (apps/web/dist), with SPA fallback
 * One origin → session cookies are first-party and no CORS is needed in
 * production. The Parachute token never leaves this process.
 */
import { serve } from "@hono/node-server";
import { config, assertConfig, emailEnabled } from "./config";
import { getVaultRegistry } from "./db";
import { reportRegistryTokens } from "./auth/vault-token";
import { startWorker } from "./worker/scheduler";
import { createApp } from "./app";
import { attachCollab } from "./collab";

assertConfig();

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Prism Server → http://localhost:${info.port}`);
  console.log(`  vault:  ${config.parachuteUrl} (vault=${config.parachuteVault})`);
  console.log(`  owner:  ${config.ownerEmail}`);
  console.log(`  email:  ${emailEnabled() ? "Resend" : "DISABLED (dev: links logged to console)"}`);
  console.log(`  collab: ws://localhost:${info.port}/collab (Hocuspocus)`);
  // Non-blocking: report token scope/expiry + warn-only hub validation. Never
  // blocks or fails boot (a bad token is logged, not fatal — wiring strict
  // rejection is a later, flag-gated step once every deploy sets the hub origin).
  void reportRegistryTokens(getVaultRegistry());
  // Phase 3: the Node worker (per-tenant ingesters). No-op unless SECRETS_KEY is
  // set and a vault has an integration secret; interval is unref'd.
  startWorker();
});

// Real-time collaboration shares this HTTP server (WebSocket upgrades on /collab).
attachCollab(server as unknown as import("node:http").Server);
