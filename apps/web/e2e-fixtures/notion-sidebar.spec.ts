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

/** NP-SB-13 */
test("one action → focused untitled page", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const nav = page.locator(".workspace-navigation");
  const started = Date.now();
  await nav.getByRole("button", { name: "New page", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await expect(title).toBeFocused();
  expect(Date.now() - started).toBeLessThan(1500); // fixture + Playwright overhead; no dialog in between
  await expect(title).toHaveValue("Untitled (2)"); // "Untitled" already exists beside the open page
  await expect(page.getByRole("dialog", { name: "New page", exact: true })).toHaveCount(0);
  // Created next to the page you were on, and you can just type the name.
  await title.fill("Sprint notes");
  await title.press("Enter");
  await expect(page.getByRole("button", { name: "Rename Sprint notes", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismShell.note("created-1")?.path)).toBe("Projects/Prism/Sprint notes");
  // The type/location chooser is one click away, never in the way.
  await nav.getByRole("button", { name: "Choose page type", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New page", exact: true })).toBeVisible();
});

/** NP-SB-11 */
test("⌘\\ collapses and width persists", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?persisted");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  const nav = page.locator(".workspace-navigation");
  await expect(nav).toBeVisible();
  // ⌘\ works from inside the editor too (⌘B there is bold).
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(nav).toHaveCount(0);
  await expect(page.getByTestId("sidebar-peek-zone")).toBeVisible();
  // ⌘⇧\ is the info panel now; it leaves the sidebar alone.
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  await expect(page.getByRole("button", { name: "Info panel (⌘⇧\\)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(nav).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  // Collapsed survives a reload.
  await page.reload();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(nav).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(nav).toBeVisible();
  // Drag the divider: the new width survives a reload, clamped to 200–400.
  const before = (await nav.boundingBox())!;
  await page.mouse.move(before.x + before.width + 2, 300);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 62, 300, { steps: 5 });
  await page.mouse.up();
  const dragged = (await nav.boundingBox())!.width;
  expect(dragged).toBeGreaterThan(before.width + 40);
  await page.reload();
  await expect(nav).toBeVisible();
  expect(Math.abs((await nav.boundingBox())!.width - dragged)).toBeLessThanOrEqual(1);
});
