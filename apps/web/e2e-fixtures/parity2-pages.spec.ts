import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 2 — clauses of the checklist that existed in the product but had no assertion.
 * Pages fixture (tree, favorites, breadcrumbs, tabs).
 */
const url = (q = "") => `/e2e-fixtures/pages-nav.html${q}`;
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const tree = (page: Page) => nav(page).getByRole("region", { name: "Pages", exact: true });
const row = (page: Page, name: string) => tree(page).getByRole("button", { name, exact: true });
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, unknown>>);
async function expand(page: Page, name: string) {
  await expect(row(page, name)).toBeVisible();
  const toggle = tree(page).getByRole("button", { name: `Expand ${name}`, exact: true });
  if (await toggle.count()) await toggle.click();
}

/** NP-SB-04: a page is starred from the tree's ⋯ menu (the header and ⌘K are covered elsewhere). */
test("tree ⋯ menu favorites a page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url());
  const favorites = page.getByRole("region", { name: "Favorites", exact: true });
  await expect(favorites).toContainText("Star a page to pin it here"); // always visible, even empty
  await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add to Favorites", exact: true }).click();
  await expect(favorites.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => (window as any).prismFixturePrefs())).prefs.favorites).toEqual(["plan"]);
  // The same menu takes it out again.
  await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove from Favorites", exact: true }).click();
  await expect(favorites).toContainText("Star a page to pin it here");
});

/** NP-PG-03: a rename shows at once in the tree and the tab. */
test("a rename shows live in the tree and the tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?open=week1"));
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  await expect(tabs.getByRole("button", { name: "Open Week 1", exact: true })).toBeVisible();
  await expect(crumbs).toContainText("Plan");

  await page.getByRole("button", { name: "Rename Week 1", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill("Sprint one");
  await title.press("Enter");
  await expect(page.getByRole("heading", { name: "Rename Sprint one", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Open Sprint one", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Open Week 1", exact: true })).toHaveCount(0);
  await expect(row(page, "Sprint one")).toBeVisible();
  await expect(row(page, "Week 1")).toHaveCount(0);

  // The tab of a page that is not in front follows too.
  await crumbs.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Plan", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Open Sprint one", exact: true })).toBeVisible();
});

/**
 * NP-PG-03 — NOT MET (recorded in PARITY-GAPS.md): renaming a page that HAS sub-pages from its title
 * writes only that note's path (DocumentRenderer.handleRename → updateNote), so its sub-pages stay
 * behind under a plain folder with the old name and their breadcrumbs do not name the renamed page.
 * The tree's "Move to…" uses the server move route and carries them along.
 */
test.fixme("renaming a page with sub-pages from its title keeps them under it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?open=plan"));
  await page.getByRole("button", { name: "Rename Plan", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill("Delivery plan");
  await title.press("Enter");
  await expect(row(page, "Delivery plan")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "week1")?.path)).toBe("vault/Projects/Prism/Delivery plan/Week 1");
  await expect(row(page, "Plan")).toHaveCount(0);
});

/** NP-SB-08: while dragging, the tree shows where the page will land — a line between rows, a highlight on a parent. */
test("tree drag shows a drop line and a target highlight", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url());
  await expand(page, "Plan");
  const source = (await row(page, "Week 1").boundingBox())!;
  const target = (await row(page, "Archive").boundingBox())!;
  await page.mouse.move(source.x + 30, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 34, source.y + source.height / 2 + 4, { steps: 2 });
  // Top edge of the target: a line before it.
  await page.mouse.move(target.x + 30, target.y + 2, { steps: 6 });
  await expect(nav(page).locator('.page-tree-row[data-drop="before"]')).toHaveCount(1);
  // Middle of the target: the row itself is highlighted as the new parent.
  await page.mouse.move(target.x + 30, target.y + target.height / 2, { steps: 4 });
  const inside = nav(page).locator('.page-tree-row[data-drop="inside"]');
  await expect(inside).toHaveCount(1);
  await expect(inside).toContainText("Archive");
  expect(await inside.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "week1")?.path)).toBe("vault/Archive/Week 1");
  await expect(nav(page).locator(".page-tree-row[data-drop]")).toHaveCount(0);
  expect((await writes(page)).some((w) => w.move === "week1")).toBe(true);
});

/** NP-MB-07 (+ the phone clause of NP-SB-01): what the Browse drawer holds, and its row size. */
test("phone drawer: favorites, recents, tree, tools, trash, new page and settings with 44px rows", async ({ browser }) => {
  // A touch device: the 44 px row rule is `@media (pointer: coarse)`.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url(`?prefs=${encodeURIComponent(JSON.stringify({ favorites: ["plan"], recents: ["week1", "archive"] }))}`));
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Favorites", exact: true }).getByRole("button", { name: "Plan", exact: true })).toBeVisible();
  const recent = drawer.getByRole("region", { name: "Recent", exact: true });
  const toggle = recent.getByRole("button", { name: "Recent", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(recent).toContainText("Week 1");
  // The page tree, with disclosure and the row ⋯.
  const pages = drawer.getByRole("region", { name: "Pages", exact: true });
  await expect(pages.getByRole("button", { name: "Prism", exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "Collapse Prism", exact: true })).toBeVisible();
  await pages.getByRole("button", { name: "Expand Plan", exact: true }).click();
  await expect(pages.getByRole("button", { name: "Week 1", exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "Page actions for Plan", exact: true })).toBeVisible();
  // Tools, Trash, New page, Settings.
  for (const name of ["Tools", "Trash", "New page", "Workspace settings"]) await expect(drawer.getByRole("button", { name, exact: true }), name).toBeVisible();
  // Rows are at least 44 px tall.
  const heights = await drawer.locator(".page-tree-row, .workspace-nav-row").evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => Math.round(el.getBoundingClientRect().height)));
  expect(heights.length).toBeGreaterThan(5);
  expect(heights.filter((h) => h < 44), `row heights ${heights.join(",")}`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  // The vault switcher is the first control of the drawer (fixture with several vaults).
  await page.goto("/e2e-fixtures/workspace.html?navigation");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const second = page.getByRole("dialog", { name: "Workspace navigation" });
  const switcher = second.getByRole("button", { name: "Switch vault" });
  await expect(switcher).toContainText("Personal vault");
  const top = (await switcher.boundingBox())!.y;
  for (const name of ["New page", "Tools"]) expect((await second.getByRole("button", { name, exact: true }).boundingBox())!.y, `${name} below the switcher`).toBeGreaterThan(top);
  expect(top).toBeLessThan(140);
  await context.close();
});
