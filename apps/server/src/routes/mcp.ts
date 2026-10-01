/**
 * Member self-serve MCP access (/api/mcp) — "give my agent this vault".
 *
 * A signed-in vault MEMBER (role >= member on the target vault; the env server
 * owner qualifies everywhere) can mint a hub JWT scoped to exactly that one
 * vault and get back a ready-to-paste MCP config for the hub's public
 * `/vault/<name>/mcp` endpoint. TRUST BOUNDARY: the token grants whole-vault
 * access directly at the hub, bypassing Prism's per-note grants — so guests,
 * capability links, and anon actors can NEVER mint, and each token is scoped
 * to a single vault the member already belongs to. The token is returned ONCE
 * and never stored; only its jti lands in the audit registry (mcp_tokens) so
 * standing access is listable and revocable (`parachute auth revoke-token`,
 * ~60s hub-side propagation).
 *
 * FROZEN (WP0.3): minting is OFF unless MEMBER_VAULT_TOKENS=true. A whole-vault
 * token bypasses every Prism grant — and can write `governance-*` notes directly
 * (inert only once GOVERNANCE_SIGNING_SECRET is set) — so it is being replaced
 * by Prism MCP credentials that carry Prism permissions (Architecture v2 WP6).
 * Listing (`GET /tokens`) and revoking (`DELETE /tokens/:jti`) keep working with
 * the flag off, so already-issued tokens can be audited and cleaned up.
 *
 * Mounted under /api BEFORE the gateway (like /api/integrations), so the owner
 * passthrough never swallows it; /api/* is already in the PWA SW denylist.
 */
import { Hono } from "hono";
import { config } from "../config";
import { resolveActor } from "../auth/actor";
import { roleAtLeast, workspaceRole, type Role } from "../roles";
import { resolveVaultEntry, getVaultRegistry, recordMcpToken, listMcpTokens, getMcpToken, setMcpTokenRevoked, listActiveMcpTokens, recordMcpTokenRevocation, listMcpTokenRevocations, markMcpRevocationNotified, type McpTokenRow } from "../db";
import { sendEmail } from "../auth/email";
import { mintVaultToken, revokeVaultToken } from "../mcp-token";

export const mcp = new Hono();

const DAY_MS = 86_400_000;

/** Shown when minting is frozen — stable text the UI/docs can point at. */
export const MINT_FROZEN_DETAIL =
  "Whole-vault member MCP tokens are frozen on this server: they bypass Prism permissions. " +
  "Prism MCP credentials (scoped to what you can access in Prism) will replace them. " +
  "Existing tokens can still be listed and revoked. The server owner can re-enable minting with MEMBER_VAULT_TOKENS=true.";

let mintOverride: boolean | undefined;
/** Test seam: force minting on/off, or restore the configured flag (undefined). */
export function setMemberVaultTokensEnabled(v: boolean | undefined): void {
  mintOverride = v;
}
export const memberVaultTokensEnabled = (): boolean => mintOverride ?? config.memberVaultTokens;
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

/** The signed-in user + their role on the REQUESTED vault (which may differ
 *  from the X-Prism-Vault header's active vault). Null unless a real user. */
function memberOn(c: Parameters<typeof resolveActor>[0], vaultId: string): { email: string; role: Role } | null {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return null;
  return { email: actor.email, role: workspaceRole(actor.email, vaultId) };
}

/** Resolve a REGISTERED vault id strictly — resolveVaultEntry's silent fallback
 *  to primary must never let a bogus id mint a primary-vault token. */
function strictVaultEntry(id: string) {
  return getVaultRegistry().find((v) => v.id === id) ?? null;
}

const mcpUrlFor = (vaultName: string): string =>
  `${config.mcpPublicUrl || config.parachuteUrl}/vault/${encodeURIComponent(vaultName)}/mcp`;

const tokenView = ({ jti, vault_id, email, scope, label, expires_at, created_at, revoked_at }: McpTokenRow) => ({
  jti,
  vaultId: vault_id,
  email,
  scope,
  label,
  expiresAt: expires_at,
  createdAt: created_at,
  revokedAt: revoked_at,
});

/** Info for the active vault: the public MCP URL and whether this actor may mint. */
mcp.get("/", (c) => {
  const actor = resolveActor(c);
  const entry = resolveVaultEntry(actor.kind === "user" ? actor.vaultId : undefined);
  const m = memberOn(c, entry.id);
  const enabled = memberVaultTokensEnabled();
  return c.json({
    vaultId: entry.id,
    url: mcpUrlFor(entry.vault),
    publicUrlConfigured: !!config.mcpPublicUrl,
    mintEnabled: enabled,
    canMint: enabled && !!m && roleAtLeast(m.role, "member"),
    ...(enabled ? {} : { mintDisabledReason: MINT_FROZEN_DETAIL }),
  });
});

/** Mint a scoped token for a vault the requester is a member of. */
mcp.post("/token", async (c) => {
  if (!memberVaultTokensEnabled()) {
    return c.json({ error: "minting_disabled", detail: MINT_FROZEN_DETAIL }, 403);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const actor = resolveActor(c);
  const requestedVault = typeof body.vaultId === "string" && body.vaultId ? body.vaultId : actor.vaultId;
  const entry = strictVaultEntry(requestedVault);
  if (!entry) return c.json({ error: "unknown_vault" }, 400);

  const m = memberOn(c, entry.id);
  if (!m || !roleAtLeast(m.role, "member")) return c.json({ error: "forbidden" }, 403);

  const verb = body.scope === "read" ? "read" : body.scope === "write" || body.scope === undefined ? "write" : null;
  if (!verb) return c.json({ error: "bad_request", detail: "scope must be 'read' or 'write'" }, 400);

  let days = DEFAULT_DAYS;
  if (body.expiresInDays !== undefined) {
    const n = Number(body.expiresInDays);
    if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) {
      return c.json({ error: "bad_request", detail: `expiresInDays must be 1–${MAX_DAYS}` }, 400);
    }
    days = Math.floor(n);
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 120) || null : null;

  let minted;
  try {
    minted = await mintVaultToken({
      vaultName: entry.vault,
      verb,
      expiresInSeconds: days * 86_400,
      // The sub shows up in the hub's own token registry — make it self-describing.
      sub: `mcp:${m.email}`,
    });
  } catch (e) {
    console.error("[mcp] mint-token failed:", (e as Error).message);
    return c.json({ error: "mint_failed" }, 502);
  }

  // Minted via a native device token? Tie it to that device: revoking the device
  // revokes this token too (auth/device.ts revokeDevice).
  const deviceId = actor.kind === "user" ? (actor.deviceId ?? null) : null;
  recordMcpToken({ jti: minted.jti, vault_id: entry.id, email: m.email, scope: minted.scope, label, expires_at: minted.expiresAt, device_id: deviceId });
  console.log(`[mcp] minted ${minted.scope} for ${m.email} (jti=${minted.jti}, ${days}d${label ? `, "${label}"` : ""})`);

  const url = mcpUrlFor(entry.vault);
  const serverName = `parachute-${entry.vault}`;
  return c.json({
    url,
    token: minted.token, // shown once; only the jti is retained server-side
    jti: minted.jti,
    scope: minted.scope,
    expiresAt: minted.expiresAt,
    // Ready-to-paste .mcp.json / claude.ai custom-connector shapes.
    mcpJson: {
      mcpServers: {
        [serverName]: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${minted.token}` },
        },
      },
    },
    claudeCommand: `claude mcp add --transport http ${serverName} ${url} --header "Authorization: Bearer ${minted.token}"`,
  });
});

/** List minted tokens for a vault (no token material — jti/audit fields only).
 *  Members see their own; admin+ see everyone's for that vault. */
mcp.get("/tokens", (c) => {
  const actor = resolveActor(c);
  const requestedVault = c.req.query("vaultId") || actor.vaultId;
  const entry = strictVaultEntry(requestedVault);
  if (!entry) return c.json({ error: "unknown_vault" }, 400);
  const m = memberOn(c, entry.id);
  if (!m || !roleAtLeast(m.role, "member")) return c.json({ error: "forbidden" }, 403);
  const rows = listMcpTokens(entry.id);
  const visible = roleAtLeast(m.role, "admin") ? rows : rows.filter((r) => r.email === m.email);
  return c.json(visible.map(tokenView));
});

/** Revoke a token: its minter, or an admin+ of its vault. */
mcp.delete("/tokens/:jti", async (c) => {
  const row = getMcpToken(c.req.param("jti"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const m = memberOn(c, row.vault_id);
  if (!m || !(m.email === row.email || roleAtLeast(m.role, "admin"))) return c.json({ error: "forbidden" }, 403);
  try {
    await revokeVaultToken(row.jti);
  } catch (e) {
    console.error("[mcp] revoke-token failed:", (e as Error).message);
    return c.json({ error: "revoke_failed" }, 502);
  }
  setMcpTokenRevoked(row.jti);
  console.log(`[mcp] revoked jti=${row.jti} (${row.scope}, minted by ${row.email}) by ${m.email}`);
  return c.json({ ok: true, note: "hub enforces revocation within ~60s" });
});

// ── Owner-only migration surface (WP6.5): legacy whole-vault member tokens ────
//
//   GET  /api/mcp/legacy-tokens          active tokens, all vaults (no token material)
//   POST /api/mcp/legacy-tokens/revoke   { jtis?: string[], notify?: boolean, dryRun?: boolean }
//
// SERVER OWNER only (config.ownerEmail). `jtis` omitted = every active token
// ("revoke all"). `dryRun` DEFAULTS TO TRUE — nothing is revoked or emailed unless
// the caller sends `dryRun: false` explicitly. Idempotent: only unrevoked tokens
// are touched, so a repeat call is a no-op. Revocation goes through the same
// injected hub revoker as DELETE /tokens/:jti; a token whose revoke fails stays
// un-marked (retry-able) and its member is NOT told it was replaced. Every
// attempt writes an mcp_token_revocations audit row (jti/email/vault/outcome).
// Notify = ONE email per affected member (however many tokens), sent only after
// at least one of theirs was revoked, pointing at Settings → Account → Connect
// your agent. Mail failures never undo a revocation.

type Notifier = (to: string, subject: string, html: string, devLine?: string) => Promise<boolean>;
let notifier: Notifier = sendEmail;
/** Test seam: replace the email sender (null restores the real one). */
export function setLegacyTokenNotifier(fn: Notifier | null): void {
  notifier = fn ?? sendEmail;
}

function ownerEmail(c: Parameters<typeof resolveActor>[0]): string | null {
  const a = resolveActor(c);
  return a.kind === "user" && a.email === config.ownerEmail ? a.email : null;
}

const legacyView = (r: McpTokenRow) => ({ ...tokenView(r), vaultLabel: getVaultRegistry().find((v) => v.id === r.vault_id)?.label ?? r.vault_id });

mcp.get("/legacy-tokens", (c) => {
  if (!ownerEmail(c)) return c.json({ error: "forbidden" }, 403);
  c.header("Cache-Control", "no-store");
  return c.json({ tokens: listActiveMcpTokens().map(legacyView), recent: listMcpTokenRevocations(50) });
});

const escHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

mcp.post("/legacy-tokens/revoke", async (c) => {
  const owner = ownerEmail(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "bad_request" }, 400);
  const dryRun = body.dryRun !== false;
  const notify = body.notify === true;
  let jtis: Set<string> | null = null;
  if (body.jtis !== undefined) {
    if (!Array.isArray(body.jtis) || body.jtis.some((j) => typeof j !== "string")) return c.json({ error: "bad_request", detail: "jtis must be an array of strings" }, 400);
    jtis = new Set(body.jtis as string[]);
  }
  const targets = listActiveMcpTokens().filter((t) => !jtis || jtis.has(t.jti));
  const byMember = new Map<string, McpTokenRow[]>();
  for (const t of targets) byMember.set(t.email, [...(byMember.get(t.email) ?? []), t]);
  const affected = [...byMember].map(([email, rows]) => ({ email, tokens: rows.map(legacyView) }));
  c.header("Cache-Control", "no-store");
  if (dryRun) return c.json({ dryRun: true, wouldRevoke: targets.length, notify, affected });

  const revoked: string[] = [];
  const failed: Array<{ jti: string; error: string }> = [];
  for (const t of targets) {
    try {
      await revokeVaultToken(t.jti);
      setMcpTokenRevoked(t.jti);
      revoked.push(t.jti);
      recordMcpTokenRevocation({ actor: owner, jti: t.jti, email: t.email, vault_id: t.vault_id, outcome: "revoked", notified: false });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      failed.push({ jti: t.jti, error: msg });
      recordMcpTokenRevocation({ actor: owner, jti: t.jti, email: t.email, vault_id: t.vault_id, outcome: "failed", notified: false, error: msg });
    }
  }
  console.log(`[mcp] legacy tokens: ${revoked.length} revoked, ${failed.length} failed by ${owner}`);

  const notified: string[] = [];
  const notifyFailed: string[] = [];
  if (notify) {
    const link = `${config.appOrigin}/`;
    for (const [email, rows] of byMember) {
      const done = rows.filter((r) => revoked.includes(r.jti));
      if (done.length === 0) continue;
      const vaults = [...new Set(done.map((r) => legacyView(r).vaultLabel))].map(escHtml).join(", ");
      const html =
        `<p>Hi,</p><p>The agent access token(s) you created earlier for <b>${vaults}</b> have been revoked and replaced by Prism access tokens. ` +
        `The old tokens gave an agent whole-vault access; the new ones act as your Prism account and only see what you can see.</p>` +
        `<p>To reconnect your agent: open Prism (<a href="${link}">${escHtml(link)}</a>), go to <b>Settings &rarr; Account &rarr; Connect your agent</b>, create a token and paste the config it shows.</p>`;
      try {
        await notifier(email, "Your Prism agent token was replaced", html, `legacy MCP token replaced -> reconnect at ${link}`);
        notified.push(email);
        for (const r of done) markMcpRevocationNotified(r.jti);
      } catch (e) {
        console.error(`[mcp] notify failed for ${email}:`, (e as Error).message);
        notifyFailed.push(email);
      }
    }
  }
  return c.json({ dryRun: false, revoked, failed, notified, notifyFailed, note: "hub enforces revocation within ~60s" });
});
