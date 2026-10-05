import { test, expect, type Page } from "@playwright/test";

/**
 * Wave 12 · the small "P2" conveniences from NOTION-GAP-DISCOVERY Table A (rows 7, 11, 23, 28,
 * 51, 71, 93) and Table C.2 "copy link to heading". One test per item; each names its row.
 */
async function openPalette(page: Page, url = "/e2e-fixtures/notion-shell.html") {
  await page.goto(url);
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search notes and commands" });
  await expect(input).toBeVisible();
  return input;
}

/** Table A 71: results can be ordered by best match (default), last edited or created. */
test("sort: best match by default; last edited and created reorder the rows and ask the server", async ({ page }) => {
  const input = await openPalette(page);
  // Distinct stamps the default order does not already follow.
  await page.evaluate(() => {
    const s = (window as any).prismShell;
    const set = (path: string, created: string, updated: string) => { const n = s.all().find((x: any) => x.path.endsWith(path)); n.createdAt = created; n.updatedAt = updated; };
    set("Workshop agenda", "2026-01-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    set("Workshop tracker", "2026-03-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
    set("Field notes", "2026-02-01T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
    set("A living workspace", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"); // the fourth hit: last in both orders
  });
  await input.fill("workshop");
  const results = page.getByRole("group", { name: "Notes" });
  await expect(results.getByRole("option")).toHaveCount(4);
  const titles = async () => (await results.getByRole("option").locator(".prism-search-result-title").allTextContents()).filter((t) => /agenda|tracker|Field notes/.test(t)).map((t) => t.trim());
  await page.getByRole("button", { name: "Filters" }).click();
  const panel = page.getByRole("group", { name: "Search filters" });
  const sort = panel.getByRole("combobox", { name: "Sort" });
  await expect(sort).toHaveValue("best");
  const searches = () => page.evaluate(() => (window as any).prismShell.searches as string[]);
  expect((await searches()).at(-1)).not.toContain("sort=");
  await sort.selectOption("edited");
  await expect.poll(async () => (await searches()).at(-1)).toContain("sort=edited");
  await expect.poll(titles).toEqual(["Field notes", "Workshop agenda", "Workshop tracker"]);
  await sort.selectOption("created");
  await expect.poll(async () => (await searches()).at(-1)).toContain("sort=created");
  await expect.poll(titles).toEqual(["Workshop tracker", "Field notes", "Workshop agenda"]);
  // A sort is not a filter: nothing was narrowed, and it is not counted as one.
  await expect(results.getByRole("option")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  // Enter opens the first row of the order on screen.
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Open document tabs" }).getByRole("button", { name: "Open Workshop tracker", exact: true })).toHaveAttribute("aria-current", "page");
});


/** Table C.2: "Copy link to heading" → `<page link>#h-<slug>`; opening it lands on that heading. */
test("copy link to heading: block menu and outline copy `<page link>#h-<slug>`; the link opens on that heading, at boot and from a link in another page", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copied = text; } } });
  });
  await page.goto("/e2e-fixtures/notion-shell.html?headings&open=agenda");
  const editor = page.locator(".tiptap[contenteditable=true]");
  const steps = editor.getByRole("heading", { name: "Next steps" });
  await expect(steps).toHaveCount(2);
  const copied = () => page.evaluate(() => (window as any).copied as string | undefined);
  const origin = new URL(page.url()).origin;

  // Block menu on the SECOND "Next steps": repeats are numbered in document order, like the published wiki.
  // (Centred first: the block menu does not open for a block at the very edge of the scroller.)
  const caretIn = async (target: import("@playwright/test").Locator, expected: string) => {
    await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await target.click();
    await expect.poll(() => page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; return `${e.state.selection.$from.parent.type.name}:${e.state.selection.$from.parent.textContent}`; })).toBe(expected);
  };
  await caretIn(steps.nth(1), "heading:Next steps");
  await page.keyboard.press("ControlOrMeta+Shift+/");
  const menu = page.getByRole("menu", { name: "Block actions" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Copy link to heading" }).click();
  await expect.poll(copied).toBe(`${origin}/page/agenda#h-next-steps-1`);
  await expect(page.getByText("Copied link to heading")).toBeVisible();
  // A paragraph has no such item.
  await expect(menu).toHaveCount(0);
  await caretIn(editor.getByText("The second one."), "paragraph:The second one.");
  await page.keyboard.press("ControlOrMeta+Shift+/");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy link to heading" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Outline: one copy button per heading, named and described by its heading; the row itself still navigates.
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  const outline = page.getByRole("navigation", { name: "Document outline" });
  const copy = outline.getByRole("button", { name: "Copy link to heading" });
  await expect(copy).toHaveCount(3);
  await expect(copy.first()).toHaveAccessibleDescription("Plan");
  await copy.first().click();
  await expect.poll(copied).toBe(`${origin}/page/agenda#h-plan`);
  await expect(outline.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
  // Copying wrote nothing to the page.
  expect(await page.evaluate(() => (window as any).prismShell.writes.filter((w: any) => String(w.path).includes("/notes")).length)).toBe(0);

  // Opening the link: the page boots on that heading (the first one is scrolled away).
  // (A different query each time: a hash-only change would not reload the page.)
  await page.goto("/e2e-fixtures/notion-shell.html?headings&open=agenda&n=1#h-next-steps-1");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(1)).toBeInViewport();
  await expect(editor.getByRole("heading", { name: "Plan" })).not.toBeInViewport();
  // An unknown heading opens the page at the top, quietly.
  await page.goto("/e2e-fixtures/notion-shell.html?headings&open=agenda&n=2#h-no-such-heading");
  await expect(steps).toHaveCount(2);
  await expect(editor.getByRole("heading", { name: "Plan" })).toBeInViewport();

  // From another page: a pasted heading link stays a LINK (a page chip would drop the heading) and opens on the heading.
  await page.goto("/e2e-fixtures/notion-shell.html?headings");
  await expect(editor).toBeVisible();
  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ");
  await page.evaluate((url) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", url);
    document.querySelector(".tiptap")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `${origin}/page/agenda#h-next-steps`);
  const link = editor.locator('a[href$="/page/agenda#h-next-steps"]');
  await expect(link).toBeVisible();
  await expect(editor.locator('[data-type="mention"]')).toHaveCount(0);
  await page.keyboard.press("Escape"); // the "Paste as" menu, if it is up
  await link.click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("navigation", { name: "Open document tabs" }).getByRole("button", { name: "Open Workshop agenda", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(steps.first()).toBeInViewport();
  await expect(editor.getByRole("heading", { name: "Plan" })).not.toBeInViewport();
});
