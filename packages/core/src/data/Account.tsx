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
