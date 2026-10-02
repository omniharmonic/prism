import { test, expect } from "@playwright/test";
async function studio(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(page.getByLabel("Draft site title")).toBeVisible();
}
test("saved drafts survive reload, preview the actual reader and publish independently of restoration", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  await page.getByLabel("Draft site title").fill("A connected field guide");
  await page.getByLabel("Publication layout").selectOption("landing");
  await page
    .getByLabel("Publication introduction")
    .fill("Notes, people and ideas in one place.");
  await expect(
    page.getByRole("button", { name: "Publish appearance", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByText("Private draft saved", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await studio(page);
  await expect(page.getByLabel("Draft site title")).toHaveValue(
    "A connected field guide",
  );
  await page
    .getByRole("button", { name: "Preview saved draft", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Private publication preview",
  });
  await expect(dialog).toBeVisible();
  const frame = page.frameLocator(
    'iframe[title="Publication preview viewport"]',
  );
  await expect(
    frame.getByRole("heading", {
      name: "A connected field guide",
      exact: true,
    }),
  ).toBeVisible();
  await expect(frame.getByText("PRISM_DRAFT_PREVIEW_BODY")).toBeVisible();
  await page
    .getByRole("button", { name: "Phone preview", exact: true })
    .click();
  await expect(frame.getByTestId("wiki-drawer-open")).toBeVisible();
  await expect
    .poll(() =>
      frame
        .locator("html")
        .evaluate(
          (el) => el.scrollWidth <= el.ownerDocument.defaultView!.innerWidth,
        ),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("private-site-preview.png"),
  });
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.published,
    ),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Publish appearance", exact: true })
    .click();
  await expect(
    page.getByText("Live revision 1", { exact: true }),
  ).toBeVisible();
  await page.getByText("Appearance history (2)", { exact: true }).click();
  await page
    .getByRole("button", { name: "Restore revision 0 as draft", exact: true })
    .click();
  await expect(page.getByLabel("Draft site title")).toHaveValue("Field guide");
  await expect(
    page.getByText("Live revision 1", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.published,
    ),
  ).toBe(1);
});
test("failed and conflicting writes retain the local draft and require an explicit reload", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  await page.getByLabel("Draft site title").fill("Keep this draft");
  await page.evaluate(() => {
    (window as any).prismPresentationFixture.fail = true;
  });
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic write unavailable",
  );
  await expect(page.getByLabel("Draft site title")).toHaveValue(
    "Keep this draft",
  );
  await page.evaluate(() => {
    const c = (window as any).prismPresentationFixture;
    c.fail = false;
    c.remote();
  });
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "changed in another session",
  );
  await expect(page.getByLabel("Draft site title")).toHaveValue(
    "Keep this draft",
  );
  await page
    .getByRole("button", {
      name: "Reload revisions and replace this draft",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Draft site title")).toHaveValue("Remote title");
  await expect(
    page.getByText("Live revision 1", { exact: true }),
  ).toBeVisible();
});
test("preview errors retry privately and Escape returns to the unchanged phone draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  await page.getByLabel("Publication layout").selectOption("docs");
  await page
    .getByRole("checkbox", { name: "Site search", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByText("Private draft saved", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPresentationFixture.previewFail = true;
  });
  await page
    .getByRole("button", { name: "Preview saved draft", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic preview unavailable",
  );
  await page.evaluate(() => {
    (window as any).prismPresentationFixture.previewFail = false;
  });
  await page
    .getByRole("button", { name: "Retry preview", exact: true })
    .click();
  const frame = page.frameLocator(
    'iframe[title="Publication preview viewport"]',
  );
  await expect(frame.getByText("PRISM_DRAFT_PREVIEW_BODY")).toBeVisible();
  await frame.getByTestId("wiki-drawer-open").click();
  await expect(frame.getByRole("searchbox")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Publication layout")).toHaveValue("docs");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("site-studio-mobile.png"),
  });
});
