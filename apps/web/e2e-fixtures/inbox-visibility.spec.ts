import { test, expect } from "@playwright/test";

for (const width of [1440, 390, 720]) {
  test(`classified inbox shows a conversation initially at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 720 ? 500 : 844 });
    await page.goto("/e2e-fixtures/inbox.html");
    const low = page.getByRole("button", { name: /^Low Priority/ });
    await expect(low).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: /Planning group/ })).toBeVisible();
    for (const name of [/^Social/, /^Reviewed/, /^Handled/])
      await expect(page.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.classList.toggle("light", theme === "light"), theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`classified-inbox-${width}-${theme}.png`), animations: "disabled" });
    }
    await low.click();
    await expect(low).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => (window as any).prismInboxQuery.invalidateQueries({ queryKey: ["vault", "inbox"] }));
    await expect(low).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: /Planning group/ })).toHaveCount(0);
    await low.click();
    await page.getByRole("button", { name: /Planning group/ }).click();
    await expect(page.getByRole("region", { name: "Conversation messages" })).toBeVisible();
    await page.getByRole("button", { name: "Back to messages" }).click();
    await expect(low).toHaveAttribute("aria-expanded", "true");
  });
}

test("high-priority defaults and search expansion stay unchanged", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?visual");
  const action = page.getByRole("button", { name: /^Action Required/ });
  const informational = page.getByRole("button", { name: /^Informational/ });
  await expect(action).toHaveAttribute("aria-expanded", "true");
  await expect(informational).toHaveAttribute("aria-expanded", "false");
  await action.click();
  await page.evaluate(() => (window as any).prismInboxQuery.invalidateQueries({ queryKey: ["vault", "inbox"] }));
  await expect(action).toHaveAttribute("aria-expanded", "false");
  await expect(informational).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("textbox", { name: "Search inbox" }).fill("Project");
  await expect(page.getByRole("button", { name: /Project notes/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Search inbox" }).fill("");
  // Existing search remount semantics are unchanged; no new persistence policy.
  await expect(action).toHaveAttribute("aria-expanded", "true");
  await expect(informational).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => (window as any).prismInboxFixture.switchScope());
  await expect(page.getByRole("button", { name: /Workshop planning/ })).toHaveCount(0);
});
