import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { vaultApi, systemApi, githubSyncApi } from "../../lib/parachute/client";
import { queryKeys } from "../../lib/parachute/queries";
import type { NoteFilters, UpdateNoteParams } from "../../lib/types";

export function useNotes(filters?: NoteFilters) {
  return useQuery({
    queryKey: queryKeys.vault.notes(filters),
    queryFn: () => vaultApi.listNotes(filters),
  });
}

/**
 * Lean tree-view query: returns id/path/tags/metadata only.
 * Auto-invalidates on any vault mutation since mutations invalidate
 * the `["vault"]` prefix.
 */
export function useVaultTree() {
  return useQuery({
    queryKey: ["vault", "tree"] as const,
    queryFn: vaultApi.listTree,
  });
}

export function useNote(id: string | null) {
  return useQuery({
    queryKey: queryKeys.vault.note(id!),
    queryFn: () => vaultApi.getNote(id!),
    enabled: !!id,
  });
}

export function useVaultSearch(query: string) {
  return useQuery({
    queryKey: queryKeys.vault.search(query),
    queryFn: () => vaultApi.search(query),
    enabled: query.length > 0,
  });
}

export function useTags() {
  return useQuery({
    queryKey: queryKeys.vault.tags(),
    queryFn: vaultApi.getTags,
  });
}

export function useVaultPaths() {
  return useQuery({
    queryKey: ["vault", "paths"],
    queryFn: () => invoke<string[]>("vault_get_paths"),
  });
}

/**
 * Fetch the full vault graph (all nodes + edges). Cached aggressively since
 * the Parachute `near` parameter isn't functional — neighborhood filtering
 * happens client-side via `filterNeighborhood()`.
 */
export function useFullGraph() {
  return useQuery({
    queryKey: queryKeys.vault.graph(),
    queryFn: () => vaultApi.getGraph(),
    staleTime: 60_000,
  });
}

/**
 * BFS from `centerId` to extract a neighborhood subgraph up to `depth` hops.
 * Returns only the nodes and edges within that neighborhood.
 */
export function filterNeighborhood(
  graph: { nodes: Array<{ id: string; path?: string; tags?: string[] }>; edges: Array<{ source: string; target: string; relationship: string }> },
  centerId: string,
  depth: number,
): { nodes: typeof graph.nodes; edges: typeof graph.edges } {
  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, new Set());
    if (!adj.has(edge.target)) adj.set(edge.target, new Set());
    adj.get(edge.source)!.add(edge.target);
    adj.get(edge.target)!.add(edge.source);
  }

  // BFS with safety cap to prevent graph explosion on hub nodes
  const MAX_BFS_NODES = 600;
  const visited = new Set<string>();
  let frontier = [centerId];
  visited.add(centerId);

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const neighbor of adj.get(nodeId) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
          if (visited.size >= MAX_BFS_NODES) break;
        }
      }
      if (visited.size >= MAX_BFS_NODES) break;
    }
    frontier = next;
    if (visited.size >= MAX_BFS_NODES) break;
  }

  const nodes = graph.nodes.filter((n) => visited.has(n.id));
  const edges = graph.edges.filter(
    (e) => visited.has(e.source) && visited.has(e.target),
  );
  return { nodes, edges };
}

export function useVaultStats() {
  return useQuery({
    queryKey: queryKeys.vault.stats(),
    queryFn: vaultApi.getStats,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: vaultApi.createNote,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...params }: { id: string } & UpdateNoteParams) =>
      vaultApi.updateNote(id, params),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.notes() });

      // Auto-sync to GitHub: trigger push for matching sync configs
      // TODO: Match note path against config.vaultPath and call githubSyncApi.pushFile()
      // For now this is a stub — the Rust side could emit events for matched configs instead
      void checkAutoSync(id);
    },
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: vaultApi.deleteNote,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
    },
  });
}

export function useServiceStatus() {
  return useQuery({
    queryKey: queryKeys.services.status(),
    queryFn: systemApi.checkServices,
    refetchInterval: 30_000,
  });
}

/** Best-effort auto-sync check after note save */
async function checkAutoSync(noteId: string) {
  try {
    const configs = await githubSyncApi.status();
    for (const config of configs) {
      if (config.autoSync) {
        // TODO: verify note's path falls under config.vaultPath before pushing
        // For now, push to all auto-sync configs — refine once note path is available in onSuccess
        await githubSyncApi.pushFile(config.id, noteId);
      }
    }
  } catch {
    // Silent fail — auto-sync is best-effort
  }
}
