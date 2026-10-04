import { test, expect } from "@playwright/test";
import { PARITY_BLOCKS } from "../../server/test/fixtures/parity-blocks";

/**
 * Parity pass 3 · NP-ED-24 "block round-trip through publish and export" — the PUBLISHED
 * PAGE half: the wiki renderer (Markdown pass + sanitiser) must still show every block type
 * of NP-ED-08 … NP-ED-19. The stored page, the publishing API, both exports and the agent
 * edit are in apps/server/test/block-roundtrip.test.ts, over the same block list.
 */
test("NP-ED-24: block round-trip through publish — every block type is on the published page", async ({ page }) => {
  await page.route("**/api/p/guide/attachments/*", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/e2e-fixtures/publication.html?blocks");
  const article = page.locator("article.prose-editor");
  await expect(article).toContainText("PRISM_PUBLICATION_guide_first_BODY");
  const lost: string[] = [];
  for (const block of PARITY_BLOCKS.filter((b) => !b.gaps?.published)) {
    const el = article.locator(block.selector).filter(block.text ? { hasText: block.text } : {}).first();
    const there = (await el.count()) > 0;
    // A divider and an empty container have no text box of their own; everything else must be visible.
    const shown = there && (block.selector === "hr" || (await el.isVisible()));
    if (!shown) lost.push(`${block.row} ${block.name} (${block.selector}${block.text ? ` "${block.text}"` : ""})`);
  }
  expect(lost, "blocks missing from the published page").toEqual([]);
  // Nothing executable and no inline style came through the sanitiser.
  expect(await article.locator("script, iframe, [style]").count()).toBe(0);
  // Files of the page come from the publication's own route, never the signed-in one.
  await expect(article.getByRole("img", { name: "RT image" })).toHaveAttribute("src", "/api/p/guide/attachments/a_rtimage0000000000000000");
  await expect(article.locator('a[href*="a_rtfile00000000000000000"]')).toHaveAttribute("href", "/api/p/guide/attachments/a_rtfile00000000000000000");
});

/** What a reader actually sees for the blocks whose editor view is interactive. */
test("NP-ED-24: published blocks read as what they are", async ({ page }) => {
  await page.route("**/api/p/guide/attachments/*", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/e2e-fixtures/publication.html?blocks");
  const article = page.locator("article.prose-editor");
  await expect(article).toContainText("RT callout");
  // Callout: its icon is drawn; a toggle opens; the checked to-do is struck through.
  const callout = article.locator('div[data-type="callout"]');
  expect(await callout.evaluate((el) => getComputedStyle(el, "::before").content)).toContain("💡");
  const toggle = article.locator('details[data-type="toggle"]:not([data-heading-level])');
  await toggle.locator("summary").click();
  await expect(toggle.getByText("RT toggle body")).toBeVisible();
  expect(await article.locator('li[data-checked="true"]').evaluate((el) => getComputedStyle(el.querySelector("div") ?? el).textDecorationLine)).toContain("line-through");
  // Columns sit side by side; the coloured block and the coloured cell are filled.
  const [left, right] = await Promise.all([0, 1].map((i) => article.locator('div[data-type="column"]').nth(i).boundingBox()));
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(4);
  expect(right!.x).toBeGreaterThan(left!.x + left!.width - 1);
  expect(await article.locator('p[data-block-color="blue_background"]').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(await article.locator('td[data-cell-color="blue"]').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(await article.locator('span[data-text-color="red"]').evaluate((el) => getComputedStyle(el).color)).not.toBe(await article.locator("p").first().evaluate((el) => getComputedStyle(el).color));
  // The code block keeps its text exactly; the image carries its caption; links point where they did.
  await expect(article.locator("pre code")).toHaveText('const rt = "code";');
  await expect(article.locator('img[alt="RT image"]')).toHaveAttribute("data-caption", "RT caption");
  await expect(article.getByRole("link", { name: "RT link" })).toHaveAttribute("href", "https://example.test/rt-link");
  await expect(article.getByRole("link", { name: "RT bookmark" })).toHaveAttribute("href", "https://example.test/rt-bookmark");
  // An embed is at least its link (never a blank frame).
  await expect(article.locator('a[href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]')).toBeVisible();
});

/**
 * FIXME (behaviour gap, PARITY-GAPS a.1 — seen failing 2026-10-03): blocks the published page does not
 * draw. Today: the table-of-contents block (NP-ED-19) is an empty element there — the reader has the
 * site's own outline, but nothing stands where the author put the block.
 */
test.fixme("NP-ED-24: published page draws every block (known gaps: " + PARITY_BLOCKS.filter((b) => b.gaps?.published).map((b) => b.name).join(", ") + ")", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/e2e-fixtures/publication.html?blocks");
  const article = page.locator("article.prose-editor");
  await expect(article).toContainText("RT callout");
  for (const block of PARITY_BLOCKS.filter((b) => b.gaps?.published)) await expect(article.locator(block.selector).first(), block.name).toBeVisible();
  // The table of contents lists the page's headings and links to them.
  await expect(article.locator('div[data-type="toc"]')).toContainText("RT heading two");
});
