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
import { runMatrixOnce, matrixPassRunning, ingestPassRunning, runFathomOnce, runFirefliesOnce, runClickUpOnce } from "../worker/scheduler";
import { BridgeCertDetectError, PROTON_CREDENTIAL, detectBridgeCert, validateDetectTarget, normalizeFingerprint, protonMode, protonPassRunning, runProtonOnce, validateProtonCredential } from "../worker/proton";
import { consumeRateLimit } from "../middleware/ratelimit";
import { requireCommsOwner } from "../comms/guard";
import { capabilitiesBody } from "../comms/send";
import { loadMatrixCreds } from "../actions/matrix";
import { BLUEBUBBLES_CREDENTIAL, MIN_WEBHOOK_SECRET, blueBubblesActive, clearBlueBubblesCredsCache, loopbackBaseUrl } from "../bluebubbles/config";
import { BlueBubblesClient, BlueBubblesError } from "../bluebubbles/client";
import { blueBubblesPassRunning, runBlueBubblesOnce } from "../bluebubbles/service";

export const integrations = new Hono();

integrations.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || !roleAtLeast(actor.role, "admin")) return c.json({ error: "forbidden" }, 403);
  await next();
});

// Comms capability declaration (owner-only, flag-gated; see comms/guard.ts).
integrations.get("/comms/capabilities", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  // + `send: {enabled, maxAttachmentBytes}` and "messages:send" while sending is on (comms/send.ts).
  return c.json(await capabilitiesBody(loadMatrixCreds(g.vaultId)));
});

// `matrix` and `google` are the identities WP1.5 live actions act AS (Matrix
// sends; the gog account for RSVP/create). Writing or deleting them is therefore
// SERVER-OWNER only, in every vault (security review M2) — a vault admin could
// otherwise point the owner's sends at an attacker homeserver or pick the gog
// account. Status (GET) and a manual sync stay admin-visible.
// `github` and `notion` joined them in Client parity B (security review H2): the
// folder/database syncs push to whatever repo/database that token reaches, so a
// vault admin must not be able to swap in (or remove) the owner's token either.
for (const kind of ["matrix", "google", "github", "notion"]) {
  integrations.on(["PUT", "DELETE"], `/${kind}`, async (c, next) => {
    const a = resolveActor(c);
    if (!(a.kind === "user" && a.email === config.ownerEmail)) return c.json({ error: "forbidden", detail: "only the server owner may change this credential" }, 403);
    await next();
  });
}

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
  // One pass per vault at a time: a second one started from the same cursor would
  // append the same events again. Never queued — the running pass covers it.
  if (matrixPassRunning(resolveVaultEntry(actor.vaultId).id)) return c.json({ error: "busy", detail: "a Matrix pass is already running for this vault" }, 409);
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
  // One pass per vault at a time (never queued, never a second writer beside the running one).
  if (ingestPassRunning("fathom", resolveVaultEntry(actor.vaultId).id)) return c.json({ error: "busy", detail: "a Fathom pass is already running for this vault" }, 409);
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
  // One pass per vault at a time (never queued, never a second writer beside the running one).
  if (ingestPassRunning("fireflies", resolveVaultEntry(actor.vaultId).id)) return c.json({ error: "busy", detail: "a Fireflies pass is already running for this vault" }, 409);
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
  // One pass per vault at a time (never queued, never a second writer beside the running one).
  if (ingestPassRunning("clickup", resolveVaultEntry(actor.vaultId).id)) return c.json({ error: "busy", detail: "a ClickUp pass is already running for this vault" }, 409);
  try {
    const tasks = await runClickUpOnce(resolveVaultEntry(actor.vaultId), { force: true });
    return c.json({ ok: true, tasks });
  } catch (e) {
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 502);
  }
});

// ── Proton Mail Bridge (WP1.2b) — {host, port, username, password, security,
// certSha256}, validated by validateProtonCredential (loopback host only, pinned
// cert required). Status echoes the NON-secret fields (never the password) so a
// re-save can keep them; a PUT without `password` keeps the stored one.
// SERVER-OWNER only (not any vault admin): this credential reads the owner's whole
// mailbox — the same check as /acl/workers/proton/intents.
const isServerOwner = (c: Parameters<typeof resolveActor>[0]): boolean => {
  const a = resolveActor(c);
  return a.kind === "user" && a.email === config.ownerEmail;
};
integrations.use("/proton-bridge", async (c, next) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  await next();
});
integrations.use("/proton-bridge/*", async (c, next) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  await next();
});

integrations.get("/proton-bridge", (c) => {
  const actor = resolveActor(c);
  const available = secretsConfigured();
  const raw = available ? getSecret(actor.vaultId, config.ownerEmail, PROTON_CREDENTIAL) : null;
  const out: Record<string, unknown> = { secretsAvailable: available, configured: !!raw, mode: protonMode() };
  if (raw) {
    try {
      const cred = JSON.parse(raw) as Record<string, unknown>;
      for (const k of ["host", "port", "username", "security", "certSha256", "smtpPort", "smtpSecurity", "smtpCertSha256"]) if (cred[k] !== undefined) out[k] = cred[k];
    } catch {
      // unreadable blob — report configured only
    }
  }
  return c.json(out);
});

integrations.put("/proton-bridge", async (c) => {
  if (!secretsConfigured()) return c.json({ error: "secrets_unconfigured", detail: "SECRETS_KEY is not set on the server" }, 400);
  const actor = resolveActor(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  let prev: Record<string, unknown> = {};
  try {
    prev = JSON.parse(getSecret(actor.vaultId, config.ownerEmail, PROTON_CREDENTIAL) ?? "{}") as Record<string, unknown>;
  } catch {
    prev = {};
  }
  // The stored password may only be reused for a NO-CHANGE re-save: re-pointing
  // host/port/security/username/pin without re-entering it could hand the stored
  // password to a different listener or account.
  if (!body.password) {
    const norm = (o: Record<string, unknown>) => ({
      host: typeof o.host === "string" && o.host ? o.host.trim().toLowerCase() : "127.0.0.1",
      port: Number(o.port ?? 1143),
      security: o.security ?? "starttls",
      username: o.username,
      certSha256: typeof o.certSha256 === "string" ? normalizeFingerprint(o.certSha256) : o.certSha256,
      // WP1.5: re-pointing the SMTP listener/pin is a change too (it would hand
      // the stored password to a different listener).
      smtpPort: o.smtpPort === undefined || o.smtpPort === "" ? 1025 : Number(o.smtpPort),
      smtpSecurity: o.smtpSecurity || "starttls",
      smtpCertSha256: typeof o.smtpCertSha256 === "string" && o.smtpCertSha256 ? normalizeFingerprint(o.smtpCertSha256) : null,
    });
    if (!prev.password || JSON.stringify(norm(body)) !== JSON.stringify(norm(prev))) {
      return c.json({ error: "bad_request", detail: "password required (it may only be omitted when nothing else changes)" }, 400);
    }
  }
  try {
    const cred = validateProtonCredential({ ...body, password: body.password || prev.password });
    putSecret(actor.vaultId, config.ownerEmail, PROTON_CREDENTIAL, JSON.stringify(cred));
  } catch (e) {
    return c.json({ error: "bad_request", detail: (e as Error).message }, 400);
  }
  return c.json({ ok: true });
});

integrations.delete("/proton-bridge", (c) => {
  deleteSecret(resolveActor(c).vaultId, config.ownerEmail, PROTON_CREDENTIAL);
  return c.json({ ok: true });
});

// One pass now (bypasses the interval slot; still honours PROTON_SHADOW — a
// shadow pass writes nothing). 409 while the ingest is off.
integrations.post("/proton-bridge/sync", async (c) => {
  if (protonMode() === "off") return c.json({ error: "disabled", detail: "PROTON_SYNC_ENABLED and PROTON_SHADOW are both off" }, 409);
  const actor = resolveActor(c);
  if (protonPassRunning(actor.vaultId)) return c.json({ error: "busy", detail: "a proton pass is already running" }, 409);
  try {
    const written = await runProtonOnce(resolveVaultEntry(actor.vaultId), { force: true });
    return c.json({ ok: true, mode: protonMode(), written });
  } catch (e) {
    if ((e as { code?: string }).code === "busy" || /already running/.test((e as Error).message)) return c.json({ error: "busy", detail: "a proton pass is already running" }, 409);
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 502);
  }
});

// Read the certificate the loopback Bridge listener presents so the owner can
// confirm + pin it (docs/credentials.md "Proton Bridge certificate"). Loopback
// host only (refused before any socket opens), greeting → STARTTLS → handshake →
// close: no LOGIN/AUTHENTICATE and no credential — the stored one is never even
// loaded here. One probe at a time, 10/min server-wide.
let detectInFlight = false;
integrations.post("/proton-bridge/detect-cert", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  // Bad input is refused before it can spend rate-limit budget or open a socket.
  try {
    validateDetectTarget(body);
  } catch (e) {
    return c.json({ error: "bad_request", detail: (e as Error).message }, 400);
  }
  if (detectInFlight) return c.json({ error: "busy", detail: "a certificate check is already running" }, 409);
  const wait = consumeRateLimit("proton-bridge:detect-cert", 10, 60_000);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return c.json({ error: "rate_limited", detail: `too many certificate checks; retry in ${wait} s` }, 429);
  }
  detectInFlight = true;
  try {
    const cert = await detectBridgeCert({ host: body.host, port: body.port, security: body.security });
    return c.json(cert);
  } catch (e) {
    const err = e as BridgeCertDetectError;
    const status = err instanceof BridgeCertDetectError && err.code === "bad_request" ? 400 : 502;
    return c.json({ error: err instanceof BridgeCertDetectError ? err.code : "detect_failed", detail: err.message }, status);
  } finally {
    detectInFlight = false;
  }
});

// ── BlueBubbles (iMessage/SMS on this Mac, decision D5) — {password, webhookSecret} ──
// SERVER-OWNER only: the password sends iMessages as the owner. Write-only: GET reports
// `configured` + the non-secret config (flag, loopback URL), never the password or the secret.
// The owner generates the webhook secret (`openssl rand -hex 32`) and puts the same value in
// BlueBubbles' webhook URL (docs/runbook/bluebubbles.md).
integrations.use("/bluebubbles", async (c, next) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  await next();
});
integrations.use("/bluebubbles/*", async (c, next) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  await next();
});
integrations.get("/bluebubbles", (c) => {
  const actor = resolveActor(c);
  const available = secretsConfigured();
  return c.json({
    secretsAvailable: available,
    configured: available && !!getSecret(actor.vaultId, config.ownerEmail, BLUEBUBBLES_CREDENTIAL),
    enabled: config.blueBubblesEnabled,
    urlAccepted: !!loopbackBaseUrl(),
    active: blueBubblesActive(),
  });
});
integrations.put("/bluebubbles", async (c) => {
  if (!secretsConfigured()) return c.json({ error: "secrets_unconfigured", detail: "SECRETS_KEY is not set on the server" }, 400);
  const actor = resolveActor(c);
  if (actor.vaultId !== resolveVaultEntry(undefined).id) return c.json({ error: "primary_vault_only" }, 409);
  const body = await c.req.json<{ password?: unknown; webhookSecret?: unknown }>().catch(() => ({}) as { password?: unknown; webhookSecret?: unknown });
  const { password, webhookSecret } = body;
  if (typeof password !== "string" || !password || password.length > 1024) return c.json({ error: "bad_request", detail: "password required" }, 400);
  if (typeof webhookSecret !== "string" || webhookSecret.length < MIN_WEBHOOK_SECRET || webhookSecret.length > 512 || !/^[\x21-\x7e]+$/.test(webhookSecret))
    return c.json({ error: "bad_request", detail: `webhookSecret required: ${MIN_WEBHOOK_SECRET}+ printable characters (openssl rand -hex 32)` }, 400);
  // Probe when the connector can reach BlueBubbles (review C1/I8): it must BE BlueBubbles — the
  // server/info shape and "pong" with this password, AND a 401 for a wrong one (a service that
  // answers anything with 2xx is not it). A refused password or a non-BlueBubbles answer is
  // never stored; an unreachable server is stored unverified.
  let verified = false;
  const base = loopbackBaseUrl();
  if (blueBubblesActive() && base) {
    const r = await verifyBlueBubbles(base, password);
    if (r === "bad_password") return c.json({ error: "bad_password", detail: "BlueBubbles refused the password" }, 400);
    if (r === "not_bluebubbles") return c.json({ error: "not_bluebubbles", detail: "the service at BLUEBUBBLES_URL is not BlueBubbles Server (check the port: lsof -iTCP -sTCP:LISTEN)" }, 400);
    verified = r === "ok";
  }
  putSecret(actor.vaultId, config.ownerEmail, BLUEBUBBLES_CREDENTIAL, JSON.stringify({ password, webhookSecret }));
  clearBlueBubblesCredsCache();
  return c.json({ ok: true, verified });
});
integrations.delete("/bluebubbles", (c) => {
  deleteSecret(resolveActor(c).vaultId, config.ownerEmail, BLUEBUBBLES_CREDENTIAL);
  clearBlueBubblesCredsCache();
  return c.json({ ok: true });
});
integrations.post("/bluebubbles/sync", async (c) => {
  if (!blueBubblesActive()) return c.json({ error: "disabled" }, 409);
  if (blueBubblesPassRunning()) return c.json({ error: "busy", detail: "a BlueBubbles pass is already running" }, 409);
  try {
    const messages = await runBlueBubblesOnce(resolveVaultEntry(undefined));
    return c.json({ ok: true, messages });
  } catch (e) {
    return c.json({ error: "sync_failed", detail: e instanceof BlueBubblesError ? e.message : "pass failed" }, 502);
  }
});

/** Is `base` really BlueBubbles Server, and does it take `password`? */
export async function verifyBlueBubbles(base: string, password: string): Promise<"ok" | "bad_password" | "not_bluebubbles" | "unreachable"> {
  const good = new BlueBubblesClient(base, password, fetch, 10_000);
  try {
    await good.serverInfo();
    await good.ping();
  } catch (e) {
    if (e instanceof BlueBubblesError && e.status === null) return "unreachable";
    if (e instanceof BlueBubblesError && e.status === 401) {
      // Only a server that ALSO refuses a random password is BlueBubbles refusing THIS one.
      return "bad_password";
    }
    return "not_bluebubbles";
  }
  // A wrong password must be refused (BlueBubbles' authMiddleware answers 401).
  try {
    await new BlueBubblesClient(base, `prism-probe-${crypto.randomUUID()}`, fetch, 10_000).ping();
    return "not_bluebubbles";
  } catch (e) {
    return e instanceof BlueBubblesError && e.status === 401 ? "ok" : "not_bluebubbles";
  }
}

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
