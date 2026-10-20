import type { NoteFilters } from "../types";

// TanStack Query key factory — ensures consistent cache keys
export const queryKeys = {
  vault: {
    all: ["vault"] as const,
    notes: (filters?: NoteFilters) =>
      filters ? ["vault", "notes", filters] as const : ["vault", "notes"] as const,
    note: (id: string) => ["vault", "notes", id] as const,
    // Nested under the note's key, so invalidating a note refreshes its history too.
    versions: (id: string) => ["vault", "notes", id, "versions"] as const,
    version: (id: string, ix: number) => ["vault", "notes", id, "versions", ix] as const,
    search: (query: string) => ["vault", "search", query] as const,
    tags: () => ["vault", "tags"] as const,
    stats: () => ["vault", "stats"] as const,
    graph: () => ["vault", "graph"] as const,
  },
  services: {
    status: () => ["services", "status"] as const,
  },
};
