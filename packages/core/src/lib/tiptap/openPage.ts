/**
 * Opening a Prism page from INSIDE a document (a page mention chip, a sub-page row, a link):
 * a tab in the workspace where there is one; where there is none — the standalone share route
 * `/collab/:id` — a NEW browser tab, never a navigation of this window:
 *   - a share-link viewer gets the share route for the target with the same link
 *     (`sharePageLink`: our own origin's `/collab/<id>` only; the gateway decides access);
 *   - anyone else gets the page's own address (`pageLink`).
 */
import { pageLink } from "../pages/usePageActions";
import { openInNewTab, sharePageLink } from "./prismLinks";

/** Is this editor inside the workspace shell (tabs to open a page in)? */
export const inWorkspace = (): boolean => typeof document !== "undefined" && !!document.getElementById("workspace-document");

export function openPageFromDocument(id: string, openTabHere: () => void): void {
  if (inWorkspace()) openTabHere();
  else openInNewTab(sharePageLink(id) ?? pageLink(id));
}
