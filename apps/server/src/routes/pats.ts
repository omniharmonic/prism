/**
 * Prism MCP personal access tokens — self-service management (WP6.1).
 *
 *   GET    /auth/pats            your live tokens (the server owner: `?all=1` → everyone's)
 *   POST   /auth/pats            create → the token, ONCE, plus ready-to-paste client config
 *   DELETE /auth/pats/:id        revoke yours (the server owner: any)
 *
 * Authenticated like the other account routes: a browser session or a native
 * device token. NEVER a PAT — a PAT cannot mint or manage PATs. Creation requires
 * `Content-Type: application/json` (a cross-site form cannot send it without a
 * CORS preflight, which /auth refuses for foreign origins).
 *
 * A token is bound to one registered vault. Minting for a vault needs SOME
 * standing there — a membership (member+) or at least one grant — so the list
 * stays meaningful; the token can never do more than the account itself can (the
 * actor is recomputed per request), so this is hygiene, not the security gate.
 */
import { Hono, type Context } from "hono";
import { config } from "../config";
import { readSession } from "../auth/session";
import { DEVICE_TOKEN_PREFIX, bearerFromHeader, verifyDeviceToken } from "../auth/device";
import {
  issuePat,
  listLivePats,
  getPat,
  revokePat,
  patView,
  sanitizePatLabel,
  PAT_DEFAULT_DAYS,
  PAT_MAX_DAYS,
  PAT_MAX_LIVE_PER_ACCOUNT,
  type PatScope,
} from "../auth/pat";
import { getVaultRegistry, grantsForUser } from "../db";
import { roleAtLeast, workspaceRole } from "../roles";
import { resourceUrl } from "../mcp/router";

export const pats = new Hono();

/** Session or device token → the account. PATs are deliberately not accepted here. */
function identity(c: Context): { email: string; deviceId: string | null } | null {
  const s = readSession(c);
  if (s) return { email: s.email, deviceId: null };
  const bearer = bearerFromHeader(c.req.header("authorization"));
  const dev = bearer?.startsWith(DEVICE_TOKEN_PREFIX) ? verifyDeviceToken(bearer) : null;
  return dev ? { email: dev.email, deviceId: dev.id } : null;
}

const MCP_SERVER_NAME = "prism";

/** Ready-to-paste client config for Claude Code / Claude Desktop / generic MCP clients. */
export function clientConfig(token: string) {
  const url = resourceUrl("/mcp");
  const headers = { Authorization: `Bearer ${token}` };
  return {
    url,
    headers,
    // Claude Code project `.mcp.json` (or `claude mcp add-json`).
    mcpJson: { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url, headers } } },
    claudeCodeCommand: `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`,
    // Claude Desktop `claude_desktop_config.json` — via the mcp-remote stdio bridge,
    // which forwards the header to a remote Streamable-HTTP server.
    claudeDesktopJson: {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: "npx",
          args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${token}`],
        },
      },
    },
  };
}

pats.get("/pats", (c) => {
  const who = identity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const all = c.req.query("all") === "1" && who.email === config.ownerEmail;
  c.header("Cache-Control", "no-store");
  return c.json({ tokens: listLivePats(all ? null : who.email).map(patView), mcpUrl: resourceUrl("/mcp") });
});

pats.post("/pats", async (c) => {
  const who = identity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "bad_request" }, 400);

  const vaultId = typeof body.vaultId === "string" && body.vaultId ? body.vaultId : c.req.header("x-prism-vault") || getVaultRegistry()[0]!.id;
  if (!getVaultRegistry().some((v) => v.id === vaultId)) return c.json({ error: "unknown_vault" }, 400);
  const standing = roleAtLeast(workspaceRole(who.email, vaultId), "member") || grantsForUser(who.email, vaultId).length > 0;
  if (!standing) return c.json({ error: "forbidden", detail: "you have no access in that vault" }, 403);

  const scope: PatScope | null = body.scope === undefined || body.scope === "read" ? "read" : body.scope === "write" ? "write" : null;
  if (!scope) return c.json({ error: "bad_request", detail: "scope must be 'read' or 'write'" }, 400);

  let days = PAT_DEFAULT_DAYS;
  if (body.expiresInDays !== undefined) {
    const n = Number(body.expiresInDays);
    if (!Number.isFinite(n) || n < 1 || n > PAT_MAX_DAYS) {
      return c.json({ error: "bad_request", detail: `expiresInDays must be 1–${PAT_MAX_DAYS}` }, 400);
    }
    days = Math.floor(n);
  }

  if (listLivePats(who.email).length >= PAT_MAX_LIVE_PER_ACCOUNT) {
    return c.json({ error: "too_many_tokens", detail: `revoke one first (limit ${PAT_MAX_LIVE_PER_ACCOUNT})` }, 409);
  }

  const { token, row } = issuePat({
    email: who.email,
    vaultId,
    scope,
    label: sanitizePatLabel(body.label),
    expiresInDays: days,
    deviceId: who.deviceId,
  });
  console.log(`[mcp] PAT ${row.id} (${row.prefix}…, ${scope}, vault=${vaultId}, ${days}d) created for ${row.email}`);
  c.header("Cache-Control", "no-store");
  return c.json({ token, ...patView(row), ...clientConfig(token) }, 201);
});

pats.delete("/pats/:id", (c) => {
  const who = identity(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const row = getPat(c.req.param("id"));
  // 404 (not 403) for someone else's token: don't confirm it exists.
  if (!row || (row.email !== who.email && who.email !== config.ownerEmail)) return c.json({ error: "not_found" }, 404);
  revokePat(row.id);
  console.log(`[mcp] PAT ${row.id} (${row.prefix}…) of ${row.email} revoked by ${who.email}`);
  return c.json({ ok: true });
});
