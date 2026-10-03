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

/** Kept-alive tabs leave hidden editors mounted; only a visible one answers. */
export function editorIsOnScreen(el: HTMLElement | null): boolean {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}
