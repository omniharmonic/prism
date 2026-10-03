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

// NP-SB-06
test("tree expansion persists on this device", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url());
  await expect(row(page, "Plan")).toBeVisible();
  await expect(row(page, "Week 1")).toHaveCount(0);
  await expand(page, "Plan");
  await expect(row(page, "Week 1")).toBeVisible();
  await page.reload();
  await expect(row(page, "Week 1")).toBeVisible(); // still open, nothing clicked
  await tree(page).getByRole("button", { name: "Collapse Plan", exact: true }).click();
  await expect(row(page, "Week 1")).toHaveCount(0);
  await page.reload();
  await expect(row(page, "Plan")).toBeVisible();
  await expect(row(page, "Week 1")).toHaveCount(0);
  // Remembered per account + vault, and nowhere but this device's storage.
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("prism:tree-expanded:")));
  expect(keys).toHaveLength(1);
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
  // The tree re-renders after the order write settles: poll (reading it once raced the refetch under load).
  await expect.poll(async () => {
    const order = await nav(page).locator(".page-tree-open").allTextContents();
    return order.indexOf("Plan") >= 0 && order.indexOf("Plan") < order.indexOf("A living workspace");
  }).toBe(true);
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
  await expect(trash).toContainText("Pages stay in the Trash until you delete them."); // NP-SB-10 retention notice
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

// NP-SB-04
test("favorites reorder by drag and keyboard", async ({ page, browser }) => {
  const seed = { favorites: ["plan", "archive", "weekly"], recents: [] };
  await page.goto(url(`?prefs=${encodeURIComponent(JSON.stringify(seed))}`));
  const favorites = page.getByRole("region", { name: "Favorites", exact: true });
  const names = () => favorites.locator(".workspace-nav-row").evaluateAll((rows) => rows.map((r) => r.querySelector("button")!.textContent!.trim()));
  await expect.poll(names).toEqual(["Plan", "Archive", "Weekly review"]);
  // Keyboard: Alt+Shift+↓ moves the focused favorite down; focus stays on it and the move is announced.
  const plan = favorites.getByRole("button", { name: "Plan", exact: true });
  await plan.focus();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect.poll(names).toEqual(["Archive", "Plan", "Weekly review"]);
  await expect(plan).toBeFocused();
  await expect(favorites.getByRole("status")).toHaveText("Plan moved to position 2 of 3 in Favorites");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.keyboard.press("Alt+Shift+ArrowDown"); // already last: nothing happens
  await expect.poll(names).toEqual(["Archive", "Weekly review", "Plan"]);
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect.poll(names).toEqual(["Archive", "Plan", "Weekly review"]);
  // Drag: "Weekly review" onto "Archive" puts it first.
  await favorites.locator(".workspace-nav-row", { hasText: "Weekly review" }).dragTo(favorites.locator(".workspace-nav-row", { hasText: "Archive" }));
  await expect.poll(names).toEqual(["Weekly review", "Archive", "Plan"]);
  // The order is the synced record: the server has it, and another device shows it.
  await expect.poll(async () => (await page.evaluate(() => (window as any).prismFixturePrefs())).prefs.favorites).toEqual(["weekly", "archive", "plan"]);
  const server = await page.evaluate(() => (window as any).prismFixturePrefs());
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(url(`?prefs=${encodeURIComponent(JSON.stringify(server.prefs))}`));
  const there = second.getByRole("region", { name: "Favorites", exact: true });
  await expect.poll(() => there.locator(".workspace-nav-row").evaluateAll((rows) => rows.map((r) => r.querySelector("button")!.textContent!.trim()))).toEqual(["Weekly review", "Archive", "Plan"]);
  await other.close();
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
  // The shortcut is handled by the mounted shell: pressing it before the app has
  // rendered is lost (this flaked ~1 in 25 under load).
  await expect(row(page, "Prism")).toBeVisible();
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


// ── wave 2D mounts (sharing) ─────────────────────────────────────────────────
test("sidebar: Shared with me lists shared pages for a member and opens them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?shared"));
  const shared = nav(page).getByRole("region", { name: "Shared with me" });
  await expect(shared.getByRole("button", { name: /Archive/ })).toBeVisible();
  await expect(shared.getByRole("button", { name: /Archive/ })).toContainText("with sub-pages");
  await expect(tree(page)).toBeVisible(); // a member keeps the workspace sections
  await shared.getByRole("button", { name: /Weekly review/ }).click();
  await expect(page.getByRole("heading", { name: "Rename Weekly review", exact: true })).toBeVisible();
  await expect(shared.getByRole("button", { name: /Weekly review/ })).toHaveAttribute("aria-current", "page");
  await shot(page, "shared-with-me-1440");
  // Nothing shared → no section at all for a member.
  await page.goto(url());
  await expect(tree(page)).toBeVisible();
  await expect(nav(page).getByRole("region", { name: "Shared with me" })).toHaveCount(0);
});

test("sidebar: a guest sees Shared with me and none of the workspace sections", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?guest"));
  const shared = nav(page).getByRole("region", { name: "Shared with me" });
  await expect(shared.getByRole("button", { name: /Archive/ })).toBeVisible();
  await expect(nav(page).getByRole("region", { name: "Pages", exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole("region", { name: "Tools", exact: true })).toHaveCount(0);
  for (const name of ["Messages", "New page", "Trash"]) await expect(nav(page).getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole("button", { name: "Home", exact: true })).toBeVisible();
  await shot(page, "shared-with-me-guest-1440");
  // A guest with nothing shared gets the explicit empty state, still no workspace.
  await page.goto(url("?guest=empty"));
  await expect(nav(page).getByRole("region", { name: "Shared with me" })).toContainText("Nothing has been shared with you yet");
  await expect(nav(page).getByRole("region", { name: "Pages", exact: true })).toHaveCount(0);
});

test("page ⋯ menu ends with the page info footer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?open=living"));
  await expect(page.getByRole("heading", { name: "Rename A living workspace", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  const info = page.getByRole("menu").locator("dl.prism-page-info");
  await expect(info).toBeVisible();
  const value = (label: string) => info.locator("div", { has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
  // "Purpose" + "A shared place to think, write, and build with the same context."
  await expect(value("Word count")).toHaveText("13");
  await expect(value("Last edited by")).toHaveText("Ada Park");
  await expect(value("Created")).not.toHaveText("");
  await shot(page, "page-menu-info-1440");
});

test("Move to… confirms first when the move changes who can open the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?shared"));
  await expand(page, "Prism");
  await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const dialog = page.getByRole("dialog", { name: /Move/ });
  await dialog.getByRole("combobox").fill("Archive");
  await dialog.getByRole("option", { name: /Archive/ }).click();
  // Nothing moved yet: the notice names who gains access and asks.
  const notice = dialog.getByRole("alert");
  await expect(notice).toContainText("Ada Park, Grace Lin will gain access");
  expect(await notePath(page, "plan")).toBe("vault/Projects/Prism/Plan");
  await shot(page, "move-access-notice-1440");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect(await notePath(page, "plan")).toBe("vault/Projects/Prism/Plan");
  await dialog.getByRole("option", { name: /Archive/ }).click();
  await dialog.getByRole("button", { name: "Move to Archive anyway" }).click();
  await expect.poll(() => notePath(page, "plan")).toBe("vault/Archive/Plan");
  // A move that changes nobody's access goes straight through (no extra step).
  await nav(page).getByRole("button", { name: "Page actions for A living workspace", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const again = page.getByRole("dialog", { name: /Move/ });
  await again.getByRole("combobox").fill("Journal");
  await again.getByRole("option", { name: /Journal/ }).first().click();
  await expect.poll(() => notePath(page, "living")).toBe("vault/Journal/A living workspace");
});

// NP-MB-03 — what the phone page-actions sheet holds, its row size and how it is dismissed.
// Share, Find and Agent are NOT rows of this sheet today (Share is a header button, Agent lives in More, Find is
// keyboard-only): product gap recorded in PARITY-EVIDENCE.md.
test("phone: the page actions sheet lists every page action with 44px rows and closes three ways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url());
  const open = async () => {
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "A living workspace" });
    await expect(sheet).toBeVisible();
    return sheet;
  };
  let sheet = await open();
  for (const name of ["Add to Favorites", "Copy link", "Move to…", "Lock page", "Version history", "Export as Markdown", "Move to Trash", "Duplicate"]) {
    const item = sheet.getByRole("button", { name, exact: true });
    await expect(item, name).toBeVisible();
    expect(await item.evaluate((el) => el.getBoundingClientRect().height), `${name} row height`).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  // Esc.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  // The Close control.
  sheet = await open();
  await sheet.getByRole("button", { name: "Close sheet" }).click();
  await expect(sheet).toHaveCount(0);
  // The drag handle.
  sheet = await open();
  const handle = sheet.locator(".prism-mobile-sheet-handle");
  await handle.evaluate((element) => {
    for (const [type, y] of [["touchstart", 100], ["touchmove", 230], ["touchend", 230]] as const) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientY: y }] });
      element.dispatchEvent(event);
    }
  });
  await expect(sheet).toHaveCount(0);
});
