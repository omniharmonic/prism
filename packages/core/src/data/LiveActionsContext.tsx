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
 * Why a live-actions family can or cannot be used right now. A caller that
 * renders a control for the family shows `reason` beside it when it is not
 * `ready`, so the control never just sits there doing nothing.
 */
export type LiveActionsState =
  | "ready"
  /** The status probe has not answered yet. */
  | "loading"
  /** This shell has no live-actions client (desktop, capability viewers). */
  | "no-client"
  /** The probe was refused (401/403/404): this viewer is not the server owner. */
  | "not-allowed"
  /** The probe failed for another reason (offline, server error). */
  | "unreachable"
  /** `ACTIONS_<FAMILY>_ENABLED` is off on the server. */
  | "disabled"
  /** The family is on but the server holds no credential for it. */
  | "unconfigured";

function useLiveActionsProbe(): { client: LiveActionsClient | null; status: LiveActionsStatus | null; settled: boolean; failed: boolean } {
  const client = useLiveActionsClient();
  const enabled = !!client && (!client.scope || !!client.scope());
  const { data, isPending, isError } = useQuery({
    queryKey: ["live-actions-status", client?.scope?.() ?? ""],
    enabled,
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
  return { client: enabled ? client : null, status: client ? (data ?? null) : null, settled: !enabled || !isPending, failed: enabled && isError };
}

/**
 * The server's live-actions status, probed once (cached 10 min). null while
 * loading, when the shell has no client, or when the viewer is not the server
 * owner (403) — every caller then behaves as before.
 */
export function useLiveActionsStatus(): LiveActionsStatus | null {
  return useLiveActionsProbe().status;
}

/**
 * The client, but only when the server has `family` turned on AND configured —
 * otherwise null, so a component falls back to its existing (desktop) path.
 */
export function useLiveActions(family: keyof LiveActionsStatus): LiveActionsClient | null {
  return useLiveActionsAvailability(family).client;
}

/** {@link useLiveActions} plus WHY the family is unavailable when it is. */
export function useLiveActionsAvailability(family: keyof LiveActionsStatus): { client: LiveActionsClient | null; state: LiveActionsState } {
  const { client, status, settled, failed } = useLiveActionsProbe();
  if (!client) return { client: null, state: "no-client" };
  if (!settled) return { client: null, state: "loading" };
  if (failed) return { client: null, state: "unreachable" };
  const s = status?.[family];
  if (!s) return { client: null, state: "not-allowed" };
  if (!s.enabled) return { client: null, state: "disabled" };
  if (!s.configured) return { client: null, state: "unconfigured" };
  return { client, state: "ready" };
}
