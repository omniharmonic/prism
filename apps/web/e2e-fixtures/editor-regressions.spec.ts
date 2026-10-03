import { test, expect, type Page } from "@playwright/test";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;

/** Relative luminance of a computed `rgb(...)`/`rgba(...)` colour (alpha 0 → null). */
async function surfaceLuminances(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const lum = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(",").map((v) => Number(v.trim()));
      if (a === 0) return null;
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const out: Array<{ el: string; lum: number }> = [];
    for (const el of [root, ...root.querySelectorAll("*")] as HTMLElement[]) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 24) continue; // ignore thumbs, dots, icons
      const l = lum(getComputedStyle(el).backgroundColor);
      if (l !== null) out.push({ el: `${el.tagName}.${String(el.className).slice(0, 60)}`, lum: l });
    }
    return out;
  }, selector);
}

test("a focused editor does not draw a box around the whole document", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await editor.locator("p").first().click();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  expect(await editor.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/focused-editor-1440.png` });
});

for (const how of ["before mount", "after mount"] as const) {
  test(`the document companion stays dark in dark mode (${how})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/e2e-fixtures/workspace.html${how === "before mount" ? "?dark" : ""}`);
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    if (how === "after mount") {
      await page.evaluate(() => { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); });
    }
    await expect(page.locator(".document-companion")).toBeVisible();
    for (const tab of ["Agent", "Details", "Activity"]) {
      const control = page.locator(".document-companion").getByRole("tab", { name: tab, exact: true });
      if (await control.count()) await control.click();
      const surfaces = await surfaceLuminances(page, ".document-companion");
      expect(surfaces, tab).not.toBeNull();
      const light = surfaces!.filter((s) => s.lum > 0.4);
      expect(light, `${tab}: light surfaces inside the dark companion`).toEqual([]);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/dark-companion-${how.replace(" ", "-")}-1440.png` });
  });
}
