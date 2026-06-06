import { createContext, useContext, type ReactNode } from "react";

/**
 * Seam for creating collaborative share links. Each host shell injects its own
 * implementation (web: call the collab Worker with the stored token; desktop:
 * a Tauri command). When no provider is supplied, share UI is hidden.
 */
export interface CollabSharing {
  /** Mint a capability-scoped collab link for a note (copyable, Google-Docs style). */
  createShareLink(noteId: string): Promise<string>;
}

const CollabSharingContext = createContext<CollabSharing | null>(null);

export function CollabSharingProvider({
  value,
  children,
}: {
  value: CollabSharing | null;
  children: ReactNode;
}) {
  return <CollabSharingContext.Provider value={value}>{children}</CollabSharingContext.Provider>;
}

/** Returns the host-provided sharing impl, or null when sharing isn't available. */
export function useCollabSharing(): CollabSharing | null {
  return useContext(CollabSharingContext);
}
