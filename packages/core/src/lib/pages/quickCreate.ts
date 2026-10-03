import { useCallback, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import type { VaultClient } from "../../data/VaultClient";
import type { Note, NoteTreeEntry } from "../types";
import { useUIStore } from "../../app/stores/ui";
import { queryKeys } from "../parachute/queries";
import { newContentFolder, newContentParams } from "../../components/navigation/newContent";

/**
 * NP-SB-13 / NP-MB-02: New page in ONE action. Creates "Untitled" next to the
 * page you are on (or in `folder`), opens it and puts the caret in its title —
 * no dialog first. Type and location stay available through "Choose page type".
 * Offline it is a queued create like any other (a local draft that syncs later).
 */
export async function createUntitledPage(client: VaultClient, queryClient: QueryClient, opts: { folder?: string } = {}): Promise<Note> {
  const cached = queryClient.getQueryData<NoteTreeEntry[]>(["vault", "tree"]);
  const tree = cached ?? (await client.listTree().catch(() => [] as NoteTreeEntry[]));
  const ui = useUIStore.getState();
  const activeNoteId = ui.openTabs.find((t) => t.id === ui.activeTabId)?.noteId ?? null;
  const folder = opts.folder ?? newContentFolder(tree, activeNoteId);
  const { title, params } = newContentParams("document", "", folder, tree);
  const note = await client.createNote(params);
  void queryClient.invalidateQueries({ queryKey: ["vault"] });
  // The create's own response IS the page: seed it so the title is on screen (and
  // focused) without waiting for a second round trip to read it back (< 300 ms).
  if (note && typeof note.id === "string") queryClient.setQueryData(queryKeys.vault.note(note.id), note);
  // NP-PG-15: an open parent page adds a sub-page row for it (lib/tiptap/childPage.tsx listens).
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("prism:page-created", { detail: { id: note.id, parentPath: folder } }));
  useUIStore.getState().openTab(note.id, title, "document");
  focusPageTitle(title);
  return note;
}

/** Put the new page's title into edit mode as soon as its header exists (≤ 4 s). */
export function focusPageTitle(title: string): void {
  const deadline = Date.now() + 4000;
  const attempt = () => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("#workspace-document h1 button[aria-label]"))
      .find((b) => b.getAttribute("aria-label") === `Rename ${title}`);
    if (button) { button.click(); return; }
    if (Date.now() < deadline) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** One-action create for a button. A double activation creates ONE page; a
 *  failure hands over to `onFail` (the title-first dialog), never a dead click. */
export function useQuickCreatePage(onFail: () => void): { create: (folder?: string) => void; pending: boolean } {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const create = useCallback((folder?: string) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    createUntitledPage(client, queryClient, folder === undefined ? {} : { folder })
      .catch(() => onFail())
      .finally(() => { lock.current = false; setPending(false); });
  }, [client, queryClient, onFail]);
  return { create, pending };
}
