/**
 * Tab inside ONE widget, handled by the widget.
 *
 * Safari's default is that Tab stops only at text fields and lists: buttons and links are
 * skipped unless the person turned on "Press Tab to highlight each item on a webpage" (or uses
 * Option+Tab). A widget whose own flow is "Tab to the next control" — the link card's
 * Open → Edit → Remove, a table's next cell — therefore cannot rely on the browser's Tab.
 *
 * `walkTab` moves focus to the next / previous stop INSIDE `root`, in document order (the
 * order native Tab uses when no positive tabindex is set), and reports whether it did. At
 * either end it does nothing and returns false: the key is left to the browser, so Tab
 * leaves the widget as it always did (never a trap). It is called from the widget's own
 * keydown handler — nothing listens globally.
 */

const STOPS = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

function isStop(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;
  if (el.closest("[inert], [hidden]")) return false;
  // Not rendered (display: none anywhere above) or collapsed away.
  if (!el.getClientRects().length) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/** The next (or, with `back`, previous) Tab stop inside `root` after `from`; null at the end. */
export function nextTabStop(root: HTMLElement, from: Element, back = false): HTMLElement | null {
  const all = Array.from(root.querySelectorAll<HTMLElement>(STOPS));
  let at = all.indexOf(from as HTMLElement);
  if (at === -1) {
    // Focus is on something that is not a stop itself (e.g. inside one): start from its position.
    at = all.findIndex((el) => !!(from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (at === -1) at = all.length;
    if (!back) at -= 1;
  }
  for (let i = at + (back ? -1 : 1); i >= 0 && i < all.length; i += back ? -1 : 1) {
    const el = all[i]!;
    if (isStop(el)) return el;
  }
  return null;
}

interface TabKey { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; defaultPrevented: boolean; preventDefault(): void }

/**
 * Handle a plain Tab / Shift+Tab keydown inside `root`. Returns true when focus moved to another
 * stop of the widget (the event is then consumed); false when the key is not a plain Tab, focus is
 * not inside `root`, or there is no further stop in that direction (the browser takes the key).
 */
export function walkTab(e: TabKey, root: HTMLElement | null): boolean {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || !root) return false;
  const from = root.ownerDocument.activeElement;
  if (!from || from === root || !root.contains(from)) return false;
  const next = nextTabStop(root, from, e.shiftKey);
  if (!next) return false;
  e.preventDefault();
  next.focus();
  return true;
}
