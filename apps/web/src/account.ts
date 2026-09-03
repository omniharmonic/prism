// Web AccountClient — self-service account management against /auth/*, riding the
// owner/member session cookie. Backs the Settings → Account tab. On success it
// refreshes the cached identity (fetchMe) so collab presence picks up the new
// name/avatar immediately.
import type { AccountClient, AccountProfile } from "@prism/core";
import { GATEWAY_ORIGIN, fetchMe } from "./config";

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const r = await fetch(`${GATEWAY_ORIGIN}/auth${path}`, {
    ...init,
    credentials: "include",
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
};
