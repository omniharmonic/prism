import { test, expect, type Page } from "@playwright/test";

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

const holdAccountCheck = (page: Page) => page.evaluate(() => { (window as any).prismFixtureControls.meHold = true; });
const answerAccountCheck = (page: Page) => page.evaluate(() => { const c = (window as any).prismFixtureControls; c.meHold = false; c.meRelease?.(); });
const treeReads = (page: Page, from: number) => page.evaluate((mark) => ((window as any).prismFixtureVaultRequests as Array<{ path: string; vault: string | null }>).slice(mark).filter((r) => r.path.startsWith("/api/tree")), from);

/**
 * Phone: the same switch from the top of the Browse drawer.
 *
 * A switch is confirmed by the server (one round trip, held open here like a slow connection).
 * The workspace used to be mounted for "nobody yet" in between and thrown away at the answer:
 * a drawer reopened in that moment shut again by itself (this test failed that way under load),
 * and the new vault's tree was fetched twice. Now there is nothing to open until the answer.
 */
test("NP-SB-01: phone — the drawer's switcher changes the tree too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html?navigation&vaultdata");
  const notes = page.getByRole("button", { name: "Notes", exact: true });
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await notes.click();
  const selector = drawer.getByRole("button", { name: "Switch vault" });
  await expect(selector).toContainText("Personal vault");
  await holdAccountCheck(page);
  const mark = await page.evaluate(() => ((window as any).prismFixtureVaultRequests as unknown[]).length);
  await selector.click();
  await drawer.getByRole("menu").getByRole("menuitem", { name: "Shared research" }).click();
  // Until the server has answered: no workspace to act in — not the old vault's, not a stand-in.
  await expect(page.getByRole("status").filter({ hasText: "Switching vault…" })).toBeVisible();
  await expect(notes).toHaveCount(0);
  await expect(drawer).toHaveCount(0);
  expect(await treeReads(page, mark)).toEqual([]);
  await answerAccountCheck(page);
  // The new vault's workspace, once. The drawer the reader opens now stays open.
  await notes.click();
  await expect(selector).toContainText("Shared research");
  const tree = drawer.getByRole("tree", { name: "Pages" });
  await expect(tree.getByRole("treeitem", { name: "Studies", exact: true })).toBeVisible();
  for (const gone of ["Journal", "Projects", "Messages"]) await expect(tree.getByRole("treeitem", { name: gone, exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Switching vault…" })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  expect((await treeReads(page, mark)).map((r) => r.vault)).toEqual(["secondary"]);
});

/** Desktop: the workspace arrives once, so what is typed right after a switch stays typed. */
test("NP-SB-01: quick find opened right after a switch keeps what was typed", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?navigation&vaultdata");
  const nav = page.locator(".workspace-navigation");
  await expect(nav.getByRole("button", { name: "Switch vault" })).toContainText("Personal vault");
  await holdAccountCheck(page);
  const mark = await page.evaluate(() => ((window as any).prismFixtureVaultRequests as unknown[]).length);
  await nav.getByRole("button", { name: "Switch vault" }).click();
  await nav.getByRole("menu").getByRole("menuitem", { name: "Shared research" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Switching vault…" })).toBeVisible();
  await expect(nav).toHaveCount(0);
  await answerAccountCheck(page);
  await expect(nav.getByRole("button", { name: "Switch vault" })).toContainText("Shared research");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search notes and commands" });
  await input.pressSequentially("tidepool");
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Tidepool study/ })).toBeVisible();
  await expect(input).toHaveValue("tidepool");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  // One workspace, one tree read (it used to be mounted — and to fetch — twice).
  expect((await treeReads(page, mark)).map((r) => r.vault)).toEqual(["secondary"]);
});

/** A check that never answers (offline, a stalled request) gives way to the workspace, as before. */
test("NP-SB-01: a switch whose account check stalls still opens the workspace", async ({ page }) => {
  await page.clock.install();
  await page.goto("/e2e-fixtures/workspace.html?navigation&vaultdata");
  const nav = page.locator(".workspace-navigation");
  await expect(nav.getByRole("button", { name: "Switch vault" })).toContainText("Personal vault");
  await holdAccountCheck(page);
  await nav.getByRole("button", { name: "Switch vault" }).click();
  await nav.getByRole("menu").getByRole("menuitem", { name: "Shared research" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Switching vault…" })).toBeVisible();
  await page.clock.fastForward(4100);
  await expect(page.getByRole("status").filter({ hasText: "Switching vault…" })).toHaveCount(0);
  await expect(nav.getByRole("tree", { name: "Pages" }).getByRole("treeitem", { name: "Studies", exact: true })).toBeVisible();
  await answerAccountCheck(page);
  await expect(nav.getByRole("button", { name: "Switch vault" })).toContainText("Shared research");
});
