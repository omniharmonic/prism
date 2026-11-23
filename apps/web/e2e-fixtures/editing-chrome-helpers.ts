import { expect, type Page } from "@playwright/test";

/** Shared by `editing-chrome.spec.ts` (the rules) and `editing-chrome-shots.spec.ts` (the screenshots). */
export const PHONE = { hasTouch: true, isMobile: true } as const;

/** Select a word of the document: a DOM range inside the editor (what a long-press ends in), until the editor has it. */
export async function selectWord(page: Page, word: string) {
  await expect(async () => {
    await page.evaluate((w) => {
      const root = document.querySelector(".tiptap")!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length);
        const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
        return;
      }
    }, word);
    await expect.poll(() => page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; const { from, to } = e.state.selection; return e.state.doc.textBetween(from, to) as string; }), { timeout: 1000 }).toBe(word);
  }).toPass({ timeout: 10_000 });
}

/**
 * A software keyboard: the visual viewport shrinks to `height` px (the recipe of notion-mobile.spec.ts).
 * `offsetTop` is how far WebKit panned the visible area down the page to show the caret. In the iOS
 * app the page itself does not scroll, so WebKit pans all the way: `offsetTop` = layout height − `height`,
 * and the visible area's bottom edge IS the layout viewport's bottom edge. `KEYBOARD` is that height.
 */
export const KEYBOARD = 480;
export const openKeyboard = (page: Page, { height = KEYBOARD, offsetTop = 0 }: { height?: number; offsetTop?: number } = {}) => page.evaluate(({ height, offsetTop }) => {
  const vv = window.visualViewport!;
  Object.defineProperty(vv, "height", { configurable: true, get: () => height });
  Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => offsetTop });
  vv.dispatchEvent(new Event("resize"));
  vv.dispatchEvent(new Event("scroll"));
}, { height, offsetTop });
/** The keyboard goes away: the visual viewport is the layout viewport again. */
export const closeKeyboard = (page: Page) => page.evaluate(() => {
  const vv = window.visualViewport!;
  Object.defineProperty(vv, "height", { configurable: true, get: () => document.documentElement.clientHeight });
  Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 0 });
  vv.dispatchEvent(new Event("resize"));
  vv.dispatchEvent(new Event("scroll"));
});
/** The visible area in layout coordinates (what `getBoundingClientRect` answers in): top and bottom edge. */
export const visibleArea = (page: Page) => page.evaluate(() => { const vv = window.visualViewport!; return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, width: document.documentElement.clientWidth }; });
/** A box is entirely inside the visible area (above the keyboard, below the panned-away top, inside the width). */
export async function expectInVisibleArea(page: Page, selector: string, what: string) {
  const area = await visibleArea(page);
  const box = await page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
  expect(box.top, `${what}: below the top of the visible area`).toBeGreaterThanOrEqual(area.top - 0.5);
  expect(box.bottom, `${what}: above the keyboard`).toBeLessThanOrEqual(area.bottom + 0.5);
  expect(box.left, `${what}: inside the screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box.right, `${what}: inside the screen`).toBeLessThanOrEqual(area.width + 0.5);
}

/**
 * Everything Prism draws around the text of a page: the chrome row's items, the strips a page used to
 * stack, the keyboard toolbar and the selection bubbles. Each visible one, with its box.
 */
const CHROME = [
  ".document-formatting-entry button", ".document-chrome-status", ".document-formatting-commands", ".document-page-status",
  ".page-discussion", ".backlinks-pill", ".prism-suggestion-review", ".prism-suggest-banner",
  ".keyboard-toolbar", ".cd-bubble", ".document-selection-actions",
];
export type Box = { name: string; left: number; top: number; right: number; bottom: number };
export async function measureChrome(page: Page) {
  return page.evaluate((selectors) => {
    const seen = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const box = (name: string, r: DOMRect) => ({ name, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const found: { el: Element; box: ReturnType<typeof box> }[] = [];
    for (const selector of selectors) for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!seen(el)) continue;
      const label = el.getAttribute("aria-label") || (el.textContent ?? "").trim().slice(0, 28);
      found.push({ el, box: box(`${selector} "${label}"`, el.getBoundingClientRect()) });
    }
    const hits = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const overlaps: string[] = [];
    for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
      const a = found[i]!, b = found[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (hits(a.box, b.box)) overlaps.push(`${a.box.name} × ${b.box.name}`);
    }
    // The caret or the selected text: no chrome may cover it.
    const sel = getSelection();
    const editor = document.querySelector(".tiptap");
    const covered: string[] = [];
    let text: ReturnType<typeof box> | null = null;
    if (sel && sel.rangeCount && editor?.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const whole = range.getBoundingClientRect();
      const rect = whole.height ? whole : r;
      if (rect && rect.height) {
        text = box("selection", rect as DOMRect);
        for (const f of found) if (hits(f.box, { ...text, right: Math.max(text.right, text.left + 2) })) covered.push(f.box.name);
      }
    }
    // The page's ONE row: every item of it shares a line.
    const entry = Array.from(document.querySelectorAll(".document-formatting-entry")).filter(seen);
    const row = entry[0] ? entry[0].getBoundingClientRect() : null;
    const items = entry[0] ? Array.from(entry[0].querySelectorAll("button, .document-chrome-status")).filter(seen).map((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      // What is DRAWN in the item: its icons and its text, each with the middle of its box.
      const drawn: number[] = Array.from(el.querySelectorAll("svg")).filter(seen).map((svg) => { const b = svg.getBoundingClientRect(); return b.top + b.height / 2; });
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (!t.textContent?.trim() || t.parentElement!.getBoundingClientRect().width <= 2) continue; // not the 1 px visually-hidden names
        const range = document.createRange(); range.selectNodeContents(t);
        const b = range.getBoundingClientRect();
        drawn.push(b.top + b.height / 2);
      }
      const border = ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && !/rgba\(.*, 0\)|transparent/.test(style.getPropertyValue(`border-${side.toLowerCase()}-color`)));
      return { name: el.getAttribute("aria-label") || (el.textContent ?? "").trim(), width: r.width, height: r.height, middle: r.top + r.height / 2, left: r.left, right: r.right, button: el.tagName === "BUTTON", drawn, border, fontSize: style.fontSize, background: style.backgroundColor };
    }) : [];
    return {
      boxes: found.map((f) => f.box), overlaps, covered, selection: text,
      rows: entry.length, row: row && { top: row.top, bottom: row.bottom, left: row.left, right: row.right, height: row.height }, items,
      viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    };
  }, CHROME);
}

/** Prism's own formatting surfaces that are on screen: the keyboard toolbar, the selection bubbles, the Formatting commands. */
export const formattingSurfaces = (page: Page) => page.locator(".keyboard-toolbar:visible, .cd-bubble:visible, .document-selection-actions:visible, .document-formatting-commands:visible");

/** One row above the body: one line, inside the screen, nothing overlapping, every button a touch target. */
export async function expectOneRow(page: Page, names: (string | RegExp)[]) {
  const m = await measureChrome(page);
  expect(m.rows, "one chrome row").toBe(1);
  expect(m.scroll, "no sideways scroll").toBeLessThanOrEqual(m.viewport);
  expect(m.row!.height, "one line").toBeLessThanOrEqual(56);
  expect(m.overlaps, "chrome overlapping chrome").toEqual([]);
  const middle = m.row!.top + m.row!.height / 2;
  for (const item of m.items) {
    expect(Math.abs(item.middle - middle), `${item.name}: on the row's line`).toBeLessThanOrEqual(2);
    expect(item.left, `${item.name}: inside the row`).toBeGreaterThanOrEqual(m.row!.left - 1);
    expect(item.right, `${item.name}: inside the row`).toBeLessThanOrEqual(m.row!.right + 1);
    if (item.button) { expect(item.width, `${item.name}: 44 px wide`).toBeGreaterThanOrEqual(44); expect(item.height, `${item.name}: 44 px tall`).toBeGreaterThanOrEqual(44); }
  }
  // Polish round 3: ONE control height, ONE optical line, ONE type size, no item heavier than its
  // neighbours (the mode button was a 44 px bordered box between bare icons).
  const buttons = m.items.filter((i) => i.button);
  for (const item of buttons) {
    expect(item.height, `${item.name}: the row's one control height`).toBeCloseTo(buttons[0]!.height, 0);
    expect(item.border, `${item.name}: no box of its own`).toBe(false);
  }
  for (const item of m.items) {
    expect(item.fontSize, `${item.name}: the row's one type size`).toBe(m.items[0]!.fontSize);
    for (const y of item.drawn) expect(Math.abs(y - middle), `${item.name}: icon and text on the row's centre line`).toBeLessThanOrEqual(1.5);
  }
  const got = m.items.map((i) => i.name);
  expect(got.length, `row items: ${got.join(" | ")}`).toBe(names.length);
  names.forEach((name, i) => (typeof name === "string" ? expect(got[i]).toBe(name) : expect(got[i]).toMatch(name)));
  return m;
}
