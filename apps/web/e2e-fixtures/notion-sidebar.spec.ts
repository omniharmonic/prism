import { test, expect } from "@playwright/test";

/** Wave 2E · NP-SB-12 */
test("collapsed sidebar peeks on edge hover", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html?collapsed");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const peek = page.getByRole("complementary", { name: "Sidebar preview" });
  await expect(peek).toHaveCount(0);
  await page.mouse.move(400, 400);
  await page.mouse.move(3, 400, { steps: 4 });
  await expect(peek).toBeVisible();
  await expect(peek.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("sidebar-peek.png") });
  // Floating: the document keeps its width underneath.
  const zone = await page.getByTestId("sidebar-peek-zone").boundingBox();
  expect(zone!.width).toBeLessThanOrEqual(12);
  await page.mouse.move(900, 400, { steps: 6 });
  await expect(peek).toHaveCount(0);
  await page.mouse.move(3, 300, { steps: 4 });
  await expect(peek).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  // The pinned sidebar replaces the peek entirely.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("sidebar-peek-zone")).toHaveCount(0);
});
