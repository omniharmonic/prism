import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { vaultApi, systemApi } from "../../lib/parachute/client";
import { queryKeys } from "../../lib/parachute/queries";
import type { NoteFilters, UpdateNoteParams } from "../../lib/types";

export function useNotes(filters?: NoteFilters) {
  return useQuery({
    queryKey: queryKeys.vault.notes(filters),
    queryFn: () => vaultApi.listNotes(filters),
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
