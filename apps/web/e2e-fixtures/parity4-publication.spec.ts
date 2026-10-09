import { test, expect } from "@playwright/test";

/**
 * Slice L · NP-ED-19 / NP-ED-24 — a published page DRAWS the table-of-contents block where the
 * author put it: the page's headings, as in-page links, built after sanitising (text as text,
 * slug ids, no inline style).
 */
const body =
  '<div data-type="toc"></div>' +
  "<h2>Getting started</h2><p>One.</p>" +
  "<h3>Install &amp; run</h3><p>Two.</p>" +
  '<h2 id="x&quot; onmouseover=&quot;alert(1)">Getting started</h2><p>Three.</p>' + // a repeated heading, with an id that is not a plain token
  "<h2>&lt;img src=x onerror=alert(1)&gt;</h2><p>Four.</p>" + // a heading whose TEXT looks like markup
  `<p>${"Filler. ".repeat(400)}</p><h2>Far below</h2><p>Five.</p>`;

test("a published page draws the table-of-contents block from the page's headings, as in-page links", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/e2e-fixtures/publication.html?html=${encodeURIComponent(body)}`);
  const article = page.locator("article.prose-editor");
  await expect(article).toContainText("PRISM_PUBLICATION_guide_first_BODY");
  const toc = article.locator('div[data-type="toc"]');
  await expect(toc).toBeVisible();
  const nav = toc.getByRole("navigation", { name: "Table of contents" });
  const links = nav.getByRole("link");
  await expect(links).toHaveText(["Getting started", "Install & run", "Getting started", "<img src=x onerror=alert(1)>", "Far below"]);
  // Every link is an in-page fragment to a heading that exists; ids are plain, unique slugs.
  const targets = await links.evaluateAll((els) => els.map((a) => a.getAttribute("href")));
  // (Prefixed, so a heading named "root" or "constructor" can never take an id the app uses.)
  expect(targets).toEqual(["#h-getting-started", "#h-install-run", "#h-getting-started-1", "#h-img-srcx-onerroralert1", "#h-far-below"]);
  for (const href of targets) await expect(article.locator(`[id="${href!.slice(1)}"]`)).toHaveCount(1);
  expect(await article.locator("h2, h3").evaluateAll((els) => els.map((h) => h.id))).toEqual(targets.map((t) => t!.slice(1)));
  // Sub-headings are indented by a rule, not by an inline style; nothing in the block is executable.
  await expect(nav.locator("li").nth(1)).toHaveAttribute("data-indent", "1");
  expect(await nav.locator("li").nth(1).evaluate((el) => parseFloat(getComputedStyle(el).paddingInlineStart))).toBeGreaterThan(0);
  expect(await article.locator("[style], script, img[onerror], [onmouseover]").count()).toBe(0);
  // A click goes to the heading — on this page (the address does not change, nothing navigates).
  const url = page.url();
  await expect(article.locator("#h-far-below")).not.toBeInViewport();
  await links.nth(4).click();
  await expect(article.locator("#h-far-below")).toBeInViewport();
  expect(page.url()).toBe(url);
  expect(dialogs).toEqual([]);
});

test("a page without headings leaves the block empty; a page without the block is unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/e2e-fixtures/publication.html?html=${encodeURIComponent('<div data-type="toc"></div><p>No headings here.</p>')}`);
  const article = page.locator("article.prose-editor");
  await expect(article).toContainText("No headings here.");
  await expect(article.locator('div[data-type="toc"] a')).toHaveCount(0);
  await page.goto(`/e2e-fixtures/publication.html?html=${encodeURIComponent("<h2>Only a heading</h2><p>Text.</p>")}`);
  await expect(article).toContainText("Only a heading");
  await expect(article.locator(".prism-toc")).toHaveCount(0);
});

test("L-2: at most three table-of-contents blocks are filled, 200 entries each; an author's own #heading link still lands", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const many = Array.from({ length: 230 }, (_, i) => `<h3>Section ${i + 1}</h3><p>Text.</p>`).join("");
  const html = '<div data-type="toc"></div>'.repeat(5) + '<p><a href="#root">Jump to root</a> · <a href="#section-229">Jump far</a></p><h2>root</h2><h2>constructor</h2>' + many;
  await page.goto(`/e2e-fixtures/publication.html?html=${encodeURIComponent(html)}`);
  const article = page.locator("article.prose-editor");
  await expect(article).toContainText("Section 230");
  const blocks = article.locator('div[data-type="toc"]');
  await expect(blocks).toHaveCount(5);
  expect(await blocks.evaluateAll((els) => els.map((el) => el.querySelectorAll("a").length))).toEqual([200, 200, 200, 0, 0]);
  // No heading takes a bare id the app could be using.
  expect(await article.locator("#root, #constructor").count()).toBe(0);
  await expect(article.locator("#h-root")).toHaveText("root");
  // A link the author wrote to the bare slug still scrolls to its heading.
  await expect(article.locator("#h-section-229")).not.toBeInViewport();
  await article.getByRole("link", { name: "Jump far" }).click();
  await expect(article.locator("#h-section-229")).toBeInViewport();
});

test("S6: a link that arrives with a #heading fragment lands on that heading", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const html = Array.from({ length: 60 }, (_, i) => `<h3>Section ${i + 1}</h3><p>${"Text. ".repeat(6)}</p>`).join("");
  // The bare slug (a link written before ids were prefixed) and the prefixed id both land.
  for (const fragment of ["#section-55", "#h-section-55", "#%E0%A4%A"]) {
    await page.goto("about:blank");
    await page.goto(`/e2e-fixtures/publication.html?html=${encodeURIComponent(html)}${fragment}`);
    const article = page.locator("article.prose-editor");
    await expect(article).toContainText("Section 60");
    if (fragment.startsWith("#%")) await expect(article.locator("#h-section-1")).toBeInViewport(); // a malformed fragment is ignored
    else await expect(article.locator("#h-section-55")).toBeInViewport();
  }
});
