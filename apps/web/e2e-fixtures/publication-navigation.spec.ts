import { test, expect } from "@playwright/test";
async function studio(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(page.getByLabel("Draft site title")).toBeVisible();
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
for (const template of ["wiki", "docs", "landing"]) {
  test(`${template} resolves navigation only from eligible pages and preserves unassigned content`, async ({
    page,
  }) => {
    await page.goto(
      `/e2e-fixtures/publication.html?custom-navigation&template=${template}`,
    );
    await expect(
      page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true }),
    ).toBeVisible();
    if (template === "landing") {
      await expect(
        page
          .getByRole("navigation", { name: "Collection pages" })
          .getByRole("button"),
      ).toHaveText([/Second page/, /First page/]);
    } else {
      await expect(
        page
          .getByRole("region", { name: "Start here", exact: true })
          .getByRole("button", { name: "Second page", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "🏠 First page", exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByText("PRIVATE_ONLY_SECTION", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("secret-private", { exact: true })).toHaveCount(
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("wiki-drawer-open").click();
    await expect(
      page.getByRole("region", { name: "Start here", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("region", { name: "Start here", exact: true })
      .getByRole("button", { name: "Second page", exact: true })
      .click();
    await expect(
      page.getByText("PRISM_PUBLICATION_guide_second_BODY", { exact: true }),
    ).toBeVisible();
  });
}
test("unknown navigation versions fall back to the path tree", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/publication.html?malformed-navigation");
  await expect(
    page.getByRole("button", { name: "second", exact: true }),
  ).toBeVisible();
});

test("navigation validation preserves appearance and drafts on rejected saves", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  await page.getByLabel("Draft site title").fill("Working collection");
  await page
    .getByRole("button", { name: "Add navigation section", exact: true })
    .click();
  await page.getByLabel("Section 1 title", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Name every navigation section",
  );
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.writes.length,
    ),
  ).toBe(0);
  await page.getByLabel("Section 1 title", { exact: true }).fill("Explore");
  await page
    .getByLabel("Add page to section 1", { exact: true })
    .selectOption("reference");
  await page.evaluate(() => {
    (window as any).prismPresentationFixture.fail = true;
  });
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic write unavailable",
  );
  await expect(page.getByLabel("Section 1 title", { exact: true })).toHaveValue(
    "Explore",
  );
  await expect(page.getByLabel("Draft site title")).toHaveValue(
    "Working collection",
  );
  await page.evaluate(() => {
    (window as any).prismPresentationFixture.fail = false;
  });
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByText("Private draft saved", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("fixture-presentation")!).draft,
  );
  expect(saved).toMatchObject({
    title: "Working collection",
    theme: {
      font: "sans",
      navigation: {
        version: 1,
        sections: [{ title: "Explore", noteIds: ["reference"] }],
      },
    },
  });
  await page
    .getByRole("button", { name: "Use page path tree", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(
    page.getByText("Private draft saved", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("fixture-presentation")!).draft.theme,
    ),
  ).toEqual({ font: "sans" });
});

test("section count and total appearance byte limits remain visible and reversible", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  for (let i = 0; i < 8; i++)
    await page
      .getByRole("button", { name: "Add navigation section", exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "Add navigation section", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Publication logo URL")
    .fill("https://example.test/" + "a".repeat(4100));
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("4 KB limit");
  expect(
    await page.evaluate(
      () => (window as any).prismPresentationFixture.writes.length,
    ),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Remove section 8", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add navigation section", exact: true }),
  ).toBeEnabled();
});

test("saved unavailable references are anonymous and unknown navigation cannot be silently replaced", async ({
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
  await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem("fixture-presentation")!);
    state.draft.theme.navigation = {
      version: 1,
      sections: [{ title: "Read first", noteIds: ["excluded", "missing"] }],
    };
    sessionStorage.setItem("fixture-presentation", JSON.stringify(state));
  });
  await page.reload();
  await studio(page);
  await expect(page.getByText("Unavailable page", { exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole("region", {name: "Site navigation", exact: true}).getByText("EXCLUDED_PAGE_TITLE", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem("fixture-presentation")!);
    state.draft.theme.navigation = { version: 99, sections: [] };
    sessionStorage.setItem("fixture-presentation", JSON.stringify(state));
  });
  await page.reload();
  await studio(page);
  await expect(page.getByRole("alert")).toContainText("not supported");
  await expect(
    page.getByRole("button", { name: "Add navigation section", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Use page path tree", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add navigation section", exact: true }),
  ).toBeEnabled();
});

for (const width of [1440, 320])
  test(`navigation editor fits studio at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(
      `/e2e-fixtures/presentation.html?visual${width === 320 ? "&dark" : ""}`,
    );
    await studio(page);
    await page
      .getByRole("button", { name: "Add navigation section", exact: true })
      .click();
    await page
      .getByLabel("Section 1 title", { exact: true })
      .fill("Start here");
    await page
      .getByLabel("Add page to section 1", { exact: true })
      .selectOption("welcome");
    await page
      .getByRole("button", { name: "Add navigation section", exact: true })
      .click();
    await page
      .getByLabel("Section 2 title", { exact: true })
      .fill("Explore the collection");
    await page
      .getByLabel("Add page to section 2", { exact: true })
      .selectOption("reference");
    await page
      .getByRole("region", { name: "Site navigation", exact: true })
      .scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`navigation-${width}.png`),
      animations: "disabled",
    });
  });

test("fixed private preview allows parent interaction while CSP blocks authored executable content", async ({
  page,
}) => {
  let scriptRequests = 0;
  await page.route("**/preview-unsafe-probe.js", async (route) => {
    scriptRequests++;
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.parent.__previewExternal = true",
    });
  });
  await page.goto("/e2e-fixtures/presentation.html");
  await studio(page);
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
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
    (window as any).previewViolations = [];
    doc.addEventListener("securitypolicyviolation", (event) =>
      (window as any).previewViolations.push(event.violatedDirective),
    );
    const inline = doc.createElement("script");
    inline.textContent = "window.parent.__previewInline = true";
    doc.body.append(inline);
    const external = doc.createElement("script");
    external.src = `${location.origin}/preview-unsafe-probe.js`;
    doc.body.append(external);
    const button = doc.createElement("button");
    button.textContent = "Unsafe handler probe";
    button.setAttribute("onclick", "window.parent.__previewHandler = true");
    doc.body.append(button);
    const link = doc.createElement("a");
    link.textContent = "Unsafe URL probe";
    link.href = "javascript:window.parent.__previewUrl=true;void(0)";
    doc.body.append(link);
  });
  await frame
    .getByRole("button", { name: "Unsafe handler probe", exact: true })
    .click();
  await frame
    .getByRole("link", { name: "Unsafe URL probe", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).previewViolations.length))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() => ({
      inline: !!(window as any).__previewInline,
      external: !!(window as any).__previewExternal,
      handler: !!(window as any).__previewHandler,
      url: !!(window as any).__previewUrl,
    })),
  ).toEqual({ inline: false, external: false, handler: false, url: false });
  expect(scriptRequests).toBe(0);
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-same-origin allow-scripts",
  );
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
