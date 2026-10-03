import { test, expect, type Page } from '@playwright/test';
import { Server } from '@hocuspocus/server';
import WebSocket from 'ws';

async function select(page: Page, text = 'A selected unsaved passage') {
  const editor = page.getByRole('region', { name: 'Working document' }).locator('.tiptap');
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await editor.press('ControlOrMeta+a');
  await expect(page.getByRole('button', { name: 'Ask agent about selection', exact: true })).toBeEnabled();
  return editor;
}
async function noSend(page: Page) {
  expect(await page.evaluate(() => ({ starts: (window as any).prismAgentFixture.attempts, sends: (window as any).prismAgentFixture.turnAttempts }))).toEqual({ starts: 0, sends: 0 });
}

test('plain selection becomes an unsent attachment without replacing drafts, mode or editor', async ({ page }, info) => {
  await page.goto('/e2e-fixtures/agent.html?context&snapshots&selection');
  const message = page.getByRole('textbox', { name: 'Message the agent', exact: true });
  await message.fill('Keep my existing thought');
  await page.getByLabel('Agent permissions', { exact: true }).selectOption('read-write');
  const editor = await select(page);
  await editor.evaluate(node => { (window as any).selectionEditorNode = node; });
  await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
  await expect(message).toHaveValue('Keep my existing thought');
  await expect(message).toBeFocused();
  await expect(page.getByLabel('Agent permissions', { exact: true })).toHaveValue('read-write');
  await noSend(page);
  await editor.fill('The document changed after capture');
  await page.getByRole('button', { name: 'Selected passage', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Captured context' })).toContainText('A selected unsaved passage');
  await expect(page.getByRole('dialog', { name: 'Captured context' })).not.toContainText('The document changed after capture');
  await page.getByRole('dialog').press('Escape');
  await page.getByRole('button', { name: 'Toggle panel', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle panel', exact: true }).click();
  await expect(message).toHaveValue('Keep my existing thought');
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
  expect(await editor.evaluate(node => node === (window as any).selectionEditorNode)).toBe(true);
  await page.screenshot({ path: info.outputPath('selection-phone.png'), fullPage: true });
  await message.fill('Discuss the captured passage');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismAgentFixture.turnAttempts)).toBe(1);
  expect(await page.evaluate(() => (window as any).prismAgentFixture.lastOptions.contextSnapshots[0].text)).toMatch(/^A selected unsaved passage\n?$/);
});

test('different working document requires a choice and preserves the old draft', async ({ page }) => {
  await page.goto('/e2e-fixtures/agent.html?context&snapshots&selection');
  await page.evaluate(() => (window as any).prismAgentStore.getState().setDraft({ noteId: 'document-b', noteTitle: 'Reference note' }));
  const message = page.getByRole('textbox', { name: 'Message the agent', exact: true });
  await message.fill('Keep the reference draft');
  await select(page);
  await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected context destination' })).toBeVisible();
  await expect(page.getByTestId('agent-working-document')).toContainText('Reference note');
  await expect(message).toHaveValue('Keep the reference draft');
  await noSend(page);
  await page.getByRole('button', { name: 'Attach to current conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
  await expect(page.getByTestId('agent-working-document')).toContainText('Reference note');
  await select(page, 'Another selected passage');
  await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation about this page', exact: true }).click();
  await expect(page.getByTestId('agent-working-document')).toContainText('Draft brief');
  await expect(message).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
  await page.evaluate(() => (window as any).prismAgentStore.getState().setDraft({ noteId: 'document-b', noteTitle: 'Reference note' }));
  await expect(message).toHaveValue('Keep the reference draft');
  await noSend(page);
});

test('pending selection is cancelled by audience change and unsupported servers never accept it', async ({ page }) => {
  await page.goto('/e2e-fixtures/agent.html?context&snapshots&selection');
  await page.evaluate(() => (window as any).prismAgentStore.getState().setDraft({ noteId: 'document-b', noteTitle: 'Reference note' }));
  await select(page);
  await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected context destination' })).toBeVisible();
  await page.getByRole('button', { name: 'Morgan', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected context destination' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(0);
  await page.goto('/e2e-fixtures/agent.html?context&permissions&selection');
  const editor = page.getByRole('region', { name: 'Working document' }).locator('.tiptap');
  await editor.fill('No snapshot support'); await editor.press('ControlOrMeta+a');
  await expect(page.getByRole('button', { name: 'Ask agent about selection', exact: true })).toBeDisabled();
  await editor.press('ControlOrMeta+j');
  await noSend(page);
});

test('keyboard and slash entries reuse the same unsent conversation flow', async ({ page }) => {
  await page.goto('/e2e-fixtures/agent.html?context&snapshots&selection');
  const editor = await select(page, 'Keyboard context');
  await editor.press('ControlOrMeta+j');
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
  await editor.press('ControlOrMeta+j');
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
  await editor.fill('A document to discuss');
  await editor.press('End'); await editor.press('Enter'); await editor.press('ControlOrMeta+Alt+0');
  await editor.pressSequentially('/ask');
  await page.getByRole('option', { name: 'Ask agent Discuss this page in your conversation' }).click();
  await expect(page.getByRole('button', { name: 'Document snapshot', exact: true })).toHaveCount(1);
  await expect(editor).not.toContainText('/ask');
  await noSend(page);
});

test('an existing session keeps its identity and mode when selected context arrives', async ({ page }) => {
  await page.goto('/e2e-fixtures/agent.html?context&snapshots&selection&history');
  const message = page.getByRole('textbox', { name: 'Message the agent', exact: true });
  await message.fill('My follow-up draft');
  await page.getByLabel('Agent permissions', { exact: true }).selectOption('suggest');
  await expect(page.getByLabel('Agent permissions', { exact: true })).toHaveValue('suggest');
  const original = await page.evaluate(() => (window as any).prismAgentStore.getState().activeSessionId);
  await select(page, 'Context for the existing session');
  await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
  await expect(message).toHaveValue('My follow-up draft');
  await expect(page.getByLabel('Agent permissions', { exact: true })).toHaveValue('suggest');
  expect(await page.evaluate(() => (window as any).prismAgentStore.getState().activeSessionId)).toBe(original);
  await noSend(page);
});

test('full attachment slots retain the pending capture until there is room', async ({ page }) => {
  await page.goto('/e2e-fixtures/agent.html?context&snapshots&selection');
  for (let i = 1; i <= 3; i++) {
    await select(page, `Passage ${i}`);
    await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(i);
  }
  await select(page, 'Retained fourth passage');
  await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected context destination' })).toContainText('Remove an attached snapshot');
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Remove snapshot 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected context destination' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Selected passage', exact: true }).last().click();
  await expect(page.getByRole('dialog', { name: 'Captured context' })).toContainText('Retained fourth passage');
  await noSend(page);
});

test('actual collaborative host hands off selected text and view-only selection never mutates content', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let level = 'own';
  const server = new Server({ address: '127.0.0.1', port: 0, quiet: true, async onAuthenticate({ connectionConfig }) { connectionConfig.readOnly = level === 'view'; return { fixture: true }; } });
  await server.listen();
  const sockets: WebSocket[] = [];
  try {
    await page.routeWebSocket(/\/collab(\?|$)/, route => {
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage(message => socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message));
      socket.on('open', () => { for (const message of pending) socket.send(message); });
      socket.on('message', (message, binary) => route.send(binary ? Buffer.from(message as Buffer) : message.toString()));
      route.onClose(() => socket.close()); socket.on('close', () => route.close({ code: 1000 }));
    });
    await page.route('**/auth/me', route => route.fulfill({ json: { authenticated: true, email: 'alex@example.test', vaultId: 'primary', workspace: { id: 'workspace-a' } } }));
    await page.route('**/api/notes/document-a', route => route.fulfill({ json: { id: 'document-a', path: 'Draft brief', content: '', _level: level, metadata: {}, tags: [] } }));
    await page.route('**/api/federated/**', route => route.fulfill({ status: 204 }));
    await page.goto('/e2e-fixtures/agent.html?context&snapshots&selection&collab');
    const editor = await select(page, 'Shared selected text');
    await page.screenshot({ path: info.outputPath('collaborative-selection-phone.png'), fullPage: true });
    await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
    await noSend(page);
    level = 'view';
    await page.reload();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    const html = await editor.innerHTML();
    await editor.selectText();
    await expect(page.getByRole('button', { name: 'Ask agent about selection', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Bold selection', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask agent about selection', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Selected passage', exact: true })).toHaveCount(1);
    expect(await editor.innerHTML()).toBe(html);
    await noSend(page);
    await page.goto('about:blank');
  } finally { for (const socket of sockets) socket.terminate(); await server.destroy(); }
});
