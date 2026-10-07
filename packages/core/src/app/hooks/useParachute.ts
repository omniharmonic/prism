import { useEffect, useRef } from "react";
import { isAccessUnavailable } from "../../data/VaultClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { systemApi, githubSyncApi } from "../../lib/parachute/client";
import { useVaultClient } from "../../data/VaultClientContext";
import { queryKeys } from "../../lib/parachute/queries";
import type { Note, NoteFilters, CreateNoteParams, UpdateNoteParams } from "../../lib/types";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useLivePollMs } from "../../lib/events/channelStatus";
import { TEMPLATE_TAG, isTemplateNote, withoutTrashed } from "../../lib/pages/model";
import { hasFilters, matchesFilters, queryTerms, sortSearchRows, type SearchFilters } from "../../lib/search/match";
import { blendResults } from "../../lib/search/blend";
import { takeFreshRead } from "../../lib/events/freshReads";
import { inferContentType } from "../../lib/schemas/content-types";
import { notePageIconChanged, pageIconWriteConfirmed, pageIconWriteFailed, reconcilePageIcons } from "../../lib/pages/iconStore";

export function useNotes(filters?: NoteFilters) {
  const client = useVaultClient();
  return useQuery({
    queryKey: queryKeys.vault.notes(filters),
    queryFn: () => client.listNotes(filters),
    // Trashed pages are hidden from every list (owner passthrough and desktop
    // return them; the gateway already drops them for everyone else). And a list BY TAG
    // never shows a page TEMPLATE as one of that tag's notes (a template of a task is not
    // a task) — unless the list asks for templates.
    select: (list: Note[]) => {
      const live = withoutTrashed(list);
      return filters?.tag && filters.tag !== TEMPLATE_TAG ? live.filter((n) => !isTemplateNote(n)) : live;
    },
  });
}

/**
 * Lean tree-view query: returns id/path/tags/metadata only.
 * Auto-invalidates on any vault mutation since mutations invalidate
 * the `["vault"]` prefix.
 */
export function useVaultTree() {
  const client = useVaultClient();
  const result = useQuery({
    queryKey: ["vault", "tree"] as const,
    queryFn: () => client.listTree(),
    select: withoutTrashed,
  });
  // A completed tree read replaces any confirmed local icon override (review M3).
  useEffect(() => { if (result.dataUpdatedAt) reconcilePageIcons(result.dataUpdatedAt); }, [result.dataUpdatedAt]);
  return result;
}

export function useNote(id: string | null) {
  const client = useVaultClient();
  const result = useQuery({
    queryKey: queryKeys.vault.note(id!),
    // A read caused by "this note changed" asks for the current state, not a reused answer.
    queryFn: () => (takeFreshRead(id!) ? client.getNote(id!, { latest: true }) : client.getNote(id!)),
    enabled: !!id,
    retry: (count, error) => !isAccessUnavailable(error) && count < 1,
  });
  // TanStack retains prior data when a background refetch fails. A confirmed
  // authorization/deletion response must hide that body in every note consumer.
  return { ...result, data: isAccessUnavailable(result.error) ? undefined : result.data };

}

/** How long the previous answer may stand in while the next search is in flight. */
const SEARCH_HOLD_MS = 10_000;

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
      const keywordSearch = async (): Promise<Note[]> => {
        const filtered = client.searchNotes ? await client.searchNotes(text, active) : null;
        // Sorted here too: a server from before `sort=` ignores it and answers in its own order.
        if (filtered) return sortSearchRows(filtered, active?.sort);
        // Another vault can only be searched by the server; never answer from the active one.
        if (active?.vault) throw new Error("This server cannot search another vault.");
        const notes = await client.search(text);
        return active ? sortSearchRows(notes.filter((n) => matchesFilters(n, active, terms, (x) => inferContentType(x as Note))), active.sort) : notes;
      };
      if (!active && client.semanticSearch) {
        // NP-SR-05: ranked and keyword run together and are blended. Either may
        // fail on its own: ranked down (or a non-primary vault) → keyword, said
        // openly; keyword down → ranked alone. Both down → the error.
        const [ranked, keyword] = await Promise.allSettled([client.semanticSearch(text), keywordSearch()]);
        if (!current()) throw new Error("Workspace changed");
        if (ranked.status === "fulfilled" && keyword.status === "fulfilled") {
          const extra = keyword.value.some((k) => !ranked.value.some((r) => r.id === k.id));
          return { notes: blendResults(ranked.value, keyword.value, terms), mode: extra ? "blended" as const : "ranked" as const };
        }
        if (ranked.status === "fulfilled") return { notes: ranked.value, mode: "ranked" as const };
        if (keyword.status === "fulfilled") return { notes: keyword.value, mode: "fallback" as const };
        throw keyword.reason;
      }
      const notes = await keywordSearch();
      if (!current()) throw new Error("Workspace changed");
      return { notes, mode: "keyword" as const };
    },
    enabled: text.length > 0,
    staleTime: 0,
    retry: false,
  });
  // A cached snippet is not proof of current access: an answer from the query cache is
  // never shown while it is being revalidated. The ONE exception is the answer this very
  // list was showing a moment ago (same audience, same filters, at most SEARCH_HOLD_MS
  // old): it stays up while the next answer is on its way, so the list does not blink
  // empty between keystrokes or during a background refetch (and Enter keeps acting on
  // the row the person is looking at). An error clears it.
  const fresh = text && !result.isFetching && !result.isError ? result.data : undefined;
  const filterKey = active ? JSON.stringify(active) : "";
  const shown = useRef<{ scope: typeof scope; filterKey: string; at: number; value: NonNullable<typeof fresh> } | null>(null);
  if (fresh) shown.current = { scope, filterKey, at: Date.now(), value: fresh };
  else if (!text || result.isError) shown.current = null;
  const last = shown.current;
  const held = !fresh && text && result.isFetching && last && last.scope === scope && last.filterKey === filterKey && Date.now() - last.at < SEARCH_HOLD_MS ? last.value : undefined;
  const visible = fresh ?? held;
  return { ...result, data: visible ? withoutTrashed(visible.notes) : undefined, mode: visible?.mode, held: !!held };
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
      // NP-PG-01: a changed icon shows in tabs, breadcrumbs and the sidebar at once.
      if (params.metadata && "icon" in params.metadata) notePageIconChanged(id, params.metadata.icon);
      return client.updateNote(id, params, { expectedScope });
    },
    onError: (_e, { id, metadata }) => {
      if (metadata && "icon" in metadata) pageIconWriteFailed(id);
    },
    onSuccess: (_, { id, path, metadata }) => {
      if (metadata && "icon" in metadata) pageIconWriteConfirmed(id);
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.notes() });
      // A rename/move changes the sidebar: don't wait for the events channel.
      if (path !== undefined || (metadata && "icon" in metadata)) queryClient.invalidateQueries({ queryKey: ["vault", "tree"] });

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
