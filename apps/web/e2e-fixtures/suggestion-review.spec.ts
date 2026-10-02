import { test, expect } from '@playwright/test';

test('focused review walks changes without body writes and follows the current position after a peer edit', async ({ page }) => {
  await page.goto('/e2e-fixtures/suggestion-review.html');
  await page.getByText('3 suggested changes', { exact: true }).click();
  await expect(page.locator('.cd-bubble:visible')).toHaveCount(0);
  const initial = await page.evaluate(() => (window as any).reviewFixture.body());
  await expect(page.getByRole('region', { name: 'Change by Prism agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Next suggested change' }).click();
  await expect(page.getByText('Change 2 of 3', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Change by Morgan' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).reviewFixture.body())).toBe(initial);
  await page.evaluate(() => (window as any).reviewFixture.prefix());
  await page.getByRole('button', { name: 'Show in document', exact: true }).click();
  expect(await page.evaluate(() => {
    const editor = (window as any).reviewFixture;
    return editor.selection();
  })).toBeGreaterThan(50);
  await page.locator('.prism-suggestion-review').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Change by Alex' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show in document', exact: true })).toBeFocused();
  await expect(page.getByRole('status')).toContainText('Accepted change by Morgan');
  await page.getByRole('button', { name: 'Previous suggested change' }).click();
  await page.locator('.prism-suggestion-review').getByRole('button', { name: 'Reject', exact: true }).click();
  const after = await page.evaluate(() => (window as any).reviewFixture.body());
  expect(after).toContain('Prism brings many tools into one interface.');
  expect(after).not.toContain('Prism is a shared workspace for you and your agent.');
  expect(after).toContain('with a shared understanding');
  await page.locator('.prism-suggestion-review').getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No suggested changes remain.');
  await expect(page.getByRole('status')).toBeFocused();
  expect(await page.evaluate(() => (window as any).reviewFixture.body())).toContain('An outdated sentence.');
});

test('another reviewer can remove the active change; the queue moves to a real remaining change', async ({ page }) => {
  await page.goto('/e2e-fixtures/suggestion-review.html');
  await page.getByText('3 suggested changes', { exact: true }).click();
  await page.evaluate(() => (window as any).reviewFixture.acceptFirst());
  await expect(page.getByText('2 suggested changes', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Change by Morgan' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to view-only' }).click();
  await expect(page.locator('.prism-suggestion-review').getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await expect(page.locator('.prism-suggestion-review').getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  const before = await page.evaluate(() => (window as any).reviewFixture.body());
  await page.getByRole('button', { name: 'Next suggested change' }).click();
  await page.getByRole('button', { name: 'Show in document', exact: true }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.body())).toBe(before);
});

for (const width of [1440, 390, 320]) test(`review diff stays legible at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 960 });
  await page.goto('/e2e-fixtures/suggestion-review.html' + (width === 320 ? '?dark' : ''));
  await page.getByText('3 suggested changes', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Change by Prism agent' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const label of ['Previous suggested change', 'Next suggested change', 'Show in document', 'Accept', 'Reject']) {
    expect((await page.locator('.prism-suggestion-review').getByRole('button', { name: label, exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('.cd-bubble:visible')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`review-${width}.png`), animations: 'disabled' });
});
