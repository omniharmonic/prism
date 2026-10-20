/** NP-PG-13, NP-CO-15 — version attribution and the page Updates feed. */
import { test, expect } from "@playwright/test";

const rows = ".prism-context-history .prism-context-history-row";

test("versions name their author kind", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=history");
  await expect(page.locator(rows)).toHaveCount(6);
  const row = (i: number) => page.locator(rows).nth(i);
  await expect(row(0)).toContainText("Current version");
  await expect(row(0)).toContainText("You ·");
  await expect(row(1)).toContainText("Accepted suggestion");
  await expect(row(1)).toContainText("You ·");
  await expect(row(2)).toContainText("Agent revision");
  await expect(row(3)).toContainText("Edit");
  await expect(row(3)).toContainText("Sam Chen ·");
  await expect(row(4)).toContainText("Edit by a link guest");
  // Unknown writers are never named.
  await expect(row(5)).not.toContainText("·  ·");
  await expect(row(5).locator("[data-writer-kind]")).toHaveAttribute("data-writer-kind", "unknown");
  await page.screenshot({ path: test.info().outputPath("history-versions-light.png") });
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=history&dark");
  await expect(page.locator(rows)).toHaveCount(6);
  await page.screenshot({ path: test.info().outputPath("history-versions-dark.png") });
});

test("page updates feed", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=history");
  await page.getByRole("tab", { name: "Updates" }).click();
  const feed = page.getByLabel("Page updates");
  const items = feed.locator("li");
  await expect(items.first()).toBeVisible();
  const kinds = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-update-kind")));
  // Newest first: current edit (11:00), reply (10:30), comment (10:10), accepted
  // suggestion (saved 10:00), share (9:15), agent revision (saved 9:00), …
  expect(kinds.slice(0, 6)).toEqual(["edit", "comment", "comment", "accepted-suggestion", "share", "agent"]);
  await expect(feed).toContainText("Replied");
  await expect(feed).toContainText("Yes, changing it.");
  await expect(feed).toContainText("Commented");
  await expect(feed).toContainText("Sam Chen");
  await expect(feed).toContainText("Shared");
  await expect(feed).toContainText("Morgan Lee · can edit (with sub-pages)");
  await expect(feed).toContainText("Agent revision");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("history-updates-phone.png") });
});

test("changes made outside Prism are never credited to the last person; the owner sees which agent", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=history&external");
  await expect(page.locator(rows)).toHaveCount(6);
  const row = (i: number) => page.locator(rows).nth(i);
  // Current: Jordan's stamp predates the note; the newest row says an agent session wrote it over MCP.
  await expect(row(0)).toContainText("Current version");
  await expect(row(0)).not.toContainText("You ·");
  await expect(row(0)).toContainText("agent-session:3f2a9c0b-1… via mcp");
  // A state whose stamp is three hours older than the save that produced it.
  await expect(row(2).locator("[data-writer-kind]")).toHaveAttribute("data-writer-kind", "external");
  await expect(row(2)).toContainText("Changed outside Prism");
  await expect(row(2)).toContainText("routine:morning-intel via api");
  await expect(row(2)).not.toContainText("You ·");
  await page.getByRole("tab", { name: "Updates" }).click();
  const feed = page.getByLabel("Page updates");
  await expect(feed.locator('li[data-update-kind="external"]').first()).toBeVisible();
  await expect(feed).toContainText("Changed outside Prism");
  await expect(feed).toContainText("routine:morning-intel via api");
});

test("page info: an external change reads as an agent or sync", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=info&external");
  await expect(page.getByLabel("Page info")).toContainText("an agent or sync");
  await expect(page.getByLabel("Page info")).not.toContainText("Jordan Diaz");
});
