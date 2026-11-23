/**
 * Where a caret popup (the `[[` list, the `@` menu) has room.
 *
 * With nothing covering the page this is the layout viewport, as before. On a phone with the
 * keyboard up it is the VISUAL viewport (which WebKit also pans: `offsetTop`) minus the bottom
 * chrome — the keyboard toolbar / bottom bar — so a list no longer opens behind the keys. Same
 * rule as the slash menu's `slashPlacement`.
 */
export function caretPopupPlacement(coords: { top: number; bottom: number }, wanted: number): { top: number; maxHeight: number } {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const layoutBottom = window.innerHeight;
  const viewTop = vv?.offsetTop ?? 0;
  let viewBottom = viewTop + (vv?.height ?? layoutBottom);
  for (const sel of [".keyboard-toolbar", ".prism-mobile-navigation:not([hidden])"]) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.height > 0 && r.top > coords.bottom && r.top < viewBottom) viewBottom = r.top;
  }
  // Nothing in the way: exactly the placement these lists always had.
  if (viewTop <= 0 && viewBottom >= layoutBottom - 1) {
    const height = Math.min(wanted, layoutBottom - 16);
    return { top: coords.bottom + height + 6 > layoutBottom ? Math.max(8, coords.top - height - 6) : coords.bottom + 6, maxHeight: height };
  }
  const below = viewBottom - coords.bottom - 12;
  const above = coords.top - viewTop - 12;
  if (below >= Math.min(wanted, 140) || below >= above) {
    return { top: coords.bottom + 6, maxHeight: Math.max(96, Math.min(wanted, below)) };
  }
  const maxHeight = Math.max(96, Math.min(wanted, above));
  return { top: Math.max(viewTop + 6, coords.top - 6 - maxHeight), maxHeight };
}
