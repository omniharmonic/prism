import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { SURFACES, openSurface } from "./a11y-surfaces";

/**
 * "The page zooms in and out by itself" on an iPhone (the iOS app is a WKWebView around this UI).
 * WebKit on a phone zooms the page when a text control gains focus and its computed font-size is
 * under 16 px (scale = 16 / font-size), and it does not zoom back out. It reads the size of the
 * FOCUSED element: an `<input>` / `<textarea>` / `<select>`, or the root of a `contenteditable`.
 * The other cause is a page wider than the screen, which the browser lets the user pan and which
 * shrinks the layout when it reflows.
 *
 * So, on every primary surface at 390×844 with a touch, coarse pointer:
 *  - every text control in the DOM (shown or not: a hidden one is one tap away) is ≥ 16 px;
 *  - the document is no wider than the viewport, at 390 and again at 320.
 * The rule that guarantees the first is `styles/touch.css` § "iOS zoom-on-focus".
 *
 * This is Chromium with phone emulation. It measures the cause (font-size, overflow); it cannot show
 * WKWebView's zoom itself — that is a device check.
 */
test.use({ hasTouch: true, isMobile: true });
const REPORT = process.env.A11Y_REPORT;
const only = (process.env.A11Y_ONLY ?? "").split(",").filter(Boolean);

/**
 * Text controls under `below` px (default 16; pass Infinity to list every one with its size).
 * Not measured: third-party canvases that bring their own inputs (Excalidraw).
 */
export async function smallTextControls(page: Page, below = 16): Promise<string[]> {
  return page.evaluate((below) => {
    const NOT_TEXT = new Set(["checkbox", "radio", "range", "color", "file", "button", "submit", "reset", "image", "hidden"]);
    const out: string[] = [];
    {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable]"))) {
        if (el instanceof HTMLInputElement && NOT_TEXT.has(el.type)) continue;
        if (el.getAttribute("contenteditable") === "false") continue;
        if (el.closest(".excalidraw")) continue;
        const cs = getComputedStyle(el);
        const size = parseFloat(cs.fontSize);
        if (size >= below) continue;
        const name = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "";
        const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
        const kind = el.hasAttribute("contenteditable") ? "[contenteditable]" : el instanceof HTMLInputElement ? `[type=${el.type}]` : "";
        out.push(`${el.tagName.toLowerCase()}${kind}${cls ? "." + cls : ""} “${name}” ${size}px`);
      }
    }
    return Array.from(new Set(out)).sort();
  }, below);
}

/** How far the document is wider than the viewport (0 = it fits). */
export const pageOverflow = (page: Page) => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));

test.describe("phone: nothing makes iOS zoom the page", () => {
  for (const s of SURFACES) {
    if (s.only === "desktop") continue;
    if (only.length && !only.includes(s.id)) continue;
    test(`${s.id} · phone`, async ({ page }) => {
      await openSurface(page, s, "phone", "light");
      const small = await smallTextControls(page);
      const at390 = await pageOverflow(page);
      await page.setViewportSize({ width: 320, height: 568 });
      await page.waitForTimeout(250);
      const at320 = await pageOverflow(page);
      const smallAt320 = (await smallTextControls(page)).filter((x) => !small.includes(x));
      const report = { small: [...small, ...smallAt320], overflowAt390: at390, overflowAt320: at320 };
      // The report also lists every text control with its size, to compare two runs (not asserted).
      if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(`${REPORT}/zoom_${s.id}.json`, JSON.stringify({ ...report, all: await smallTextControls(page, Infinity) }, null, 1)); }
      expect(report).toEqual({ small: [], overflowAt390: 0, overflowAt320: 0 });
    });
  }
});

/** Controls that are not in the DOM until something is tapped, and the editable regions a setting can shrink. */
test.describe("phone: controls opened by a tap, and the writing surface", () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); });
  const size = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  test("a property's text editor and the tag search", async ({ page }) => {
    await page.goto("/e2e-fixtures/databases.html?open=page");
    const props = page.getByRole("group", { name: "Page properties" });
    await props.getByRole("button", { name: "Owner: Alex Chen" }).click();
    await expect(page.getByLabel("Owner", { exact: true })).toBeFocused();
    expect(await smallTextControls(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await props.getByRole("button", { name: "Add tag" }).click();
    await expect(page.getByLabel("Search tags")).toBeVisible();
    expect(await smallTextControls(page)).toEqual([]);
  });

  test("the page title being renamed keeps the title's size (the floor is not a cap)", async ({ page }) => {
    await page.goto("/e2e-fixtures/workspace.html");
    const heading = await size(page, ".document-page-heading h1");
    await page.getByRole("button", { name: "Rename A living workspace", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Document title" });
    await expect(input).toBeFocused();
    expect(heading).toBeGreaterThan(24);
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(heading);
  });

  test("the new page title keeps its display size", async ({ page }) => {
    await page.goto("/e2e-fixtures/workspace.html");
    await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByRole("dialog", { name: "Search workspace" });
    await search.getByRole("combobox").fill("New document");
    await search.getByRole("option", { name: "New document", exact: true }).click();
    const title = page.getByRole("dialog", { name: "New page", exact: true }).getByLabel("Page title");
    await expect(title).toBeFocused();
    expect(await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(26);
    expect(await smallTextControls(page)).toEqual([]);
  });

  test("the writing surface: a page set to Small text, and the smallest font-size setting", async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    const editor = ".tiptap[contenteditable=true]";
    await expect(page.locator(editor).first()).toBeVisible();
    expect(await size(page, editor)).toBe(16);
    await page.evaluate(() => document.getElementById("workspace-document")!.setAttribute("data-page-small", "true"));
    expect(await size(page, editor)).toBe(16);
    // Settings → Appearance → Font size 11 (what `applyFontSize(11)` sets), then 18.
    await page.evaluate(() => { const r = document.documentElement.style; r.setProperty("--text-base", `${11 / 16}rem`); r.setProperty("--text-lg", `${13 / 16}rem`); });
    expect(await size(page, editor)).toBe(16);
    await page.evaluate(() => document.getElementById("workspace-document")!.removeAttribute("data-page-small"));
    expect(await size(page, editor)).toBe(16);
    await page.evaluate(() => { const r = document.documentElement.style; r.setProperty("--text-base", `${18 / 16}rem`); r.setProperty("--text-lg", `${20 / 16}rem`); });
    expect(await size(page, editor)).toBe(20); // a larger setting is kept
    expect(await smallTextControls(page)).toEqual([]);
  });

  test("a code file", async ({ page }) => {
    await page.goto("/e2e-fixtures/renderer-preservation.html?kind=code");
    await expect(page.locator(".cm-content[contenteditable=true]")).toContainText("const answer = 42;");
    expect(await smallTextControls(page)).toEqual([]);
    expect(await pageOverflow(page)).toBe(0);
  });
});

/** Desktop is not touched: the same controls keep their drawn sizes with a mouse at 1440. */
test.describe("desktop: text sizes are unchanged", () => {
  test.use({ hasTouch: false, isMobile: false });
  test("sign-in fields, a page set to Small text and a code file keep their desktop sizes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const size = (selector: string) => page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    await page.goto("/e2e-fixtures/notion-shell.html");
    await expect(page.locator(".tiptap[contenteditable=true]").first()).toBeVisible();
    expect(await size(".tiptap[contenteditable=true]")).toBe(16);
    await page.evaluate(() => document.getElementById("workspace-document")!.setAttribute("data-page-small", "true"));
    expect(await size(".tiptap[contenteditable=true]")).toBe(14);
    await page.goto("/e2e-fixtures/renderer-preservation.html?kind=code");
    await expect(page.locator(".cm-content[contenteditable=true]")).toContainText("const answer = 42;");
    expect(await size(".cm-content")).toBe(13);
    const s = SURFACES.find((x) => x.id === "sign-in")!;
    await openSurface(page, s, "desktop", "light");
    expect(await size("input[type=email]")).toBe(14);
  });
});

/** The measures are not vacuous. */
test("the zoom measures catch a small input, a small editable region and a wide page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // With the app's own viewport meta: without one a phone lays the page out 980 px wide and nothing overflows.
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><main style="width:500px"><input aria-label="Tiny" style="font-size:12px"><input type="checkbox" style="font-size:12px">
    <div contenteditable="true" aria-label="Note" style="font-size:14px">x</div><textarea aria-label="Fine" style="font-size:16px"></textarea></main>`);
  const small = await smallTextControls(page);
  expect(small).toHaveLength(2);
  expect(small.join()).toContain("Tiny");
  expect(small.join()).toContain("Note");
  expect(await pageOverflow(page)).toBeGreaterThan(0);
});
