import { test, expect, type Locator } from "@playwright/test";
for (const template of ["wiki", "docs", "landing"]) {
  for (const width of [1440, 390]) {
    test(`saved serif font applies to ${template} public article at ${width}px while code stays monospace`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/e2e-fixtures/publication.html?template=${template}&font=serif`,
      );
      const article = page.locator("article.prose-editor");
      await expect(
        article.getByText("PRISM_PUBLICATION_guide_first_BODY", {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await article.evaluate((el) => getComputedStyle(el).fontFamily),
      ).toContain("Georgia");
      expect(
        await article
          .getByRole("heading", { name: "Reading together" })
          .evaluate((el) => getComputedStyle(el).fontFamily),
      ).toContain("Georgia");
      expect(
        await article
          .locator("code")
          .evaluate((el) => getComputedStyle(el).fontFamily),
      ).toMatch(/mono/i);
      expect(
        await article
          .locator("code")
          .evaluate((el) => getComputedStyle(el).fontFamily),
      ).not.toContain("Georgia");
    });
  }
}
test("an unspecified publication font keeps the legacy reader default", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/publication.html");
  const article = page.locator("article.prose-editor");
  await expect(article).toBeVisible();
  await expect(page.locator('[data-publication-font="custom"]')).toHaveCount(0);
  expect(
    await article.evaluate((el) => getComputedStyle(el).fontFamily),
  ).not.toContain("Georgia");
});

async function typography(heading: Locator) {
  return heading.evaluate((element) => {
    const text = element.firstChild!;
    const start = text.textContent!.indexOf("understanding");
    const range = element.ownerDocument.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "understanding".length);
    const styles = getComputedStyle(element);
    return {
      font: styles.fontFamily,
      size: parseFloat(styles.fontSize),
      wordLines: range.getClientRects().length,
      overflow: element.scrollWidth > element.clientWidth,
    };
  });
}
for (const font of ["serif", "sans"])
  for (const width of [220, 320, 390])
    test(`${font} headings fit actual ${width}px reader viewport`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/e2e-fixtures/publication.html?typography&font=${font}`);
      const heading = page.locator("article h1");
      await expect(heading).toBeVisible();
      const metrics = await typography(heading);
      await page.screenshot({
        path: test.info().outputPath(`reader-${font}-${width}.png`),
        animations: "disabled",
      });
      expect(metrics.font).toContain(
        font === "serif" ? "Georgia" : "system-ui",
      );
      expect(metrics.size).toBeGreaterThanOrEqual(22);
      expect(metrics.size).toBeLessThanOrEqual(28);
      expect(metrics.size).toBeCloseTo(
        Math.max(22, Math.min(28, width * 0.07)),
        1,
      );
      expect(metrics.wordLines).toBe(1);
      expect(metrics.overflow).toBe(false);
      expect(
        (
          await typography(
            page.getByRole("heading", {
              name: "Shared understanding",
              exact: true,
            }),
          )
        ).wordLines,
      ).toBe(1);
      const prose = await page.locator("article").evaluate((el) => ({
        size: parseFloat(getComputedStyle(el).fontSize),
        line: parseFloat(getComputedStyle(el).lineHeight),
        overflow: el.scrollWidth > el.clientWidth,
      }));
      expect(prose.size).toBe(16);
      expect(prose.line).toBeCloseTo(27.2, 3);
      expect(prose.overflow).toBe(false);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect
        .poll(async () => (await typography(page.locator("article h1"))).size)
        .toBe(28);
    });

for (const font of ["serif", "sans"])
  test(`nested ${font} preview scales headings with its own viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/e2e-fixtures/presentation.html?visual");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Publication font").selectOption(font);
    await page
      .getByRole("button", { name: "Save private draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Show preview in studio", exact: true })
      .click();
    const iframe = page.locator('iframe[title="Publication preview viewport"]');
    const frame = page.frameLocator(
      'iframe[title="Publication preview viewport"]',
    );
    await expect(frame.locator("article h1")).toBeVisible();
    for (const width of [220, 320, 390]) {
      await iframe.evaluate((el, width) => {
        el.style.width = `${width}px`;
      }, width);
      await expect
        .poll(() =>
          frame
            .locator("html")
            .evaluate((el) => el.ownerDocument.defaultView!.innerWidth),
        )
        .toBe(width);
      await frame.locator("html").evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            const win = el.ownerDocument.defaultView!;
            win.requestAnimationFrame(() => {
              win.scrollTo(0, 0);
              win.requestAnimationFrame(() => resolve());
            });
          }),
      );
      const metrics = await typography(frame.locator("article h1"));
      await iframe.screenshot({
        path: test.info().outputPath(`preview-${font}-${width}.png`),
        animations: "disabled",
      });
      expect(metrics.font).toContain(
        font === "serif" ? "Georgia" : "system-ui",
      );
      expect(metrics.size).toBeGreaterThanOrEqual(22);
      expect(metrics.size).toBeLessThanOrEqual(28);
      expect(metrics.size).toBeCloseTo(
        Math.max(22, Math.min(28, width * 0.07)),
        1,
      );
      expect(metrics.wordLines).toBe(1);
      expect(metrics.overflow).toBe(false);
    }
  });
