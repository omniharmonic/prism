import { test, expect, type Page } from "@playwright/test";
async function studio(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/presentation.html${query}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(page.getByLabel("Draft site title")).toBeVisible();
}
async function showInline(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Preview view",
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole("button", { name: "Show preview in studio", exact: true })
    .click();
}
const frame = (page: Page) =>
  page.frameLocator('iframe[title="Publication preview viewport"]');

test("inline preview is explicit and saved; expansion preserves local edits without another read", async ({
  page,
}) => {
  await studio(page);
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.previewReads,
    ),
  ).toBe(0);
  await expect(
    page.getByRole("button", { name: "Show preview in studio", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Draft site title").fill("Saved field guide");
  await page.getByLabel("Publication layout").selectOption("landing");
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await showInline(page);
  await expect(
    frame(page).getByRole("heading", {
      name: "Saved field guide",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Private preview · draft 1",
      exact: true,
    }),
  ).toBeFocused();
  await page.getByLabel("Draft site title").fill("Still local");
  await expect(
    page.getByText("Your local edits are not shown in the saved preview."),
  ).toBeVisible();
  await expect(
    frame(page).getByRole("heading", { name: "Still local", exact: true }),
  ).toHaveCount(0);
  const reads = await page.evaluate(
    () => (window as any).prismPresentationFixture.previewReads,
  );
  await page
    .getByRole("button", { name: "Expand preview", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Private publication preview" }),
  ).toBeVisible();
  await expect(
    frame(page).getByRole("heading", {
      name: "Saved field guide",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    frame(page).getByRole("heading", {
      name: "Saved field guide",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Draft site title")).toHaveValue("Still local");
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.previewReads,
    ),
  ).toBe(reads);
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Show preview in studio", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.published,
    ),
  ).toBe(0);
});

test("saving refreshes the inline saved revision and publishing closes a consumed draft", async ({
  page,
}) => {
  await studio(page);
  await page.getByLabel("Publication layout").selectOption("landing");
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await showInline(page);
  await expect(frame(page).getByText("PRISM_DRAFT_PREVIEW_BODY")).toBeVisible();
  await page.getByLabel("Draft site title").fill("Second saved revision");
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Private preview · draft 2",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    frame(page).getByRole("heading", {
      name: "Second saved revision",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publish appearance", exact: true })
    .click();
  await expect(
    page.getByText("Live revision 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('iframe[title="Publication preview viewport"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show preview in studio", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.published,
    ),
  ).toBe(1);
});

for (const [width, dark] of [
  [1440, false],
  [390, false],
  [320, true],
] as const) {
  test(`studio and actual inline reader at ${width}px ${dark ? "dark" : "light"}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await studio(page, `?visual${dark ? "&dark" : ""}`);
    await page.getByLabel("Publication font").selectOption("serif");
    await page
      .getByLabel("Publication introduction")
      .fill("Notes from a shared field guide.");
    await page
      .getByRole("button", { name: "Save private draft", exact: true })
      .click();
    await showInline(page);
    await expect(
      frame(page).getByRole("heading", {
        name: "A place for shared understanding",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await frame(page)
        .locator("article.prose-editor")
        .evaluate((el) => getComputedStyle(el).fontFamily),
    ).toContain("Georgia");
    expect(
      await frame(page)
        .getByRole("heading", { name: "Guiding principles", exact: true })
        .evaluate((el) => getComputedStyle(el).fontFamily),
    ).toContain("Georgia");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(
        `publishing-studio-${width}-${dark ? "dark" : "light"}.png`,
      ),
      fullPage: true,
    });
    await page.setViewportSize({
      width: width === 1440 ? 390 : 1440,
      height: 1000,
    });
    await expect(page.getByLabel("Publication font")).toHaveValue("serif");
    await expect(
      frame(page).getByRole("heading", {
        name: "A place for shared understanding",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as any).prismPresentationFixture.published,
      ),
    ).toBe(0);
  });
}

for (const width of [390, 720])
  test(`compact studio switches views without losing draft or preview at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await studio(page, "?visual");
    const settings = page.getByRole("button", {
      name: "Settings view",
      exact: true,
    });
    const preview = page.getByRole("button", {
      name: "Preview view",
      exact: true,
    });
    await expect(settings).toHaveAttribute("aria-pressed", "true");
    await preview.click();
    await expect(preview).toBeFocused();
    await expect(page.getByLabel("Draft site title")).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as any).prismPresentationFixture.previewReads,
      ),
    ).toBe(0);
    await settings.click();
    await page.getByLabel("Draft site title").fill("Saved guide");
    await page
      .getByRole("button", { name: "Save private draft", exact: true })
      .click();
    await showInline(page);
    await expect(
      frame(page).getByRole("heading", {
        name: "A place for shared understanding",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .locator('iframe[title="Publication preview viewport"]')
      .evaluate((el) => el.setAttribute("data-retained-frame", "same"));
    const reads = await page.evaluate(
      () => (window as any).prismPresentationFixture.previewReads,
    );
    await settings.click();
    await page.getByLabel("Draft site title").fill("Unsent local title");
    await preview.click();
    await expect(
      page.getByText(
        "Preview shows saved draft 1. Unsaved settings are not shown.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.locator('iframe[data-retained-frame="same"]'),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as any).prismPresentationFixture.previewReads,
      ),
    ).toBe(reads);
    await settings.click();
    await expect(page.getByLabel("Draft site title")).toHaveValue(
      "Unsent local title",
    );
    await preview.click();
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
    await expect(page.getByLabel("Draft site title")).toBeFocused();
    await expect(settings).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(
        () => (window as any).prismPresentationFixture.published,
      ),
    ).toBe(0);
  });

test("compact collection header keeps visible membership and expandable address controls", async ({
  page,
}) => {
  await studio(page, "?visual");
  await expect(
    page.getByText("2 pages are currently visible.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Publication address")).toBeHidden();
  await page
    .locator("summary")
    .filter({ hasText: "Site address & membership" })
    .click();
  await expect(page.getByLabel("Publication address")).toHaveValue(
    "https://prism.example.test/p/guide",
  );
  await expect(
    page.getByText("Private notes stay excluded.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Site address & membership" })
    .click();
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await showInline(page);
  await expect(
    frame(page).getByRole("heading", {
      name: "A place for shared understanding",
      exact: true,
    }),
  ).toBeVisible();
  const previewTop = await page
    .getByRole("heading", { name: "Private preview · draft 1", exact: true })
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(previewTop).toBeLessThan(390);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: test.info().outputPath("publishing-compact-desktop.png"),
    animations: "disabled",
  });
});
