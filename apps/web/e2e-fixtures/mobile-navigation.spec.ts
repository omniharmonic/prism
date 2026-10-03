import { test, expect, type Page, type Locator } from "@playwright/test";
const nav = (page: Page) => page.getByRole("navigation", { name: "Mobile workspace" });
const sheet = (page: Page) => page.locator("dialog.prism-mobile-sheet");
async function start(page: Page, query = "") {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html" + query);
  await expect(nav(page)).toBeVisible();
}
async function openMore(page: Page) {
  await nav(page).getByRole("button", { name: "More", exact: true }).click();
  await expect(sheet(page)).toBeVisible();
}
async function swipe(locator: Locator) {
  await locator.evaluate((element) => {
    for (const [type, y] of [
      ["touchstart", 100],
      ["touchmove", 230],
      ["touchend", 230],
    ] as const) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientY: y }] });
      element.dispatchEvent(event);
    }
  });
}

test("labeled destinations preserve the real document, navigation and agent state", async ({ page }) => {
  await start(page, "?navigation&agent");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" MOBILE_DRAFT_RETAINS");
  await page.evaluate(() => {
    (window as any).mobileEditor = document.querySelector(".tiptap[contenteditable=true]");
  });
  expect(await nav(page).getByRole("button").allTextContents()).toEqual([
    "Notes",
    "Messages",
    "Search",
    "Agent",
    "More",
  ]);
  for (const button of await nav(page).getByRole("button").all()) {
    const rect = await button.boundingBox();
    expect(rect!.height).toBeGreaterThanOrEqual(44);
    expect(rect!.width).toBeGreaterThanOrEqual(44);
  }
  await nav(page).getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toContainText("Personal vault");
  await expect(
    page
      .getByRole("dialog", { name: "Workspace navigation" })
      .getByRole("button", { name: "New page", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav(page).getByRole("button", { name: "Notes", exact: true })).toBeFocused();
  await nav(page).getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Document panel" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav(page).getByRole("button", { name: "Agent", exact: true })).toBeFocused();
  await openMore(page);
  await page.keyboard.press("Escape");
  await expect(editor).toContainText("MOBILE_DRAFT_RETAINS");
  expect(
    await page.evaluate(
      () => (window as any).mobileEditor === document.querySelector(".tiptap[contenteditable=true]"),
    ),
  ).toBe(true);
  await nav(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
  await page.keyboard.press("Escape");
  await nav(page).getByRole("button", { name: "Messages", exact: true }).click();
  await nav(page).getByRole("button", { name: "Messages", exact: true }).click();
  await expect(nav(page).getByRole("button", { name: "Messages", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).prismFixtureUI
          .getState()
          .openTabs.filter((tab: any) => tab.noteId === "vault-messages").length,
    ),
  ).toBe(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(nav(page)).toHaveCount(0);
});

test("More retains every page action and transitions to creation without focus loss", async ({ page }) => {
  await start(page, "?agent");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await openMore(page);
  for (const name of [
    "New page",
    "Choose page type",
    "Open documents",
    "Details & metadata",
    "Ask about this note",
    "Agent chat",
    "Version history",
    "Open graph view",
    "Add to favorites",
    "Settings",
  ])
    await expect(
      sheet(page).getByRole("button", { name: new RegExp("^" + name.replace("&", "&")) }),
    ).toBeVisible();
  await expect(sheet(page).getByText("Reading font")).toBeVisible();
  // "New page" creates at once (NP-MB-02); the title-first chooser is its own row.
  await sheet(page).getByRole("button", { name: "Choose page type", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Page title" })).toBeFocused();
  await page.getByRole("textbox", { name: "Page title" }).fill("Unsent page idea");
  await page.keyboard.press("Escape");
  await expect(nav(page).getByRole("button", { name: "More", exact: true })).toBeFocused();
  await openMore(page);
  await sheet(page).getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav(page).getByRole("button", { name: "More", exact: true })).toBeFocused();
  await openMore(page);
  await sheet(page).getByRole("button", { name: "Details & metadata", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Document panel" })
      .getByRole("tab", { name: "Properties", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav(page).getByRole("button", { name: "More", exact: true })).toBeFocused();
});

test("open documents supports keyboard selection, close, long names and handle-only dismissal", async ({ page }, info) => {
  await start(page);
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.evaluate(() => {
    const ui = (window as any).prismFixtureUI;
    const first = ui.getState().openTabs[0];
    ui.setState({
      openTabs: [
        first,
        ...Array.from({ length: 19 }, (_, i) => ({
          ...first,
          id: "fixture-tab-" + i,
          noteId: "field-notes",
          title: "Research document " + i + " — a long title about connected ideas and collaboration",
          isDirty: i === 3,
        })),
      ],
    });
  });
  await openMore(page);
  await sheet(page).getByRole("button", { name: "Open documents 20", exact: true }).click();
  await expect(sheet(page)).toHaveAccessibleName("Open documents · 20");
  await expect(sheet(page).locator(".prism-mobile-document-open")).toHaveCount(20);
  expect(await sheet(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({path: info.outputPath('mobile-open-documents.png')});
  await expect(
    sheet(page).getByRole("button", { name: /Open Research document 3.*unsaved changes/ }),
  ).toBeVisible();
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog.prism-mobile-sheet"))).toBe(
      true,
    );
  }
  await sheet(page)
    .getByRole("button", { name: /Close Research document 18/ })
    .click();
  await expect(sheet(page).locator(".prism-mobile-document-open")).toHaveCount(19);
  await swipe(sheet(page).locator(".prism-mobile-sheet-content"));
  await expect(sheet(page)).toBeVisible();
  await swipe(sheet(page).locator(".prism-mobile-sheet-handle"));
  await expect(sheet(page)).toHaveCount(0);
  await expect(nav(page).getByRole("button", { name: "More", exact: true })).toBeFocused();
  await openMore(page);
  await sheet(page).getByRole("button", { name: "Open documents 19", exact: true }).click();
  const open = sheet(page).getByRole("button", { name: "Open A living workspace", exact: true });
  await open.focus();
  await open.press("Enter");
  await expect(sheet(page)).toHaveCount(0);
  await expect(nav(page).getByRole("button", { name: "More", exact: true })).toBeFocused();
});

test("keyboard viewport hides navigation during editing and bounds an open sheet", async ({ page }) => {
  await page.addInitScript(() => {
    const vv = Object.assign(new EventTarget(), {
      height: 844,
      width: 390,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    (window as any).mobileViewport = vv;
  });
  await start(page);
  const input = page.locator('.tiptap[contenteditable=true]');
  await expect(input).toBeVisible();
  await input.press('ControlOrMeta+End');
  await input.pressSequentially(' Retained mobile document draft');
  await page.evaluate(() => {
    const vv = (window as any).mobileViewport;
    vv.height = 400;
    vv.dispatchEvent(new Event("resize"));
  });
  await expect(nav(page)).toBeHidden();
  await expect(input).toContainText("Retained mobile document draft");
  await page.evaluate(() => {
    const vv = (window as any).mobileViewport;
    vv.scale = 2;
    vv.dispatchEvent(new Event("resize"));
  });
  await expect(nav(page)).toBeVisible();
  await page.evaluate(() => {
    const vv = (window as any).mobileViewport;
    vv.scale = 1;
    vv.height = 844;
    vv.dispatchEvent(new Event("resize"));
  });
  await openMore(page);
  await page.evaluate(() => {
    const vv = (window as any).mobileViewport;
    vv.height = 400;
    vv.dispatchEvent(new Event("resize"));
  });
  const bounds = await sheet(page).boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
  await page.keyboard.press("Escape");
  await expect(input).toContainText("Retained mobile document draft");
});

for (const appearance of ["390-light", "320-dark", "landscape"])
  test(`mobile navigation visual ${appearance}`, async ({ page }, info) => {
    await page.setViewportSize(
      appearance === "320-dark"
        ? { width: 320, height: 760 }
        : appearance === "landscape"
          ? { width: 600, height: 390 }
          : { width: 390, height: 844 },
    );
    await page.goto("/e2e-fixtures/workspace.html?navigation" + (appearance.includes("dark") ? "&dark" : ""));
    await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
    await expect(nav(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`mobile-${appearance}.png`) });
    await openMore(page);
    await expect(sheet(page).getByRole("button", { name: "New page", exact: true })).toBeVisible();
    expect(await sheet(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`mobile-more-${appearance}.png`) });
  });
