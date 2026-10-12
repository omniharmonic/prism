import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test('reopening a large sidebar reuses rows, scroll and search without replacing the editor', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation');
  const editor = page.locator('.tiptap');
  // Startup deliberately prepares all 1,206 retained rows before exposing the editor.
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.evaluate(node => { (window as any).sidebarEditor = node; });
  const notes = page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Notes', exact: true });
  await notes.click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  await expect(drawer.locator('.page-tree-row')).toHaveCount(1206);
  await drawer.locator('.workspace-nav-scroll').evaluate(node => { node.scrollTop = 600; (window as any).sidebarScroll = node.scrollTop; });
  await drawer.locator('.page-tree-row').first().evaluate(node => { (window as any).sidebarRow = node; });
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sidebarRow.isConnected)).toBe(true);
  await notes.click();
  expect(await drawer.locator('.page-tree-row').first().evaluate(node => node === (window as any).sidebarRow)).toBe(true);
  expect(await drawer.locator('.workspace-nav-scroll').evaluate(node => node.scrollTop === (window as any).sidebarScroll)).toBe(true);
  expect(await editor.evaluate(node => node === (window as any).sidebarEditor)).toBe(true);
  const search = drawer.getByPlaceholder('Search…', { exact: true });
  await search.fill('Load note');
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByPlaceholder('Search…', { exact: true })).not.toBeVisible();
  await notes.click();
  await expect(search).toHaveValue('Load note');
});

test('warmed closed navigation cannot receive focus or pointer input', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation');
  await expect(page.locator('.page-tree-row')).toHaveCount(1206);
  const drawer = page.locator('.workspace-mobile-drawer[data-side="left"]');
  const metrics = await drawer.evaluate(node => ({ width: (node as HTMLElement).offsetWidth, open: (node as HTMLDialogElement).open, inert: (node as HTMLElement).inert }));
  expect(metrics.open).toBe(false);
  expect(metrics.inert).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveCount(0);
  await drawer.locator('input').first().evaluate(node => (node as HTMLElement).focus());
  expect(await drawer.evaluate(node => node.contains(document.activeElement))).toBe(false);
});


test('a far-offscreen row remains reachable and opens the selected note', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation');
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  const row = drawer.getByRole('treeitem', { name: 'Load note 1100', exact: true });
  await row.scrollIntoViewIfNeeded();
  await row.getByRole('button', { name: 'Load note 1100', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Rename Load note 1100', exact: true })).toBeVisible();
});

test('startup prepares the full tree before navigation becomes interactive', async ({ page }) => {
  await page.addInitScript(() => {
    window.requestIdleCallback = () => 0;
    window.cancelIdleCallback = () => {};
  });
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation');
  const drawer = page.locator('.workspace-mobile-drawer[data-side="left"]');
  await expect(drawer.locator('.page-tree-row')).toHaveCount(1206);
  await expect(page.getByRole('status', { name: 'Preparing workspace' })).toHaveCount(0);
  const before = await drawer.locator('.page-tree-row').first().evaluate(node => {
    (window as any).preparedRow = node;
    return { height: node.getBoundingClientRect().height, visibility: getComputedStyle(node).contentVisibility };
  });
  expect(before.height).toBeGreaterThan(0);
  expect(before.visibility).toBe('auto');
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByText('Loading navigation…', { exact: true })).toHaveCount(0);
  expect(await drawer.locator('.page-tree-row').first().evaluate(node => node === (window as any).preparedRow)).toBe(true);
});


test('a slow tree loads behind one startup screen and appears complete on the first opening', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation&hold-navigation');
  const startup = page.getByRole('status', { name: 'Preparing workspace' });
  await expect(startup).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile workspace' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => typeof (window as any).prismFixtureControls.treeRelease)).toBe('function');
  await page.evaluate(() => { const c = (window as any).prismFixtureControls; c.treeHold = false; c.treeRelease(); });
  await expect(startup).toHaveCount(0);
  const rows = page.locator('.workspace-mobile-drawer[data-side="left"] .page-tree-row');
  await expect(rows).toHaveCount(1206);
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' }).locator('.page-tree-row')).toHaveCount(1206);
});

test('a stalled startup offers a way back into the workspace', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation&hold-navigation');
  await expect(page.getByRole('status', { name: 'Preparing workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to workspace' }).click({ timeout: 20_000 });
  await expect(page.getByRole('status', { name: 'Preparing workspace' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Mobile workspace' })).toBeVisible();
});


test('startup waits for the initial recent-page access check, not just tree data', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation&hold-shortcuts');
  await expect(page.locator('.workspace-mobile-drawer .page-tree-row')).toHaveCount(1206);
  await expect(page.locator('.tiptap')).toContainText('A shared place');
  await expect(page.getByRole('status', { name: 'Preparing workspace' })).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureReleaseShortcuts());
  await expect(page.getByRole('status', { name: 'Preparing workspace' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' }).getByRole('button', { name: 'A living workspace', exact: true }).first()).toBeVisible();
});
