import { test, expect } from "@playwright/test";

test("phone settings stay inside the viewport with touch-sized, keyboard reachable tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace-settings.html");
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
  const publish = page.getByRole("tab", { name: "Publish", exact: true });
  await expect(publish).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const tabs = page.getByRole("tablist");
  expect(await tabs.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.getByRole("tab").evaluateAll(items => items.every(item => item.getBoundingClientRect().height >= 44))).toBe(true);
  await publish.focus();
  await page.keyboard.press("End");
  const server = page.getByRole("tab", { name: "Server", exact: true });
  await expect(server).toBeFocused();
  await expect(server).toHaveAttribute("aria-selected", "true");
  const bounds = await server.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("workspace-settings-phone.png") });
});

test("members reach their vaults without mounting owner panels, including after a vault role change", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace-settings.html?member");
  await expect(page.getByRole("tab", { name: "Vaults", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveText(["Vaults", "Governance"]);
  expect(await page.evaluate(() => (window as any).prismSettingsFixture.publicationReads)).toBe(0);
  await page.goto("/e2e-fixtures/workspace-settings.html");
  await expect(page.getByRole("tab", { name: "Publish", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => (window as any).prismSettingsFixture.demote());
  await expect(page.getByRole("tab")).toHaveText(["Vaults", "Governance"]);
  await expect(page.getByRole("tab", { name: "Vaults", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Connected vaults", { exact: true })).toBeVisible();
});

test("connections without settings show a useful empty state and never read publications", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace-settings.html?none");
  await expect(page.getByRole("status")).toContainText("aren't available for this connection");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismSettingsFixture.publicationReads)).toBe(0);
});
