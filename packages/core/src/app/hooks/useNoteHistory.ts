import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { HistoryUnavailableError } from "../../data/VaultClient";
import type { Note } from "../../lib/types";
import { queryKeys } from "../../lib/parachute/queries";
import { flushPendingSaves, discardPendingSaves } from "./useAutoSave";
import { useUIStore } from "../stores/ui";

const PAGE = 50;

/**
 * A note's version history, newest first, paged. `unavailable` is true when the
 * shell or the vault predates note history — callers show the plain timeline.
 */
export function useNoteVersions(noteId: string | null) {
  const client = useVaultClient();
  const supported = !!client.listNoteVersions;
  const query = useInfiniteQuery({
    queryKey: queryKeys.vault.versions(noteId ?? ""),
    enabled: !!noteId && supported,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => client.listNoteVersions!(noteId!, { limit: PAGE, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.versions.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    retry: (count, err) => !(err instanceof HistoryUnavailableError) && count < 2,
    staleTime: 10_000,
  });
  const versions = query.data?.pages.flatMap((p) => p.versions) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const unavailable = !supported || query.error instanceof HistoryUnavailableError;
  return { ...query, versions, total, unavailable };
}

/** One version with content. Versions are immutable, so cache them indefinitely. */
export function useNoteVersion(noteId: string | null, versionIx: number | null) {
  const client = useVaultClient();
  return useQuery({
    queryKey: queryKeys.vault.version(noteId ?? "", versionIx ?? -1),
    enabled: !!noteId && versionIx !== null && !!client.getNoteVersion,
    queryFn: () => client.getNoteVersion!(noteId!, versionIx!),
    staleTime: Infinity,
  });
}

/**
 * Restore a version. The sequence protects the user's work at every step:
 *  1. flush any unsaved edits in open editors — they land as a version of their
 *     own, so restoring never silently discards typing;
 *  2. restore against the note's updatedAt AFTER that flush (the vault refuses a
 *     blind restore and 409s if something else wrote meanwhile);
 *  3. drop the editors' now-stale state and remount them on the restored note.
 * The replaced content is captured by the vault as a new version, so every
 * restore is itself one click to undo.
 */
export function useRestoreVersion() {
  const client = useVaultClient();
  const qc = useQueryClient();
  const bumpNoteRevision = useUIStore((s) => s.bumpNoteRevision);
  return useMutation({
    mutationFn: async ({ noteId, versionIx }: { noteId: string; versionIx: number }): Promise<Note> => {
      if (!client.restoreNoteVersion) throw new HistoryUnavailableError();
      await flushPendingSaves(noteId);
      const current = await client.getNote(noteId);
      if (!current.updatedAt) throw new Error("This note has no modification time to restore against.");
      const restored = await client.restoreNoteVersion(noteId, versionIx, current.updatedAt);
      discardPendingSaves(noteId);
      return restored;
    },
    onSuccess: (restored, { noteId }) => {
      qc.setQueryData(queryKeys.vault.note(noteId), restored);
      bumpNoteRevision(noteId);
      qc.invalidateQueries({ queryKey: queryKeys.vault.versions(noteId) });
      qc.invalidateQueries({ queryKey: queryKeys.vault.notes(), exact: true });
    },
    onError: (_e, { noteId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.vault.note(noteId) });
    },
  });
}
