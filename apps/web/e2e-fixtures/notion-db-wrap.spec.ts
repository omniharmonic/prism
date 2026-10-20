import { test, expect, type Page } from "@playwright/test";

/** A table view can wrap its cells (per view; default off). Fixture: databases.html. */
const configWrites = (page: Page) => page.evaluate(() => ((window as any).dbFixture.writes as any[]).filter((w) => w.metadata?.prism_database));
const table = (page: Page, name = "All tasks") => page.getByRole("table", { name });
const settings = (page: Page) => page.getByRole("dialog", { name: "View settings" });

test("wrap cells: off by default (one line per cell); on, rows grow — saved per table view", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const long = "Coordinate the printer driver fix with the hardware partners and confirm the schedule before the release notes go out";
  await page.evaluate((text) => { const f = (window as any).dbFixture; const n = f.notes().find((x: any) => x.id === "t2"); n.metadata.title = text; n.metadata.link = `https://example.test/${text.replace(/ /g, "-")}`; }, long);
  await page.getByRole("searchbox", { name: "Search this database" }).fill("printer");
  const row = table(page).locator('tbody tr[data-row-id="t2"]');
  await expect(row).toBeVisible();
  // The search re-queries: wait until its answer is what is drawn (only the matching row, carrying the long title set
  // above) before measuring — the row is replaced while the answer comes in, and a box asked for then is null.
  await expect(table(page).locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(row).toContainText("Coordinate the printer driver fix");
  await expect(table(page)).not.toHaveAttribute("data-wrap", "");
  const height = async () => (await row.boundingBox())?.height ?? null;
  await expect.poll(height).not.toBeNull();
  const before = (await height())!;
  expect(before).toBeLessThan(60);
  await page.getByRole("button", { name: "View settings" }).click();
  await settings(page).getByRole("checkbox", { name: "Wrap cells" }).check();
  await page.keyboard.press("Escape");
  await expect(table(page)).toHaveAttribute("data-wrap", "");
  await expect.poll(async () => (await height()) ?? 0).toBeGreaterThan(before + 16);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[0].wrap).toBe(true);
  // Other layouts have no such setting.
  await page.getByRole("tab", { name: "List" }).click();
  await page.getByRole("button", { name: "View settings" }).click();
  await expect(settings(page).getByRole("checkbox", { name: "Wrap cells" })).toHaveCount(0);
});
