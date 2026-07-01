/**
 * Per-tenant integration config (Phase 3). Lets an owner/admin store a
 * workspace's third-party credential (encrypted, server-side) and trigger an
 * immediate sync — so the Node worker can ingest into THIS vault. Admin-session
 * only; mounted under /api/integrations BEFORE the gateway. The credential is
 * never returned; GET only reports whether one is configured.
 */
import { Hono } from "hono";
import { resolveActor } from "../auth/actor";
import { roleAtLeast } from "../roles";
import { config } from "../config";
import { resolveVaultEntry } from "../db";
import { putSecret, getSecret, deleteSecret, secretsConfigured } from "../secrets";
import { runMatrixOnce, runFathomOnce } from "../worker/scheduler";

export const integrations = new Hono();

integrations.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || !roleAtLeast(actor.role, "admin")) return c.json({ error: "forbidden" }, 403);
  await next();
});

// Status: is the secret store available, and is Matrix configured for this vault?
integrations.get("/matrix", (c) => {
  const actor = resolveActor(c);
  const available = secretsConfigured();
  const configured = available && !!getSecret(actor.vaultId, config.ownerEmail, "matrix");
  return c.json({ secretsAvailable: available, configured });
});

// Store the Matrix credential for this vault (encrypted at rest).
integrations.put("/matrix", async (c) => {
  if (!secretsConfigured()) {
    return c.json({ error: "secrets_unconfigured", detail: "SECRETS_KEY is not set on the server" }, 400);
  }
  const actor = resolveActor(c);
  const { homeserver, accessToken } = await c.req
    .json<{ homeserver?: string; accessToken?: string }>()
    .catch(() => ({}) as { homeserver?: string; accessToken?: string });
  if (typeof homeserver !== "string" || typeof accessToken !== "string" || !homeserver || !accessToken) {
    return c.json({ error: "bad_request", detail: "homeserver + accessToken required" }, 400);
  }
  putSecret(actor.vaultId, config.ownerEmail, "matrix", JSON.stringify({ homeserver: homeserver.replace(/\/+$/, ""), accessToken }));
  return c.json({ ok: true });
});

integrations.delete("/matrix", (c) => {
  deleteSecret(resolveActor(c).vaultId, config.ownerEmail, "matrix");
  return c.json({ ok: true });
});

// Trigger an immediate Matrix ingest for this vault (the worker also runs it on
// its interval). Returns the message count ingested this pass.
integrations.post("/matrix/sync", async (c) => {
  const actor = resolveActor(c);
  try {
    const messages = await runMatrixOnce(resolveVaultEntry(actor.vaultId));
    return c.json({ ok: true, messages });
  } catch (e) {
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 502);
  }
});

// ── Fathom (meeting transcripts) — same shape as Matrix ──
integrations.get("/fathom", (c) => {
  const actor = resolveActor(c);
  const available = secretsConfigured();
  const configured = available && !!getSecret(actor.vaultId, config.ownerEmail, "fathom");
  return c.json({ secretsAvailable: available, configured });
});

integrations.put("/fathom", async (c) => {
  if (!secretsConfigured()) {
    return c.json({ error: "secrets_unconfigured", detail: "SECRETS_KEY is not set on the server" }, 400);
  }
  const actor = resolveActor(c);
  const { apiKey } = await c.req.json<{ apiKey?: string }>().catch(() => ({}) as { apiKey?: string });
  if (typeof apiKey !== "string" || !apiKey) return c.json({ error: "bad_request", detail: "apiKey required" }, 400);
  putSecret(actor.vaultId, config.ownerEmail, "fathom", JSON.stringify({ apiKey }));
  return c.json({ ok: true });
});

integrations.delete("/fathom", (c) => {
  deleteSecret(resolveActor(c).vaultId, config.ownerEmail, "fathom");
  return c.json({ ok: true });
});

integrations.post("/fathom/sync", async (c) => {
  const actor = resolveActor(c);
  try {
    const transcripts = await runFathomOnce(resolveVaultEntry(actor.vaultId));
    return c.json({ ok: true, transcripts });
  } catch (e) {
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 502);
  }
});

// ── Sync-adapter credentials (GitHub / Google Docs / Notion), Phase 3 ──
// Same shape as matrix/fathom: GET status (never leaks the value), PUT to store
// encrypted, DELETE to remove. github={token}, google={account}, notion={apiKey}.
function registerCredential(kind: string, fields: string[]) {
  integrations.get(`/${kind}`, (c) => {
    const actor = resolveActor(c);
    const available = secretsConfigured();
    return c.json({ secretsAvailable: available, configured: available && !!getSecret(actor.vaultId, config.ownerEmail, kind) });
  });
  integrations.put(`/${kind}`, async (c) => {
    if (!secretsConfigured()) return c.json({ error: "secrets_unconfigured", detail: "SECRETS_KEY is not set on the server" }, 400);
    const actor = resolveActor(c);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const cred: Record<string, string> = {};
    for (const f of fields) {
      const v = body[f];
      if (typeof v !== "string" || !v) return c.json({ error: "bad_request", detail: `${f} required` }, 400);
      cred[f] = v;
    }
    putSecret(actor.vaultId, config.ownerEmail, kind, JSON.stringify(cred));
    return c.json({ ok: true });
  });
  integrations.delete(`/${kind}`, (c) => {
    deleteSecret(resolveActor(c).vaultId, config.ownerEmail, kind);
    return c.json({ ok: true });
  });
}
registerCredential("github", ["token"]);
registerCredential("google", ["account"]);
registerCredential("notion", ["apiKey"]);
