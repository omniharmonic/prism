import type { NoteFilters } from "../types";

// TanStack Query key factory — ensures consistent cache keys
export const queryKeys = {
  vault: {
    all: ["vault"] as const,
    notes: (filters?: NoteFilters) =>
      filters ? ["vault", "notes", filters] as const : ["vault", "notes"] as const,
    note: (id: string) => ["vault", "notes", id] as const,
    search: (query: string) => ["vault", "search", query] as const,
    tags: () => ["vault", "tags"] as const,
    stats: () => ["vault", "stats"] as const,
    graph: () => ["vault", "graph"] as const,
  },
  services: {
    status: () => ["services", "status"] as const,
  },
};
