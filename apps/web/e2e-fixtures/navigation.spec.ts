import { test, expect } from "@playwright/test";

test("writing navigation keeps the vault above the page tree and tools reachable", async ({ page }, testInfo) => {
  await page.goto("/e2e-fixtures/workspace.html?navigation");
  const nav = page.locator(".workspace-navigation");
  const selector = nav.getByRole("button", { name: "Switch vault" });
  await expect(selector).toContainText("Personal vault");
  expect((await selector.boundingBox())!.y).toBeLessThan((await nav.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Messages", exact: true }).boundingBox())!.y);
  await expect(nav.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Calendar", exact: true })).toHaveCount(0);
  await nav.getByRole("button", { name: "Tools", exact: true }).click();
  for (const name of ["Calendar", "People", "Automations", "Map"]) await expect(nav.getByRole("button", { name, exact: true })).toBeVisible();
  await selector.click();
  const menu = nav.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Personal workspace" })).toBeVisible();
  expect((await menu.boundingBox())!.y).toBeGreaterThan((await selector.boundingBox())!.y);
  await menu.getByRole("menuitem", { name: "Shared research" }).click();
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([{ switchedVault: "secondary" }]);
  await expect(menu).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("navigation-desktop-light.png") });
});

test("phone navigation preserves document state and has readable creation and settings actions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("prism-settings", JSON.stringify({ state: { theme: "light" }, version: 0 })));
  await page.goto("/e2e-fixtures/workspace.html?navigation");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const nav = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(nav.getByRole("button", { name: "Switch vault" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Workspace settings", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Map", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("navigation-phone-light.png") });
  await nav.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
});


test("dark writing navigation retains every specialist destination", async ({ page }, testInfo) => {
  await page.goto("/e2e-fixtures/workspace.html?navigation&dark");
  await expect(page.getByRole("button", { name: "Switch vault" })).toContainText("Personal vault");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("navigation-desktop-dark.png") });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const nav = page.locator(".workspace-navigation");
  for (const name of ["New page", "Workspace settings", "Calendar", "People", "Automations", "Map"]) await expect(nav.getByRole("button", { name, exact: true })).toBeVisible();
  expect(await nav.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});


test("sidebar preferences pin, hide and order tools without changing document data", async ({ page }, testInfo) => {
  await page.goto("/e2e-fixtures/workspace.html?navigation");
  await page.getByRole("button", { name: "Customize sidebar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Your sidebar" });
  await dialog.getByLabel("Calendar placement").selectOption("pinned");
  await dialog.getByLabel("People placement").selectOption("pinned");
  await dialog.getByLabel("Map placement").selectOption("hidden");
  await dialog.getByLabel("Navigation spacing").selectOption("compact");
  await dialog.getByRole("button", { name: "Move People up", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("sidebar-preferences.png") });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const primary = page.getByRole("navigation", { name: "Workspace destinations" });
  expect(await primary.getByRole("button").allTextContents()).toEqual(["Messages", "", "People", "Calendar"]);
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
  await page.reload();
  await expect(primary.getByRole("button", { name: "People", exact: true })).toBeVisible();
  await expect(page.locator(".workspace-navigation")).toHaveAttribute("data-density", "compact");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.locator(".workspace-navigation").getByRole("button", { name: "Map", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Customize sidebar", exact: true }).click();
  await dialog.getByRole("button", { name: "Restore defaults" }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".workspace-navigation").getByRole("button", { name: "Map", exact: true })).toBeVisible();
});

test("phone sidebar customization is keyboard dismissible and fits narrow screens", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/e2e-fixtures/workspace.html?navigation");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const opener = page.getByRole("button", { name: "Customize sidebar", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Your sidebar" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sidebar-preferences-phone.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
