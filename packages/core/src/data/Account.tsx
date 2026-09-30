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
