/**
 * "Open in new tab" (NP-SB-07 / NP-PG-07 / NP-SR-01 ⌘↵): the page opens as a tab
 * behind the one being read, with a toast that can switch to it. A page that is
 * already open is simply named in the toast.
 */
import { useUIStore } from "../../app/stores/ui";
import { usePagesUI } from "./store";
import type { ContentType } from "../types";

export function openInNewTab(noteId: string, title: string, type: ContentType): void {
  const ui = useUIStore.getState();
  const had = ui.openTabs.some((t) => t.noteId === noteId);
  const hadCurrent = !!ui.activeTabId;
  ui.openTabInBackground(noteId, title, type);
  if (!hadCurrent) return;
  if (ui.openTabs.find((t) => t.id === ui.activeTabId)?.noteId === noteId) return;
  usePagesUI.getState().showToast({
    message: had ? `“${title}” is already open in a tab` : `Opened “${title}” in a new tab`,
    action: { label: "Go to tab", run: () => useUIStore.getState().openTab(noteId, title, type) },
  });
}
