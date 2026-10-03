import { test, expect } from "@playwright/test";

/** Wave 2E · NP-SR-03 / NP-SR-04 against the real HttpVaultClient → /api/search. */
async function openPalette(page: import("@playwright/test").Page) {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search notes and commands" });
  await expect(input).toBeVisible();
  return input;
}

test("match highlighting", async ({ page }, info) => {
  const input = await openPalette(page);
  await input.fill("workshop");
  const results = page.getByRole("group", { name: "Notes" });
  const agenda = results.getByRole("option", { name: /Workshop agenda/ });
  await expect(agenda).toBeVisible();
  await expect(agenda.locator(".prism-search-result-title mark")).toHaveText("Workshop");
  await expect(agenda.locator("mark").nth(1)).toHaveText("workshop");
  // Snippets come from the server's offsets and stay plain text.
  const searched = await page.evaluate(() => (window as any).prismShell.searches as string[]);
  expect(searched.at(-1)).toContain("lean=1");
  await expect(results.locator("mark")).not.toHaveCount(0);
  await page.screenshot({ path: info.outputPath("search-highlight-desktop.png") });
  // Opening a result remembers the search for next time.
  await agenda.click();
  await page.keyboard.press("ControlOrMeta+k");
  const recent = page.getByRole("group", { name: "Recent searches" });
  await expect(recent.getByRole("option", { name: "workshop" })).toBeVisible();
  await recent.getByRole("option", { name: "workshop" }).click();
  await expect(page.getByRole("combobox", { name: "Search notes and commands" })).toHaveValue("workshop");
});

test("filters narrow results", async ({ page }, info) => {
  const input = await openPalette(page);
  await input.fill("workshop");
  const results = page.getByRole("group", { name: "Notes" });
  await expect(results.getByRole("option")).toHaveCount(4);
  await page.getByRole("button", { name: "Filters" }).click();
  const panel = page.getByRole("group", { name: "Search filters" });
  await panel.getByRole("combobox", { name: "Type" }).selectOption("database");
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results.getByRole("option")).toContainText("Workshop tracker");
  expect((await page.evaluate(() => (window as any).prismShell.searches as string[])).at(-1)).toContain("type=database");
  await panel.getByRole("combobox", { name: "Type" }).selectOption("");
  await panel.getByRole("checkbox", { name: "Title only" }).check();
  await expect(results.getByRole("option")).toHaveCount(2);
  await expect(results).not.toContainText("Field notes");
  await expect(results).not.toContainText("A living workspace");
  await panel.getByRole("checkbox", { name: "Title only" }).uncheck();
  await panel.getByRole("combobox", { name: "Edited by" }).selectOption("me");
  await expect(results.getByRole("option")).toHaveCount(3);
  await expect(results).not.toContainText("Workshop agenda");
  await panel.getByRole("combobox", { name: "Edited by" }).selectOption("anyone");
  await panel.getByRole("combobox", { name: "Date" }).selectOption("year");
  await expect(page.getByRole("status").filter({ hasText: "1 filter" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("search-filters-desktop.png") });
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(results.getByRole("option")).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("vault scope searches another vault the account can reach", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?vaults");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("workshop");
  const results = page.getByRole("group", { name: "Notes" });
  await expect(results.getByRole("option")).toHaveCount(4);
  await page.getByRole("button", { name: "Filters" }).click();
  const vault = page.getByRole("group", { name: "Search filters" }).getByRole("combobox", { name: "Vault" });
  await expect(vault.locator("option")).toHaveText(["Personal vault (current)", "Shared research"]);
  await vault.selectOption({ label: "Shared research" });
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results.getByRole("option")).toContainText("Workshop field study");
  await expect(page.getByRole("status").filter({ hasText: "Shared research" })).toBeVisible();
  // Opening it switches to that vault (the page lives there).
  await results.getByRole("option").click();
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.switchedVault)).toBe("research");
});

test("without several vaults there is no vault selector", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByRole("group", { name: "Search filters" }).getByRole("combobox", { name: "Vault" })).toHaveCount(0);
});

// NP-SB-02: quick find opens from anywhere — including mid-sentence in the editor — and Esc gives the caret back.
test("⌘K opens while typing in the editor and Esc returns to the caret", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" caret-before");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search notes and commands" });
  await expect(input).toBeFocused();
  await input.fill("workshop"); // typing goes to the palette, not the page
  await expect(editor).not.toContainText("workshop caret");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(editor).toBeFocused();
  await page.keyboard.type("-after");
  await expect(editor).toContainText("caret-before-after"); // same caret position, nothing lost
});

/** NP-SR-07 */
test("back/forward restores scroll", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.evaluate(() => {
    const shell = (window as any).prismShell;
    shell.note("agenda").content = Array.from({ length: 120 }, (_, i) => `<p>Agenda line ${i + 1}</p>`).join("");
    (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document");
  });
  const main = page.locator("#workspace-document .document-writing-scroll");
  await expect(page.locator(".tiptap")).toContainText("Agenda line 120");
  // A scroll position is remembered from the scroll EVENT, which the browser sends a frame after
  // the scroll: leave the page only once it has been delivered (a person cannot be faster than that).
  await main.evaluate((node) => new Promise<void>((resolve) => { node.addEventListener("scroll", () => resolve(), { once: true }); node.scrollTop = 900; }));
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(900);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.locator(".tiptap")).toContainText("workshop budget");
  expect(await main.evaluate((node) => node.scrollTop)).toBeLessThan(50);
  // ⌘[ goes back to the agenda, at the line it was left on.
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(page.locator(".tiptap")).toContainText("Agenda line 120");
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(900);
  // ⌘] goes forward again; the header arrows do the same.
  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(page.locator(".tiptap")).toContainText("workshop budget");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".tiptap")).toContainText("Agenda line 120");
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(900);
  // The restore lets go as soon as the reader scrolls.
  await main.evaluate((node) => { node.scrollTop = 0; });
  await page.waitForTimeout(300);
  expect(await main.evaluate((node) => node.scrollTop)).toBe(0);
});

/** NP-SR-01 */
test("⌘↵ opens a result in a new tab; rows show the edited date", async ({ page }) => {
  const input = await openPalette(page);
  await input.fill("agenda");
  const row = page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Workshop agenda/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Library/Workshop agenda");
  await expect(row).toContainText(/Edited (today|yesterday|\d+ days ago|[A-Z][a-z]{2} \d{1,2}(, \d{4})?)/);
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toContainText("new tab");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toHaveCount(0);
  // The page being read stays in front; the result is a tab behind it.
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  await expect(tabs.getByRole("button", { name: "Open Workshop agenda", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Open A living workspace", exact: true })).toHaveAttribute("aria-current", "page");
  const toast = page.getByText("Opened “Workshop agenda” in a new tab");
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "Go to tab" }).click();
  await expect(tabs.getByRole("button", { name: "Open Workshop agenda", exact: true })).toHaveAttribute("aria-current", "page");
  // Plain ↵ still opens in place.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("budget");
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Field notes/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(tabs.getByRole("button", { name: "Open Field notes", exact: true })).toHaveAttribute("aria-current", "page");
});

/** NP-SR-06 */
test("commands carry icons and shortcut hints; Toggle theme works from the palette and the keyboard", async ({ page }) => {
  const input = await openPalette(page);
  await input.fill("toggle");
  const commands = page.getByRole("group", { name: "Commands" });
  const theme = commands.getByRole("option", { name: "Toggle Theme", exact: true });
  await expect(theme).toBeVisible();
  await expect(theme).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+Shift\+L$/);
  await expect(theme.locator("kbd")).toHaveText(/^(⌘⇧L|Ctrl\+Shift\+L)$/);
  await expect(theme.locator("svg")).toHaveCount(1);
  await expect(commands.getByRole("option", { name: "Toggle Sidebar", exact: true }).locator("kbd")).toHaveText(/^(⌘\\|Ctrl\+\\)$/);
  const isLight = () => page.evaluate(() => document.documentElement.classList.contains("light"));
  const before = await isLight();
  await theme.click();
  await expect.poll(isLight).toBe(!before);
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect.poll(isLight).toBe(before);
  // The required commands are all there, each with an icon.
  await page.keyboard.press("ControlOrMeta+k");
  for (const [query, name] of [["new page", "New Page"], ["template", "New Page from Template"], ["trash", "Open Trash"], ["settings", "Settings"], ["inbox", "Open Inbox"]] as const) {
    await page.getByRole("combobox", { name: "Search notes and commands" }).fill(query);
    const option = page.getByRole("group", { name: "Commands" }).getByRole("option", { name, exact: true });
    await expect(option).toBeVisible();
    await expect(option.locator("svg").first()).toBeVisible();
  }
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("settings");
  await expect(page.getByRole("group", { name: "Commands" }).getByRole("option", { name: "Settings", exact: true })).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+,$/);
});

/** NP-SB-04 (star from ⌘K) */
test("a page can be starred from ⌘K without opening it", async ({ page }) => {
  const input = await openPalette(page);
  await input.fill("agenda");
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Workshop agenda/ })).toBeVisible();
  const star = page.getByRole("button", { name: "Add Workshop agenda to Favorites", exact: true });
  await star.click();
  await expect(page.getByRole("button", { name: "Remove Workshop agenda from Favorites", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  const favorites = page.locator(".workspace-navigation").getByRole("region", { name: "Favorites" });
  await expect(favorites.getByRole("button", { name: "Workshop agenda", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismShell.preferences.favorites)).toEqual(["agenda"]);
  // The page was not opened.
  await expect(page.getByRole("navigation", { name: "Open document tabs" }).getByRole("button", { name: "Open Workshop agenda", exact: true })).toHaveCount(0);
});

/** NP-SR-08 */
test("phone search recents", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  // Leave a recent page and a recent search behind.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(page.locator(".tiptap")).toContainText("Saturday");
  await page.evaluate(() => (window as any).prismShellUI.getState().openCommandBar());
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  const input = dialog.getByRole("combobox", { name: "Search notes and commands" });
  await expect(input).toBeFocused(); // keyboard up at once
  await input.fill("workshop");
  await dialog.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Field notes/ }).click();
  await page.evaluate(() => (window as any).prismShellUI.getState().openCommandBar());
  await expect(input).toBeFocused();
  // Full screen: the surface covers the whole viewport, field at the top.
  const box = (await page.getByTestId("phone-search").boundingBox())!;
  expect(box.x).toBeLessThanOrEqual(1);
  expect(box.y).toBeLessThanOrEqual(1);
  expect(box.width).toBeGreaterThanOrEqual(389);
  expect(box.height).toBeGreaterThanOrEqual(800);
  expect((await input.boundingBox())!.y).toBeLessThan(80);
  // Recent searches and recent pages before typing, 44 px rows.
  const searches = dialog.getByRole("group", { name: "Recent searches" });
  await expect(searches.getByRole("option", { name: "workshop" })).toBeVisible();
  const pages = dialog.getByRole("group", { name: "Recent pages" });
  await expect(pages.getByRole("option", { name: /Workshop agenda/ })).toBeVisible();
  for (const option of await dialog.getByRole("option").all()) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("phone-search-fullscreen.png") });
  await dialog.getByRole("button", { name: "Close search" }).click();
  await expect(dialog).toHaveCount(0);
});
