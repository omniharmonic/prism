import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { LiveActionError, type LiveActionsClient, type LiveActionsStatus } from "../lib/actions/client";

const LiveActionsContext = createContext<LiveActionsClient | null>(null);

/**
 * Provides the host's {@link LiveActionsClient} (server-side live actions,
 * Arch v2 WP1.5). Optional: with no provider (desktop, capability viewers) the
 * components keep their existing Tauri paths.
 */
export function LiveActionsProvider({ client, children }: { client: LiveActionsClient | null; children: ReactNode }) {
  return <LiveActionsContext.Provider value={client}>{children}</LiveActionsContext.Provider>;
}

/** The raw client (null when this shell has none). */
export function useLiveActionsClient(): LiveActionsClient | null {
  return useContext(LiveActionsContext);
}

/**
 * The server's live-actions status, probed once (cached 10 min). null while
 * loading, when the shell has no client, or when the viewer is not the server
 * owner (403) — every caller then behaves as before.
 */
export function useLiveActionsStatus(): LiveActionsStatus | null {
  const client = useLiveActionsClient();
  const { data } = useQuery({
    queryKey: ["live-actions-status", client?.scope?.() ?? ""],
    enabled: !!client && (!client.scope || !!client.scope()),
    staleTime: 10 * 60_000,
    retry: (n, e) => !(e instanceof LiveActionError && (e.status === 401 || e.status === 403 || e.status === 404)) && n < 1,
    queryFn: async () => {
      try {
        return await client!.status();
      } catch (e) {
        if (e instanceof LiveActionError && (e.status === 401 || e.status === 403 || e.status === 404)) return null;
        throw e;
      }
    },
  });
  return client ? (data ?? null) : null;
}

/**
 * The client, but only when the server has `family` turned on AND configured —
 * otherwise null, so a component falls back to its existing (desktop) path.
 */
export function useLiveActions(family: keyof LiveActionsStatus): LiveActionsClient | null {
  const client = useLiveActionsClient();
  const status = useLiveActionsStatus();
  const s = status?.[family];
  return client && s?.enabled && s.configured ? client : null;
}
