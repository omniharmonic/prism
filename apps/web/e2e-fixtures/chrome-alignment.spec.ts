import { test, expect, type Page } from '@playwright/test';

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  await expect(page.getByRole('heading', { name: /A living workspace/ })).toBeVisible();
};
const bar = (page: Page) => page.locator('button[title^="Toggle sidebar"]').locator('..');

test('the tab bar and the docked panel header share one hairline', async ({ page }) => {
  await open(page, 1440);
  const header = page.locator('.document-companion-header');
  await expect(header).toBeVisible();
  expect(await header.evaluate(el => !!el.closest('dialog'))).toBe(false);
  const bottom = (await bar(page).boundingBox())!;
  const panel = (await header.boundingBox())!;
  expect(panel.y + panel.height).toBe(bottom.y + bottom.height);
});

test('every control in the tab bar has the same height', async ({ page }) => {
  await open(page, 1440);
  const heights = await bar(page).evaluate(el => [...new Set([...el.querySelectorAll<HTMLElement>(':scope > button, :scope > div > button, .sync-state-header, [data-tab-id]')]
    .filter(node => node.getBoundingClientRect().width > 0).map(node => node.getBoundingClientRect().height))]);
  expect(heights).toEqual([28]);
});

test('a squeezed active tab shortens its title instead of sliding under the controls', async ({ page }) => {
  await open(page, 1280);
  const strip = page.getByRole('navigation', { name: 'Open document tabs' });
  await expect.poll(() => strip.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const tab = (await strip.locator('[data-tab-id]').first().boundingBox())!;
  const box = (await strip.boundingBox())!;
  expect(tab.x).toBeGreaterThanOrEqual(box.x - 0.5);
  expect(tab.x + tab.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
});

test('the find bar opens over the page, not over the docked panel beside it', async ({ page }) => {
  await open(page, 1440);
  const panel = page.locator('.prism-workspace-companion');
  await expect(panel).toBeVisible();
  await page.locator('.tiptap').first().click();
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.locator('.prism-find-bar');
  await expect(find).toBeVisible();
  const found = (await find.boundingBox())!;
  const canvas = (await page.locator('.prism-workspace-canvas').boundingBox())!;
  expect(found.x + found.width).toBeLessThanOrEqual(canvas.x + canvas.width);
  expect(found.x).toBeGreaterThanOrEqual(canvas.x);
  // With the panel closed the bar goes back to the window's edge.
  await page.locator('button[title^="Info panel"]').click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => { const box = (await find.boundingBox())!; return Math.round(1440 - (box.x + box.width)); }).toBe(24);
});

test('every sidebar destination but Home can be hidden, and the choice holds on a phone', async ({ page }) => {
  await open(page, 1440);
  const nav = page.getByRole('navigation', { name: 'Workspace destinations' });
  await expect(nav.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Messages', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Customize sidebar', exact: true }).click();
  const prefs = page.getByRole('dialog', { name: 'Your sidebar' });
  // Home is not something to place: it has no row here.
  await expect(prefs.getByLabel('Home placement')).toHaveCount(0);
  for (const tool of ['Messages', 'Calendar', 'People', 'Automations', 'Map']) await prefs.getByLabel(`${tool} placement`).selectOption('hidden');
  await page.keyboard.press('Escape');
  await expect(nav.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  // (The page tree has a folder called Messages; the destination is the row under Home.)
  await expect(nav.getByRole('button', { name: 'Messages', exact: true })).toHaveCount(0);
  await expect(page.locator('.workspace-navigation').getByRole('button', { name: 'Calendar', exact: true })).toHaveCount(0);
  // The same device as a phone: the bottom bar does not offer what was hidden.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneBar = page.getByRole('navigation', { name: 'Mobile workspace' });
  await expect(phoneBar).toBeVisible();
  await expect(phoneBar.getByRole('button', { name: 'Messages', exact: true })).toHaveCount(0);
});
