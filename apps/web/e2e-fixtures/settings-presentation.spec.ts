import { test, expect, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const width of [1440, 390, 320]) {
  test(`settings sections and device appearance work at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/e2e-fixtures/workspace.html");
    let dialog = await openSettings(page);
    await expect(dialog.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    await dialog.getByLabel("Editor Font", { exact: true }).selectOption("Georgia");
    await dialog.getByLabel("Code Font", { exact: true }).selectOption("Menlo");
    await dialog.getByLabel("Sidebar Label", { exact: true }).fill("Knowledge");
    await dialog.getByRole("button", { name: "Services", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Services", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "Data Sources", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(dialog.getByLabel("Editor Font", { exact: true })).toHaveValue("Georgia");
    await expect(dialog.getByLabel("Sidebar Label", { exact: true })).toHaveValue("Knowledge");
    if (width === 320) await dialog.getByRole("button", { name: "Dark", exact: true }).click();
    else await dialog.getByRole("button", { name: "Light", exact: true }).click();
    const contrast = await dialog.evaluate(el => {
      const heading = el.querySelector("h2")!;
      const surface = el.querySelector(".prism-settings")!;
      const luminance = (color: string) => {
        const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
        return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
      };
      const text = luminance(getComputedStyle(heading).color), background = luminance(getComputedStyle(surface).backgroundColor);
      return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
    });
    expect(contrast).toBeGreaterThan(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });
    await dialog.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    dialog = await openSettings(page);
    await expect(dialog.getByLabel("Editor Font", { exact: true })).toHaveValue("Georgia");
    await expect(dialog.getByLabel("Code Font", { exact: true })).toHaveValue("Menlo");
    await expect(dialog.getByLabel("Sidebar Label", { exact: true })).toHaveValue("Knowledge");
    await dialog.getByRole("button", { name: "Close settings" }).focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
