import type { QueryClient } from "@tanstack/react-query";
import type { Note } from "../../lib/types";

/**
 * After a CONFIRMED status write: put the note's new tags into every Messages list in place (the
 * chip and the filter counts move together, the row keeps its place), then re-read in the
 * background — only the Messages lists and this note, never the whole vault cache.
 */
export function syncTriageCaches(queryClient: QueryClient, noteId: string, tags: string[], scope?: string | null): void {
  const inboxKey = scope ? ["vault", "inbox", scope] : ["vault", "inbox"];
  queryClient.setQueriesData<unknown>({ queryKey: inboxKey }, (old: unknown) =>
    Array.isArray(old) ? old.map((n: Note) => (n?.id === noteId ? { ...n, tags } : n)) : old);
  void queryClient.invalidateQueries({ queryKey: inboxKey });
  void queryClient.invalidateQueries({ queryKey: ["vault", "notes", noteId] });
  if (scope) void queryClient.invalidateQueries({ queryKey: ["vault", "message-detail", scope, noteId] });
}
