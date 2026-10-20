/**
 * Find-in-page plumbing shared by the plain and live editors.
 *  - ⌘F / Ctrl+F: find.  ⌘⌥F / Ctrl+Alt+F: find + replace (⌘⇧H is highlight, NP-ED-05).
 *  - `FIND_IN_PAGE_EVENT` on `window`: open the find bar of the editor on screen
 *    (the phone ⋯ sheet has no keyboard, NP-ED-22).
 */
export const FIND_IN_PAGE_EVENT = "prism:find-in-page";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const REPLACE_SHORTCUT_LABEL = isMac ? "⌘⌥F" : "Ctrl+Alt+F";

/** ⌘⌥F / Ctrl+Alt+F. Uses `code`: on macOS Option changes `key` (⌥F types "ƒ"). */
export function isReplaceShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && (e.code === "KeyF" || e.key.toLowerCase() === "f");
}

/** Ask the editor on screen to open its find bar. */
export function requestFindInPage(): void {
  window.dispatchEvent(new CustomEvent(FIND_IN_PAGE_EVENT));
}

/**
 * Which editor answers a find request: it must be on screen (kept-alive tabs leave
 * hidden editors mounted), and when focus sits in ANOTHER editor (a row peek over
 * the page, two live documents side by side) that one answers instead.
 *
 * Contract for shells: `window.dispatchEvent(new CustomEvent("prism:find-in-page"))`
 * (or `requestFindInPage()`) opens the find bar of the focused editor, else of the
 * editor on screen. No detail, no response.
 */
export function editorIsOnScreen(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const focusedEditor = active?.closest?.(".tiptap") ?? null;
  if (focusedEditor && !el.contains(focusedEditor) && focusedEditor !== el) return false;
  // With several on screen and none focused, the top-most layer (a peek) wins.
  if (!focusedEditor && !el.closest(".db-peek") && document.querySelector(".db-peek .tiptap")) return false;
  return true;
}
