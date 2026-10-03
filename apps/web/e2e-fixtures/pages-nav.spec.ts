import { test, expect, type Page } from "@playwright/test";

/** Pages & navigation (nested pages, move, Trash, page menu, synced favorites/recents, breadcrumbs, templates). */
const SHOTS = process.env.PAGES_NAV_SHOTS;
const url = (q = "") => `/e2e-fixtures/pages-nav.html${q}`;
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, unknown>>);
const notePath = (page: Page, id: string) => page.evaluate((id) => (window as any).prismFixtureNotes.find((n: any) => n.id === id)?.path, id);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const tree = (page: Page) => nav(page).getByRole("region", { name: "Pages", exact: true });
const row = (page: Page, name: string) => tree(page).getByRole("button", { name, exact: true });
async function expand(page: Page, name: string) {
  await expect(row(page, name)).toBeVisible();
  const toggle = tree(page).getByRole("button", { name: `Expand ${name}`, exact: true });
  if (await toggle.count()) await toggle.click();
}

test("a page with sub-pages is one node: it opens, discloses its children, and adds a page inside", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url());
  // The open page's ancestors are revealed; "Prism" is a page AND the parent of its sub-pages.
  await expect(row(page, "Prism")).toBeVisible();
  await expect(nav(page).getByRole("button", { name: "Collapse Prism", exact: true })).toBeVisible();
  await expect(row(page, "Plan")).toBeVisible();
  await expect(row(page, "Week 1")).toHaveCount(0);
  await expand(page, "Plan");
  await expect(row(page, "Week 1")).toBeVisible();
  await row(page, "Prism").click();
  await expect(page.getByRole("heading", { name: "Rename Prism", exact: true })).toBeVisible();
  await shot(page, "tree-nested-1440");

  // "+" on a row creates the sub-page at once, title focused (NP-SB-13): type the name, Enter.
  await nav(page).getByRole("button", { name: "Add a page inside Prism", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("Untitled");
  expect((await writes(page)).find((w) => w.create)).toMatchObject({ create: { path: "vault/Projects/Prism/Untitled" } });
  await title.fill("Roadmap");
  await title.press("Enter");
  await expect(page.getByRole("heading", { name: "Rename Roadmap", exact: true })).toBeVisible();
  await expect(row(page, "Roadmap")).toBeVisible();
});

test("Move to… moves a page with its sub-pages, and the breadcrumbs follow", async ({ page }) => {
  await page.goto(url("?open=week1"));
  await expect(page.getByRole("navigation", { name: "Document location" })).toContainText("Plan");
  await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move “Plan”" });
  await expect(dialog).toBeVisible();
  // Its own subtree is never offered as a destination.
  await dialog.getByLabel("Find a page or folder").fill("Week 1");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await dialog.getByLabel("Find a page or folder").fill("Archive");
  await shot(page, "move-picker-1440");
  await dialog.getByRole("option", { name: /Archive/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Moved “Plan”" })).toBeVisible();
  expect(await notePath(page, "plan")).toBe("vault/Archive/Plan");
  expect(await notePath(page, "week1")).toBe("vault/Archive/Plan/Week 1");
  const move = (await writes(page)).find((w) => w.move);
  expect(move).toMatchObject({ move: "plan", newParentPath: "vault/Archive" });
  expect(typeof move!.if_updated_at).toBe("string");
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  await expect(crumbs).toContainText("Archive");
  await crumbs.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Plan", exact: true })).toBeVisible();
});

test("drag and drop reparents a page and reorders siblings", async ({ page }) => {
  await page.goto(url());
  await expand(page, "Plan");
  // Drop Week 1 onto the middle of Archive → nested inside it.
  await row(page, "Week 1").dragTo(row(page, "Archive"));
  await expect.poll(() => notePath(page, "week1")).toBe("vault/Archive/Week 1");
  // Drop Plan on the top edge of "A living workspace" → reordered before it.
  const target = row(page, "A living workspace");
  const box = (await target.boundingBox())!;
  await row(page, "Plan").dragTo(target, { targetPosition: { x: 20, y: 2 } });
  await expect.poll(async () => (await writes(page)).filter((w) => (w.set as any)?.prism_order !== undefined).length).toBeGreaterThan(0);
  const order = await nav(page).locator(".page-tree-open").allTextContents();
  expect(order.indexOf("Plan")).toBeLessThan(order.indexOf("A living workspace"));
  expect(box.height).toBeGreaterThan(0);
});

test("a partial move reports what moved and finishes on retry", async ({ page }) => {
  await page.goto(url("?fail-move=week1"));
  await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move “Plan”" });
  await dialog.getByLabel("Find a page or folder").fill("Archive");
  await dialog.getByRole("option", { name: /Archive/ }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Part of “Plan” moved" });
  await expect(alert).toBeVisible();
  expect(await notePath(page, "plan")).toBe("vault/Archive/Plan");
  expect(await notePath(page, "week1")).toBe("vault/Projects/Prism/Plan/Week 1");
  await alert.getByRole("button", { name: "Finish move" }).click();
  await expect.poll(() => notePath(page, "week1")).toBe("vault/Archive/Plan/Week 1");
  expect((await writes(page)).filter((w) => w.move).at(-1)).toMatchObject({ moveId: "move-1" });
});

test("Trash: delete moves to Trash with Undo; the Trash restores and deletes permanently", async ({ page }) => {
  await page.goto(url());
  await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  const toast = page.getByRole("status").filter({ hasText: "Moved “Plan” and 1 page inside to Trash" });
  await expect(toast).toBeVisible();
  await expect(row(page, "Plan")).toHaveCount(0);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(row(page, "Plan")).toBeVisible();

  await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(row(page, "Plan")).toHaveCount(0);
  await nav(page).getByRole("button", { name: "Trash", exact: true }).click();
  const trash = page.getByRole("dialog", { name: "Trash" });
  await expect(trash.getByRole("listitem", { name: "Plan" })).toContainText("1 page inside");
  await shot(page, "trash-1440");
  await trash.getByLabel("Search the Trash").fill("nothing-matches");
  await expect(trash).toContainText("No matching pages");
  await trash.getByLabel("Search the Trash").fill("plan");
  await trash.getByRole("button", { name: "Restore Plan" }).click();
  await expect(trash).toContainText("No matching pages");
  await trash.getByLabel("Search the Trash").fill("");
  await expect(trash).toContainText("Trash is empty");
  await trash.getByRole("button", { name: "Close Trash" }).click();
  await expand(page, "Plan");
  await expect(row(page, "Week 1")).toBeVisible();

  // Delete permanently is two explicit steps, from the Trash only.
  await nav(page).getByRole("button", { name: "Page actions for Archive", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await nav(page).getByRole("button", { name: "Trash", exact: true }).click();
  await trash.getByRole("button", { name: "Delete Archive permanently" }).click();
  await trash.getByRole("button", { name: "Delete forever" }).click();
  await expect(trash).toContainText("Trash is empty");
  expect(await notePath(page, "archive")).toBeUndefined();
});

test("integration-owned pages can't be moved or trashed from the page menu", async ({ page }) => {
  await page.goto(url());
  await expand(page, "messages");
  await expand(page, "chat");
  await nav(page).getByRole("button", { name: "Page actions for Team room", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Move to…" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Move to Trash" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(nav(page).getByRole("button", { name: "Add a page inside Team room" })).toHaveCount(0);
});

test("page ⋯ menu: favorite, duplicate, copy link, lock, export and history", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?open=prism"));
  await expect(page.getByRole("heading", { name: "Rename Prism", exact: true })).toBeVisible();
  const open = async () => page.getByRole("button", { name: "Page actions", exact: true }).click();
  await open();
  await shot(page, "page-menu-1440");
  await page.getByRole("menuitem", { name: "Add to Favorites" }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Prism");

  await open();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/page\/prism$/);

  await open();
  await page.getByRole("menuitem", { name: "Lock page" }).click();
  await expect(page.getByText("This page is locked, so editing is off.")).toBeVisible();
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  expect((await writes(page)).filter((w) => w.meta === "prism").map((w) => (w.set as any)?.prism_locked)).toEqual([true, false]);

  await open();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
  expect((await download).suggestedFilename()).toBe("Prism.md");

  await open();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  expect(await page.evaluate(() => { const s = (window as any).prismFixtureUI.getState(); return [s.contextPanelOpen, s.contextPanelTab]; })).toEqual([true, "history"]);

  await open();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("heading", { name: "Rename Prism (copy)", exact: true })).toBeVisible();
  expect((await writes(page)).find((w) => w.create)).toMatchObject({ create: { path: "vault/Projects/Prism (copy)", tags: ["page"] } });
});

test("favorites and recents sync through the server and migrate this device's shortcuts once", async ({ page, browser }) => {
  const scope = (origin: string) => JSON.stringify([origin + "/api", "default", "primary", "owner@example.test"]);
  await page.addInitScript((key) => {
    // This device's older per-device favorites (seeded once, before the first load).
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(key.replace(encodeURIComponent("ORIGIN"), encodeURIComponent(location.origin)), JSON.stringify({ version: 1, favorites: ["archive"], recents: [], legacyHandled: true }));
      sessionStorage.setItem("seeded", "1");
    }
  }, "prism:note-shortcuts:v1:" + encodeURIComponent(scope("ORIGIN")));
  await page.goto(url());
  const favorites = page.getByRole("region", { name: "Favorites", exact: true });
  await expect(favorites).toContainText("Archive");
  const migrations = (await writes(page)).filter((w) => (w.preferences as any)?.preferences?.favorites?.includes("archive"));
  expect(migrations.length).toBeGreaterThanOrEqual(1);
  await row(page, "Plan").click();
  await page.getByRole("button", { name: "Add to Favorites", exact: true }).click();
  await expect(favorites).toContainText("Plan");
  const server = await page.evaluate(() => (window as any).prismFixturePrefs());
  expect(server.prefs.favorites).toEqual(["plan", "archive"]);
  expect(server.prefs.recents.slice(0, 2)).toEqual(["plan", "living"]);
  await page.reload();
  await expect(favorites).toContainText("Plan");
  expect((await writes(page)).filter((w) => w.preferences && (w.preferences as any).preferences.favorites.length === 1)).toHaveLength(0);

  // Another device: no local storage at all, the server's record alone.
  const other = await browser.newContext();
  const phone = await other.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(url(`?prefs=${encodeURIComponent(JSON.stringify(server.prefs))}`));
  await phone.getByRole("button", { name: "Notes", exact: true }).click();
  const drawer = phone.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer.getByRole("region", { name: "Favorites", exact: true })).toContainText("Plan");
  await expect(drawer.getByRole("region", { name: "Favorites", exact: true })).toContainText("Archive");
  await shot(phone, "drawer-favorites-390");
  await other.close();
});

test("⌘K lists recent pages first, and the palette opens the Trash and templates", async ({ page }) => {
  await page.goto(url(`?prefs=${encodeURIComponent(JSON.stringify({ recents: ["week1", "archive"] }))}`));
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search workspace" });
  const recent = search.getByRole("group", { name: "Recent pages" });
  await expect(recent.getByRole("option").first()).toContainText("A living workspace");
  await expect(recent).toContainText("Week 1");
  await shot(page, "command-k-recents-1440");
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await search.getByRole("combobox").fill("Open Trash");
  await search.getByRole("option", { name: "Open Trash" }).click();
  await expect(page.getByRole("dialog", { name: "Trash" })).toBeVisible();
});

test("breadcrumbs open parent pages, reveal folders, and collapse long trails", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?open=watersheds"));
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  await expect(crumbs.getByRole("button", { name: "Show 1 more location" })).toBeVisible();
  await expect(crumbs).toContainText("Areas");
  await expect(crumbs).toContainText("Watersheds");
  await shot(page, "breadcrumbs-1440");
  await crumbs.getByRole("button", { name: "Show 1 more location" }).click();
  await page.getByRole("menuitem", { name: "Research" }).click();
  await expect(row(page, "Research")).toBeVisible();
  await page.goto(url("?open=week1"));
  await page.getByRole("navigation", { name: "Document location" }).getByRole("button", { name: "Prism", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Prism", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("?open=watersheds"));
  await expect(page.getByRole("navigation", { name: "Document location" }).getByRole("button", { name: "Show 3 more locations" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("New page from template copies the template's body, properties and tags", async ({ page }) => {
  await page.goto(url());
  await nav(page).getByRole("button", { name: "New page from template", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  const templates = create.getByRole("group", { name: "Templates" });
  await expect(templates.getByRole("button")).toHaveText(["Blank page", "Meeting notes", "Project brief", "Task"]);
  await shot(page, "templates-1440");
  await templates.getByRole("button", { name: "Meeting notes" }).click();
  await create.getByLabel("Page title").fill("Design sync");
  await create.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Design sync", exact: true })).toBeVisible();
  await expect(page.locator(".tiptap")).toContainText("Attendees");
  const created = (await writes(page)).find((w) => w.create)!.create as Record<string, any>;
  expect(created.tags).toEqual(["meeting"]);
  expect(created.metadata).toMatchObject({ title: "Design sync", status: "draft", type: "document" });
  expect(created.path).toBe("vault/Projects/Prism/Design sync");
});

test("phone: the drawer tree offers page actions in a sheet and the header ⋯ works", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url());
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await drawer.getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Plan" });
  await expect(sheet.getByRole("button", { name: "Move to Trash" })).toBeVisible();
  await shot(page, "phone-actions-sheet-390");
  await sheet.getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved “Plan”" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "A living workspace" }).getByRole("button", { name: "Move to…" })).toBeVisible();
});
