import { useQuery } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import type { Note } from "../types";
import { useScope } from "../database/hooks";
import { parseEmailContent, type EmailMessage } from "./emailThread";

/** One message of a conversation, with the saved note it came from. */
export interface ThreadMessage extends EmailMessage {
  noteId: string;
  /** The message that is open: the one a reply answers. */
  current: boolean;
}

/** Enough to read a whole conversation; a longer one shows its most recent messages. */
const THREAD_MAX = 40;
const when = (note: Pick<Note, "metadata" | "createdAt">): number => {
  const at = Date.parse(String(note.metadata?.date ?? ""));
  return Number.isNaN(at) ? Date.parse(note.createdAt) || 0 : at;
};

/**
 * The whole conversation an imported email belongs to, oldest first.
 *
 * The mail importer saves one note per message and stamps each with the conversation's `threadId`,
 * but nothing read the other notes: an opened email showed that one message alone. This reads the
 * notes that share the id (the same permission-filtered query as a database view, so a message the
 * viewer cannot see is simply not there) and their bodies. `null` = no other message, not asked
 * for, or not readable here — the caller shows the open message as before.
 */
export function useEmailThread(note: Pick<Note, "id" | "content" | "metadata" | "createdAt">, threadId: string, enabled: boolean): ThreadMessage[] | null {
  const client = useVaultClient();
  const scope = useScope();
  const wanted = enabled && !!threadId && !!client.queryNotes;
  const { data } = useQuery({
    // Under ["vault","notes"]: a newly synced message refreshes the conversation like any list.
    queryKey: ["vault", "notes", { emailThread: scope, threadId }],
    enabled: wanted,
    staleTime: 30_000,
    queryFn: async (): Promise<Array<Pick<Note, "id" | "content" | "metadata" | "createdAt">>> => {
      const page = await client.queryNotes!({ tags: ["email"], filter: { match: "all", conditions: [{ key: "threadId", op: "eq", value: threadId }] }, fields: ["threadId", "date"], sort: [{ key: "date", dir: "desc" }], limit: THREAD_MAX });
      // The filter compares leniently (case, brackets); the conversation is the exact id.
      const ids = page.rows.filter((row) => row.metadata.threadId === threadId).map((row) => row.id);
      const notes = await Promise.all(ids.map((id) => client.getNote(id).catch(() => null)));
      return notes.filter((n): n is Note => !!n);
    },
  });
  if (!wanted || !data) return null;
  // The open note is always part of it, in its current state (it may be newer than the listing).
  const notes = [...data.filter((n) => n.id !== note.id), note];
  if (notes.length < 2) return null;
  return notes
    .sort((a, b) => when(a) - when(b))
    .flatMap((n) => {
      const meta = n.metadata ?? {};
      return parseEmailContent(n.content ?? "", String(meta.from ?? ""), String(meta.date ?? ""), typeof meta.source === "string" ? meta.source : undefined)
        .map((message) => ({ ...message, noteId: n.id, current: n.id === note.id }));
    });
}
