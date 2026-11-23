import { test, expect } from '@playwright/test';

test('history dialog preserves the mounted conversation and restores keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
  await page.setViewportSize({ width: 390, height: 844 });
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
    await expect(page.getByRole('complementary', { name: 'Conversation history' })).toBeVisible();
    for (const button of await page.getByRole('complementary', { name: 'Conversation history' }).getByRole('button', { name: 'Archive session', exact: true }).all()) {
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

test('desktop history remains visible and conversation chrome does not show API costs', async ({page}) => {
 await page.setViewportSize({width: 1440,height: 900});
 await page.goto('/e2e-fixtures/agent.html?history&permissions&visual');
 await expect(page.getByRole('complementary', {name: 'Conversation history'})).toBeVisible();
 await expect(page.getByTestId('agent-session-row')).toHaveCount(3);
 await expect(page.getByTestId('agent-session-cost')).toHaveCount(0);
 await expect(page.locator('[data-testid="agent-conversation"]')).not.toContainText('$');
});

test('phone controls stay compact with full touch targets and adjacent attachment actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e-fixtures/agent.html?history&permissions&visual&snapshots');
  const permission = page.getByRole('combobox', { name: 'Agent permissions' });
  expect((await permission.boundingBox())!.height).toBe(44);
  expect(await permission.evaluate(el => getComputedStyle(el.parentElement!, '::before').height)).toBe('32px');
  const attach = await page.getByRole('button', { name: 'Attach notes', exact: true }).boundingBox();
  const capture = await page.getByRole('button', { name: 'Attach files', exact: true }).boundingBox();
  expect(Math.abs(attach!.y + attach!.height / 2 - capture!.y - capture!.height / 2)).toBeLessThan(1);
  await page.goto('/e2e-fixtures/inbox.html?resolved&email-status=owner');
  await page.locator('.prism-message-row').filter({ hasText: 'Saturday workshop agenda' }).click();
  const status = page.getByRole('combobox', { name: 'Thread status' });
  expect((await status.boundingBox())!.height).toBe(44);
  expect(await status.evaluate(el => getComputedStyle(el.parentElement!, '::before').height)).toBe('32px');
});

test('pointer focus avoids boxes while keyboard navigation keeps a visible focus indicator', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const close = page.getByRole('button', { name: 'Close navigation' });
  await expect(close).toBeVisible();
  await close.focus();
  await expect(close).toHaveCSS('outline-style', 'none');
  await expect(close).toHaveCSS('box-shadow', 'none');
  await page.getByRole('dialog', { name: 'Workspace navigation' }).focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  expect(await close.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
});
