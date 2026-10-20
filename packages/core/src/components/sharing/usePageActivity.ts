import { useQuery } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import type { WriterDirectory } from "../../lib/history/attribution";
import type { Note } from "../../lib/types";

/** A page's activity (comments, shares, last editor, writer directory). Disabled when the shell has no such read. */
export function usePageActivity(note: Pick<Note, "id" | "updatedAt">) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  const query = useQuery({
    queryKey: ["page-activity", scope, note.id, note.updatedAt],
    enabled: !!client.getPageActivity,
    queryFn: () => client.getPageActivity!(note.id),
    staleTime: 15_000,
    retry: 1,
  });
  const directory: WriterDirectory = { names: query.data?.writers ?? null, me: query.data?.me ?? null };
  return { ...query, directory };
}
