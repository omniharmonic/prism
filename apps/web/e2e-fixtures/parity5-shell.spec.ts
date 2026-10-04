import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 4 (docs: PARITY-EVIDENCE "Fourth pass") — clauses whose behaviour is on main and had no
 * assertion. Shell + pages fixtures. A clause the product does not meet is `test.fixme` with its reason
 * (PARITY-GAPS §a.1); nothing is weakened to pass.
 */
const editor = (page: Page) => page.locator(".tiptap[contenteditable=true]").first();
const title = (page: Page) => page.getByRole("textbox", { name: "Document title" });

/**
 * NP-SB-13: ⌘N / Ctrl+N creates an "Untitled" page with the title focused. A browser tab keeps the
 * combination for a new window, so it reaches the page only in the native shell (device row NP-NA-07);
 * the binding itself is the app's and is what this asserts.
 */
test("NP-SB-13: ⌘N creates an untitled page with the title focused — from the page and from inside the editor", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(editor(page)).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  const before = await tabs.getByRole("button", { name: /^Open Untitled/ }).count();

  await page.locator("body").press("ControlOrMeta+n");
  await expect(title(page)).toBeFocused();
  await expect(title(page)).toHaveValue(/^Untitled/);
  await expect(tabs.getByRole("button", { name: /^Open Untitled/ })).toHaveCount(before + 1);
  // No chooser was required before typing.
  await expect(page.getByRole("dialog", { name: /Choose page type|New page/ })).toHaveCount(0);

  // With the caret in the body the key still belongs to the app (the editor has no ⌘N of its own).
  await title(page).press("Enter");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".tiptap"))).toBe(true);
  await page.keyboard.type("in the body");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(title(page)).toBeFocused();
  await expect(title(page)).toHaveValue(/^Untitled/);
  await expect(tabs.getByRole("button", { name: /^Open Untitled/ })).toHaveCount(before + 2);

  // ⌘⇧N is not this command (left to the host).
  await title(page).press("Escape");
  await page.locator("body").press("ControlOrMeta+Shift+n");
  await page.waitForTimeout(300);
  await expect(tabs.getByRole("button", { name: /^Open Untitled/ })).toHaveCount(before + 2);
});

/** NP-PG-03: "a rename shows live in the tree, tabs and breadcrumbs" — the breadcrumb half. */
test("NP-PG-03: renaming a parent page shows in the breadcrumb of its open sub-page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/pages-nav.html?open=week1");
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  await expect(tabs.getByRole("button", { name: "Open Week 1", exact: true })).toBeVisible();
  await expect(crumbs.getByRole("button", { name: "Plan", exact: true })).toBeVisible();

  // Open the parent from the crumb and rename it from its title.
  await crumbs.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("button", { name: "Rename Plan", exact: true }).click();
  await title(page).fill("Roadmap");
  await title(page).press("Enter");
  await expect(page.getByRole("heading", { name: "Rename Roadmap", exact: true })).toBeVisible();

  // Back on the sub-page (its tab stayed open): the trail names the parent as it is now.
  await tabs.getByRole("button", { name: "Open Week 1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Week 1", exact: true })).toBeVisible();
  await expect(crumbs.getByRole("button", { name: "Roadmap", exact: true })).toBeVisible();
  await expect(crumbs.getByRole("button", { name: "Plan", exact: true })).toHaveCount(0);
  // …and the crumb still opens the renamed parent.
  await crumbs.getByRole("button", { name: "Roadmap", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Roadmap", exact: true })).toBeVisible();
});

async function openAppearance(page: Page) {
  await page.waitForFunction(() => !!(window as any).prismFixtureUI);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  return dialog;
}
const themeClass = (page: Page) => page.evaluate(() => (document.documentElement.classList.contains("light") ? "light" : "dark"));
const storedTheme = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("prism-settings") || "{}")?.state?.theme ?? null);

/** NP-AX-01: the theme SETTING (the dark sweep forces the class; this drives the control). */
test("NP-AX-01: Settings → Appearance switches between Light and Dark, and the choice survives a reload", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const dialog = await openAppearance(page);
  const light = dialog.getByRole("button", { name: /^light$/i });
  const dark = dialog.getByRole("button", { name: /^dark$/i });
  await expect(light).toBeVisible();
  await expect(dark).toBeVisible();

  await light.click();
  await expect(light).toHaveAttribute("aria-pressed", "true");
  await expect(dark).toHaveAttribute("aria-pressed", "false");
  expect(await themeClass(page)).toBe("light");
  expect(await storedTheme(page)).toBe("light");
  // The dialog itself follows: a light surface, dark text.
  const lum = (rgb: string) => { const m = rgb.match(/\d+(\.\d+)?/g)!.map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
  expect(lum(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))).toBeGreaterThan(0.8);

  await dark.click();
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  expect(await themeClass(page)).toBe("dark");
  expect(await storedTheme(page)).toBe("dark");
  expect(lum(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))).toBeLessThan(0.25);

  await light.click();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).prismFixtureUI);
  expect(await themeClass(page)).toBe("light");
});

/**
 * NP-AX-01 "Light/Dark/System setting" — BEHAVIOUR GAP: the setting offers Dark and Light only
 * (`Theme = "dark" | "light"` in app/stores/settings.ts; Settings.tsx renders those two buttons).
 * There is no System choice that follows `prefers-color-scheme`.
 */
test.fixme("NP-AX-01: the theme setting offers System, which follows the OS colour scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/e2e-fixtures/workspace.html");
  const dialog = await openAppearance(page);
  await dialog.getByRole("button", { name: /^system$/i }).click();
  expect(await themeClass(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => themeClass(page)).toBe("dark");
});
