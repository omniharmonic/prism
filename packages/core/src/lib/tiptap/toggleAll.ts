/**
 * Expand / collapse every toggle of the page on screen (Notion's ⌘⌥T).
 *
 * Open/closed is VIEW state (never a document attribute, never synced): each toggle's node view
 * keeps it and flips on the `prism:toggle-open` DOM event (`editor/blocks.ts`). So this is DOM
 * only — no transaction, no save, nothing a collaborator sees — and it works in read-only,
 * suggest-only and live documents alike.
 */
const TOGGLE = '.prism-toggle[data-type="toggle"]';

/** The editor a page-level command acts on: the focused one, else a row peek's, else the page's. */
export function editorOnScreen(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const focused = document.activeElement?.closest?.<HTMLElement>(".tiptap");
  if (focused) return focused;
  const visible = (el: HTMLElement | null) => (el && el.getClientRects().length ? el : null);
  return visible(document.querySelector<HTMLElement>(".db-peek .tiptap"))
    ?? visible(document.querySelector<HTMLElement>("#workspace-document .tiptap"))
    ?? [...document.querySelectorAll<HTMLElement>(".tiptap")].find((el) => el.getClientRects().length) ?? null;
}

/** How many toggles the editor on screen has, and how many are closed. */
export function toggleState(root: HTMLElement | null = editorOnScreen()): { total: number; closed: number } {
  const all = root ? [...root.querySelectorAll<HTMLElement>(TOGGLE)] : [];
  return { total: all.length, closed: all.filter((t) => t.getAttribute("data-open") === "false").length };
}

/** Open (or close) every toggle, nested ones included. Returns how many changed. */
export function setAllToggles(open: boolean, root: HTMLElement | null = editorOnScreen()): number {
  if (!root) return 0;
  let changed = 0;
  for (const toggle of root.querySelectorAll<HTMLElement>(TOGGLE)) {
    if ((toggle.getAttribute("data-open") !== "false") === open) continue;
    toggle.dispatchEvent(new CustomEvent("prism:toggle-open"));
    changed++;
  }
  return changed;
}

/** ⌘⌥T: any toggle closed → open them all; all open → close them all. False when the page has none. */
export function expandOrCollapseAllToggles(root: HTMLElement | null = editorOnScreen()): boolean {
  const { total, closed } = toggleState(root);
  if (!total) return false;
  setAllToggles(closed > 0, root);
  return true;
}

/** ⌘⌥T / Ctrl+Alt+T. By `code`: on macOS Option changes `key` (⌥T types "†"). */
export function isToggleAllShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && (e.code === "KeyT" || e.key.toLowerCase() === "t");
}

// One listener for every editor host (the workspace, a row peek, the share route). Installed by
// the modules that mount an editor (BlockHandles imports this file).
let installed = false;
export function installToggleAllShortcut(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => {
    if (!isToggleAllShortcut(e) || e.defaultPrevented || e.isComposing) return;
    // A modal owns the interaction; a page without toggles leaves the key alone.
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') && !document.querySelector(".db-peek .tiptap")) return;
    if (expandOrCollapseAllToggles()) e.preventDefault();
  });
}
installToggleAllShortcut();
