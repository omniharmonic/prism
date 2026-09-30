import { createContext, useContext, type ReactNode } from "react";

/**
 * Seam for "Notify me when an agent finishes" (Arch v2 WP3.3). The web shell
 * backs it with Web Push (PushManager + /api/push/*); the desktop shell and the
 * native (WP2.2) build provide nothing, so the section hides. Native/APNs
 * registration (WP5.3) is the future second implementation of this same seam.
 *
 *   unsupported    no Push API in this browser
 *   needs-install  iOS Safari outside an installed (standalone) PWA — web push
 *                  only works for PWAs added to the Home Screen (iOS 16.4+)
 *   server-off     the server has no VAPID keys configured
 *   denied         the user blocked notifications in the browser
 *   off | on       subscribed or not (on THIS browser)
 */
export type PushState = "unsupported" | "needs-install" | "server-off" | "denied" | "off" | "on";

export interface PushClient {
  state(): Promise<PushState>;
  /** Ask permission, subscribe, register with the server. Throws a readable Error. */
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** Ask the server to send a content-free test notification. */
  test(): Promise<void>;
}

const PushContext = createContext<PushClient | null>(null);

export function PushProvider({ value, children }: { value: PushClient | null; children: ReactNode }) {
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

/** The push client, or null when this shell has no push (desktop / native). */
export function usePush(): PushClient | null {
  return useContext(PushContext);
}
