import { test, expect } from "@playwright/test";

test("a protected empty publication unlocks once instead of looping back to its password gate", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/publication.html?protected&empty");
  await page.getByLabel("Password", { exact: true }).fill("fixture-secret");
  await page.getByRole("button", { name: /unlock/i }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No published notes.")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).prismPublicationFixture.authCalls,
    ),
  ).toBe(1);
});

test("publication loading errors offer recovery without losing the requested site", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/publication.html?unavailable");
  await expect(
    page.getByRole("heading", { name: "Publication unavailable" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPublicationFixture.manifestStatus = 200;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Publication unavailable" }),
  ).toHaveCount(0);
});

test("a failed page transition hides the prior body and retries the requested page", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/publication.html");
  await expect(
    page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPublicationFixture.noteStatus.second = 503;
  });
  await page.getByRole("button", { name: "second", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This page could not be loaded",
  );
  await expect(
    page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    delete (window as any).prismPublicationFixture.noteStatus.second;
  });
  await page.getByRole("button", { name: "Retry page", exact: true }).click();
  await expect(
    page.getByText("PRISM_PUBLICATION_guide_second_BODY", { exact: true }),
  ).toBeVisible();
});

test("late page reads cannot populate a different publication", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/publication.html");
  await expect(
    page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPublicationFixture.hold = "second";
  });
  await page.getByRole("button", { name: "second", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).prismPublicationFixture.release),
    )
    .toBe(true);
  await page.evaluate(() => {
    const f = (window as any).prismPublicationFixture;
    f.setSlug("other");
  });
  await expect(
    page.getByText("PRISM_PUBLICATION_other_first_BODY", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).prismPublicationFixture;
    f.hold = "";
    f.release();
  });
  await expect(
    page.getByText("PRISM_PUBLICATION_guide_second_BODY", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("PRISM_PUBLICATION_other_first_BODY", { exact: true }),
  ).toBeVisible();
});

test("an unlocked empty site has a readable phone landing page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/publication.html?protected&empty");
  await page.getByLabel("Password", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: /unlock/i }).click();
  await expect(
    page.getByText("Incorrect password.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /unlock/i })).toBeEnabled();
  await page.getByLabel("Password", { exact: true }).fill("fixture-secret");
  await page.getByRole("button", { name: /unlock/i }).click();
  await expect(
    page.getByRole("heading", { name: "No pages published yet" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => {
      const root = document.querySelector(".pubwiki-m")!;
      return (
        getComputedStyle(root.querySelector("header")!).backgroundColor ===
        getComputedStyle(root).backgroundColor
      );
    }),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("publication-empty-mobile.png"),
  });
});

test("phone publication chrome and canvas follow both actual workspace theme palettes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/publication.html?empty");
  await expect(
    page.getByRole("heading", { name: "No pages published yet" }),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.className = theme;
    }, theme);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.querySelector(".pubwiki-m")!;
          const probe = document.createElement("div");
          probe.style.backgroundColor = "var(--bg-base)";
          root.append(probe);
          const background = getComputedStyle(root).backgroundColor;
          const expected = getComputedStyle(probe).backgroundColor;
          const header = getComputedStyle(
            root.querySelector("header")!,
          ).backgroundColor;
          const text = getComputedStyle(root.querySelector("h1")!).color;
          probe.remove();
          return (
            background === expected &&
            header === expected &&
            text !== background
          );
        }),
      )
      .toBe(true);
  }
  await page.screenshot({
    path: test.info().outputPath("publication-empty-dark-mobile.png"),
  });
});

test("malformed legacy theme fields do not break the public reader", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/e2e-fixtures/publication.html?malformed-theme");
  await expect(
    page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

for (const layout of ["wiki", "docs", "landing"]) {
  test(`${layout} reader wraps long titles, headings and links without widening the page`, async ({
    page,
  }) => {
    await page.goto(
      `/e2e-fixtures/publication.html?long-content&template=${layout}`,
    );
    await expect(
      page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true }),
    ).toBeVisible();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator("main")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        )
        .toBe(true);
      // Long code lines remain locally scrollable rather than widening the article.
      await expect(page.locator("article pre")).toBeVisible();
    }
  });
}
