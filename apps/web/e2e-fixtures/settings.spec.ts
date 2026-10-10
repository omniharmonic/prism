/**
 * Settings: one calm set of sections, and every Appearance control changes what the
 * app actually reads (the writing surface, the interface, the sidebar) and is still
 * there after a reload.
 */
import { test, expect, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
const close = async (page: Page) => { await page.getByRole("button", { name: "Close settings" }).click(); await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0); };
const prose = (page: Page) => page.locator(".prose-editor").first();
const css = (page: Page, prop: string) => prose(page).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const firstFont = async (page: Page) => (await css(page, "font-family")).split(",")[0]!.replace(/['"]/g, "").trim();

test("sections: Appearance · Inputs & integrations · AI & agent · Advanced, none of them empty or in error", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const dialog = await openSettings(page);
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  // This fixture has no signed-in account and no server owner: Account, Notifications and Search index are left out.
  await expect(nav.getByRole("button")).toHaveText(["Appearance", "Inputs & integrations", "AI & agent", "Advanced"]);
  await expect(nav.getByRole("button", { name: "Appearance", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const name of ["Inputs & integrations", "AI & agent", "Advanced", "Appearance"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(dialog.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(await dialog.locator(".prism-settings__content").evaluate((el) => el.querySelectorAll("section, [role=note]").length)).toBeGreaterThan(0);
  }
  // Appearance holds theme, writing, typefaces, sidebar, motion and region.
  for (const title of ["Theme", "Writing", "Typefaces", "Sidebar", "Motion", "Language & region"]) await expect(dialog.getByRole("heading", { level: 4, name: title, exact: true })).toBeVisible();
  // Keyboard: the sections are reachable and operable without a pointer.
  await nav.getByRole("button", { name: "Appearance", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("button", { name: "Inputs & integrations", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { level: 3, name: "Inputs & integrations", exact: true })).toBeVisible();
});

test("Writing font + Editor Font change the writing surface's font, and stay after a reload", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(prose(page)).toContainText("A shared place to think");
  expect(await firstFont(page)).toBe("-apple-system");
  let dialog = await openSettings(page);
  await dialog.getByLabel("Writing font", { exact: true }).selectOption("serif");
  await dialog.getByLabel("Editor Font", { exact: true }).selectOption("Georgia");
  expect(await firstFont(page)).toBe("Georgia"); // applies at once, behind the dialog
  await dialog.getByLabel("Code Font", { exact: true }).selectOption("Menlo");
  await dialog.getByLabel("Writing font", { exact: true }).selectOption("mono");
  expect(await firstFont(page)).toBe("Menlo");
  await dialog.getByLabel("Writing font", { exact: true }).selectOption("serif");
  await close(page);
  await page.reload();
  await expect(prose(page)).toContainText("A shared place to think");
  expect(await firstFont(page)).toBe("Georgia");
  dialog = await openSettings(page);
  await expect(dialog.getByLabel("Writing font", { exact: true })).toHaveValue("serif");
  // Sans again: the writing surface follows the UI font.
  await dialog.getByLabel("Writing font", { exact: true }).selectOption("sans");
  await dialog.getByLabel("UI Font", { exact: true }).selectOption("Helvetica Neue");
  expect(await firstFont(page)).toBe("Helvetica Neue");
  expect((await page.evaluate(() => getComputedStyle(document.body).fontFamily)).split(",")[0]).toContain("Helvetica Neue");
});

test("Font Size changes interface and writing text; Page width widens the writing column; both persist", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(prose(page)).toContainText("A shared place to think");
  expect(await css(page, "font-size")).toBe("16px");
  const standard = await css(page, "max-width");
  const standardWidth = (await prose(page).boundingBox())!.width;
  const dialog = await openSettings(page);
  await dialog.getByLabel("Font Size", { exact: true }).fill("18");
  expect(await css(page, "font-size")).toBe("20px");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("18px");
  await dialog.getByLabel("Page width", { exact: true }).selectOption("wide");
  expect(await css(page, "max-width")).toBe("960px");
  expect(standard).not.toBe("960px");
  await close(page);
  await page.reload();
  await expect(prose(page)).toContainText("A shared place to think");
  expect(await css(page, "font-size")).toBe("20px");
  expect(await css(page, "max-width")).toBe("960px");
  expect((await prose(page).boundingBox())!.width).toBeGreaterThan(standardWidth + 80); // the column itself is wider on screen
  const again = await openSettings(page);
  await again.getByLabel("Page width", { exact: true }).selectOption("standard");
  expect(await css(page, "max-width")).toBe(standard);
});

test("Sidebar Label renames the pages section; Start with last open document lives under Advanced", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const dialog = await openSettings(page);
  await dialog.getByLabel("Sidebar Label", { exact: true }).fill("Knowledge");
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  const start = dialog.getByLabel("Start with last open document", { exact: true });
  await expect(start).toBeChecked();
  await start.uncheck();
  await close(page);
  await expect(page.getByRole("button", { name: "Knowledge", exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("prism-settings")!).state.startWithLastDocument)).toBe(false);
});

for (const theme of ["Light", "Dark"])
  test(`phone, ${theme}: every section fits 390px with 44px targets`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/e2e-fixtures/workspace.html?connections");
    const dialog = await openSettings(page);
    await dialog.getByRole("button", { name: theme, exact: true }).click();
    const nav = dialog.getByRole("navigation", { name: "Settings sections" });
    for (const name of ["Appearance", "Inputs & integrations", "AI & agent", "Advanced"]) {
      const tab = nav.getByRole("button", { name, exact: true });
      await tab.scrollIntoViewIfNeeded();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-pressed", "true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      expect(await dialog.locator(".prism-settings__content").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const small = await dialog.locator(".prism-settings__content").evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>("button, select, input:not([type=checkbox]):not([type=range])")]
          .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height < 44)
          .map((b) => `${b.tagName} ${b.getAttribute("aria-label") ?? b.textContent?.trim().slice(0, 30)} ${Math.round(b.getBoundingClientRect().height)}`));
      expect(small, `${name}: targets under 44px`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`settings-${theme}-${name.replace(/\W+/g, "-")}.png`) });
    }
  });
