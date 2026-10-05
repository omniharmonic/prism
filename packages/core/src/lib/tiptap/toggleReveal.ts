/**
 * Showing something that sits inside a CLOSED toggle (NP-ED-08). A toggle's open
 * state is view state (never in the document), so anything that takes the reader
 * to a place in the page — find, a comment / mention / reminder anchor, the outline,
 * "follow" a collaborator — opens the toggles around it first. DOM only: no editor
 * transaction, and the reveal is not remembered (the toggle is closed again on the
 * next open of the page, as the person left it).
 */
export const TOGGLE_REVEAL_EVENT = "prism:toggle-reveal";

/** Open every closed toggle around `target`. Returns how many were opened. */
export function revealInToggles(target: Element | null | undefined): number {
  let opened = 0;
  if (!target || typeof CustomEvent === "undefined") return opened;
  for (let el: Element | null = target.closest?.('.prism-toggle[data-open="false"]') ?? null; el; el = el.parentElement?.closest('.prism-toggle[data-open="false"]') ?? null) {
    // The summary line is always visible: a target inside it needs nothing opened.
    const body = el.querySelector(":scope > .prism-toggle-body");
    const summary = body?.querySelector(":scope > summary");
    if (summary && summary.contains(target)) continue;
    el.dispatchEvent(new CustomEvent(TOGGLE_REVEAL_EVENT));
    opened++;
  }
  return opened;
}
