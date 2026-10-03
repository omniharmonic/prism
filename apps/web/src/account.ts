// Web AccountClient — self-service account management against /auth/*, riding the
// owner/member session cookie. Backs the Settings → Account tab. On success it
// refreshes the cached identity (fetchMe) so collab presence picks up the new
// name/avatar immediately.
import type { AccountClient, AccountProfile, SignedInDevice, AgentTokenList, CreatedAgentToken } from "@prism/core/shell";
import { fetchMe, vaultHeader, logout } from "./config";
import { serverFetch } from "./transport";

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const r = await serverFetch(`/auth${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(prettyError(body.error) ?? `Request failed (${r.status}).`);
  }
  return r;
}

function prettyError(code?: string): string | null {
  switch (code) {
    case "wrong_password": return "That current password is incorrect.";
    case "invalid_avatar": return "That image is too large — pick a smaller one.";
    case "invalid_name": return "Please enter a valid name.";
    case "too_many_tokens": return "You have too many agent tokens — revoke one first.";
    case "forbidden": return "You have no access in this vault.";
    case undefined: return null;
    default: return code.replace(/_/g, " ");
  }
}

export const webAccount: AccountClient = {
  // The one sign-out path (config.logout): asks about unsent changes, ends the
  // session (PWA: POST /auth/logout; native: revoke the device token + tell the
  // host), clears the offline read cache and its localStorage keys. Then a reload
  // lands on the shell's own sign-in screen with no in-memory state left.
  async signOut(): Promise<boolean> {
    const left = await logout();
    if (left) window.location.reload();
    return left;
  },
  async getProfile(): Promise<AccountProfile> {
    const me = await fetchMe({ maxAgeMs: 3000 });
    return {
      email: me.email ?? "",
      name: me.name ?? null,
      avatar: (me as { avatar?: string | null }).avatar ?? null,
      hasPassword: !!me.hasPassword,
    };
  },
  async updateProfile(patch: { name?: string; avatar?: string | null }): Promise<void> {
    await authFetch("/profile", { method: "PUT", body: JSON.stringify(patch) });
    await fetchMe(); // refresh cached identity → collab presence updates
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await authFetch("/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
  },
  // Native apps signed in via device tokens (WP2.1, /auth/devices).
  async listDevices(): Promise<SignedInDevice[]> {
    const r = await authFetch("/devices", { method: "GET" });
    const j = (await r.json()) as { devices: SignedInDevice[] };
    return j.devices;
  },
  async revokeDevice(id: string): Promise<void> {
    await authFetch(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  // Prism MCP access tokens for agents (WP6.1, /auth/pats). A new token is bound
  // to the ACTIVE vault (X-Prism-Vault).
  async listAgentTokens(): Promise<AgentTokenList> {
    const r = await authFetch("/pats", { method: "GET" });
    return (await r.json()) as AgentTokenList;
  },
  async createAgentToken(opts): Promise<CreatedAgentToken> {
    const r = await authFetch("/pats", { method: "POST", headers: vaultHeader(), body: JSON.stringify(opts) });
    return (await r.json()) as CreatedAgentToken;
  },
  async listAgentVaults() {
    const r = await serverFetch("/api/vaults", { headers: vaultHeader() });
    if (!r.ok) throw new Error(`Couldn't load vaults (${r.status}).`);
    const rows = (await r.json()) as Array<{ id: string; label: string; active?: boolean }>;
    return rows.map((v) => ({ id: v.id, label: v.label, active: !!v.active }));
  },
  // "Test connection": a stateless MCP tools/list with the NEW token (never the
  // session). The token is used for this one request and not stored anywhere.
  async testAgentConnection(token: string): Promise<{ toolCount: number }> {
    const r = await serverFetch("/mcp", {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": "2026-07-28",
        "MCP-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
      }),
    });
    if (!r.ok) throw new Error(r.status === 401 ? "The server rejected the token." : `The server answered ${r.status}.`);
    const text = await r.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    const msg = JSON.parse(data ? data.slice(6) : text) as { result?: { tools?: unknown[] }; error?: { message?: string } };
    if (!msg.result?.tools) throw new Error(msg.error?.message ?? "Unexpected response from the MCP endpoint.");
    return { toolCount: msg.result.tools.length };
  },
  async revokeAgentToken(id: string): Promise<void> {
    await authFetch(`/pats/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
