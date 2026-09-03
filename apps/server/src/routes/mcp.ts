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
 * Mounted under /api BEFORE the gateway (like /api/integrations), so the owner
 * passthrough never swallows it; /api/* is already in the PWA SW denylist.
 */
import { Hono } from "hono";
import { config } from "../config";
import { resolveActor } from "../auth/actor";
import { roleAtLeast, workspaceRole, type Role } from "../roles";
import { resolveVaultEntry, getVaultRegistry, recordMcpToken, listMcpTokens, getMcpToken, setMcpTokenRevoked, type McpTokenRow } from "../db";
import { mintVaultToken, revokeVaultToken } from "../mcp-token";

export const mcp = new Hono();

const DAY_MS = 86_400_000;
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
  return c.json({
    vaultId: entry.id,
    url: mcpUrlFor(entry.vault),
    publicUrlConfigured: !!config.mcpPublicUrl,
    canMint: !!m && roleAtLeast(m.role, "member"),
  });
});

/** Mint a scoped token for a vault the requester is a member of. */
mcp.post("/token", async (c) => {
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

  recordMcpToken({ jti: minted.jti, vault_id: entry.id, email: m.email, scope: minted.scope, label, expires_at: minted.expiresAt });
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
