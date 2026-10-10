import { test, expect, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const width of [1440, 1024, 390, 320]) {
  test(`settings sections and device appearance work at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/e2e-fixtures/workspace.html");
    let dialog = await openSettings(page);
    await expect(dialog.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    if (width <= 640) {
      const navigation=dialog.getByRole("navigation",{name:"Settings sections"});
      expect((await navigation.boundingBox())!.height).toBeLessThan(65);
      expect(await dialog.locator(".prism-settings__content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await dialog.getByLabel("Editor Font", { exact: true }).selectOption("Georgia");
    await dialog.getByLabel("Code Font", { exact: true }).selectOption("Menlo");
    await dialog.getByLabel("Sidebar Label", { exact: true }).fill("Knowledge");
    await dialog.getByRole("button", { name: "AI & agent", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "AI & agent", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("alert")).toHaveCount(0); // a server-backed shell has no host config to fail on
    await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(dialog.getByLabel("Editor Font", { exact: true })).toHaveValue("Georgia");
    await expect(dialog.getByLabel("Sidebar Label", { exact: true })).toHaveValue("Knowledge");
    if (width === 320) await dialog.getByRole("button", { name: "Dark", exact: true }).click();
    else await dialog.getByRole("button", { name: "Light", exact: true }).click();
    await expect(dialog.locator(".prism-settings")).toHaveCSS("background-color", width === 320 ? "rgb(32, 33, 38)" : "rgb(255, 255, 255)");
    await expect(dialog.getByRole("heading", { name: "Settings", exact: true })).toHaveCSS("color", width === 320 ? "rgb(237, 238, 239)" : "rgb(41, 42, 48)");
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
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`), animations: "disabled" });
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

for (const [width,height,top,bottom] of [[390,844,59,34],[1024,768,24,20]]) test(`settings respect native safe insets at ${width}`, async ({page}, info) => {
 await page.setViewportSize({width,height}); await page.emulateMedia({reducedMotion:"reduce"});
 await page.goto("/e2e-fixtures/workspace.html");
 await page.evaluate(({top,bottom}) => {
  document.documentElement.style.setProperty("--prism-safe-area-top",`${top}px`);
  document.documentElement.style.setProperty("--prism-safe-area-bottom",`${bottom}px`);
 }, {top,bottom});
 const dialog=await openSettings(page), surface=dialog.locator(".prism-settings");
 const bounds=await surface.boundingBox(); expect(bounds!.y).toBeGreaterThanOrEqual(top); expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(height-bottom+1);
 const content=dialog.locator(".prism-settings__content");
 expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`settings-native-appearance-${width}.png`),animations:"disabled"});
 for (const section of ["Inputs & integrations","AI & agent","Advanced"]) {
  await dialog.getByRole("button",{name:section,exact:true}).click();
  expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
 }

 await content.evaluate(el => {el.scrollTop=el.scrollHeight;});
 await expect(dialog.getByRole("button",{name:"Close settings"})).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
 await page.screenshot({path:info.outputPath(`settings-native-${width}.png`),animations:"disabled"});
});
