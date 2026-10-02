import { test, expect } from "@playwright/test";
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
