import { test, expect, type Page } from "@playwright/test";
async function open(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/page-creation.html${query}`);
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "New page", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create page", exact: true }),
  ).toBeEnabled();
}
test("title-first page uses the current folder and edits persist through reload", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByLabel("Page title")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Location: Projects / Prism" }),
  ).toBeVisible();
  await page.getByLabel("Page title").fill("Field notes");
  await page.getByLabel("Page title").press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.fill("A03_CREATED_EDIT_OK");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).prismCreation.latest().content),
    )
    .toContain("A03_CREATED_EDIT_OK");
  await page.reload();
  await expect(editor).toContainText("A03_CREATED_EDIT_OK");
  expect(
    await page.evaluate(() => (window as any).prismCreation.latest().path),
  ).toBe("Projects/Prism/Field notes");
});
test("blank title starts Untitled and avoids a known duplicate without timestamp clutter", async ({
  page,
}) => {
  await open(page, "?prefixed");
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).prismCreation.latest().path),
  ).toBe("vault/Projects/Prism/Untitled (2)");
  expect(
    await page.evaluate(
      () => (window as any).prismCreation.latest().metadata.type,
    ),
  ).toBe("document");
});
test("folder picker searches existing folders without treating note names as folders", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("button", { name: "Location: Projects / Prism" })
    .click();
  await page.getByLabel("Find a folder").fill("Weekly review");
  await expect(
    page.getByText("No matching folders.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Find a folder").fill("Journal");
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await page.getByLabel("Page title").fill("Daily notes");
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).prismCreation.latest().path),
  ).toBe("Journal/Daily notes");
});
test("pending creates resist double activation and failures keep title and location", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("Page title").fill("A deliberate page");
  await page.evaluate(() => {
    (window as any).prismCreation.fail = true;
  });
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't create");
  await expect(page.getByLabel("Page title")).toHaveValue("A deliberate page");
  await expect(
    page.getByRole("button", { name: "Location: Projects / Prism" }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.assign((window as any).prismCreation, { fail: false, hold: true });
  });
  await page.getByLabel("Page title").press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Creating…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismCreation.requests.length),
  ).toBe(2);
  await page.evaluate(() => (window as any).prismCreation.release());
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("scope changes close creation and a late result cannot open a tab in another vault", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    (window as any).prismCreation.hold = true;
  });
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).prismCreation.requests.length),
    )
    .toBe(1);
  await page.evaluate(() => (window as any).prismCreation.switchScope());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => (window as any).prismCreation.release());
  await expect(page.locator(".tiptap")).toHaveCount(0);
});
test("virtual tabs default to home and a legacy host needs no optional agent or host provider", async ({
  page,
}) => {
  await open(page, "?virtual&legacy");
  await expect(
    page.getByRole("button", { name: "Location: Vault home" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).prismCreation.latest().path),
  ).toBe("Untitled");
});
test("explicit tree context wins; invalid titles do not create nested paths", async ({
  page,
}) => {
  await open(page, "?folder=Shared%2FResearch");
  await expect(
    page.getByRole("button", { name: "Location: Shared / Research" }),
  ).toBeVisible();
  await page.getByLabel("Page title").fill("../Escape");
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("without slashes");
  expect(
    await page.evaluate(() => (window as any).prismCreation.requests.length),
  ).toBe(0);
});
test("folder discovery failure has honest root fallback and retry", async ({
  page,
}) => {
  await open(page, "?tree-error");
  await expect(page.getByRole("status")).toContainText("Folders couldn’t load");
  await page.evaluate(() => {
    (window as any).prismCreation.failTree = false;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Location: Projects / Prism" }),
  ).toBeVisible();
});
test("all specialized page defaults and dedicated Task/Message entry points remain available", async ({
  page,
}) => {
  test.setTimeout(90_000); // nine full page loads in one test
  for (const [label, type] of [
    ["Canvas", "canvas"],
    ["Spreadsheet", "spreadsheet"],
    ["Presentation", "presentation"],
    ["Code file", "code"],
    ["Dashboard", "dashboard"],
    ["Website", "website"],
    ["Email draft", "email"],
  ]) {
    await open(page);
    await page.getByRole("button", { name: "Page", exact: true }).click();
    await expect(page.locator("#creation-formats button")).toHaveCount(10);
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // The create is asynchronous: read the result only once it has landed.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).prismCreation.latest()?.metadata?.type,
        ),
      )
      .toBe(type);
  }
  await open(page);
  await page.getByRole("button", { name: "Page", exact: true }).click();
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await expect(page.getByText("New Task", { exact: true })).toBeVisible();
  await open(page);
  await page.getByRole("button", { name: "Page", exact: true }).click();
  await page.getByRole("button", { name: "Message", exact: true }).click();
  await expect(
    page.getByText("Compose Message", { exact: true }),
  ).toBeVisible();
});
for (const theme of ["light", "dark"])
  test(`creation matches the calm page flow at phone and desktop sizes in ${theme}`, async ({
    page,
  }, testInfo) => {
    await open(page, theme === "dark" ? "?dark" : "");
    await page.getByLabel("Page title").fill("Notes for a living workspace");
    await page.screenshot({
      path: testInfo.outputPath(`creation-desktop-${theme}.png`),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Page title")).toHaveValue(
      "Notes for a living workspace",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`creation-phone-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "New page", exact: true }),
    ).toBeFocused();
  });

test("keyboard focus stays in creation, folder search Enter is harmless, and a reduced CSS viewport keeps actions reachable", async ({
  page,
}, testInfo) => {
  await open(
    page,
    "?folder=Projects%2FAn%20especially%20long%20shared%20workspace%20folder%20name",
  );
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  await page.getByRole("button", { name: /^Location:/ }).click();
  await page.getByLabel("Find a folder").fill("Journal");
  await page.getByLabel("Find a folder").press("Enter");
  expect(
    await page.evaluate(() => (window as any).prismCreation.requests.length),
  ).toBe(0);
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  // Reflow coverage, not a claim of physical browser/OS zoom verification.
  await page.setViewportSize({ width: 640, height: 360 });
  await page
    .getByRole("button", { name: "Create page", exact: true })
    .scrollIntoViewIfNeeded();
  const bounds = await page
    .getByRole("button", { name: "Create page", exact: true })
    .boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(640);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(360);
  await page
    .getByRole("button", { name: "Create page", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("creation-reflow.png"),
  });
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Escape dismisses creation without cancelling its containing navigation dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "?nested");
  await page.getByLabel("Page title").fill("Temporary draft");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "New page", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Navigation fixture", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New page", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => (window as any).prismCreation.requests.length),
  ).toBe(0);
});
