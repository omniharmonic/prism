import { createContext, useContext, type ReactNode } from "react";
import type { HostServices } from "../lib/host/services";

const HostServicesContext = createContext<HostServices | null>(null);

/**
 * Provides the shell's {@link HostServices} (server-backed replacements for the
 * legacy desktop's host commands, Arch v2 WP4.3). Optional: with no provider
 * (the desktop, capability viewers, non-owners) components keep their existing
 * Tauri path or hide the affordance.
 */
export function HostServicesProvider({ client, children }: { client: HostServices | null; children: ReactNode }) {
  return <HostServicesContext.Provider value={client}>{children}</HostServicesContext.Provider>;
}

/** The client, or null when this shell/viewer has none. */
export function useHostServices(): HostServices | null {
  return useContext(HostServicesContext);
}
