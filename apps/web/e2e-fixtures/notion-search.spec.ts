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
