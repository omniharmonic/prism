import { test, expect, type Page } from "@playwright/test";

/** Wave 2E · NP-AX-06: 120–180 ms surfaces; none under reduced motion (OS or in-app). */
const ms = (value: string) => Math.max(...value.split(",").map((v) => (v.trim().endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000)));
async function paletteDuration(page: Page): Promise<number> {
  await page.keyboard.press("ControlOrMeta+k");
  const sheet = page.locator(".prism-search-sheet");
  await expect(sheet).toBeVisible();
  const value = await sheet.evaluate((node) => getComputedStyle(node).animationDuration);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  return ms(value);
}

test("reduced motion disables transitions", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const normal = await paletteDuration(page);
  expect(normal).toBeGreaterThanOrEqual(120);
  expect(normal).toBeLessThanOrEqual(180);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await paletteDuration(page)).toBeLessThanOrEqual(1);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await paletteDuration(page)).toBeGreaterThanOrEqual(120);
  // The in-app setting does the same, persists on this device and survives reload.
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
  await page.keyboard.press("Escape");
  expect(await paletteDuration(page)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
});
