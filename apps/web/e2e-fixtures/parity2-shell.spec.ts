import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 2 — clauses of the checklist that existed in the product but had no assertion.
 * Shell fixture (real App + HttpVaultClient over the intercepted fetch).
 */
async function typeInEditor(page: Page, text: string) {
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

/** NP-SB-15 / NP-OF-01: the footer (and the header) say "offline" and "waiting for the server" truthfully. */
test("footer reflects offline and waiting-for-server states", async ({ page, context }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const nav = page.locator(".workspace-navigation");
  const footer = nav.locator(".sync-state-footer");
  await expect(footer).toHaveText("Synced");
  // Settings sits in the same footer area of the sidebar.
  await expect(nav.getByRole("button", { name: /settings/i }).first()).toBeVisible();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible(); // loaded while online

  await context.setOffline(true);
  await typeInEditor(page, " Footer offline edit.");
  await expect(footer).toHaveText("Offline · saved on this device", { timeout: 8000 });

  // Back online, but the server does not answer: the change is still only on this device.
  await page.evaluate(() => { (window as any).prismShell.unreachable = true; });
  await context.setOffline(false);
  await expect(footer).toHaveText("Waiting for server", { timeout: 15000 });
  await expect(page.locator(".sync-state-header")).toContainText("Waiting for server");
  expect(await page.evaluate(() => (window as any).prismShell.note("workspace").content as string)).not.toContain("Footer offline edit.");

  // The server answers again: the queued save is delivered and only then is it "Synced".
  await page.evaluate(() => { (window as any).prismShell.unreachable = false; });
  await expect(footer).toHaveText("Synced", { timeout: 90000 });
  expect(await page.evaluate(() => (window as any).prismShell.note("workspace").content as string)).toContain("Footer offline edit.");
});

/** NP-MB-10: both iPad sizes get the desktop layout — persistent sidebar, hover peek, desktop shortcuts. */
test("tablet layouts", async ({ page }) => {
  for (const [width, height] of [[1024, 768], [820, 1180]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/e2e-fixtures/notion-shell.html");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    const nav = page.locator(".workspace-navigation");
    // Persistent sidebar beside the page, no phone bottom bar, no sideways scroll.
    await expect(nav, `${width}: sidebar`).toBeVisible();
    const box = (await nav.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBeLessThan(width / 2);
    await expect(page.getByRole("navigation", { name: "Mobile workspace" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no overflow`).toBe(true);
    // External keyboard: the desktop shortcuts work as they do on a Mac.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: "Search notes and commands" })).toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator(".tiptap[contenteditable=true]").click();
    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(nav).toHaveCount(0);
    // Pointer: hovering the left edge shows the sidebar as an overlay.
    await page.mouse.move(400, 400);
    await page.mouse.move(3, 400, { steps: 4 });
    await expect(page.getByRole("complementary", { name: "Sidebar preview" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(nav).toBeVisible();
  }
});

/** NP-PG-01: the icon picker is searchable; an icon can be changed and removed, and every surface follows. */
test("icon picker search, change and remove", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  const icon = () => page.evaluate(() => (window as any).prismShell.note("workspace").metadata.icon as string | undefined | null);
  const picker = page.locator(".EmojiPickerReact");
  const emojis = picker.locator("button.epr-emoji:visible");

  await page.getByRole("button", { name: "Add icon" }).click();
  await expect(picker).toBeVisible();
  await expect(emojis.first()).toBeVisible();
  const all = await emojis.count();
  // Search narrows the grid.
  await picker.locator("input").first().fill("rocket");
  await expect.poll(() => emojis.count()).toBeLessThan(all);
  await expect(emojis.first()).toBeVisible();
  await emojis.first().click();
  const tile = page.locator(".document-icon-control.has-icon");
  await expect(tile).toBeVisible();
  const first = (await tile.innerText()).trim();
  expect(first.length).toBeGreaterThan(0);
  await expect.poll(icon).toBe(first);
  await expect(tabs.locator('[data-page-icon="workspace"]')).toHaveText(first);

  // Change: the tile opens the same picker; another emoji replaces the first everywhere.
  await tile.click();
  await expect(picker).toBeVisible();
  await picker.locator("input").first().fill("tree");
  const treeEmoji = picker.locator('button.epr-emoji[data-full-name*="tree"]:visible').first();
  await expect(treeEmoji).toBeVisible();
  await treeEmoji.evaluate((el) => (el as HTMLElement).click()); // a sticky category label can sit over the first row
  await expect.poll(async () => (await tile.innerText()).trim()).not.toBe(first);
  const second = (await tile.innerText()).trim();
  await expect.poll(icon).toBe(second);
  await expect(tabs.locator('[data-page-icon="workspace"]')).toHaveText(second);

  // Remove: back to "Add icon", and the tab loses it.
  await tile.click();
  await page.getByRole("button", { name: "Remove icon" }).click();
  await expect(page.getByRole("button", { name: "Add icon" })).toBeVisible();
  await expect(page.locator(".document-icon-control.has-icon")).toHaveCount(0);
  await expect.poll(async () => !(await icon())).toBe(true);
  await expect(tabs.locator('[data-page-icon="workspace"]')).toHaveCount(0);
});

/** NP-SB-02: search is a row of the sidebar itself (⌘K is the same search from anywhere). */
test("search is a sidebar row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const nav = page.locator(".workspace-navigation");
  const field = nav.getByPlaceholder(/^Search/);
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", /⌘K/); // it names the shortcut
  // A row near the top: above the destinations and the page tree.
  expect((await field.boundingBox())!.y).toBeLessThan((await nav.getByRole("navigation", { name: "Workspace destinations" }).boundingBox())!.y);
  await field.fill("workshop");
  const results = nav.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Workshop agenda");
  await results.getByText("Workshop agenda").first().click();
  await expect(page.locator(".tiptap")).toContainText("Saturday");
});
