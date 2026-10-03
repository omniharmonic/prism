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

test("the sidebar peek is reachable and dismissible from the keyboard", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?collapsed");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const trigger = page.getByRole("button", { name: "Show sidebar preview" });
  await trigger.focus();
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Enter");
  const peek = page.getByRole("complementary", { name: "Sidebar preview" });
  await expect(peek).toBeVisible();
  expect(await peek.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  // Mouse-out does not take a keyboard-opened preview away.
  await page.mouse.move(900, 400);
  await page.waitForTimeout(350);
  await expect(peek).toBeVisible();
  // Only one navigation exists at a time.
  await expect(page.locator(".workspace-navigation")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show sidebar preview" })).toBeFocused();
});
