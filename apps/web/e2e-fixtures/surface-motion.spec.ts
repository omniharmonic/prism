import { test, expect, type Locator } from '@playwright/test';
async function touch(target: Locator, type: string, y: number) {
  await target.evaluate((node, { type, y }) => {
    const point = { clientX: 140, clientY: y };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } });
    node.dispatchEvent(event);
  }, { type, y });
}
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
for (const surface of ['Search', 'More']) {
  test(`${surface} follows chrome drags, cancels, and dismisses without replacing the editor`, async ({ page }) => {
    await page.goto('/e2e-fixtures/workspace.html?navigation');
    await expect(page.locator('.tiptap')).toBeVisible();
    await page.locator('.tiptap').evaluate(node => { (window as any).originalEditor = node; });
    await page.locator('.prism-mobile-navigation').getByRole('button', { name: surface, exact: true }).click();
    const dialog = page.locator(surface === 'Search' ? '.prism-search-fullscreen' : '.prism-mobile-sheet');
    const handle = dialog.locator(surface === 'Search' ? '.prism-search-drag-handle' : '.prism-mobile-sheet-heading');
    await expect(dialog).toBeVisible();
    await dialog.evaluate(async node => { await Promise.all(node.getAnimations().map(a => a.finished.catch(() => {}))); });
    const top = (await dialog.boundingBox())!.y;
    await touch(handle, 'touchstart', 100);
    await touch(handle, 'touchmove', 140);
    expect((await dialog.boundingBox())!.y - top).toBeCloseTo(40, 0);
    await touch(handle, 'touchcancel', 140);
    await expect.poll(async () => (await dialog.boundingBox())!.y).toBeCloseTo(top, 0);
    await touch(handle, 'touchstart', 100);
    await touch(handle, 'touchmove', 200);
    expect((await dialog.boundingBox())!.y - top).toBeCloseTo(100, 0);
    await touch(handle, 'touchend', 200);
    await expect(dialog).toHaveCount(0);
    expect(await page.locator('.tiptap').evaluate(node => node === (window as any).originalEditor)).toBe(true);
  });
}
test('real touch dismisses search from its handle', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP touch dispatch is Chromium-only');
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  await page.locator('.prism-mobile-navigation').getByRole('button', { name: 'Search', exact: true }).click();
  const dialog = page.locator('.prism-search-fullscreen');
  const handle = await page.locator('.prism-search-drag-handle').boundingBox();
  const session = await page.context().newCDPSession(page);
  const x = handle!.x + handle!.width / 2, y = handle!.y + handle!.height / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const dy of [15, 40, 80, 120]) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy }] });
  expect((await dialog.boundingBox())!.y).toBeGreaterThan(100);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(dialog).toHaveCount(0);
});

test('search text and results keep their gestures; reduced motion dismisses immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  await page.locator('.prism-mobile-navigation').getByRole('button', { name: 'Search', exact: true }).click();
  const dialog = page.locator('.prism-search-fullscreen');
  for (const target of [dialog.locator('input').first(), dialog.getByRole('listbox')]) {
    await touch(target, 'touchstart', 100);
    await touch(target, 'touchmove', 220);
    await touch(target, 'touchend', 220);
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())!.y).toBe(0);
  }
  await page.getByRole('button', { name: 'Close search', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('document panel follows an outward swipe and restores the More trigger', async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  const more = page.locator('.prism-mobile-navigation').getByRole('button', { name: 'More', exact: true });
  await more.click();
  await page.getByRole('button', { name: 'Details & metadata', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Document panel' });
  await panel.evaluate(async node => { await Promise.all(node.getAnimations().map(a => a.finished.catch(() => {}))); });
  const header = panel.locator('.document-companion-header');
  await header.evaluate(node => {
    for (const [type, x] of [['touchstart', 120], ['touchmove', 230]] as const) {
      const point = { clientX: x, clientY: 60 };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: [point] }, changedTouches: { value: [point] } });
      node.dispatchEvent(event);
    }
  });
  expect((await panel.boundingBox())!.x).toBeCloseTo(110, 0);
  await header.evaluate(node => {
    const event = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: [] }, changedTouches: { value: [{ clientX: 230, clientY: 60 }] } });
    node.dispatchEvent(event);
  });
  await expect(panel).toHaveCount(0);
  await expect(more).toBeFocused();
});
