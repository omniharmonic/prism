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
