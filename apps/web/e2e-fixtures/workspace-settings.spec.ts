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

test("delegated vault admins retain Members but cannot manage global vaults or federation", async ({ page }) => {
 await page.goto("/e2e-fixtures/workspace-settings.html?admin");
 await expect(page.getByRole("tab", { name:"Members", exact:true })).toBeVisible();
 await expect(page.getByRole("tab", { name:"Federate", exact:true })).toHaveCount(0);
 await expect(page.getByRole("tab", { name:"Workspaces", exact:true })).toHaveCount(0);
 await expect(page.getByRole("tab", { name:"Access", exact:true })).toHaveCount(0);
 await page.getByRole("tab", { name:"Vaults", exact:true }).click();
 await expect(page.getByText("Shared", { exact:true })).toBeVisible();
 await expect(page.getByRole("button", { name:/remove|create|link/i })).toHaveCount(0);
});

for (const width of [1024, 1440]) test(`settings section navigation at ${width}px`, async ({page}) => {
 await page.setViewportSize({width,height:900});
 await page.emulateMedia({reducedMotion:"reduce"});
 await page.goto("/e2e-fixtures/workspace-settings.html");
 await expect(page.getByRole("tablist")).toHaveAttribute("aria-orientation","vertical");
 const publish = page.getByRole("tab",{name:"Publish",exact:true});
 await publish.focus(); await page.keyboard.press("ArrowDown");
 await expect(page.getByRole("tab",{name:"Federate",exact:true})).toBeFocused();
 await page.getByRole("tab",{name:"Vaults",exact:true}).click();
 await expect(page.getByText("Connected vaults",{exact:true})).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.screenshot({path:test.info().outputPath(`settings-${width}.png`)});
});

for (const width of [390,1440]) test(`dark settings material at ${width}px`, async ({page}) => {
 await page.setViewportSize({width,height:900});
 await page.goto("/e2e-fixtures/workspace-settings.html?dark");
 await page.getByRole("tab",{name:"Vaults",exact:true}).click();
 await expect(page.getByText("Shared",{exact:true})).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.screenshot({path:test.info().outputPath(`settings-dark-${width}.png`)});
});

for (const width of [390,1024]) test(`workspace settings content gutters at ${width}px`, async ({page}, info) => {
 await page.setViewportSize({width,height:900}); await page.emulateMedia({reducedMotion:"reduce"});
 await page.goto("/e2e-fixtures/workspace-settings.html");
 const content=page.locator(".network-workspace-content");
 for (const section of ["Publish","Members","Vaults"]) {
  await page.getByRole("tab",{name:section,exact:true}).click();
  expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  await page.screenshot({path:info.outputPath(`workspace-${section.toLowerCase()}-${width}.png`),animations:"disabled"});
 }
});
