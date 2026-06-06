import { createContext, useContext, type ReactNode } from "react";
import type { VaultClient } from "./VaultClient";

const VaultClientContext = createContext<VaultClient | null>(null);

/**
 * Provides the active {@link VaultClient} to the shared UI tree. Each host shell
 * (desktop / web) constructs its own implementation and supplies it here.
 */
export function VaultClientProvider({
  client,
  children,
}: {
  client: VaultClient;
  children: ReactNode;
}) {
  return (
    <VaultClientContext.Provider value={client}>{children}</VaultClientContext.Provider>
  );
}

/** Access the host-provided {@link VaultClient}. Throws if no provider is mounted. */
export function useVaultClient(): VaultClient {
  const client = useContext(VaultClientContext);
  if (!client) {
    throw new Error(
      "useVaultClient must be used within a <VaultClientProvider>. " +
        "The host shell (desktop/web) is responsible for providing a VaultClient.",
    );
  }
  return client;
}
