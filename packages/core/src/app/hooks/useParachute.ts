import { isAccessUnavailable } from "../../data/VaultClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { systemApi, githubSyncApi } from "../../lib/parachute/client";
import { useVaultClient } from "../../data/VaultClientContext";
import { queryKeys } from "../../lib/parachute/queries";
import type { Note, NoteFilters, CreateNoteParams, UpdateNoteParams } from "../../lib/types";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useLivePollMs } from "../../lib/events/channelStatus";
import { withoutTrashed } from "../../lib/pages/model";
import { hasFilters, matchesFilters, queryTerms, type SearchFilters } from "../../lib/search/match";
import { inferContentType } from "../../lib/schemas/content-types";

export function useNotes(filters?: NoteFilters) {
  const client = useVaultClient();
  return useQuery({
    queryKey: queryKeys.vault.notes(filters),
    queryFn: () => client.listNotes(filters),
    // Trashed pages are hidden from every list (owner passthrough and desktop
    // return them; the gateway already drops them for everyone else).
    select: withoutTrashed,
  });
}

/**
 * Lean tree-view query: returns id/path/tags/metadata only.
 * Auto-invalidates on any vault mutation since mutations invalidate
 * the `["vault"]` prefix.
 */
export function useVaultTree() {
  const client = useVaultClient();
  return useQuery({
    queryKey: ["vault", "tree"] as const,
    queryFn: () => client.listTree(),
    select: withoutTrashed,
  });
}

export function useNote(id: string | null) {
  const client = useVaultClient();
  const result = useQuery({
    queryKey: queryKeys.vault.note(id!),
    queryFn: () => client.getNote(id!),
    enabled: !!id,
    retry: (count, error) => !isAccessUnavailable(error) && count < 1,
  });
  // TanStack retains prior data when a background refetch fails. A confirmed
  // authorization/deletion response must hide that body in every note consumer.
  return { ...result, data: isAccessUnavailable(result.error) ? undefined : result.data };

}

/** Ranked retrieval with an explicit keyword fallback and audience-scoped results. */
export function useVaultSearch(query: string, filters?: SearchFilters) {
  const client = useVaultClient();
  const scope = useAgentChatStore((state) => state.scope);
  const text = query.trim();
  const active = filters && hasFilters(filters) ? filters : undefined;
  const result = useQuery({
    queryKey: ["vault", "search", scope, text, active ?? null],
    queryFn: async () => {
      const current = () => useAgentChatStore.getState().scope === scope;
      const terms = queryTerms(text);
      // Filters narrow the server's permission-filtered keyword search (or, on an
      // older server, the same results client-side). Ranked search has no filters.
      if (!active && client.semanticSearch) {
        try {
          const notes = await client.semanticSearch(text);
          if (!current()) throw new Error("Workspace changed");
          return { notes, mode: "ranked" as const };
        } catch {
          if (!current()) throw new Error("Workspace changed");
        }
      }
      const fallback = !active && client.semanticSearch ? "fallback" as const : "keyword" as const;
      const filtered = client.searchNotes ? await client.searchNotes(text, active) : null;
      if (!current()) throw new Error("Workspace changed");
      if (filtered) return { notes: filtered, mode: fallback };
      const notes = await client.search(text);
      if (!current()) throw new Error("Workspace changed");
      return { notes: active ? notes.filter((n) => matchesFilters(n, active, terms, (x) => inferContentType(x as Note))) : notes, mode: fallback };
    },
    enabled: text.length > 0,
    staleTime: 0,
    retry: false,
  });
  // A cached snippet is not proof of current access; hide it during revalidation.
  const visible = text && !result.isFetching && !result.isError ? result.data : undefined;
  return { ...result, data: visible ? withoutTrashed(visible.notes) : undefined, mode: visible?.mode };
}

export function useTags() {
  const client = useVaultClient();
  return useQuery({
    queryKey: queryKeys.vault.tags(),
    queryFn: () => client.getTags(),
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
  const client = useVaultClient();
  return useQuery({
    queryKey: queryKeys.vault.graph(),
    queryFn: () => client.getGraph(),
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
  const client = useVaultClient();
  return useQuery({
    queryKey: queryKeys.vault.stats(),
    queryFn: () => client.getStats(),
  });
}

export function useCreateNote() {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateNoteParams) => client.createNote(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
    },
  });
}

export function useUpdateNote() {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedScope, ...params }: { id: string; expectedScope?: string } & UpdateNoteParams) => {
      // Optimistic concurrency (vault 0.4.0+): forward the `updatedAt` we last
      // read for this note (from the query cache) so a stale CONTENT write fails
      // with a 409 rather than clobbering a newer revision. Only guard content —
      // that's the contended field. A rename (`path`) or icon/font (`metadata`)
      // carries no content, and for a note open in the collaborative editor the
      // server rewrites content (bumping updatedAt) every few seconds, so a
      // cached `updatedAt` is almost always stale: guarding those non-content
      // writes would 409 every rename of a collab note. They fall back to
      // force:true (path is last-writer-wins; metadata merges) — both safe.
      if (params.ifUpdatedAt === undefined && params.content !== undefined) {
        const cached = queryClient.getQueryData<Note>(queryKeys.vault.note(id));
        if (cached?.updatedAt) params = { ...params, ifUpdatedAt: cached.updatedAt };
      }
      return client.updateNote(id, params, { expectedScope });
    },
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
  const client = useVaultClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteNote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.all });
    },
  });
}

export function useServiceStatus() {
  return useQuery({
    queryKey: queryKeys.services.status(),
    queryFn: systemApi.checkServices,
    refetchInterval: useLivePollMs(30_000),
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
