import { type Page } from "@playwright/test";
import { test, expect } from "./browser-compat";

/**
 * NP-ED-26 — block selection with the mouse, plain editor and live (Yjs) editor.
 * Real pointer events (Playwright's mouse). Fixture: editor-select.html (six paragraphs "One"…"Six";
 * `?live` = two CollabEditors on one document, `?viewer` = client B read-only; `?readonly` = plain read-only).
 */
type Box = { x: number; y: number; w: number; h: number; right: number; bottom: number };
const api = <T,>(page: Page, fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => (window as any).prismSelect[fn](...args), { fn, args }) as Promise<T>;
const blocks = (page: Page, i = 0) => api<number[]>(page, "blocks", i);
const texts = async (page: Page, i = 0) => (await api<string[]>(page, "texts", i)).map((t) => t.split(" ")[0]);
const rect = (page: Page, n: number, i = 0) => api<Box>(page, "rect", i, n);
const column = (page: Page, i = 0) => api<Box>(page, "column", i);
const selectedDom = (page: Page, i = 0) => page.locator(".tiptap").nth(i).locator("> .prism-block-selected, > .ProseMirror-selectednode");
const live = (page: Page) => page.locator("[data-block-selection-live]");
const mid = (b: Box) => b.y + b.h / 2;

async function open(page: Page, query = "") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/e2e-fixtures/editor-select.html${query ? `?${query}` : ""}`);
  await expect(page.locator(".tiptap").first()).toContainText("Six paragraph");
  if (query.includes("live")) await expect(page.locator(".tiptap").nth(1)).toContainText("Six paragraph");
}
/** A point in the page margin beside the editor: the left gutter (plain) or the gap right of client A (live). */
async function gutterX(page: Page, mode: string, i = 0) {
  const col = await column(page, i);
  return mode === "plain" ? col.x - 140 : col.right + 40;
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, release = true) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  if (release) await page.mouse.up();
}
/** Marquee from the margin beside block `a` to inside block `b`. */
async function marquee(page: Page, mode: string, a: number, b: number, i = 0) {
  const x = await gutterX(page, mode, i);
  const col = await column(page, i);
  await drag(page, { x, y: mid(await rect(page, a, i)) }, { x: col.x + col.w / 2, y: mid(await rect(page, b, i)) });
}
/** A real click with modifier keys held (page.mouse.click takes no modifiers). */
async function modClick(page: Page, x: number, y: number, keys: string[]) {
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.click(x, y);
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
}
async function copyFrom(page: Page, selector: string, type: "copy" | "cut" = "copy") {
  return page.evaluate(({ selector, type }) => {
    const dt = new DataTransfer();
    const target = selector === "body" ? document.body : document.querySelector(selector)!;
    const event = new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return { html: dt.getData("text/html"), text: dt.getData("text/plain"), handled: event.defaultPrevented };
  }, { selector, type });
}

for (const mode of ["plain", "live"]) {
  const q = mode === "live" ? "live" : "";
  test.describe(`mouse block selection — ${mode} editor`, () => {
    test("a marquee from the margin selects the blocks it crosses, announces them, and a click on empty space clears", async ({ page }) => {
      await open(page, q);
      await marquee(page, mode, 1, 3);
      await expect.poll(() => blocks(page)).toEqual([1, 2, 3]);
      await expect(selectedDom(page)).toHaveCount(3);
      await expect(page.locator(".prism-block-marquee")).toHaveCount(0);
      await expect(live(page)).toHaveText("3 blocks selected");
      await expect(live(page)).toHaveAttribute("aria-live", "polite");
      // The rectangle is on screen while the button is down.
      const x = await gutterX(page, mode);
      const col = await column(page);
      await drag(page, { x, y: mid(await rect(page, 4)) }, { x: col.x + 80, y: mid(await rect(page, 5)) }, false);
      await expect(page.locator(".prism-block-marquee")).toBeVisible();
      await expect.poll(() => blocks(page)).toEqual([4, 5]);
      await page.mouse.up();
      await expect(page.locator(".prism-block-marquee")).toHaveCount(0);
      await expect.poll(() => blocks(page)).toEqual([4, 5]);
      // A click (no drag) in the margin clears.
      await page.mouse.click(x, mid(await rect(page, 0)));
      await expect.poll(() => blocks(page)).toEqual([]);
      await expect(selectedDom(page)).toHaveCount(0);
    });

    test("a marquee that starts below the last block selects upwards", async ({ page }) => {
      await open(page, q);
      const col = await column(page);
      const last = await rect(page, 5);
      await drag(page, { x: col.x + col.w / 2, y: Math.min(last.bottom + 120, 880) }, { x: col.x + 60, y: mid(await rect(page, 4)) });
      await expect.poll(() => blocks(page)).toEqual([4, 5]);
      expect((await api<{ from: number; to: number }>(page, "run"))).toMatchObject({ from: 4, to: 5 });
    });

    test("a text drag that leaves its block becomes a block selection without flicker, and a text selection again when it returns", async ({ page }) => {
      await open(page, q);
      await api(page, "watch", 0);
      const b1 = await rect(page, 1);
      const b3 = await rect(page, 3);
      await page.mouse.move(b1.x + 40, mid(b1));
      await page.mouse.down();
      await page.mouse.move(b1.x + 160, mid(b1), { steps: 5 });
      await expect.poll(() => page.evaluate(() => (window as any).prismSelect.editor(0).state.selection.empty)).toBe(false);
      expect(await blocks(page)).toEqual([]);
      await page.mouse.move(b3.x + 90, mid(b3), { steps: 12 });
      await expect.poll(() => blocks(page)).toEqual([1, 2, 3]);
      await page.mouse.move(b3.x + 200, mid(b3) + 4, { steps: 8 });
      await page.waitForTimeout(150);
      expect(await blocks(page)).toEqual([1, 2, 3]);
      // Once blocks were selected, no transaction left the page with none until the pointer came home.
      const log = await api<number[]>(page, "log", 0);
      const firstBlocks = log.findIndex((n) => n > 0);
      expect(firstBlocks).toBeGreaterThanOrEqual(0);
      expect(log.slice(firstBlocks)).not.toContain(0);
      // Back inside the first block: text again.
      await page.mouse.move(b1.x + 120, mid(b1), { steps: 12 });
      await expect.poll(() => blocks(page)).toEqual([]);
      const sel = await page.evaluate(() => { const s = (window as any).prismSelect.editor(0).state.selection; return { empty: s.empty, text: s.$from.parent.textContent.split(" ")[0], same: s.$from.sameParent(s.$to) }; });
      expect(sel).toEqual({ empty: false, text: "Two", same: true });
      // Out again and release: the blocks stay selected after the browser's own selection events settle.
      const b2 = await rect(page, 2);
      await page.mouse.move(b2.x + 90, mid(b2), { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(250);
      expect(await blocks(page)).toEqual([1, 2]);
      await expect(selectedDom(page)).toHaveCount(2);
      // …and the keyboard acts on them.
      await page.keyboard.press("Backspace");
      await expect.poll(() => texts(page)).toEqual(["One", "Four", "Five", "Six"]);
      if (mode === "live") await expect.poll(() => texts(page, 1)).toEqual(["One", "Four", "Five", "Six"]);
    });

    test("Shift+click extends the block selection; ⌘⇧click adds and removes single blocks", async ({ page }) => {
      await open(page, q);
      await marquee(page, mode, 0, 1);
      await expect.poll(() => blocks(page)).toEqual([0, 1]);
      const b3 = await rect(page, 3);
      await modClick(page, b3.x + 80, mid(b3), ["Shift"]);
      await expect.poll(() => blocks(page)).toEqual([0, 1, 2, 3]);
      const b2 = await rect(page, 2);
      await modClick(page, b2.x + 80, mid(b2), ["ControlOrMeta", "Shift"]);
      await expect.poll(() => blocks(page)).toEqual([0, 1, 3]);
      const b5 = await rect(page, 5);
      await modClick(page, b5.x + 80, mid(b5), ["ControlOrMeta", "Shift"]);
      await expect.poll(() => blocks(page)).toEqual([0, 1, 3, 5]);
      await expect(selectedDom(page)).toHaveCount(4);
      await expect(live(page)).toHaveText("4 blocks selected");
      // The keyboard run is the block clicked last; the others are the added blocks.
      expect(await api(page, "run")).toMatchObject({ from: 5, to: 5 });
      expect(await api(page, "extra")).toEqual([0, 1, 3]);
      // Without a block selection, Shift+click is the browser's text selection.
      await page.keyboard.press("Escape");
      await expect.poll(() => blocks(page)).toEqual([]);
      const b0 = await rect(page, 0);
      await page.mouse.click(b0.x + 20, mid(b0));
      await modClick(page, b0.x + 120, mid(b0), ["Shift"]);
      await expect.poll(() => page.evaluate(() => { const e = (window as any).prismSelect.editor(0); const s = e.state.selection; return e.state.doc.textBetween(s.from, s.to).length; })).toBeGreaterThan(3);
      expect(await blocks(page)).toEqual([]);
    });

    test("⌘-click on a block's handle adds that block to the selection", async ({ page }) => {
      await open(page, q);
      await marquee(page, mode, 0, 0);
      await expect.poll(() => blocks(page)).toEqual([0]);
      const b3 = await rect(page, 3);
      await page.mouse.move(b3.x + 60, mid(b3));
      const grip = page.locator(".block-gutter[data-block-index='3'] .block-gutter-grip");
      await expect(grip).toBeVisible();
      await grip.click({ modifiers: ["ControlOrMeta"] });
      await expect.poll(() => blocks(page)).toEqual([0, 3]);
      await expect(page.getByRole("menu")).toHaveCount(0);
    });

    test("⌘A selects the block's text, then the block, then every block", async ({ page }) => {
      await open(page, q);
      const b1 = await rect(page, 1);
      await page.mouse.click(b1.x + 50, mid(b1));
      await page.keyboard.press("ControlOrMeta+a");
      const first = await page.evaluate(() => { const e = (window as any).prismSelect.editor(0); const s = e.state.selection; return e.state.doc.textBetween(s.from, s.to); });
      expect(first).toBe("Two paragraph with some words in it.");
      expect(await blocks(page)).toEqual([]);
      await page.keyboard.press("ControlOrMeta+a");
      await expect.poll(() => blocks(page)).toEqual([1]);
      await page.keyboard.press("ControlOrMeta+a");
      await expect.poll(() => blocks(page)).toEqual([0, 1, 2, 3, 4, 5]);
      await page.keyboard.press("ControlOrMeta+a");
      expect(await blocks(page)).toEqual([0, 1, 2, 3, 4, 5]);
      // Esc clears; typing with blocks selected replaces them; Enter returns to the text.
      await page.keyboard.press("Escape");
      await expect.poll(() => blocks(page)).toEqual([]);
      expect(await texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
      await marquee(page, mode, 4, 5);
      await expect.poll(() => blocks(page)).toEqual([4, 5]);
      await page.keyboard.press("Enter");
      await expect.poll(() => blocks(page)).toEqual([]);
      expect(await texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
      await marquee(page, mode, 4, 5);
      await expect.poll(() => blocks(page)).toEqual([4, 5]);
      await page.keyboard.type("New");
      await expect.poll(() => texts(page)).toEqual(["One", "Two", "Three", "Four", "New"]);
    });

    test("Delete, ⌘D and copy act on a mouse-made selection — also when it is not contiguous", async ({ page }) => {
      await open(page, q);
      // Contiguous: the keyboard block selection's own commands.
      await marquee(page, mode, 1, 2);
      await expect.poll(() => blocks(page)).toEqual([1, 2]);
      const run = await copyFrom(page, ".tiptap");
      expect(run.html).toContain("Two paragraph");
      expect(run.html).toContain("Three paragraph");
      expect(run.html).not.toContain("Four paragraph");
      expect(run.text).toBe("Two paragraph with some words in it.\n\nThree paragraph with some words in it.");
      await page.keyboard.press("ControlOrMeta+d");
      await expect.poll(() => texts(page)).toEqual(["One", "Two", "Three", "Two", "Three", "Four", "Five", "Six"]);
      // The peer gets each change exactly once.
      if (mode === "live") await expect.poll(() => texts(page, 1)).toEqual(["One", "Two", "Three", "Two", "Three", "Four", "Five", "Six"]);
      await expect.poll(() => blocks(page)).toEqual([3, 4]);
      await page.keyboard.press("Delete");
      await expect.poll(() => texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
      if (mode === "live") await expect.poll(() => texts(page, 1)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
      // Not contiguous: One + Three + Five.
      await marquee(page, mode, 0, 0);
      for (const n of [2, 4]) { const b = await rect(page, n); await modClick(page, b.x + 80, mid(b), ["ControlOrMeta", "Shift"]); }
      await expect.poll(() => blocks(page)).toEqual([0, 2, 4]);
      const set = await copyFrom(page, ".tiptap");
      expect(set.handled).toBe(true);
      expect(set.text).toBe(["One", "Three", "Five"].map((w) => `${w} paragraph with some words in it.`).join("\n\n"));
      expect(set.html).not.toContain("Two paragraph");
      await page.keyboard.press("ControlOrMeta+d");
      await expect.poll(() => texts(page)).toEqual(["One", "One", "Two", "Three", "Three", "Four", "Five", "Five", "Six"]);
      if (mode === "live") await expect.poll(() => texts(page, 1)).toEqual(["One", "One", "Two", "Three", "Three", "Four", "Five", "Five", "Six"]);
      await expect.poll(() => blocks(page)).toEqual([1, 4, 7]);
      await page.keyboard.press("Backspace");
      await expect.poll(() => texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
      if (mode === "live") await expect.poll(() => texts(page, 1)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
      // Typing over a set replaces every block of it.
      await marquee(page, mode, 1, 1);
      { const b = await rect(page, 3); await modClick(page, b.x + 80, mid(b), ["ControlOrMeta", "Shift"]); }
      await expect.poll(() => blocks(page)).toEqual([1, 3]);
      await page.keyboard.type("Z");
      await expect.poll(() => texts(page)).toEqual(["One", "Z", "Three", "Five", "Six"]);
      if (mode === "live") await expect.poll(() => texts(page, 1)).toEqual(["One", "Z", "Three", "Five", "Six"]);
    });

    test("dragging a selected block's handle moves the whole mouse-made run", async ({ page }) => {
      await open(page, q);
      await marquee(page, mode, 1, 2);
      await expect.poll(() => blocks(page)).toEqual([1, 2]);
      const b1 = await rect(page, 1);
      await page.mouse.move(b1.x + 60, mid(b1));
      const grip = page.locator(".block-gutter[data-block-index='1'] .block-gutter-grip");
      await expect(grip).toBeVisible();
      const b5 = await rect(page, 5);
      await grip.dragTo(page.getByText("Six paragraph with some words in it.", { exact: true }).first(), { targetPosition: { x: 4, y: Math.max(2, b5.h - 3) } });
      await expect.poll(() => texts(page)).toEqual(["One", "Four", "Five", "Six", "Two", "Three"]);
      if (mode === "live") await expect.poll(() => texts(page, 1)).toEqual(["One", "Four", "Five", "Six", "Two", "Three"]);
    });
  });
}

test.describe("mouse block selection — read-only and shared views", () => {
  test("read-only page: blocks can be selected and copied, never deleted or moved; Esc clears", async ({ page }) => {
    await open(page, "readonly");
    await marquee(page, "plain", 1, 3);
    await expect.poll(() => blocks(page)).toEqual([1, 2, 3]);
    await expect(selectedDom(page)).toHaveCount(3);
    for (const key of ["Backspace", "Delete", "ControlOrMeta+d", "x"]) await page.keyboard.press(key);
    expect(await texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
    expect(await blocks(page)).toEqual([1, 2, 3]);
    // The browser holds the same selection (so ⌘C and the context menu copy it)…
    await expect.poll(() => page.evaluate(() => String(getSelection()))).toContain("Three paragraph");
    // …and a copy that reaches no editor is answered with the blocks as HTML + Markdown.
    const copied = await copyFrom(page, "body");
    expect(copied.text).toBe(["Two", "Three", "Four"].map((w) => `${w} paragraph with some words in it.`).join("\n\n"));
    expect(copied.html).toMatch(/<p[^>]*>Two paragraph/);
    expect(copied.html).not.toContain("One paragraph");
    const cut = await copyFrom(page, "body", "cut");
    expect(cut.text).toContain("Two paragraph");
    expect(await texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
    // Non-contiguous in a read-only page, too.
    const b5 = await rect(page, 5);
    await modClick(page, b5.x + 80, mid(b5), ["ControlOrMeta", "Shift"]);
    await expect.poll(() => blocks(page)).toEqual([1, 2, 3, 5]);
    await page.keyboard.press("Escape");
    await expect.poll(() => blocks(page)).toEqual([]);
    expect(await texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
  });

  test("live viewer: selection and copy only, and it is local (the other client sees nothing)", async ({ page }) => {
    await open(page, "live&viewer");
    const col = await column(page, 1);
    await drag(page, { x: col.right + 40, y: mid(await rect(page, 0, 1)) }, { x: col.x + 80, y: mid(await rect(page, 2, 1)) });
    await expect.poll(() => blocks(page, 1)).toEqual([0, 1, 2]);
    expect(await blocks(page, 0)).toEqual([]);
    await expect(selectedDom(page, 0)).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    expect(await texts(page, 1)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
    expect(await texts(page, 0)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
    const copied = await copyFrom(page, "body");
    expect(copied.text).toContain("One paragraph");
    expect(copied.text).toContain("Three paragraph");
    expect(copied.text).not.toContain("Four paragraph");
  });

  test("while Suggesting: blocks can be selected, structural keys do not remove them", async ({ page }) => {
    await open(page, "live&suggesting");
    await marquee(page, "live", 1, 2);
    await expect.poll(() => blocks(page)).toEqual([1, 2]);
    await page.keyboard.press("ControlOrMeta+d");
    expect(await texts(page)).toEqual(["One", "Two", "Three", "Four", "Five", "Six"]);
    expect(await api<string[]>(page, "texts", 1)).toHaveLength(6);
  });

  test("a collaborator's edits keep the selection on the same blocks; a block they delete drops out", async ({ page }) => {
    await open(page, "live");
    await marquee(page, "live", 1, 3);
    await expect.poll(() => blocks(page)).toEqual([1, 2, 3]);
    const remote = (fn: string) => page.evaluate(`(() => { const editor = window.prismSelect.editor(1); (${fn})(editor); })()`);
    // B adds a block above: the selection moves down with its blocks.
    await remote(`(e) => e.commands.insertContentAt(0, "<p>Zero from Ben</p>")`);
    await expect.poll(() => texts(page)).toEqual(["Zero", "One", "Two", "Three", "Four", "Five", "Six"]);
    await expect.poll(() => blocks(page)).toEqual([2, 3, 4]);
    await expect(selectedDom(page)).toHaveCount(3);
    // B types inside a selected block: still selected.
    await remote(`(e) => { let pos = 0; for (let k = 0; k < 3; k++) pos += e.state.doc.child(k).nodeSize; e.commands.insertContentAt(pos + 1, "Edited ") }`);
    await expect.poll(async () => (await api<string[]>(page, "texts", 0))[3]).toBe("Edited Three paragraph with some words in it.");
    expect(await blocks(page)).toEqual([2, 3, 4]);
    // B deletes one of them: it drops out, the others stay.
    await remote(`(e) => { let pos = 0; for (let k = 0; k < 3; k++) pos += e.state.doc.child(k).nodeSize; e.commands.deleteRange({ from: pos, to: pos + e.state.doc.child(3).nodeSize }) }`);
    await expect.poll(() => texts(page)).toEqual(["Zero", "One", "Two", "Four", "Five", "Six"]);
    await expect.poll(() => blocks(page)).toEqual([2, 3]);
    await expect(selectedDom(page)).toHaveCount(2);
    // The selection never went to B.
    expect(await blocks(page, 1)).toEqual([]);
    // And A can still act on it.
    await page.keyboard.press("Backspace");
    await expect.poll(() => texts(page, 1)).toEqual(["Zero", "One", "Five", "Six"]);
  });

  test("the scroller follows a marquee held at its edge, and the selection grows with it", async ({ page }) => {
    await open(page, "blocks=60");
    const scroller = page.locator(".document-writing-scroll");
    const col = await column(page);
    const x = col.x - 140;
    const b1 = await rect(page, 1);
    await page.mouse.move(x, mid(b1));
    await page.mouse.down();
    await page.mouse.move(col.x + 80, 700, { steps: 6 });
    await page.mouse.move(col.x + 80, 892, { steps: 6 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    const grown = await blocks(page);
    expect(grown[0]).toBe(1);
    expect(grown.length).toBeGreaterThan(20);
    await page.mouse.up();
    expect((await blocks(page))[0]).toBe(1);
  });

  test("a touch in the margin starts nothing", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 800 } });
    const page = await context.newPage();
    await page.goto("/e2e-fixtures/editor-select.html");
    await expect(page.locator(".tiptap").first()).toContainText("Six paragraph");
    const col = await column(page);
    const b2 = await rect(page, 2);
    await page.touchscreen.tap(Math.max(8, col.x - 60), mid(b2));
    await page.waitForTimeout(200);
    expect(await blocks(page)).toEqual([]);
    await expect(page.locator(".prism-block-marquee")).toHaveCount(0);
    await context.close();
  });
});
