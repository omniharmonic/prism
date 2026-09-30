// Web AccountClient — self-service account management against /auth/*, riding the
// owner/member session cookie. Backs the Settings → Account tab. On success it
// refreshes the cached identity (fetchMe) so collab presence picks up the new
// name/avatar immediately.
import type { AccountClient, AccountProfile, SignedInDevice, AgentTokenList, CreatedAgentToken } from "@prism/core";
import { fetchMe, vaultHeader } from "./config";
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
  async getProfile(): Promise<AccountProfile> {
    const me = await fetchMe();
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
  async revokeAgentToken(id: string): Promise<void> {
    await authFetch(`/pats/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
