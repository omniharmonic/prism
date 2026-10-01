import { test, expect } from "@playwright/test";

test("shared workspace keeps writing and navigation available", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await expect(page.getByText("A shared place to think, write, and build with the same context.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Agent unavailable")).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-desktop.png", fullPage: true, animations: "disabled" });
});

test("mobile workspace fits the viewport and opens navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/workspace-mobile-document.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("button", { name: "Inbox" })).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-mobile.png", fullPage: true, animations: "disabled" });
});

test("mobile agent panel fills the screen and restores navigation focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  await agent.click();
  const panel = page.getByRole("dialog", { name: "Document panel" });
  await expect(panel).toBeVisible();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(390);
  await expect(panel.getByRole("tab", { name: "Agent", exact: true })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: "Agent", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByRole("tab", { name: "Details", exact: true })).toBeFocused();
  await expect(panel.getByRole("tab", { name: "Properties" })).toBeVisible();
  await panel.getByRole("tab", { name: "Agent", exact: true }).click();
  await expect(panel.getByText("Agent unavailable")).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-mobile-agent.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(agent).toBeFocused();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("button", { name: "Files", exact: true })).toBeFocused();
});

test("document title supports keyboard rename and cancel", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const title = page.getByRole("button", { name: "Rename A living workspace" });
  await title.focus();
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "Document title" });
  await expect(input).toBeFocused();
  await input.fill("Temporary title");
  await input.press("Escape");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  expect(await page.locator(".prose-editor ul").first().evaluate((node) => getComputedStyle(node).listStyleType)).toBe("disc");
});
