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

const stubClipboard = (page: Page) => page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copied = text; } } });
});
const noteWrites = (page: Page) => page.evaluate(() => (window as any).prismShell.writes.filter((w: any) => String(w.path).includes("/notes")).length);

/** Table A 7: expand / collapse all toggles (⌘⌥T, page ⋯, ⌘K). Open state is view state: nothing is written. */
test("expand or collapse all toggles: ⌘⌥T, the page menu and the palette; nested toggles follow; nothing is saved", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?headings&open=agenda");
  const editor = page.locator(".tiptap[contenteditable=true]");
  const toggles = editor.locator('.prism-toggle[data-type="toggle"]');
  await expect(toggles).toHaveCount(3);
  const closed = editor.locator('.prism-toggle[data-open="false"]');
  const inside = editor.getByText("Inside the nested toggle.");
  await expect(closed).toHaveCount(0);
  await expect(inside).toBeVisible();
  const html = () => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
  const before = await html();

  // ⌘⌥T with the caret in the page: all open → all closed (the nested one too).
  await editor.getByText("The second one.").click();
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await expect(closed).toHaveCount(3);
  await expect(inside).toBeHidden();
  // Again: all open.
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await expect(closed).toHaveCount(0);
  await expect(inside).toBeVisible();
  // Mixed (one closed by hand) → the key EXPANDS.
  await toggles.first().locator("> .prism-toggle-arrow").click();
  await expect(closed).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await expect(closed).toHaveCount(0);

  // Page ⋯: the item names what it will do.
  const more = page.getByRole("button", { name: "Page actions", exact: true });
  await more.click();
  await page.getByRole("menuitem", { name: "Collapse all toggles" }).click();
  await expect(closed).toHaveCount(3);
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Collapse all toggles" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Expand all toggles" }).click();
  await expect(closed).toHaveCount(0);

  // ⌘K has the same action, with its key.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("toggles");
  await page.getByRole("option", { name: /Expand or Collapse All Toggles/ }).click();
  await expect(closed).toHaveCount(3);

  // View state only: the document is unchanged and nothing was sent.
  expect(await html()).toBe(before);
  expect(await noteWrites(page)).toBe(0);

  // A page without toggles: no menu item, and the key is left alone.
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(editor).toBeVisible();
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /all toggles/ })).toHaveCount(0);
});

/** Table A 23: ⌘L copies the open page's link. Table A 28: a closed tab can be reopened. */
test("⌘L copies the page link; Reopen Closed Tab brings back the tab closed last, where it was", async ({ page }) => {
  await stubClipboard(page);
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  const origin = new URL(page.url()).origin;
  const copied = () => page.evaluate(() => (window as any).copied as string | undefined);
  await editor.locator("p").first().click();
  await page.keyboard.press("ControlOrMeta+l");
  await expect.poll(copied).toBe(`${origin}/page/workspace`);
  await expect(page.getByText("Link copied")).toBeVisible();
  // The palette lists it with the key; nothing was typed into or written to the page.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search notes and commands" });
  await input.fill("copy link");
  await expect(page.getByRole("option", { name: /Copy Link to Page/ })).toBeVisible();
  // No tab was closed yet: nothing to reopen.
  await input.fill("reopen");
  await expect(page.getByRole("option", { name: /Reopen Closed Tab/ })).toHaveCount(0);
  expect(await noteWrites(page)).toBe(0);

  // Open two more pages, then close the MIDDLE one.
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  const order = () => page.evaluate(() => (window as any).prismShellUI.getState().openTabs.map((t: any) => t.noteId) as string[]);
  for (const [q, name] of [["agenda", /Workshop agenda/], ["budget", /Field notes/]] as const) {
    await input.fill(q);
    await page.getByRole("group", { name: "Notes" }).getByRole("option", { name }).first().click();
    await page.keyboard.press("ControlOrMeta+k");
  }
  await page.keyboard.press("Escape");
  expect(await order()).toEqual(["workspace", "agenda", "field-notes"]);
  await tabs.getByRole("button", { name: "Open Workshop agenda", exact: true }).click();
  await page.evaluate(() => { const ui = (window as any).prismShellUI.getState(); ui.closeTab(ui.activeTabId); });
  expect(await order()).toEqual(["workspace", "field-notes"]);

  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("reopen");
  await page.getByRole("option", { name: /Reopen Closed Tab/ }).click();
  expect(await order()).toEqual(["workspace", "agenda", "field-notes"]);
  await expect(tabs.getByRole("button", { name: "Open Workshop agenda", exact: true })).toHaveAttribute("aria-current", "page");
  // Used up: the command is gone again.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("reopen");
  await expect(page.getByRole("option", { name: /Reopen Closed Tab/ })).toHaveCount(0);
});

/** Table A 51: previous / next row while a peek is open. */
test("row peek: Previous / Next walk the view's rows in its order, stop at the ends, and keep the peek", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.locator(".db-row-open").first()).toBeVisible();
  const titles = (await page.locator(".db-row-open").allTextContents()).map((t) => t.trim());
  expect(titles.length).toBeGreaterThan(2);
  await page.getByRole("button", { name: titles[0]!, exact: true }).click();
  const peek = page.getByRole("dialog", { name: /side peek/ });
  await expect(peek).toHaveAccessibleName(`${titles[0]} (side peek)`);
  const steps = peek.getByRole("group", { name: "Go to another page of this view" });
  const prev = steps.getByRole("button", { name: "Previous page" });
  const next = steps.getByRole("button", { name: "Next page" });
  await expect(steps).toContainText(`1 of ${titles.length}`);
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  // At the first row Previous does nothing.
  await prev.click({ force: true }); // aria-disabled: a person can still press it; nothing happens
  await expect(peek).toHaveAccessibleName(`${titles[0]} (side peek)`);

  await next.click();
  await expect(peek).toHaveAccessibleName(`${titles[1]} (side peek)`);
  await expect(steps).toContainText(`2 of ${titles.length}`);
  // Keyboard: the button keeps focus across the change of page (Safari does not focus a clicked button).
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(next).toBeFocused();
  await expect(peek).toHaveAccessibleName(`${titles[2]} (side peek)`);
  await prev.click();
  await expect(peek).toHaveAccessibleName(`${titles[1]} (side peek)`);
  // The database underneath never became a tab, and the peek shows the row's own page.
  expect(await page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId))).toEqual(["db"]);
  // To the last row: Next stops there.
  for (let i = 2; i < titles.length; i++) await next.click();
  await expect(peek).toHaveAccessibleName(`${titles.at(-1)} (side peek)`);
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await next.click({ force: true });
  await expect(peek).toHaveAccessibleName(`${titles.at(-1)} (side peek)`);
  // Esc still closes the peek.
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
});
