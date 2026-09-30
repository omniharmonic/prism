import { createContext, useContext, type ReactNode } from "react";

/** The signed-in user's own account, for the Account settings surface. Email is
 *  the immutable login identity; name + avatar are editable and feed the collab
 *  presence (so a person's cursor/comments/edits are identifiable). */
export interface AccountProfile {
  email: string;
  name: string | null;
  avatar: string | null;
  hasPassword: boolean;
}

/**
 * Seam for self-service account management (web session only). The web shell
 * backs it with /auth/*; the desktop shell (local owner, no session) provides
 * nothing, so the Account tab hides. Same surface for the owner and for members.
 */
export interface AccountClient {
  getProfile(): Promise<AccountProfile>;
  /** Update display name and/or avatar (a small data:image/ URL, or null to clear). */
  updateProfile(patch: { name?: string; avatar?: string | null }): Promise<void>;
  /** Change password (verifies the current one server-side). */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** Native apps signed in to this account via device tokens (optional: a shell
   *  without the /auth/devices surface omits both, and the section hides). */
  listDevices?(): Promise<SignedInDevice[]>;
  /** Revoke one device's token — it is signed out on its next request. */
  revokeDevice?(id: string): Promise<void>;
  /** Prism MCP personal access tokens for agents (WP6.1, /auth/pats). Optional:
   *  a shell without that surface omits all three and the section hides. */
  listAgentTokens?(): Promise<AgentTokenList>;
  /** Create a token for the active vault. The secret is in the result ONCE. */
  createAgentToken?(opts: { label?: string; scope: "read" | "write"; expiresInDays?: number }): Promise<CreatedAgentToken>;
  /** Revoke a token — the agent's next request is refused. */
  revokeAgentToken?(id: string): Promise<void>;
}

/** A Prism MCP access token as listed (never the secret). Times are epoch ms. */
export interface AgentToken {
  id: string;
  /** The first characters of the token (e.g. `pp_Ab3dE6`), to tell tokens apart. */
  prefix: string;
  vaultId: string;
  scope: "read" | "write";
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

export interface AgentTokenList {
  tokens: AgentToken[];
  /** The Prism MCP endpoint URL agents connect to. */
  mcpUrl: string;
}

/** A freshly created token: the secret (shown once) plus paste-ready client config. */
export interface CreatedAgentToken extends AgentToken {
  token: string;
  url: string;
  /** Claude Code `.mcp.json` shape. */
  mcpJson: unknown;
  /** Claude Code one-liner (`claude mcp add …`). */
  claudeCodeCommand: string;
  /** Claude Desktop `claude_desktop_config.json` shape (via mcp-remote). */
  claudeDesktopJson: unknown;
}

/** A native client signed in with a device token (WP2.1). Times are epoch ms. */
export interface SignedInDevice {
  id: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number;
  /** True when this request itself came from that device. */
  current: boolean;
}

const AccountContext = createContext<AccountClient | null>(null);

export function AccountProvider({ value, children }: { value: AccountClient | null; children: ReactNode }) {
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** The account client, or null when the shell doesn't support self-service
 *  account management (desktop) — callers hide the Account UI in that case. */
export function useAccount(): AccountClient | null {
  return useContext(AccountContext);
}
