import { test, expect } from "@playwright/test";
const path = "/e2e-fixtures/publication-settings.html";

test("server preview drives actual counts and saving content preserves unknown exclusions", async ({
  page,
}) => {
  await page.goto(path);
  await expect(
    page.getByText("1 page is currently visible.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Content", exact: true }).click();
  await expect(
    page.getByText("1 of 2 selected", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2 private notes stay excluded automatically.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Include Reference", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Set Reference as home page", exact: true })
    .click();
  await page.getByRole("button", { name: "Save content", exact: true }).click();
  await expect(
    page.getByText("2 pages are currently visible.", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismPublishingFixture.writes),
  ).toEqual([
    {
      slug: "field-guide",
      patch: { homeNoteId: "reference", excludeNoteIds: ["old-hidden"] },
    },
  ]);
  expect(
    await page.evaluate(
      () => (window as any).prismPublishingFixture.vaultReads,
    ),
  ).toBe(0);
});

test("settings drafts survive section changes and collapse; a failed save retains them", async ({
  page,
}) => {
  await page.goto(path);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  await page
    .getByLabel("Publication title", { exact: true })
    .fill("Draft field guide");
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page
    .getByLabel("Publication font", { exact: true })
    .selectOption("serif");
  await settings.click();
  await expect(
    page.getByRole("tablist", { name: "Publication settings" }),
  ).not.toBeVisible();
  await settings.click();
  await expect(
    page.getByLabel("Publication font", { exact: true }),
  ).toHaveValue("serif");
  await page.getByRole("tab", { name: "Site details", exact: true }).click();
  await expect(
    page.getByLabel("Publication title", { exact: true }),
  ).toHaveValue("Draft field guide");
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failSave = true;
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic save unavailable",
  );
  await expect(
    page.getByLabel("Publication title", { exact: true }),
  ).toHaveValue("Draft field guide");
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failSave = false;
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(
    page.getByLabel("Publication font", { exact: true }),
  ).toHaveValue("serif");
  await expect(
    page.getByRole("button", { name: "Save appearance", exact: true }),
  ).toBeEnabled();
});

test("failed previews and removals expose deliberate retry without inventing an empty collection", async ({
  page,
}) => {
  await page.goto(path);
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failPreview = true;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Content", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "preview could not be loaded",
  );
  await expect(page.getByText("No notes in this collection yet.")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Save content", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failPreview = false;
  });
  await page
    .getByRole("button", { name: "Retry preview", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Include Welcome", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failUnpublish = true;
  });
  await page.getByRole("button", { name: "Unpublish", exact: true }).click();
  await page.getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic removal unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failUnpublish = false;
  });
  await page.getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);
});

test("late previews do not populate another audience", async ({ page }) => {
  await page.goto(path);
  await expect(
    page.getByText("1 page is currently visible.", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.holdPreview = true;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Content", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => !!(window as any).prismPublishingFixture.previewRelease,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const f = (window as any).prismPublishingFixture;
    f.switchScope();
    f.holdPreview = false;
    f.previewRelease();
  });
  await expect(
    page.getByText("Prism field guide", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Include Welcome", exact: true }),
  ).toHaveCount(0);
});

test("phone publishing applies a password in the creation request and retains failed drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);
  await page
    .getByRole("button", { name: "Publish a collection", exact: true })
    .click();
  await page.getByRole("button", { name: "By folder", exact: true }).click();
  await page
    .getByLabel("Publication folder", { exact: true })
    .fill("_test/private-publication");
  await page
    .getByLabel("Reader access", { exact: true })
    .selectOption("password");
  await expect(
    page.getByRole("button", { name: "Publish folder", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("New publication password", { exact: true })
    .fill("fixture-secret");
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failPublish = true;
  });
  await page
    .getByRole("button", { name: "Publish folder", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic publication unavailable",
  );
  await expect(
    page.getByLabel("New publication password", { exact: true }),
  ).toHaveValue("fixture-secret");
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failPublish = false;
  });
  await page
    .getByRole("button", { name: "Publish folder", exact: true })
    .click();
  await expect(
    page.getByText("is now password protected.", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).prismPublishingFixture.creates.at(-1),
    ),
  ).toEqual({
    prefix: "_test/private-publication",
    options: { template: "wiki", password: "fixture-secret" },
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("publishing-mobile.png"),
  });
});

test("settings sections support keyboard navigation and a failed clipboard never claims success", async ({
  page,
}) => {
  await page.goto(path);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const first = page.getByRole("tab", { name: "Site details", exact: true });
  await first.focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "Access", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Publication password", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("Denied");
        },
      },
    });
    // The legacy fallback (lib/clipboard.ts) is refused too: nothing reaches the clipboard.
    document.execCommand = () => false;
  });
  await page.locator("summary").filter({hasText: "Site address & membership"}).click();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be copied");
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toHaveCount(0);
});

test("failed appearance reset preserves the unsaved theme for retry", async ({
  page,
}) => {
  await page.goto(path);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page
    .getByLabel("Publication font", { exact: true })
    .selectOption("serif");
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failSave = true;
  });
  await page
    .getByRole("button", { name: "Reset to default", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic save unavailable",
  );
  await expect(
    page.getByLabel("Publication font", { exact: true }),
  ).toHaveValue("serif");
  await page.evaluate(() => {
    (window as any).prismPublishingFixture.failSave = false;
  });
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save appearance", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as any).prismPublishingFixture.writes.at(-1).patch,
    ),
  ).toEqual({ theme: { font: "serif" } });
});
