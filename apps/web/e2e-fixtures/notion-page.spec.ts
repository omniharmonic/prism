/** NP-PG-17 — the page ⋯ menu's info footer (standalone component; 2B's chrome mounts it). */
import { test, expect } from "@playwright/test";

const shots = "/private/tmp/claude-501/-Users-benjaminlife-dev-prism/94600911-66b9-4b8d-b802-fc8f8fe9305f/scratchpad/w2-sharing";

test("page info footer", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=info");
  const dl = page.locator("dl.prism-page-info");
  await expect(dl).toBeVisible();
  const value = (label: string) => dl.locator("div", { has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
  // "Research handbook" + "A shared workspace where you and your agent work with connected context." + "Prism brings notes, tasks and sources together."
  await expect(value("Word count")).toHaveText("21");
  await expect(value("Characters")).toHaveText(String("Research handbookA shared workspace where you and your agent work with connected context.Prism brings notes, tasks and sources together.".length));
  await expect(value("Created")).toContainText("Sep 1");
  await expect(value("Last edited")).not.toHaveText("");
  await expect(value("Last edited by")).toHaveText("You");
  await page.screenshot({ path: `${shots}/page-info.png` });
});
