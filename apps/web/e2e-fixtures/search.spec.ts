import { test, expect } from "@playwright/test";

test("search shows ranked passages and openly labels keyword fallback without rendering source HTML", async ({ page }, testInfo) => {
  const external: string[] = [];
  await page.route("https://untrusted.example.test/**", route => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/e2e-fixtures/search.html");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Ranked search");
  await expect(results).toContainText("A matching passage about connected ideas.");
  await page.evaluate(() => { (window as any).prismSearchFixture.semantic = "fail"; });
  await page.getByRole("textbox", { name: "Query", exact: true }).fill("context");
  await expect(results).toContainText("Keyword search · Ranked search is unavailable");
  await expect(results).toContainText("Shared context Documents & conversations.");
  await expect(results).not.toContainText("<h2>");
  await expect(results).not.toContainText("window.prismInjected");
  expect(external).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("search-results-mobile.png") });
});

test("failed revalidation and audience changes never expose cached search results", async ({ page }) => {
  await page.goto("/e2e-fixtures/search.html");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Connected ideas");
  await page.evaluate(() => { const w = window as any; w.prismSearchFixture.semantic = "fail"; w.prismSearchFixture.keyword = "fail"; void w.prismSearchClient.invalidateQueries({ queryKey: ["vault", "search"] }); });
  await expect(results.getByRole("alert")).toBeVisible();
  await expect(results).not.toContainText("Connected ideas");
  await page.evaluate(() => { const w = window as any; w.prismSearchFixture.semantic = "wait"; w.prismSearchFixture.keyword = "ok"; });
  await results.getByRole("button", { name: "Try again" }).click();
  await expect(results).toContainText("Searching…");
  await page.evaluate(() => { const w = window as any; const release = w.prismSearchFixture.release; w.prismSearchFixture.semantic = "ok"; w.prismSearchStore.setState({ scope: "search-b" }); release(); });
  await expect(results).toContainText("No matching notes");
  await expect(results).not.toContainText("Connected ideas");
});

test("phone search contains focus, announces keyboard selection, opens the result and restores the trigger", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/search.html");
  const trigger = page.getByRole("button", { name: "Open search", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  const input = dialog.getByRole("combobox", { name: "Search notes and commands" });
  await expect(input).toBeFocused();
  await input.fill("ideas");
  await expect(dialog.getByRole("option", { name: /Connected ideas/ })).toBeVisible();
  await expect(input).toHaveAttribute("aria-activedescendant", "prism-command-0");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close search" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("search-command-mobile.png") });
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as any).prismSearchUI.getState().activeTabId)).toBe("tab-source-a");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
