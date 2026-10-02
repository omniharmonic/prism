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

for (const empty of [false, true]) {
  test(`phone preview wraps unbroken landing titles with ${empty ? "no" : "visible"} pages`, async ({
    page,
  }) => {
    await page.goto(`/e2e-fixtures/presentation.html${empty ? "?empty" : ""}`);
    await studio(page);
    const title = "PRISM_SITE_STUDIO_UI_VERIFIED";
    await page.getByLabel("Draft site title").fill(title);
    await page.getByLabel("Publication layout").selectOption("landing");
    await page
      .getByRole("button", { name: "Save private draft", exact: true })
      .click();
    await expect(
      page.getByText("Private draft saved", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Preview saved draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Phone preview", exact: true })
      .click();
    const frame = page.frameLocator(
      'iframe[title="Publication preview viewport"]',
    );
    await expect(
      frame.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(frame.getByTestId("wiki-drawer-open")).toBeVisible();
    if (empty)
      await expect(
        frame.getByRole("heading", { name: "No pages published yet" }),
      ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('iframe[title="Publication preview viewport"]')
          .evaluate((el) => el.getBoundingClientRect().width),
      )
      .toBe(390);
    // WebKit reserves scrollbar width inside the frame when the page is tall.
    await expect
      .poll(() =>
        frame
          .locator("html")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("private-long-title-phone.png"),
    });
  });
}

test("navigation sections reorder eligible pages, survive draft reload and preview without hiding unassigned pages", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  await page
    .getByRole("button", { name: "Add navigation section", exact: true })
    .click();
  await page.getByLabel("Section 1 title", { exact: true }).fill("");
  await page.getByLabel("Section 1 title", { exact: true }).fill("Start here");
  await expect(
    page
      .getByLabel("Add page to section 1", { exact: true })
      .getByRole("option", { name: "EXCLUDED_PAGE_TITLE" }),
  ).toHaveCount(0);
  await page
    .getByLabel("Add page to section 1", { exact: true })
    .selectOption("welcome");
  await page
    .getByLabel("Add page to section 1", { exact: true })
    .selectOption("reference");
  await page
    .getByRole("button", { name: "Move page 2 up in section 1", exact: true })
    .click();
  await expect(
    page
      .getByRole("group", { name: "Navigation section 1", exact: true })
      .locator("ol li"),
  ).toHaveText([/Reference/, /Welcome/]);
  await page
    .getByRole("button", { name: "Remove page 2 from section 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByText("Private draft saved", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await studio(page);
  await expect(page.getByLabel("Section 1 title", { exact: true })).toHaveValue(
    "Start here",
  );
  await page.screenshot({
    path: test.info().outputPath("site-navigation-editor.png"),
  });
  await page
    .getByRole("button", { name: "Preview saved draft", exact: true })
    .click();
  const frame = page.frameLocator(
    'iframe[title="Publication preview viewport"]',
  );
  await expect(
    frame
      .getByRole("region", { name: "Start here", exact: true })
      .getByRole("button", { name: "Reference", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "🏠 Welcome", exact: true }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Reference", exact: true }).click();
  await expect(
    frame.getByRole("heading", { name: "Reference", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Phone preview", exact: true })
    .click();
  await frame.getByTestId("wiki-drawer-open").click();
  await expect(
    frame.getByRole("region", { name: "Start here", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use page path tree", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Navigation section 1", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
});

test("private preview allows trusted reader interaction but blocks scripts authored inside its document", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByText("Private draft saved", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Preview saved draft", exact: true })
    .click();
  const frame = page.frameLocator(
    'iframe[title="Publication preview viewport"]',
  );
  await expect(
    frame.getByText("PRISM_DRAFT_PREVIEW_BODY", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const doc = document.querySelector("iframe")!.contentDocument!;
    const script = doc.createElement("script");
    script.textContent = "window.parent.__previewUnsafeScript = true";
    doc.body.append(script);
    const inline = doc.createElement("button");
    inline.id = "unsafe-inline-probe";
    inline.textContent = "Unsafe inline probe";
    inline.setAttribute(
      "onclick",
      "window.parent.__previewUnsafeHandler = true",
    );
    doc.body.append(inline);
  });
  await frame
    .getByRole("button", { name: "Unsafe inline probe", exact: true })
    .click();
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-same-origin allow-scripts",
  );
  expect(
    await page.evaluate(() => ({
      script: !!(window as any).__previewUnsafeScript,
      handler: !!(window as any).__previewUnsafeHandler,
    })),
  ).toEqual({ script: false, handler: false });
  await page
    .getByRole("button", { name: "Phone preview", exact: true })
    .click();
  await frame.getByTestId("wiki-drawer-open").click();
  await expect(
    frame.getByRole("dialog", { name: "Contents", exact: true }),
  ).toBeVisible();
  await frame
    .getByRole("button", { name: "Close contents", exact: true })
    .click();
  await expect(
    frame.getByRole("dialog", { name: "Contents", exact: true }),
  ).toHaveCount(0);
});

test("navigation candidate errors recover without changing section drafts and sections can be reordered by keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/presentation.html");
  await page.evaluate(() => {
    (window as any).prismPresentationFixture.candidatesFail = true;
  });
  await studio(page);
  await expect(page.getByRole("alert")).toContainText(
    "Candidate list unavailable",
  );
  await page
    .getByRole("button", { name: "Add navigation section", exact: true })
    .click();
  await page.getByLabel("Section 1 title", { exact: true }).fill("Read first");
  await page
    .getByRole("button", { name: "Add navigation section", exact: true })
    .click();
  await page.getByLabel("Section 2 title", { exact: true }).fill("Browse next");
  await page
    .getByRole("button", { name: "Move section 2 up", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Section 1 title", { exact: true })).toHaveValue(
    "Browse next",
  );
  await page.evaluate(() => {
    (window as any).prismPresentationFixture.candidatesFail = false;
  });
  await page
    .getByRole("button", { name: "Retry eligible pages", exact: true })
    .click();
  await expect(
    page.getByLabel("Add page to section 1", { exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Section 2 title", { exact: true })).toHaveValue(
    "Read first",
  );
  await page
    .getByLabel("Add page to section 1", { exact: true })
    .selectOption("reference");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("site-navigation-mobile.png"),
  });
});
