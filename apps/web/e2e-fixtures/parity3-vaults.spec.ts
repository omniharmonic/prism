import { test, expect } from "@playwright/test";

/**
 * Parity pass 3 · NP-SB-01: "Switching reloads the tree, favorites, recents and search scope
 * with no data from the previous vault." Tabs, favorites and recents are asserted elsewhere
 * (workspace-session, shortcuts); this covers the TREE and the SEARCH SCOPE, driven from the
 * sidebar's own switcher. `?vaultdata`: the second vault holds different pages.
 */
test("NP-SB-01: after a vault switch the tree and search show only the new vault", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?navigation&vaultdata");
  const nav = page.locator(".workspace-navigation");
  const selector = nav.getByRole("button", { name: "Switch vault" });
  await expect(selector).toContainText("Personal vault");
  const tree = nav.getByRole("tree", { name: "Pages" });
  // The first vault: its pages are in the tree and in search.
  await expect(tree.getByRole("treeitem", { name: "Field notes", exact: true })).toBeVisible();
  await tree.getByRole("button", { name: "Expand Journal" }).click();
  await expect(tree.getByRole("treeitem", { name: "Weekly review", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Studies", exact: true })).toHaveCount(0);
  const before = await tree.getByRole("treeitem").count();
  expect(before).toBeGreaterThanOrEqual(5);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search notes and commands" });
  await input.fill("weekly");
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Weekly review/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Switch through the sidebar control.
  await selector.click();
  await nav.getByRole("menu").getByRole("menuitem", { name: "Shared research" }).click();
  await expect(selector).toContainText("Shared research");
  const mark = await page.evaluate(() => ((window as any).prismFixtureVaultRequests as unknown[]).length);

  // The tree is the new vault's, with nothing left from the previous one.
  await expect(tree.getByRole("treeitem", { name: "Studies", exact: true })).toBeVisible();
  await tree.getByRole("button", { name: "Expand Studies" }).click().catch(() => {});
  await expect(tree.getByRole("treeitem", { name: "Tidepool study", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Methods", exact: true })).toBeVisible();
  // Exactly the new vault's folder and its two pages: every row of the previous vault is gone.
  await expect(tree.getByRole("treeitem")).toHaveCount(3);
  // (Nowhere in the sidebar — tree, favorites or recents.)
  for (const gone of ["Field notes", "Weekly review", "A living workspace", "Project discussion"]) await expect(nav.getByText(gone, { exact: true })).toHaveCount(0);
  // The open page of the previous vault was closed with it.
  expect(await page.evaluate(() => (window as any).prismFixtureUI.getState().openTabs.map((t: any) => t.noteId))).toEqual([]);

  // Search is scoped to the new vault: a previous-vault page cannot be found, a new-vault page can.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("weekly");
  await expect.poll(() => page.evaluate((from) => ((window as any).prismFixtureVaultRequests as Array<{ path: string; vault: string | null }>).slice(from).some((r) => r.path.startsWith("/api/search") && r.path.includes("weekly")), mark)).toBe(true);
  await expect(page.getByRole("option", { name: /Weekly review/ })).toHaveCount(0);
  await input.fill("tidepool");
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Tidepool study/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Field notes|Weekly review|A living workspace/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Every page-data request since the switch named the new vault.
  const after = await page.evaluate((from) => ((window as any).prismFixtureVaultRequests as Array<{ path: string; vault: string | null }>).slice(from), mark);
  const pageData = after.filter((r) => /^\/api\/(tree|notes|search)/.test(r.path));
  expect(pageData.length).toBeGreaterThan(0);
  expect(pageData.filter((r) => r.vault !== "secondary")).toEqual([]);

  // And back: the first vault's tree returns, the second vault's pages are gone.
  await selector.click();
  await nav.getByRole("menu").getByRole("menuitem", { name: "Personal vault" }).click();
  await expect(selector).toContainText("Personal vault");
  await expect(tree.getByRole("treeitem", { name: "Journal", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Projects", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Studies", exact: true })).toHaveCount(0);
  await expect(nav.getByText("Tidepool study", { exact: true })).toHaveCount(0);
});

/** Phone: the same switch from the top of the Browse drawer. */
test("NP-SB-01: phone — the drawer's switcher changes the tree too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html?navigation&vaultdata");
  await page.evaluate(() => (window as any).prismFixtureUI.setState({ sidebarOpen: true, contextPanelOpen: false }));
  const selector = page.getByRole("button", { name: "Switch vault" });
  await expect(selector).toContainText("Personal vault");
  await selector.click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Shared research" }).click();
  // The drawer closes on the switch; reopened, it is the new vault's.
  await page.evaluate(() => (window as any).prismFixtureUI.setState({ sidebarOpen: true }));
  await expect(page.getByRole("button", { name: "Switch vault" })).toContainText("Shared research");
  const tree = page.getByRole("tree", { name: "Pages" });
  await expect(tree.getByRole("treeitem", { name: "Studies", exact: true })).toBeVisible();
  for (const gone of ["Journal", "Projects", "Messages"]) await expect(tree.getByRole("treeitem", { name: gone, exact: true })).toHaveCount(0);
});
