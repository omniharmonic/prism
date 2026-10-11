import { test, expect } from '@playwright/test';

test('history dialog preserves the mounted conversation and restores keyboard focus', async ({ page }) => {
  await page.goto('/e2e-fixtures/agent.html?history&permissions&visual');
  const input = page.getByRole('textbox', { name: 'Message the agent' });
  await input.fill('Keep this draft while I browse history.');
  await input.evaluate(el => { (window as any).liquidInput = el; });
  const trigger = page.getByRole('button', { name: 'Conversation history', exact: true });
  await trigger.click();
  const history = page.getByRole('dialog', { name: 'Conversation history' });
  await expect(history).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close conversation history' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(history).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue('Keep this draft while I browse history.');
  expect(await input.evaluate(el => el === (window as any).liquidInput)).toBe(true);
  expect(await page.evaluate(() => (window as any).prismAgentFixture.turnAttempts)).toBe(0);
});

test('history honors OS and app reduced motion; permission controls remain in composer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e-fixtures/agent.html?history&permissions&visual');
  await expect(page.locator('.prism-agent-compose-surface').getByRole('combobox', { name: 'Agent permissions' })).toHaveValue('read-only');
  await page.getByRole('button', { name: 'Conversation history', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Conversation history' })).toHaveCSS('animation-name', 'none');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
  await page.getByRole('button', { name: 'Conversation history', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Conversation history' })).toHaveCSS('animation-name', 'none');
});

test.describe('iPad controls', () => {
  test.use({ hasTouch: true, viewport: { width: 834, height: 1194 } });
  test('history and permissions have real touch targets', async ({ page }) => {
    await page.goto('/e2e-fixtures/agent.html?history&permissions&visual');
    const permission = page.getByRole('combobox', { name: 'Agent permissions' });
    expect((await permission.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const trigger = page.getByRole('button', { name: 'Conversation history', exact: true });
    expect((await trigger.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await trigger.click();
    for (const button of await page.getByRole('dialog').getByRole('button', { name: 'Archive session', exact: true }).all()) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });
});

test('focus mode retains the live document and restores saved panel choices', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  await expect(page.getByRole('heading', { name: /A living workspace/ })).toBeVisible();
  await page.locator('.tiptap').evaluate(el => { (window as any).focusEditor = el; });
  const before = await page.evaluate(() => ({...JSON.parse(localStorage.getItem('prism:sidebar')!)}));
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  await expect(page.locator('.workspace-navigation')).toHaveCount(0);
  expect(await page.locator('.tiptap').evaluate(el => el === (window as any).focusEditor)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('prism:sidebar')!))).toEqual(before);
  await page.getByRole('button', { name: 'Exit focus mode', exact: true }).click();
  await expect(page.locator('.workspace-navigation')).toBeVisible();
  expect(await page.locator('.tiptap').evaluate(el => el === (window as any).focusEditor)).toBe(true);
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle sidebar (⌘\\)', exact: true }).click();
  await expect(page.locator('.workspace-navigation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Focus mode', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
