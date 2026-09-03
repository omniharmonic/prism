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
import { runMatrixOnce, runFathomOnce, runFirefliesOnce, runClickUpOnce } from "../worker/scheduler";

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

// ── Fireflies (meeting transcripts + self-cleanup) — same shape as Fathom ──
integrations.get("/fireflies", (c) => {
  const actor = resolveActor(c);
  const available = secretsConfigured();
  const configured = available && !!getSecret(actor.vaultId, config.ownerEmail, "fireflies");
  return c.json({ secretsAvailable: available, configured });
});

integrations.put("/fireflies", async (c) => {
  if (!secretsConfigured()) {
    return c.json({ error: "secrets_unconfigured", detail: "SECRETS_KEY is not set on the server" }, 400);
  }
  const actor = resolveActor(c);
  const { apiKey } = await c.req.json<{ apiKey?: string }>().catch(() => ({}) as { apiKey?: string });
  if (typeof apiKey !== "string" || !apiKey) return c.json({ error: "bad_request", detail: "apiKey required" }, 400);
  putSecret(actor.vaultId, config.ownerEmail, "fireflies", JSON.stringify({ apiKey }));
  return c.json({ ok: true });
});

integrations.delete("/fireflies", (c) => {
  deleteSecret(resolveActor(c).vaultId, config.ownerEmail, "fireflies");
  return c.json({ ok: true });
});

// Force one ingest+cleanup pass now (bypasses the fixed-hours slot gate, still
// honors the daily budget). Repeat-call ≥1/min to drain a backlog on Pro.
integrations.post("/fireflies/sync", async (c) => {
  const actor = resolveActor(c);
  try {
    const transcripts = await runFirefliesOnce(resolveVaultEntry(actor.vaultId), { force: true });
    return c.json({ ok: true, transcripts });
  } catch (e) {
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 502);
  }
});

// ── ClickUp (task pull) — custom routes: apiKey required, scope fields optional ──
// Status also echoes the NON-secret scope fields (never the apiKey) so the UI
// can prefill them — a re-save of just the key must not drop teamId/spaceIds.
integrations.get("/clickup", (c) => {
  const actor = resolveActor(c);
  const available = secretsConfigured();
  const raw = available ? getSecret(actor.vaultId, config.ownerEmail, "clickup") : null;
  const out: Record<string, unknown> = { secretsAvailable: available, configured: !!raw };
  if (raw) {
    try {
      const cred = JSON.parse(raw) as Record<string, unknown>;
      if (typeof cred.teamId === "string") out.teamId = cred.teamId;
      if (typeof cred.spaceIds === "string") out.spaceIds = cred.spaceIds;
      if (typeof cred.assignedOnly === "boolean") out.assignedOnly = cred.assignedOnly;
    } catch {
      // unreadable blob — report configured only
    }
  }
  return c.json(out);
});

integrations.put("/clickup", async (c) => {
  if (!secretsConfigured()) {
    return c.json({ error: "secrets_unconfigured", detail: "SECRETS_KEY is not set on the server" }, 400);
  }
  const actor = resolveActor(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const apiKey = body.apiKey;
  if (typeof apiKey !== "string" || !apiKey) return c.json({ error: "bad_request", detail: "apiKey required" }, 400);
  const cred: Record<string, unknown> = { apiKey };
  if (typeof body.teamId === "string" && body.teamId) cred.teamId = body.teamId;
  if (typeof body.spaceIds === "string" && body.spaceIds) cred.spaceIds = body.spaceIds;
  if (typeof body.assignedOnly === "boolean") cred.assignedOnly = body.assignedOnly;
  putSecret(actor.vaultId, config.ownerEmail, "clickup", JSON.stringify(cred));
  return c.json({ ok: true });
});

integrations.delete("/clickup", (c) => {
  deleteSecret(resolveActor(c).vaultId, config.ownerEmail, "clickup");
  return c.json({ ok: true });
});

// Force one ingest pass now (bypasses the interval slot gate). Returns the
// count of tasks created+updated this pass.
integrations.post("/clickup/sync", async (c) => {
  const actor = resolveActor(c);
  try {
    const tasks = await runClickUpOnce(resolveVaultEntry(actor.vaultId), { force: true });
    return c.json({ ok: true, tasks });
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
