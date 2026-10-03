/**
 * "Find in page" from outside the editor (the phone page sheet, a command).
 *
 * CONTRACT (shared with the editor group — integration note): a window
 * `CustomEvent("prism:find-in-page", { detail: { noteId?: string } })`.
 * The editor showing that page (plain or live) opens its own find bar and
 * focuses it; an editor for another page, or one embedded outside the workspace
 * document, ignores the event. The editor branch's `requestFindInPage()` should
 * dispatch (or be replaced by) exactly this event when it merges, so there stays
 * ONE "Find in page" entry point and no synthetic key presses.
 */
export const FIND_IN_PAGE_EVENT = "prism:find-in-page";

export interface FindInPageDetail { noteId?: string }

export function requestFindInPage(noteId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FindInPageDetail>(FIND_IN_PAGE_EVENT, { detail: noteId ? { noteId } : {} }));
}

/** Subscribe an editor. `accepts(detail)` decides whether this editor is the page meant. */
export function onFindInPage(accepts: (detail: FindInPageDetail) => boolean, open: () => void): () => void {
  const handler = (event: Event) => {
    const detail = ((event as CustomEvent<FindInPageDetail>).detail ?? {}) as FindInPageDetail;
    if (accepts(detail)) open();
  };
  window.addEventListener(FIND_IN_PAGE_EVENT, handler);
  return () => window.removeEventListener(FIND_IN_PAGE_EVENT, handler);
}
