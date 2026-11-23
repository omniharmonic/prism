import { test, expect, type Page } from '@playwright/test';

const open = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  await expect(page.getByRole('heading', { name: /A living workspace/ })).toBeVisible();
};
const dock = (page: Page, side: 'left' | 'right') => page.locator(`.prism-workspace-dock[data-side="${side}"]`);
const toggle = (page: Page) => page.getByRole('button', { name: 'Toggle sidebar (⌘\\)', exact: true });
const canvasLeft = async (page: Page) => Math.round((await page.locator('.prism-workspace-canvas').boundingBox())!.x);
/** Every animation the app starts, as [what moved, how long]; read back with `started`. */
const record = (page: Page) => page.addInitScript(() => {
  const log: Array<{ target: string; duration: number }> = [];
  (window as any).panelMotion = log;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, frames: any, options: any) {
    if (this.classList.contains('prism-workspace-dock')) log.push({ target: this.getAttribute('data-side') ?? '', duration: typeof options === 'number' ? options : Number(options?.duration) });
    return animate.call(this, frames, options);
  };
});
const started = (page: Page) => page.evaluate(() => (window as any).panelMotion as Array<{ target: string; duration: number }>);

test('the sidebar slides away over a page that already has its room, then is gone', async ({ page }) => {
  await record(page);
  await open(page);
  await expect(dock(page, 'left')).toBeVisible();
  const before = await canvasLeft(page);
  await page.locator('.tiptap').evaluate(el => { (window as any).keptEditor = el; (window as any).panelMotion.length = 0; });
  await toggle(page).click();
  // One layout step: the page is at its final place while the panel is still leaving.
  await expect(dock(page, 'left')).toHaveAttribute('data-closing', 'true');
  expect(await canvasLeft(page)).toBeLessThan(before);
  await expect(dock(page, 'left')).toHaveCount(0);
  const moves = await started(page);
  expect(moves.map(m => m.target)).toEqual(['left']);
  expect(moves[0]!.duration).toBeGreaterThanOrEqual(100);
  expect(moves[0]!.duration).toBeLessThanOrEqual(320);
  // The page beside it is never transformed or rebuilt.
  expect(await page.locator('.prism-workspace-canvas').evaluate(el => getComputedStyle(el).transform)).toBe('none');
  expect(await page.locator('.tiptap').evaluate(el => el === (window as any).keptEditor)).toBe(true);
  await toggle(page).click();
  await expect(dock(page, 'left')).toBeVisible();
  await expect.poll(async () => (await started(page)).length).toBe(2);
  await expect.poll(() => canvasLeft(page)).toBe(before);
});

test('reopening a panel that is still leaving brings it back; nothing is left half way', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(dock(page, 'left')).toHaveAttribute('data-closing', 'true');
  await toggle(page).click();
  await expect(dock(page, 'left')).not.toHaveAttribute('data-closing', 'true');
  await expect(page.locator('.workspace-navigation')).toBeVisible();
  await expect.poll(() => dock(page, 'left').evaluate(el => el.getAnimations().length === 0 && getComputedStyle(el).transform)).toBe('none');
});

for (const how of ['os', 'app'] as const)
  test(`with reduced motion (${how}) panels appear and go at once`, async ({ page }) => {
    await record(page);
    if (how === 'os') await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    if (how === 'app') await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
    await page.evaluate(() => { (window as any).panelMotion.length = 0; });
    await toggle(page).click();
    await expect(dock(page, 'left')).toHaveCount(0);
    await toggle(page).click();
    await expect(dock(page, 'left')).toBeVisible();
    expect(await started(page)).toEqual([]);
  });

test('the sidebar edge: a small pull resizes, a pull well past its smallest width closes it and keeps the saved width', async ({ page }) => {
  await open(page);
  const handle = dock(page, 'left').locator('.cursor-col-resize');
  const nav = dock(page, 'left').locator(':scope > div').first();
  const edge = async () => { const box = (await handle.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + 300 }; };
  // Wider by 60.
  let at = await edge();
  const width = Math.round((await nav.boundingBox())!.width);
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 60, at.y, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(width + 60);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('prism:sidebar')!))).toEqual({ open: true, width: width + 60 });
  // Pulled in to just under the smallest width: it resists, and springs back to the smallest width.
  at = await edge();
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x - (width + 60 - 200) - 30, at.y, { steps: 20 });
  const resisted = (await nav.boundingBox())!.width;
  expect(resisted).toBeLessThan(200);
  expect(resisted).toBeGreaterThan(170);
  // Held still before letting go: a release, not a flick toward the edge.
  await page.waitForTimeout(200);
  await page.mouse.up();
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(200);
  // Pulled well past it: closed, and the width it had is kept for when it comes back.
  at = await edge();
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x - 120, at.y, { steps: 20 }); await page.waitForTimeout(200); await page.mouse.up();
  await expect(dock(page, 'left')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('prism:sidebar')!))).toEqual({ open: false, width: 200 });
  await toggle(page).click();
  await expect.poll(async () => Math.round((await dock(page, 'left').locator(':scope > div').first().boundingBox())!.width)).toBe(200);
});
