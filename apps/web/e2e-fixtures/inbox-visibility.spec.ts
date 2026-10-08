import { test, expect } from "@playwright/test";

const filter = (page: import("@playwright/test").Page, name: RegExp) =>
  page.getByRole("group", { name: "Filter by category" }).getByRole("button", { name });

for (const width of [1440, 390, 720]) {
  test(`classified inbox opens on Needs attention; All shows every conversation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 720 ? 500 : 844 });
    await page.goto("/e2e-fixtures/inbox.html");
    // Owner decision 2026-10-08: the view opens on urgent + action required; All is one tap away.
    await expect(filter(page, /^Needs attention/)).toHaveAttribute("aria-pressed", "true");
    await filter(page, /^All/).click();
    await expect(filter(page, /^All/)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Planning group/ })).toBeVisible();
    for (const name of [/^Low priority 1$/, /^Social 1$/, /^Reviewed 1$/, /^Handled 1$/])
      await expect(filter(page, name)).toHaveAttribute("aria-pressed", "false");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.classList.toggle("light", theme === "light"), theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`classified-inbox-${width}-${theme}.png`), animations: "disabled" });
    }
    // A chosen filter survives a background re-read and a trip into a conversation and back.
    const low = filter(page, /^Low priority/);
    await low.click();
    await expect(low).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => (window as any).prismInboxQuery.invalidateQueries({ queryKey: ["vault", "inbox"] }));
    await expect(low).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Social discussion/ })).toHaveCount(0);
    await page.getByRole("button", { name: /Planning group/ }).click();
    await expect(page.getByRole("region", { name: "Conversation messages" })).toBeVisible();
    await page.getByRole("button", { name: "Back to messages" }).click();
    await expect(low).toHaveAttribute("aria-pressed", "true");
  });
}

test("filters and search work together and reset on a workspace change", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?visual");
  const action = filter(page, /^Action required/);
  const informational = filter(page, /^Informational/);
  await expect(action).toHaveText("Action required 1");
  await expect(informational).toHaveText("Informational 2");
  await informational.click();
  await page.evaluate(() => (window as any).prismInboxQuery.invalidateQueries({ queryKey: ["vault", "inbox"] }));
  await expect(informational).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Search inbox" }).fill("Project");
  await expect(page.getByRole("button", { name: /Project notes/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Rowan Ellis/ })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search inbox" }).fill("");
  await expect(page.getByRole("button", { name: /Rowan Ellis/ })).toBeVisible();
  await page.evaluate(() => (window as any).prismInboxFixture.switchScope());
  await expect(page.getByRole("button", { name: /Workshop planning/ })).toHaveCount(0);
});
