/**
 * Prism Server entry. Fails fast if misconfigured, then serves:
 *   /auth/*  — sign-in (magic link), logout, identity
 *   /api/*   — the permission gateway (authorizes every vault read/write)
 *   /*       — the built web app (apps/web/dist), with SPA fallback
 * One origin → session cookies are first-party and no CORS is needed in
 * production. The Parachute token never leaves this process.
 */
import { serve } from "@hono/node-server";
import { config, assertConfig, emailEnabled, embeddingsConfigured } from "./config";
import { db, getVaultRegistry } from "./db";
import { reportRegistryTokens, startTokenExpiryWatch } from "./auth/vault-token";
import { startWorker, stopWorker } from "./worker/scheduler";
import { refreshGitHubAutoSync } from "./worker/github-folder";
import { createApp } from "./app";
import { bootSweepAgentSessions, startAgentMaintenance } from "./agent-sessions";
import { startBillingProbe } from "./agent-billing";
import { attachCollab, beginCollabShutdown, closeCollabConnections } from "./collab";
import { closeEventStreams } from "./events";
import { haltAgentRuns } from "./agent-exec";
import { stopConversionWorkers } from "./convert/service";
import { stopNudgeDelivery } from "./omni/nudge-delivery";
import { createShutdown, isShuttingDown, markShuttingDown, shutdownDeadlineMs } from "./shutdown";
import { governanceIntegrityEnabled, reportGovernanceIntegrity } from "./governance-integrity";
import { reportApns } from "./apns";
import { startProactiveIntake } from "./omni/proactive-intake";
import { startNotificationWorker } from "./notifications";

assertConfig();

// Agent sessions (WP3.1): no child survives a restart — mark every queued/running
// turn `interrupted` (with a persisted status event) and free its session.
{
  const { interrupted } = bootSweepAgentSessions();
  if (interrupted > 0) console.log(`[agent] boot sweep: ${interrupted} in-flight turn(s) marked interrupted`);
  // Retention: old events, orphan CLI session artifacts — now, then daily.
  startAgentMaintenance();
  // Billing mode (subscription vs API key) for cost labelling; skipped under test.
  if (process.env.NODE_ENV !== "test") startBillingProbe();
}

const app = createApp();

// After a shutdown began, a request that still arrives on an open keep-alive socket is
// answered 503 (the client retries against the restarted server) instead of starting work.
const fetchHandler: typeof app.fetch = (req, ...rest) =>
  isShuttingDown()
    ? new Response(JSON.stringify({ error: "shutting_down" }), { status: 503, headers: { "content-type": "application/json", "retry-after": "5", connection: "close" } })
    : app.fetch(req, ...rest);

let stopNotifications: () => void = () => {};
const server = serve({ fetch: fetchHandler, port: config.port, hostname: config.bindHost }, (info) => {
  console.log(`Prism Server → http://localhost:${info.port} (bound to ${config.bindHost})`);
  console.log(`  vault:  ${config.parachuteUrl} (vault=${config.parachuteVault})`);
  console.log(`  owner:  ${config.ownerEmail}`);
  console.log(`  email:  ${emailEnabled() ? "Resend" : "DISABLED (dev: links logged to console)"}`);
  console.log(`  collab: ws://localhost:${info.port}/collab (Hocuspocus)`);
  console.log(`  governance integrity: ${governanceIntegrityEnabled() ? "ON (gov_sig verified)" : "OFF"}`);
  // Loud one-time warning when integrity is off (or the secret is weak).
  reportGovernanceIntegrity();
  // iOS push: ON / off / a loud warning when a configured key is refused (perms).
  reportApns();
  // Say which embedder is live at BOOT. The offline fallback returns plausible
  // results instead of failing, so "semantic" search silently ran on lexical
  // hashes for months with nothing anywhere saying so (audit 2026-08-13, F3).
  console.log(
    `  search: ${
      embeddingsConfigured()
        ? `${config.embedModel} @ ${config.embedEndpoint} (semantic)`
        : "OFFLINE HASH FALLBACK — lexical only, NOT semantic. Set EMBED_ENDPOINT."
    }`,
  );
  // Non-blocking: report token scope/expiry + warn-only hub validation. Never
  // blocks or fails boot (a bad token is logged, not fatal — wiring strict
  // rejection is a later, flag-gated step once every deploy sets the hub origin).
  void reportRegistryTokens(getVaultRegistry());
  // …and re-check daily: a long-lived server otherwise only learns a vault token
  // lapsed when that vault's pipeline starts 401ing.
  startTokenExpiryWatch(getVaultRegistry);
  // Phase 3: the Node worker (per-tenant ingesters). No-op unless SECRETS_KEY is
  // set and a vault has an integration secret; interval is unref'd.
  startWorker();
  startProactiveIntake();
  // Wave 2A: reminders (bounded, idempotent) + the unread-notification email digest.
  stopNotifications = startNotificationWorker();
  // GitHub folder auto-sync (Client parity B): attach the tree change feed for
  // vaults that have an auto-sync config. No config with auto_sync → nothing runs.
  refreshGitHubAutoSync();
});

// Real-time collaboration shares this HTTP server (WebSocket upgrades on /collab).
attachCollab(server as unknown as import("node:http").Server);

// Graceful shutdown (docs/host-bundle.md § Stopping): see src/shutdown.ts for the order.
const httpServer = server as unknown as import("node:http").Server;
const shutdown = createShutdown({
  stopAccepting() {
    markShuttingDown();
    httpServer.close();
    httpServer.closeIdleConnections?.();
  },
  stopBackground() {
    stopWorker();
    stopNotifications();
    stopNudgeDelivery();
    const killed = haltAgentRuns();
    if (killed) console.log(`[shutdown] stopped ${killed} running agent process(es); their turns are marked interrupted at the next start`);
  },
  storeDocuments: () => beginCollabShutdown(),
  closeClients() {
    const streams = closeEventStreams();
    closeCollabConnections();
    httpServer.closeAllConnections?.();
    if (streams) console.log(`[shutdown] closed ${streams} event stream(s)`);
  },
  stopConversion: () => stopConversionWorkers(),
  closeDb() {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  },
  exit: (code) => process.exit(code),
  log: (line) => console.log(line),
  deadlineMs: shutdownDeadlineMs(),
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  },
});
process.on("SIGTERM", () => shutdown.onSignal("SIGTERM"));
process.on("SIGINT", () => shutdown.onSignal("SIGINT"));
