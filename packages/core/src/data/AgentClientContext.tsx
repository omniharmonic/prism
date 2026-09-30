import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentApiError, type AgentClient } from "../lib/agent/sessions";

const AgentClientContext = createContext<AgentClient | null>(null);

/**
 * Provides the host's {@link AgentClient} (server-side agent sessions, WP3.2).
 * Optional: with no provider (desktop today, capability-link viewers) every
 * Agent chat entry point stays hidden.
 */
export function AgentClientProvider({ client, children }: { client: AgentClient | null; children: ReactNode }) {
  return <AgentClientContext.Provider value={client}>{children}</AgentClientContext.Provider>;
}

/** The host's AgentClient, or null when this shell has none. */
export function useAgentClient(): AgentClient | null {
  return useContext(AgentClientContext);
}

/** Query-key root for everything agent-session related (scoped per vault). */
export function agentKeys(client: AgentClient | null) {
  const scope = client?.scope?.() ?? "";
  return {
    all: ["agent-sessions", scope] as const,
    available: ["agent-available", scope] as const,
    list: (archived: boolean) => ["agent-sessions", scope, "list", archived] as const,
  };
}

export type AgentAvailability = "none" | "checking" | "yes" | "no" | "error";

/**
 * Can this viewer use server agent sessions? Probes `GET /sessions?limit=1`
 * once (cached): the API is SERVER-OWNER only, so admins/members get 403 and the
 * entry points hide. "none" = the shell has no AgentClient; "error" = the probe
 * failed for another reason (offline, 5xx) — entry points stay hidden.
 */
export function useAgentAvailability(): AgentAvailability {
  const client = useAgentClient();
  const keys = agentKeys(client);
  const { data, isError } = useQuery({
    queryKey: keys.available,
    enabled: !!client,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async () => {
      try {
        await client!.listSessions({ limit: 1 });
        return true;
      } catch (e) {
        if (e instanceof AgentApiError && (e.status === 401 || e.status === 403 || e.status === 404)) return false;
        throw e;
      }
    },
  });
  if (!client) return "none";
  if (data === true) return "yes";
  if (data === false) return "no";
  return isError ? "error" : "checking";
}

/** True only when the agent chat can be used (hide entry points otherwise). */
export function useAgentAvailable(): boolean {
  return useAgentAvailability() === "yes";
}
