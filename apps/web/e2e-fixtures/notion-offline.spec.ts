import { test, expect } from "@playwright/test";

/** Wave 2E · NP-OF-04: favorites, recents and pinned pages read with no connection. */
test("favorites readable offline after prefetch", async ({ page, context }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html?favorites");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  // The favorite was never opened, yet it is fetched in the background.
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.reads.includes("agenda")), { timeout: 10_000 }).toBe(true);
  // Per-page toggle in the page ⋯ menu, remembered for this account + vault.
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Make available offline/ }).click();
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Remove offline copy/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await context.setOffline(true);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(page.getByText("Saturday: opening discussion", { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath("offline-favorite.png") });
  // An uncached page is honestly unavailable, never a blank editor.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.getByText("Notes from the last conversation")).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByText("Notes from the last conversation")).toBeVisible({ timeout: 15_000 });
});
