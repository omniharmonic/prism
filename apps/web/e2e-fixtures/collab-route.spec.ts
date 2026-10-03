import { test, expect } from '@playwright/test';
import { Server } from '@hocuspocus/server';
import WebSocket from 'ws';

for (const [target, capability] of [['Projects/Prism/Shared ideas', ''], ['shared-real-id', ''], ['Shared ideas', 'fictional-capability']]) test(`actual collaboration route resolves ${target} ${capability ? 'capability link' : 'account'} before opening a real-ID socket`, async ({ page }) => {
  const names: string[] = [];
  const tokens: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const errors: string[] = [];
  const sockets: WebSocket[] = [];
  const server = new Server({ address: '127.0.0.1', port: 0, quiet: true, async onAuthenticate({ documentName, token }) { names.push(documentName); tokens.push(token); if (documentName !== 'shared-real-id') throw new Error('Real IDs only'); return {}; } });
  await server.listen();
  try {
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket(/\/collab(\?|$)/, route => {
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage(message => socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message));
      socket.on('open', () => { for (const message of pending) socket.send(message); });
      socket.on('message', (message, binary) => route.send(binary ? Buffer.from(message as Buffer) : message.toString()));
      route.onClose(() => socket.close()); socket.on('close', () => route.close({ code: 1000 }));
    });
    await page.route('**/auth/me', route => route.fulfill({ json: { authenticated: true, email: 'reviewer@example.test', vaultId: 'primary', workspace: { id: 'fixture-workspace' } } }));
    await page.route('**/api/notes/**', route => { authorizations.push(route.request().headers()['authorization']); return route.fulfill({ json: { id: 'shared-real-id', path: 'Projects/Prism/Shared ideas', content: '', metadata: {}, tags: [], _level: 'edit' } }); });
    await page.route('**/api/federated/**', route => route.fulfill({ status: 204 }));
    await page.goto('/e2e-fixtures/collab-route.html?target=' + encodeURIComponent(target!) + (capability ? '&token=' + capability : ''));
    const editor = page.locator('.tiptap[contenteditable=true]');
    await expect(editor).toBeVisible();
    await expect.poll(() => names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(['shared-real-id']));
    if (capability) { expect(new Set(tokens)).toEqual(new Set([capability])); expect(new Set(authorizations)).toEqual(new Set(['Capability ' + capability])); }
    await editor.fill('A shared route is ready to write.');
    await expect(editor).toHaveText('A shared route is ready to write.');
    expect(errors).toEqual([]);
    await page.goto('about:blank');
  } finally { for (const socket of sockets) socket.terminate(); await server.destroy(); }
});

test('a denied alias never opens a socket or exposes an old title and can retry', async ({ page }) => {
  let reads = 0; let sockets = 0;
  await page.routeWebSocket(/\/collab(\?|$)/, route => { sockets++; route.close(); });
  await page.route('**/api/notes/**', route => { reads++; return route.fulfill({ status: 403, json: { error: 'private fixture diagnostics' } }); });
  await page.goto('/e2e-fixtures/collab-route.html');
  await expect(page.getByRole('alert')).toContainText('This shared document could not be opened');
  await expect(page.getByRole('alert')).not.toContainText('private fixture');
  expect(sockets).toBe(0);
  const before = reads;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  expect(sockets).toBe(0);
});
