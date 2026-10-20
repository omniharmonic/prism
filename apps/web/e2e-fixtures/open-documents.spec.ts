import { expect, test, type Page } from "@playwright/test";
async function state(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).prismTabs.getState();
    return {
      tabs: s.openTabs,
      active: s.activeTabId,
      history: s.navHistory,
      index: s.navIndex,
    };
  });
}
async function menu(page: Page) {
  await page.getByRole("button", { name: /^Open documents \(/ }).click();
  return page.getByRole("dialog", { name: /^Open documents/ });
}

test("twenty crowded tabs retain all actions, searchable full titles, active and unsaved state", async ({
  page,
}, info) => {
  await page.goto("/e2e-fixtures/open-documents.html");
  const before = await state(page);
  // The breadcrumb yields to the tabs first: in a strip that scrolls it is only its "…" menu, which still lists the trail.
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  await expect(crumbs).toHaveAttribute("data-room", "menu");
  await crumbs.getByRole("button", { name: "Show 2 locations" }).click();
  await expect(page.getByRole("menu", { name: "More locations" }).getByRole("menuitem")).toHaveText(["Projects", "Prism"]);
  await page.keyboard.press("Escape");
  const dialog = await menu(page);
  await expect(dialog.locator("li[data-document-id]")).toHaveCount(20);
  await expect(
    dialog.locator('[data-document-id="doc-1"] button[aria-current=page]'),
  ).toBeVisible();
  await expect(dialog.locator('[data-document-id="doc-5"]')).toContainText(
    "Unsaved",
  );
  await dialog.getByLabel("Find an open document").fill("Document 20");
  await expect(dialog.locator("li[data-document-id]")).toHaveCount(1);
  await expect(dialog.locator('[data-document-id="doc-20"]')).toContainText(
    "long-term collaborative workspace planning",
  );
  await dialog.getByRole("button", { name: /^Open Document 20/ }).click();
  const after = await state(page);
  expect(after.active).toBe(after.tabs[19].id);
  expect(after.tabs).toEqual(before.tabs);
  const lastTab = page
    .getByRole("navigation", { name: "Open document tabs" })
    .locator('[data-tab-id="doc-20"]');
  await expect.poll(async () => {
    const tabBounds = await lastTab.boundingBox();
    const stripBounds = await page.getByRole("navigation", { name: "Open document tabs" }).boundingBox();
    return !!tabBounds && !!stripBounds && tabBounds.x >= stripBounds.x - 1 && tabBounds.x + tabBounds.width <= stripBounds.x + stripBounds.width + 1;
  }).toBe(true);
  await menu(page);
  await page.screenshot({ path: info.outputPath("open-documents-light.png") });
});

test("menu reorder preserves active document, history, dirty markers and live editor draft", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/open-documents.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await editor.fill("A04_DRAFT_KEPT");
  const before = await state(page);
  const dialog = await menu(page);
  const row = dialog.locator('[data-document-id="doc-1"]');
  await row.getByRole("button", { name: /later$/ }).click();
  const after = await state(page);
  expect(after.tabs[1].noteId).toBe("doc-1");
  expect(after.active).toBe(before.active);
  expect(after.history).toEqual(before.history);
  expect(after.tabs.find((tab: any) => tab.noteId === "doc-5").isDirty).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await expect(editor).toContainText("A04_DRAFT_KEPT");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).prismTabWrites.some((write: any) =>
          write.content?.includes("A04_DRAFT_KEPT"),
        ),
      ),
    )
    .toBe(true);
});

test("tab keyboard reorder is local, focus stays visible, and close supports remaining history", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/open-documents.html");
  const strip = page.getByRole("navigation", { name: "Open document tabs" });
  const tab = strip.getByRole("button", {
    name: "Open Working draft",
    exact: true,
  });
  await tab.focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  expect((await state(page)).tabs[1].noteId).toBe("doc-1");
  await expect(tab).toBeFocused();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  expect((await state(page)).tabs[0].noteId).toBe("doc-1");
  await expect(tab).toBeFocused();
  const dialog = await menu(page);
  await dialog.getByLabel("Find an open document").fill("Document 19");
  await dialog.getByRole("button", { name: /^Open Document 19/ }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  expect((await state(page)).active).toBe((await state(page)).tabs[0].id);
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await menu(page);
  await page
    .getByRole("dialog")
    .locator('[data-document-id="doc-19"]')
    .getByRole("button", { name: /^Close / })
    .click();
  expect((await state(page)).tabs).toHaveLength(19);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open documents (19)" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  expect((await state(page)).active).toBe((await state(page)).tabs[0].id);
});

test("keyboard traverses menu controls, filtering empties honestly, and dark tablet remains in bounds", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/e2e-fixtures/open-documents.html?dark");
  const dialog = await menu(page);
  await expect(dialog.getByLabel("Find an open document")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Open Working draft", exact: true }),
  ).toBeFocused();
  await dialog.getByLabel("Find an open document").fill("nothing matches this");
  await expect(dialog.getByText("No open documents match.")).toBeVisible();
  await dialog.getByLabel("Find an open document").fill("");
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
  await page.screenshot({
    path: info.outputPath("open-documents-dark-tablet.png"),
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open documents (20)" }),
  ).toBeFocused();
});

test("mobile header retains existing controls and has no second document switcher", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/open-documents.html");
  await expect(
    page.getByRole("button", { name: /^Open documents \(/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Back", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("span.truncate").filter({ hasText: /^Working draft$/ }),
  ).toBeVisible();
});

test("boundary menu movement and inactive keyboard close retain usable focus", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/open-documents.html");
  const before = await state(page);
  const dialog = await menu(page);
  const second = dialog.locator('[data-document-id="doc-2"]');
  await second.getByRole("button", { name: /earlier$/ }).focus();
  await page.keyboard.press("Enter");
  expect((await state(page)).tabs[0].noteId).toBe("doc-2");
  await expect(second.getByRole("button", { name: /^Open / })).toBeFocused();
  await page.keyboard.press("Escape");
  const strip = page.getByRole("navigation", { name: "Open document tabs" });
  const close = strip
    .locator('[data-tab-id="doc-2"]')
    .getByRole("button", { name: /^Close / });
  await close.focus();
  await page.keyboard.press("Enter");
  expect((await state(page)).active).toBe(before.active);
  await expect(
    strip.getByRole("button", { name: "Open Working draft", exact: true }),
  ).toBeFocused();
});

test("existing drag reorder works and editor shortcuts do not reorder tabs or scroll the document", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/open-documents.html");
  const strip = page.getByRole("navigation", { name: "Open document tabs" });
  await strip
    .locator('[data-tab-id="doc-1"]')
    .dragTo(strip.locator('[data-tab-id="doc-3"]'));
  expect((await state(page)).tabs[2].noteId).toBe("doc-1");
  const before = await state(page);
  const editor = page.locator(".tiptap[contenteditable=true]");
  await editor.focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  expect((await state(page)).tabs).toEqual(before.tabs);
  await page.evaluate(() => {
    document.body.style.minHeight = "2000px";
    window.scrollTo(0, 300);
  });
  const scroll = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => {
    const store = (window as any).prismTabs;
    store.getState().setActiveTab(store.getState().openTabs[19].id);
  });
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
});
