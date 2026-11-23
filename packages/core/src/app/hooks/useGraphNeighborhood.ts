import { leafTitle } from "../../lib/pages/containerTitle";
import { useQuery } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { filterNeighborhood } from "./useParachute";
import type { VaultNeighborhood } from "../../data/VaultClient";

export function useGraphNeighborhood(center: string, depth: number) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  const query = useQuery({
    queryKey: ["vault", "neighborhood", scope, center, depth],
    enabled: !!center,
    retry: false,
    refetchInterval: 60_000,
    queryFn: async (): Promise<VaultNeighborhood> => {
      const current = () =>
        (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
      if (!current()) throw new Error("Workspace changed");
      if (client.getNeighborhood) {
        const result = await client.getNeighborhood(center, depth, 150);
        if (!current()) throw new Error("Workspace changed");
        return result;
      }
      // Legacy native host: keep its existing graph provider, with a visible cap.
      const graph = await client.getGraph();
      if (!current()) throw new Error("Workspace changed");
      const local = filterNeighborhood(graph, center, depth);
      const ids = new Set(
        [center, ...local.nodes.map((n) => n.id)].slice(0, 150),
      );
      const edges = local.edges.filter(
        (e) => ids.has(e.source) && ids.has(e.target),
      );
      return {
        nodes: local.nodes
          .filter((n) => ids.has(n.id))
          .map((n) => ({
            ...n,
            path: n.path ?? null,
            title: leafTitle(n.path) || n.id,
            tags: n.tags ?? [],
          })),
        edges: edges.slice(0, 2000),
        truncated:
          local.nodes.length >= 150 ||
          edges.length > 2000 ||
          graph.nodes.length >= 10000,
      };
    },
  });
  // Permission revalidation is a boundary: never show cached neighbor titles
  // while a fresh read is pending or after the server rejects it.
  return {
    ...query,
    data: query.isFetching || query.isError ? undefined : query.data,
    scope,
  };
}
