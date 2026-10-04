import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { SURFACES, openSurface } from "./a11y-surfaces";
import { touchTargets } from "./a11y-measure";

/**
 * NP-AX-07 "touch targets ≥44px": every primary surface on a phone (390×844, touch, coarse pointer).
 * A control passes when its box is ≥ 44×44, or its effective hit area is (hit-slop), or it is ≥ 24×24
 * with no other control inside the 44×44 square centred on it (WCAG 2.5.8 spacing). See `a11y-measure.ts`.
 * Not measured: third-party widgets (Excalidraw, emoji picker, map), inline links in running text.
 */
test.use({ hasTouch: true, isMobile: true });
const REPORT = process.env.A11Y_REPORT;
/** Buttons the fixture pages add around the product UI (unstyled, class-less). */
const SCAFFOLD = ["Toggle panel", "Alex", "Morgan", "Switch workspace", "Switch to view-only", "Open search", "Query", "Prepend history", "Receive message", "Room A", "Room B", "Alex account", "Morgan account"];
/**
 * Known and NOT fixed: the database month grid. Seven day columns in 390 px are 51 px wide; a 44 px
 * "+" and 44 px page chips cannot fit a day cell. Every page is also reachable from the list/table
 * views and "New" (44 px) creates a page. Reported in A11Y-RESULTS.md as open.
 */
const KNOWN = [/^button\.db-cal-add/, /^button\.db-cal-item/];
/**
 * WebKit project only (desktop macOS engine at phone width): a native `<select>` is drawn as the
 * macOS pop-up button, whose height is fixed (20–23 px) whatever CSS `height` / `min-height` says.
 * iOS Safari sizes a select by its CSS box, so this is not what a phone shows; Playwright's WebKit
 * cannot draw iOS form controls. Selects are therefore not judged here on WebKit (every other
 * control is); Chromium still measures them. Reported in WEBKIT-RESULTS.md.
 */
const MAC_NATIVE_SELECT = /^select(\.|\s|$)/;
const only = (process.env.A11Y_ONLY ?? "").split(",").filter(Boolean);

test.describe("touch targets ≥44px", () => {
  for (const s of SURFACES) {
    if (s.only === "desktop") continue;
    if (only.length && !only.includes(s.id)) continue;
    test(`${s.id} · phone`, async ({ page, browserName }) => {
      await openSurface(page, s, "phone", "light");
      const offenders = await touchTargets(page, SCAFFOLD);
      if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(`${REPORT}/touch_${s.id}.json`, JSON.stringify(offenders, null, 1)); }
      const known = offenders.filter((o) => KNOWN.some((k) => k.test(o.what)));
      const nativeSelects = browserName === "webkit" ? offenders.filter((o) => MAC_NATIVE_SELECT.test(o.what)) : [];
      if (nativeSelects.length) test.info().annotations.push({ type: "webkit-native-select", description: `${nativeSelects.length} not judged (macOS pop-up button height is fixed)` });
      const bad = offenders.filter((o) => !known.includes(o) && !nativeSelects.includes(o));
      if (known.length) test.info().annotations.push({ type: "known-small-targets", description: `${known.length} (month grid)` });
      expect(bad, "controls smaller than a touch target").toEqual([]);
    });
  }
});

// Review fix 4: the phone block handle's enlarged hit area must not cover the text beside it.
test("phone: a tap on the first character of a paragraph places the caret (the block handle does not take it)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/editor-blocks.html");
  const para = page.getByText("Bravo paragraph", { exact: true });
  await expect(para).toBeVisible();
  // Put the caret in the block first: on a phone the handle shows for the caret's block.
  const box = (await para.boundingBox())!;
  await page.touchscreen.tap(box.x + 80, box.y + box.height / 2);
  const grip = page.getByRole("button", { name: "Block actions" });
  await expect(grip).toBeVisible();
  // Where the first character starts.
  const first = await para.evaluate((el) => { const r = document.createRange(); r.setStart(el.firstChild!, 0); r.setEnd(el.firstChild!, 1); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; });
  for (const dx of [1, first.w / 2]) {
    // Apart in time as well as place: two quick taps are a double tap (word selection).
    await page.waitForTimeout(500);
    await page.touchscreen.tap(box.x + 80, box.y + box.height / 2);
    await page.waitForTimeout(500);
    await page.touchscreen.tap(first.x + dx, first.y);
    await expect(page.getByRole("menu", { name: "Block actions" }), `tap ${dx}px into the first character`).toHaveCount(0);
    const read = () => page.evaluate(() => { const s = (document.querySelector(".tiptap") as any).editor.state.selection; return { text: s.$from.parent.textContent, offset: s.$from.parentOffset, empty: s.empty }; });
    // The editor reads the new selection on `selectionchange`, a moment after the tap.
    await expect.poll(async () => (await read()).offset, `caret at the start (${dx}px)`).toBeLessThanOrEqual(1);
    const at = await read();
    expect(at.text).toBe("Bravo paragraph");
    expect(at.empty, `caret, not a selection (${dx}px)`).toBe(true);
    expect(at.offset).toBeLessThanOrEqual(1);
  }
  // The handle itself still opens the menu, and still has a 44 px hit area (to its left).
  const g = (await grip.boundingBox())!;
  await page.touchscreen.tap(g.x + g.width / 2, g.y + g.height / 2);
  await expect(page.getByRole("menu", { name: "Block actions" })).toBeVisible();
});

// Review fixes 2, 3 and the breadcrumb: what touch.css must NOT do.
test("touch.css stays out of editor content and out of print; breadcrumbs keep their ellipsis", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/editor-blocks.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  // A to-do item of a document shown inside a dialog (a database row peek) is not a dialog form row.
  await page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; e.chain().focus("end").insertContent('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Task in a peek</p></li></ul>').run(); });
  const label = editor.locator('ul[data-type="taskList"] li > label').last();
  await expect(label).toHaveCount(1);
  const style = (peek: boolean) => page.evaluate((peek) => {
    const host = document.querySelector(".tiptap")!.parentElement!;
    if (peek) host.setAttribute("role", "dialog"); else host.removeAttribute("role");
    const l = Array.from(document.querySelectorAll('.tiptap ul[data-type="taskList"] li > label')).pop()!;
    const st = getComputedStyle(l);
    return `${st.display} ${st.minHeight} ${st.gap}`;
  }, peek);
  const plain = await style(false);
  expect(await style(true), "task item label inside a dialog").toBe(plain);
  await style(false);
  // The control case: a real dialog form row IS sized.
  expect(await page.evaluate(() => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); d.innerHTML = '<label><input type="checkbox"> Row</label>'; document.body.append(d); const v = getComputedStyle(d.firstElementChild!).minHeight; d.remove(); return v; })).toBe("44px");
  // Breadcrumb parts: 44 px tall, and still truncating (not a flex container).
  const crumb = page.locator(".document-breadcrumb-part").first();
  await expect(crumb).toBeVisible();
  expect(await crumb.evaluate((el) => { const st = getComputedStyle(el); return { h: el.getBoundingClientRect().height >= 43.5, ellipsis: st.textOverflow === "ellipsis" && st.overflow.includes("hidden") && !st.display.includes("flex") }; })).toEqual({ h: true, ellipsis: true });
  // Print (a portrait page is narrower than 768 px): none of the phone sizes apply.
  const crumbHeight = () => crumb.evaluate((el) => getComputedStyle(el).minHeight);
  expect(await crumbHeight()).toBe("44px");
  await page.emulateMedia({ media: "print" });
  expect(await crumbHeight()).not.toBe("44px");
  expect(await page.evaluate(() => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); d.innerHTML = '<label><input type="checkbox"> Row</label>'; document.body.append(d); const v = getComputedStyle(d.firstElementChild!).minHeight; d.remove(); return v; })).not.toBe("44px");
});
