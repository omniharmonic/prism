/**
 * NP-AX-08 — a key press that belongs to an IME composition is the input method's, not the app's.
 *
 * While a composition is in progress the browser still fires `keydown` for Enter (commit), arrows
 * (candidate list), Tab and Escape. Dozens of handlers act on those keys (send a message, submit a
 * comment, pick a slash/mention/⌘K row, commit a title, create a row). Rather than rely on each one
 * remembering `isComposing`, the event is stopped in the capture phase at the window, before React's
 * root listener and before any other listener (ProseMirror ignores composing keys itself).
 *
 * `isComposing` covers Chromium and Firefox. Safari fires the committing Enter AFTER `compositionend`,
 * with `isComposing: false` and `keyCode: 229` — hence the second test. Other 229 keys (Android soft
 * keyboards report every key that way) are left alone.
 *
 * Only propagation is stopped: the browser's own handling of the key is untouched.
 */
let installed = false;

export function isImeKey(e: { isComposing?: boolean; keyCode?: number; key?: string }): boolean {
  return !!e.isComposing || (e.keyCode === 229 && (e.key === "Enter" || e.key === "Process"));
}

export function installImeKeyGuard(target: Window | undefined = typeof window === "undefined" ? undefined : window): void {
  if (installed || !target) return;
  installed = true;
  // On `window`, first in line (this module is imported with the shell, before any component mounts):
  // several menus listen on window/document in the capture phase themselves.
  const guard = (e: KeyboardEvent) => { if (isImeKey(e)) e.stopImmediatePropagation(); };
  // keydown only: ProseMirror clears its Shift flag on the Shift KEYUP — swallowing a keyup during a
  // composition would leave it stuck (the next paste would be treated as plain text). No handler in
  // the app acts on keyup.
  target.addEventListener("keydown", guard, true);
}
