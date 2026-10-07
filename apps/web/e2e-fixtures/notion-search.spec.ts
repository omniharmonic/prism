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
  await panel.getByRole("combobox", { name: "Created by" }).selectOption("me");
  await expect(results.getByRole("option")).toHaveCount(3);
  await expect(results).not.toContainText("Workshop agenda");
  await panel.getByRole("combobox", { name: "Created by" }).selectOption("anyone");
  await panel.getByRole("combobox", { name: "Date" }).selectOption("year");
  await expect(page.getByRole("status").filter({ hasText: "1 filter" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("search-filters-desktop.png") });
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(results.getByRole("option")).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

/** NP-SR-04: "Created by me" beside "Edited by me"; the two combine; the date range narrows. */
test("created by me and edited by me are separate filters that combine; the date range narrows", async ({ page }) => {
  // ?authors: "Workshop agenda" was created by someone else and last edited by this account.
  await page.goto("/e2e-fixtures/notion-shell.html?authors");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("workshop");
  const results = page.getByRole("group", { name: "Notes" });
  await expect(results.getByRole("option")).toHaveCount(4);
  await page.getByRole("button", { name: "Filters" }).click();
  const panel = page.getByRole("group", { name: "Search filters" });
  const created = panel.getByRole("combobox", { name: "Created by" });
  const edited = panel.getByRole("combobox", { name: "Edited by" });
  await expect(created.locator("option")).toHaveText(["Created by anyone", "Created by me"]);
  await expect(edited.locator("option")).toHaveText(["Edited by anyone", "Edited by me"]);

  const lastSearch = async () => new URLSearchParams((await page.evaluate(() => (window as any).prismShell.searches as string[])).at(-1));
  // Edited by me = the SERVER's `editor=me` (the last-writer stamp is an opaque id the client cannot compare).
  await edited.selectOption("me");
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results).toContainText("Workshop agenda");
  expect((await lastSearch()).get("editor")).toBe("me");
  expect((await lastSearch()).get("author")).toBeNull();
  // Created by me = `author=me` (creator only): the page I only edited is out.
  await edited.selectOption("anyone");
  await created.selectOption("me");
  await expect(results.getByRole("option")).toHaveCount(3);
  await expect(results).not.toContainText("Workshop agenda");
  expect((await lastSearch()).get("author")).toBe("me");
  expect((await lastSearch()).get("editor")).toBeNull();
  // Both: created by me AND last edited by me — the server applies both; two filters are counted.
  await edited.selectOption("me");
  await expect(results.getByRole("option")).toHaveCount(0);
  expect([(await lastSearch()).get("author"), (await lastSearch()).get("editor")]).toEqual(["me", "me"]);
  await expect(page.getByRole("button", { name: "Filters · 2" })).toBeVisible();
  // They combine with the other filters.
  await edited.selectOption("anyone");
  await panel.getByRole("combobox", { name: "Type" }).selectOption("database");
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results.getByRole("option")).toContainText("Workshop tracker");

  // Date range: three of the four were edited on 2026-10-01, the agenda on 2026-05-02. What each
  // range keeps is worked out from today's date, so the assertion holds whenever the suite runs.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(results.getByRole("option")).toHaveCount(4);
  const stamps = ["2026-10-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-05-02T09:00:00.000Z"];
  const within = (days: number) => {
    const from = Date.parse(`${new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`);
    return stamps.filter((s) => Date.parse(s) >= from).length;
  };
  expect(within(365)).toBeGreaterThan(within(30)); // the fixture's dates still tell the two ranges apart
  await panel.getByRole("combobox", { name: "Date" }).selectOption("year");
  await expect(results.getByRole("option")).toHaveCount(within(365));
  await panel.getByRole("combobox", { name: "Date" }).selectOption("month");
  await expect(results.getByRole("option")).toHaveCount(within(30));
  await expect(results).not.toContainText("Workshop agenda");
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  expect((await page.evaluate(() => (window as any).prismShell.searches as string[])).at(-1)).toContain(`after=${monthAgo}`);
});

/** Review F1: an identity filter is offered only where the server can answer it. */
test("an older server offers no \"Edited by\"; a share-link viewer gets neither identity filter", async ({ page }) => {
  for (const [query, has] of [["?oldserver", { created: 1, edited: 0 }], ["?linkviewer", { created: 0, edited: 0 }], ["", { created: 1, edited: 1 }]] as const) {
    await page.goto(`/e2e-fixtures/notion-shell.html${query}`);
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search notes and commands" }).fill("workshop");
    await expect(page.getByRole("group", { name: "Notes" }).getByRole("option")).toHaveCount(4);
    await page.getByRole("button", { name: "Filters" }).click();
    const panel = page.getByRole("group", { name: "Search filters" });
    await expect(panel.getByRole("combobox", { name: "Type" })).toBeVisible();
    await expect(panel.getByRole("combobox", { name: "Created by" }), query).toHaveCount(has.created);
    await expect(panel.getByRole("combobox", { name: "Edited by" }), query).toHaveCount(has.edited);
  }
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
test("⌘K keeps its rows while the next search is in flight; Enter opens the row that is showing", async ({ page }) => {
  const input = await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  const notes = page.getByRole("group", { name: "Notes" });
  await input.fill("agenda");
  const row = notes.getByRole("option", { name: /Workshop agenda/ });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-selected", "true");

  // The server is slow from here on: the next search does not answer until released.
  await page.evaluate(() => { (window as any).prismShell.searchHold = true; });
  const before = await page.evaluate(() => (window as any).prismShell.searches.length as number);
  await input.pressSequentially(" work");
  // While typing (debounce) and while the request is in flight, the row never leaves.
  await expect(row).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.searchWaiting.length as number)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).prismShell.searches.length as number)).toBeGreaterThan(before);
  await expect(dialog).toContainText("Searching…");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(dialog).not.toContainText("No matching notes");

  // Enter in that gap opens the row on screen.
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  await expect(tabs.getByRole("button", { name: "Open Workshop agenda", exact: true })).toHaveAttribute("aria-current", "page");
  await page.evaluate(() => (window as any).prismShell.releaseSearch());

  // When the slow answer arrives it replaces the held rows (here: nothing matches).
  await page.keyboard.press("ControlOrMeta+k");
  const again = page.getByRole("combobox", { name: "Search notes and commands" });
  await again.fill("agenda");
  await expect(notes.getByRole("option", { name: /Workshop agenda/ })).toBeVisible();
  await page.evaluate(() => { (window as any).prismShell.searchHold = true; });
  await again.pressSequentially(" zzzz");
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.searchWaiting.length as number)).toBeGreaterThan(0);
  await expect(notes.getByRole("option", { name: /Workshop agenda/ })).toBeVisible();
  await page.evaluate(() => (window as any).prismShell.releaseSearch());
  await expect(page.getByRole("option", { name: /Workshop agenda/ })).toHaveCount(0);
  await expect(dialog).toContainText("No matching notes");
  // Clearing the field goes back to recents at once — no stale search rows.
  await again.fill("");
  await expect(dialog).not.toContainText("No matching notes");
  await expect(page.getByRole("option", { name: /Library\/Workshop agenda/ })).toHaveCount(0);
});

test("commands carry icons and shortcut hints; Toggle theme works from the palette and the keyboard", async ({ page }) => {
  const input = await openPalette(page);
  await input.fill("toggle");
  const commands = page.getByRole("group", { name: "Commands" });
  const theme = commands.getByRole("option", { name: "Toggle theme", exact: true });
  await expect(theme).toBeVisible();
  await expect(theme).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+Shift\+L$/);
  await expect(theme.locator("kbd")).toHaveText(/^(⌘⇧L|Ctrl\+Shift\+L)$/);
  await expect(theme.locator("svg")).toHaveCount(1);
  await expect(commands.getByRole("option", { name: "Toggle sidebar", exact: true }).locator("kbd")).toHaveText(/^(⌘\\|Ctrl\+\\)$/);
  const isLight = () => page.evaluate(() => document.documentElement.classList.contains("light"));
  const before = await isLight();
  await theme.click();
  await expect.poll(isLight).toBe(!before);
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect.poll(isLight).toBe(before);
  // The required commands are all there, each with an icon.
  await page.keyboard.press("ControlOrMeta+k");
  for (const [query, name] of [["new page", "New page"], ["template", "New page from template"], ["trash", "Open Trash"], ["settings", "Settings"], ["inbox", "Open Inbox"]] as const) {
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

/** A mouse press is on an ITEM, not on a place: results that land between down and up move the row. */
test("⌘K: a press on a command runs it when page results land between mouse down and up", async ({ page }) => {
  const input = await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await page.evaluate(() => {
    const shell = (window as any).prismShell;
    shell.serverCreate("Library/Theme ideas", "<p>A theme for the season.</p>");
    shell.serverCreate("Library/Theme colours", "<p>Every theme has colours.</p>");
    shell.searchHold = true;
  });
  const dark = () => page.evaluate(() => document.documentElement.classList.contains("light"));
  const before = await dark();
  await input.fill("theme");
  const command = dialog.getByRole("option", { name: "Toggle theme" });
  await expect(command).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.searchWaiting.length as number)).toBeGreaterThan(0);
  const at = (await command.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  // The page results arrive while the button is down: the command row is pushed down the list.
  await page.evaluate(() => (window as any).prismShell.releaseSearch());
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option")).toHaveCount(2);
  expect((await command.boundingBox())!.y).toBeGreaterThan(at.y + at.height);
  await page.mouse.up();
  // The pressed command ran, once; the page row the pointer ended on did not open.
  await expect(dialog).toHaveCount(0);
  expect(await dark()).toBe(!before);
  await expect(page.getByRole("navigation", { name: "Open document tabs" }).getByRole("button", { name: /Theme (ideas|colours)/ })).toHaveCount(0);

  // An ordinary press (nothing moves) runs once too.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("toggle theme");
  await dialog.getByRole("option", { name: "Toggle theme" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await dark()).toBe(before);
});

test("⌘K: dragging from one row to another, or out of the list, opens nothing", async ({ page }) => {
  const input = await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await input.fill("workshop");
  const rows = page.getByRole("group", { name: "Notes" }).getByRole("option");
  await expect(rows).toHaveCount(4);
  await expect(dialog).not.toContainText("Searching…");
  const tabs = page.getByRole("navigation", { name: "Open document tabs" }).getByRole("button", { name: /^Open / });
  const open = await tabs.count();
  const first = (await rows.nth(0).boundingBox())!;
  const second = (await rows.nth(1).boundingBox())!;
  await page.mouse.move(first.x + 40, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + 40, second.y + second.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.move(first.x + 40, first.y + first.height / 2);
  await page.mouse.down();
  const field = (await input.boundingBox())!;
  await page.mouse.move(field.x + 30, field.y + field.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(tabs).toHaveCount(open);
});

/** Review: "moved" is judged in the list's own coordinates — scrolling the list is not the row moving. */
test("⌘K: scrolling the list while the button is down does not run the pressed row", async ({ page }) => {
  await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await dialog.getByRole("button", { name: "Commands", exact: true }).click();
  const list = dialog.getByRole("listbox", { name: "Notes and commands" });
  const rows = list.getByRole("option");
  await expect(rows.first()).toBeVisible();
  // The list is taller than its box (otherwise there is nothing to scroll).
  expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(120);
  const first = (await rows.first().boundingBox())!;
  await page.mouse.move(first.x + 60, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.wheel(0, 160);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await page.mouse.up();
  // The pointer came up over another row of an UNCHANGED list: nothing ran.
  await page.waitForTimeout(150);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Search notes and commands" })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("⌘K: a press that never got its release is forgotten — a later click elsewhere does not run it", async ({ page }) => {
  const input = await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await page.evaluate(() => {
    const shell = (window as any).prismShell;
    shell.serverCreate("Library/Theme ideas", "<p>A theme for the season.</p>");
    shell.searchHold = true;
  });
  const light = () => page.evaluate(() => document.documentElement.classList.contains("light"));
  const before = await light();
  await input.fill("theme");
  const command = dialog.getByRole("option", { name: "Toggle theme" });
  await expect(command).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.searchWaiting.length as number)).toBeGreaterThan(0);
  // A press whose release the page never sees (the button came up outside the window).
  await command.evaluate((el) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, pointerId: 1 })));
  await page.evaluate(() => (window as any).prismShell.releaseSearch());
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option")).toHaveCount(1); // the row has moved
  // Clicking the search field is a new press somewhere else.
  await input.click();
  await page.waitForTimeout(150);
  await expect(dialog).toBeVisible();
  expect(await light()).toBe(before);
  // The same for a right-click and for the window losing focus.
  for (const forget of ["contextmenu", "blur"] as const) {
    await command.evaluate((el) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, pointerId: 1 })));
    await page.evaluate((type) => (type === "blur" ? window.dispatchEvent(new Event("blur")) : document.querySelector('[role="listbox"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), forget);
    await input.evaluate((el) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, pointerId: 1 })));
    await page.waitForTimeout(100);
    await expect(dialog, `after ${forget}`).toBeVisible();
    expect(await light(), `after ${forget}`).toBe(before);
  }
});

test("⌘K: Enter while a mouse press is pending runs the selected row only", async ({ page }) => {
  // A recent search "theme" and a page that matches it.
  const input = await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await page.evaluate(() => (window as any).prismShell.serverCreate("Library/Theme ideas", "<p>A theme for the season.</p>"));
  await input.fill("theme");
  await page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Theme ideas/ }).click();
  await expect(dialog).toHaveCount(0);
  const light = () => page.evaluate(() => document.documentElement.classList.contains("light"));
  const before = await light();

  await page.keyboard.press("ControlOrMeta+k");
  const field = page.getByRole("combobox", { name: "Search notes and commands" });
  const recent = page.getByRole("group", { name: "Recent searches" }).getByRole("option", { name: "theme" });
  await expect(recent).toBeVisible();
  const command = dialog.getByRole("option", { name: "Toggle theme" });
  await command.scrollIntoViewIfNeeded();
  const at = (await command.boundingBox())!;
  await page.mouse.move(at.x + 60, at.y + at.height / 2);
  await page.mouse.down();
  // Safari leaves focus in the search field on a mouse press; Chromium moves it to the row. Same start for both.
  await field.focus();
  // The pointer rests on the search field (rows scrolling under a still pointer would re-select themselves,
  // and the top of the sheet is the part that does not move when the list changes).
  const rest = (await field.boundingBox())!;
  await page.mouse.move(rest.x + rest.width - 30, rest.y + rest.height / 2, { steps: 3 });
  // With the button still down, the keyboard goes to the recent search and runs it.
  for (let i = 0; i < 40 && (await recent.getAttribute("aria-selected")) !== "true"; i++) await page.keyboard.press("ArrowUp");
  await expect(recent).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("theme");
  await page.mouse.up();
  // Only the recent search ran: the palette is open on "theme" and the pressed command did not run.
  await page.waitForTimeout(150);
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("theme");
  expect(await light()).toBe(before);
});
