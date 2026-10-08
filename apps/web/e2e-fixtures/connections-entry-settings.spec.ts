import { test, expect } from "@playwright/test";

test("Settings → Inputs & integrations lists the inputs and opens Workspace settings at Connections", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?connections");
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Inputs & integrations", exact: true }).click();
  const inputs = dialog.getByRole("list", { name: "Inputs and integrations" });
  await expect(inputs.getByRole("listitem")).toHaveCount(8);
  await expect(inputs.locator('[data-input="matrix"]')).toContainText("Connected");
  await expect(inputs.locator('[data-input="notion"]')).toContainText("Not connected");
  await expect(dialog).toContainText("write-only");
  await expect(dialog.locator('input[type="password"], input[type="text"]')).toHaveCount(0); // no credential field of its own
  await dialog.getByRole("button", { name: "Manage connections", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismFixtureUI.getState().activeTabId)).toBe("tab-network");
  await expect(page.getByRole("tab", { name: "Connections", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("someone who cannot manage connections sees the list and who to ask, no dead button and no error", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Inputs & integrations", exact: true }).click();
  await expect(dialog.getByRole("list", { name: "Inputs and integrations" }).getByRole("listitem")).toHaveCount(8);
  await expect(dialog.getByRole("note")).toContainText("Workspace settings → Connections");
  await expect(dialog.getByRole("button", { name: "Manage connections" })).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
