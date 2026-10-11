import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test('reopening a large sidebar reuses rows, scroll and search without replacing the editor', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation');
  const editor = page.locator('.tiptap');
  await expect(editor).toBeVisible();
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

test('a cold drawer animates before mounting the large tree', async ({ page }) => {
  await page.addInitScript(() => {
    window.requestIdleCallback = () => 0;
    window.cancelIdleCallback = () => {};
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this instanceof HTMLDialogElement && this.dataset.side === 'left') animation.pause();
      return animation;
    };
  });
  await page.goto('/e2e-fixtures/workspace.html?navigation&large-navigation');
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  await expect(drawer.getByRole('status')).toHaveText('Loading navigation…');
  await expect(drawer.locator('.page-tree-row')).toHaveCount(0);
  await drawer.evaluate(node => node.getAnimations().forEach(animation => animation.finish()));
  await expect(drawer.locator('.page-tree-row')).toHaveCount(1206);
});
