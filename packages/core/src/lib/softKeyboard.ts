import { useSyncExternalStore } from "react";

/**
 * The software keyboard, measured ONCE for everything that has to sit on it or get out of its way
 * (the phone bottom bar, the keyboard toolbar, the docked composers, the comments drawer).
 *
 * Two facts, deliberately separate — mixing them was the bug behind the toolbar floating mid-screen
 * on the first iPhone run:
 *
 *  - `open`: the visual viewport is more than 120 px SHORTER than the layout viewport, and that began
 *    while a text control had the focus. It stays open until the height comes back — not until the
 *    focus leaves: a tap on a toolbar button or a menu item moves the focus while the keys are still
 *    on screen, and whatever sits on the keyboard must not jump away under that finger. Height only. WebKit does not shrink the layout viewport for the keyboard; it
 *    pans the visual viewport inside it (`offsetTop`) to bring the caret into view, and it pans all
 *    the way down in a page that does not scroll. There `layout height − (offsetTop + height)` is 0
 *    although the keyboard is up, so that difference must never be the test for "is it open".
 *  - `inset`: how far the visual viewport's bottom edge is above the layout viewport's bottom edge
 *    (`layout height − (offsetTop + height)`, 0 when panned all the way down). This is the `bottom`
 *    of a `position: fixed` element that must end where the visible area ends.
 *
 * The root element mirrors it for CSS: `data-soft-keyboard="open"`, `--keyboard-inset` (set only
 * while open), `--visual-viewport-top`, `--visual-viewport-height`.
 */
export interface SoftKeyboard {
  open: boolean;
  /** px from the layout viewport's bottom to the visual viewport's bottom. */
  inset: number;
  /** `visualViewport.offsetTop`: how far the visible area is panned down the layout viewport. */
  top: number;
  /** Height of the visible area. */
  height: number;
}

const CLOSED: SoftKeyboard = { open: false, inset: 0, top: 0, height: 0 };
const TEXT_CONTROL = 'textarea,input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=submit]):not([type=reset]):not([type=file]):not([type=color]),[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';

/** The focused element is something a software keyboard types into. */
export function isTextControl(element: Element | null | undefined): boolean {
  return !!element && element !== document.body && !!(element as HTMLElement).closest?.(TEXT_CONTROL);
}

/** Pure: the keyboard state for one set of measurements (unit-tested through the fixture specs). */
export function measureSoftKeyboard(m: { layoutHeight: number; height: number; offsetTop: number; scale: number; typing: boolean; wasOpen?: boolean }): SoftKeyboard {
  const inset = Math.max(0, Math.round(m.layoutHeight - (m.offsetTop + m.height)));
  // Pinch zoom also shrinks the visual viewport: it is not a keyboard.
  const open = (m.typing || !!m.wasOpen) && Math.abs(m.scale - 1) < 0.05 && m.layoutHeight - m.height > 120;
  return { open, inset, top: Math.max(0, Math.round(m.offsetTop)), height: Math.round(m.height) };
}

let state: SoftKeyboard = CLOSED;
const listeners = new Set<() => void>();
let started = false;

function read(): SoftKeyboard {
  const vv = window.visualViewport;
  if (!vv) return CLOSED;
  // The layout viewport (what `position: fixed` is laid out in), not `innerHeight`: WebKit has
  // reported the visual height there.
  const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
  return measureSoftKeyboard({ layoutHeight, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale ?? 1, typing: isTextControl(document.activeElement), wasOpen: state.open });
}

function update() {
  const next = read();
  if (next.open === state.open && next.inset === state.inset && next.top === state.top && next.height === state.height) return;
  state = next;
  const root = document.documentElement;
  if (next.open) { root.dataset.softKeyboard = "open"; root.style.setProperty("--keyboard-inset", `${next.inset}px`); }
  else { delete root.dataset.softKeyboard; root.style.removeProperty("--keyboard-inset"); }
  root.style.setProperty("--visual-viewport-top", `${next.top}px`);
  if (next.height) root.style.setProperty("--visual-viewport-height", `${next.height}px`);
  for (const listener of listeners) listener();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const vv = window.visualViewport;
  // Focus moves before `activeElement` does in some engines: read it after the event.
  const later = () => queueMicrotask(update);
  vv?.addEventListener("resize", update);
  vv?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  document.addEventListener("focusin", later);
  document.addEventListener("focusout", later);
  update();
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The software keyboard's state; every caller shares one set of listeners. */
export function useSoftKeyboard(): SoftKeyboard {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}
