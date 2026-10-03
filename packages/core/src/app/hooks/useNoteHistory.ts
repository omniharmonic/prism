import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { HistoryUnavailableError, isAccessUnavailable, type VaultClient } from "../../data/VaultClient";
import type { Note } from "../../lib/types";
import { queryKeys } from "../../lib/parachute/queries";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { reviewMode } from "../../lib/governance/review";
import { flushPendingSaves, discardPendingSaves } from "./useAutoSave";
import { useUIStore } from "../stores/ui";

const PAGE = 50;
const activeScope = (client: VaultClient) => client.scope?.() ?? useAgentChatStore.getState().scope;
function assertAudience(client: VaultClient, scope: string | null) {
  if (activeScope(client) !== scope) throw new Error("Workspace changed. Reopen this page’s history.");
}
async function freshSource(client: VaultClient, noteId: string, scope: string | null) {
  assertAudience(client, scope);
  const note = await client.getNote(noteId, { fresh: true });
  assertAudience(client, scope);
  if (note.id !== noteId) throw new Error("The requested page is unavailable.");
  return note;
}
function useHistoryScope() {
  const client = useVaultClient();
  const audience = useAgentChatStore((state) => state.scope);
  return { client, scope: client.scope?.() ?? audience };
}
const retry = (count: number, error: Error) =>
  !(error instanceof HistoryUnavailableError) && !isAccessUnavailable(error) && count < 1;

/** Version access remains audience-bound even when immutable bodies are cached. */
export function useNoteVersions(noteId: string | null) {
  const { client, scope } = useHistoryScope();
  const supported = !!client.listNoteVersions;
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.vault.versions(noteId ?? ""), scope],
    enabled: !!noteId && supported,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      await freshSource(client, noteId!, scope);
      const page = await client.listNoteVersions!(noteId!, { limit: PAGE, offset: pageParam });
      assertAudience(client, scope);
      return page;
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.versions.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    retry,
    staleTime: 0,
  });
  // Retain identity for an already-open viewer during a flush-triggered list refresh.
  // The panel hides rows while fetching; the viewer independently revalidates its source.
  const visible = !query.isError ? query.data : undefined;
  const versions = visible?.pages.flatMap((page) => page.versions) ?? [];
  const total = visible?.pages[0]?.total ?? 0;
  return {
    ...query,
    versions,
    total,
    unavailable: !supported || query.error instanceof HistoryUnavailableError,
  };
}

export function useHistorySource(noteId: string) {
  const { client, scope } = useHistoryScope();
  const query = useQuery({
    queryKey: [...queryKeys.vault.note(noteId), "history-source", scope],
    queryFn: () => freshSource(client, noteId, scope),
    retry,
    staleTime: 0,
  });
  return { ...query, data: !query.isFetching && !query.isError ? query.data : undefined };
}

export function useNoteVersion(noteId: string | null, versionIx: number | null) {
  const { client, scope } = useHistoryScope();
  const query = useQuery({
    queryKey: [...queryKeys.vault.version(noteId ?? "", versionIx ?? -1), scope],
    enabled: !!noteId && versionIx !== null && !!client.getNoteVersion,
    queryFn: async () => {
      await freshSource(client, noteId!, scope);
      const version = await client.getNoteVersion!(noteId!, versionIx!);
      assertAudience(client, scope);
      return version;
    },
    retry,
    staleTime: 0,
  });
  return {
    ...query,
    data: !query.isFetching && !query.isError ? query.data : undefined,
    unavailable: !client.getNoteVersion,
  };
}

/** Flush first, then fresh capability/concurrency check, then restore and remount.
 * A late result must not discard drafts or populate another audience’s caches. */
export function useRestoreVersion() {
  const { client } = useHistoryScope();
  const qc = useQueryClient();
  const bumpNoteRevision = useUIStore((s) => s.bumpNoteRevision);
  return useMutation({
    mutationFn: async ({
      noteId,
      versionIx,
      expectedScope,
    }: {
      noteId: string;
      versionIx: number;
      expectedScope: string | null;
    }): Promise<Note> => {
      if (!client.restoreNoteVersion) throw new HistoryUnavailableError();
      assertAudience(client, expectedScope);
      await flushPendingSaves(noteId);
      // The flush must have REACHED the server: a save parked on this device
      // (offline / awaiting review) would be silently skipped by the restore.
      if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("You’re offline. Reconnect before restoring a version.");
      if (await client.hasPendingWrites?.()) throw new Error("Some changes on this device haven’t reached the server yet. Wait for “Saved” (or review them) before restoring a version.");
      const current = await freshSource(client, noteId, expectedScope);
      if (reviewMode(current) !== "none") throw new Error("Restoring this page requires edit access.");
      if (!current.updatedAt) throw new Error("This note has no modification time to restore against.");
      const restored = await client.restoreNoteVersion(noteId, versionIx, current.updatedAt);
      assertAudience(client, expectedScope);
      if (restored.id !== noteId) throw new Error("The restored page could not be verified.");
      discardPendingSaves(noteId);
      return restored;
    },
    onSuccess: (restored, { noteId, expectedScope }) => {
      if (activeScope(client) !== expectedScope) return;
      qc.setQueryData(queryKeys.vault.note(noteId), restored);
      bumpNoteRevision(noteId);
      void qc.invalidateQueries({ queryKey: queryKeys.vault.versions(noteId) });
      void qc.invalidateQueries({ queryKey: [...queryKeys.vault.note(noteId), "history-source"] });
      void qc.invalidateQueries({ queryKey: queryKeys.vault.notes(), exact: true });
    },
    onError: (_error, { noteId, expectedScope }) => {
      if (activeScope(client) === expectedScope) {
        void qc.invalidateQueries({ queryKey: queryKeys.vault.note(noteId), exact: true });
        void qc.invalidateQueries({ queryKey: [...queryKeys.vault.note(noteId), "history-source"] });
      }
    },
  });
}
