/**
 * Copy the open page's link from the keyboard (⌘L) and the command palette — the same link and
 * the same words as the page menu's "Copy link" (`usePageActions.copyLink`).
 */
import { isVaultNoteId } from "../noteIdentity";
import { usePagesUI } from "./store";
import { pageLink } from "./pageLink";

/** A tab that shows a vault page (not Home, Inbox, a dashboard, a tag view …). */
export const isPageTab = (noteId: string | null | undefined): noteId is string => isVaultNoteId(noteId);

export async function copyPageLink(noteId: string): Promise<boolean> {
  const link = pageLink(noteId);
  const toast = usePagesUI.getState().showToast;
  try {
    await navigator.clipboard.writeText(link);
    toast({ message: "Link copied" });
    return true;
  } catch {
    toast({ message: `Copy this link: ${link}` });
    return false;
  }
}
