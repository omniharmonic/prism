import { test, expect } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

test("page properties preserve the editor and failed title changes remain recoverable", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const editor = page.locator('.tiptap[contenteditable=true]');
  await expect(editor).toBeVisible();
  await editor.evaluate(node => { (window as any).originalWritingEditor = node; });
  await page.locator('.document-properties-disclosure summary').click();
  await expect(page.locator('.document-properties-content')).toContainText('Projects/Prism/A living workspace');
  await expect(page.locator('.document-property-tag')).toHaveText('project');
  expect(await editor.evaluate(node => node === (window as any).originalWritingEditor)).toBe(true);
  // A failure the person can retry (the server broke): the typed title stays. (A 403 reverts it — parity2-pages.)
  await page.evaluate(() => { (window as any).prismFixtureControls.rejectWriteStatus = 500; (window as any).prismFixtureControls.rejectWrite = true; });
  await page.getByRole('button', { name: 'Rename A living workspace', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Document title' });
  await title.fill('A clearer workspace');
  await title.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Could not rename this page' })).toBeVisible();
  await expect(title).toHaveValue('A clearer workspace');
  await expect(title).toBeFocused();
  await page.evaluate(() => { (window as any).prismFixtureControls.rejectWrite = false; });
  await title.press('Enter');
  await expect(page.getByRole('button', { name: 'Rename A clearer workspace', exact: true })).toBeVisible();
  await expect(page.locator('.document-properties-content')).toContainText('Projects/Prism/A clearer workspace');
  expect(await editor.evaluate(node => node === (window as any).originalWritingEditor)).toBe(true);
  await page.screenshot({ path: info.outputPath('document-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.document-page-header')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('document-phone.png'), fullPage: true });
});

test("outline opens without moving the selection, follows heading edits and navigates the same editor", async ({ page }, info) => {
  await page.goto('/e2e-fixtures/workspace.html');
  const editor = page.locator('.tiptap[contenteditable=true]');
  await expect(editor).toBeVisible();
  await editor.locator('h2').first().click();
  const selection = await page.evaluate(() => { const s = getSelection()!; return { text: s.anchorNode?.textContent, offset: s.anchorOffset }; });
  const scroll = await page.locator('.document-writing-scroll').evaluate(node => node.scrollTop);
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  const outline = page.getByRole('navigation', { name: 'Document outline' });
  await expect(outline.getByRole('button', { name: 'Purpose', exact: true })).toBeVisible();
  expect(await page.evaluate(() => { const s = getSelection()!; return { text: s.anchorNode?.textContent, offset: s.anchorOffset }; })).toEqual(selection);
  expect(await page.locator('.document-writing-scroll').evaluate(node => node.scrollTop)).toBe(scroll);
  await page.screenshot({ path: info.outputPath('outline-desktop.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(outline).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Outline', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await outline.getByRole('button', { name: 'Next steps', exact: true }).click();
  await expect(outline).toHaveCount(0);
  expect(await page.locator('.document-writing-scroll').evaluate(node => node.scrollTop)).toBeGreaterThan(scroll);
  await editor.locator('h2').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' together');
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(outline.getByRole('button', { name: 'Next steps together', exact: true })).toBeVisible();
  // NP-PG-11: the section being read is highlighted, and follows the scroll while the outline is open.
  await expect(outline.getByRole('button', { name: 'Next steps together', exact: true })).toHaveAttribute('aria-current', 'location');
  await expect(outline.locator('[aria-current="location"]')).toHaveCount(1);
  await page.locator('.document-writing-scroll').evaluate(node => { node.scrollTop = 0; });
  await expect(outline.getByRole('button', { name: 'Next steps together', exact: true })).not.toHaveAttribute('aria-current', 'location');
  expect(await outline.locator('[aria-current="location"]').count()).toBeLessThanOrEqual(1);
  await outline.getByRole('button', { name: 'Next steps together', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(outline).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Outline', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); });
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(outline).toBeVisible();
  await page.screenshot({ path: info.outputPath('outline-phone-dark.png'), fullPage: true, animations: 'disabled' });
});

test("formatting is discoverable, preserves selection and remembers the full toolbar preference", async ({ page }) => {
  await page.goto('/e2e-fixtures/workspace.html');
  const editor = page.locator('.tiptap[contenteditable=true]');
  await expect(editor).toBeVisible();
  await editor.fill('Selected writing');
  await editor.press('ControlOrMeta+Alt+0');
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Document outline' })).toContainText('Add headings to navigate this page.');
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await editor.press('ControlOrMeta+a');
  const formatting = page.getByRole('button', { name: 'Formatting', exact: true });
  await expect(formatting).toHaveAttribute('aria-expanded', 'false');
  await formatting.click();
  await page.getByRole('group', { name: 'Text formatting' }).getByRole('button', { name: /Bold/ }).click();
  await expect(editor.locator('strong')).toHaveText('Selected writing');
  await page.getByRole('checkbox', { name: 'Always show formatting toolbar' }).check();
  await formatting.click();
  await expect(formatting).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(formatting).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('checkbox', { name: 'Always show formatting toolbar' }).uncheck();
  await page.reload();
  await expect(formatting).toHaveAttribute('aria-expanded', 'false');
});

test("real collaborative host shares properties and readable mobile header without replacing its live editor", async ({ page }, info) => {
  const server = new Server({ address: '127.0.0.1', port: 0, quiet: true, debounce: 10, async onAuthenticate() { return { fixture: true }; } });
  await server.listen();
  const sockets: WebSocket[] = [];
  let path = 'Projects/Prism/A collaborative workspace with connected ideas';
  let rejectRename = true;
  let renameRequests = 0;
  let releaseRename: (() => void) | undefined;
  let holdRename = false;
  let uncertainRename = false;
  let partialRename = false;
  const finished: string[] = [];
  let level = 'own';
  try {
    await page.routeWebSocket(/\/collab(\?|$)/, route => {
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage(message => socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message));
      socket.on('open', () => { for (const message of pending) socket.send(message); });
      socket.on('message', (message, binary) => route.send(binary ? Buffer.from(message as Buffer) : message.toString()));
      route.onClose(() => socket.close()); socket.on('close', () => route.close({ code: 1000 }));
    });
    await page.route('**/auth/me', route => route.fulfill({ json: { authenticated: true, email: 'alice@example.test', vaultId: 'primary', workspace: { id: 'workspace-a' } } }));
    // A title rename is a MOVE of the page and its sub-pages (NP-PG-03).
    await page.route('**/api/notes/denied-note/move', async route => {
      renameRequests++;
      if (uncertainRename) return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
      if (rejectRename) return route.fulfill({ status: 500, json: { error: 'fixture_failed' } });
      if (holdRename) await new Promise<void>(resolve => { releaseRename = resolve; });
      const sent = route.request().postDataJSON();
      if (sent.moveId) { finished.push(sent.moveId); return route.fulfill({ json: { ok: true, path, moved: [] } }); }
      path = sent.newPath;
      // A rename whose sub-pages did not all move (207): the page is renamed, the rest waits for "Finish move".
      if (partialRename) return route.fulfill({ status: 207, json: { error: 'partial_move', moveId: 'move-1', moved: [{ id: 'denied-note', from: '', to: path }], failed: { id: 'child', from: 'a', to: 'b', reason: 'vault_500' }, remaining: 1, resume: { moveId: 'move-1', newPath: path } } });
      await route.fulfill({ json: { ok: true, path, moved: [{ id: 'denied-note', from: '', to: path }] } });
    });
    await page.route('**/api/notes/denied-note', async route => {
      // The gateway never moves a page by PATCH for a non-owner; the title must not try.
      if (route.request().method() === 'PATCH' && 'path' in route.request().postDataJSON()) return route.fulfill({ status: 403, json: { error: 'move_required' } });
      await route.fulfill({ json: { id: 'denied-note', path, content: '', _level: level, metadata: {}, tags: [] } });
    });
    await page.route('**/api/federated/**', route => route.fulfill({ status: 204 }));
    await page.goto('/e2e-fixtures/collab-storage.html?live');
    const editor = page.locator('.tiptap[contenteditable=true]');
    await expect(editor).toBeVisible();
    await editor.fill('Our shared ideas stay connected.');
    const formatting = page.getByRole('button', { name: 'Formatting', exact: true });
    await expect(formatting).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: 'Editing', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept all suggestions', exact: true })).toBeVisible();
    await editor.press('ControlOrMeta+a');
    await formatting.click();
    await page.getByRole('group', { name: 'Text formatting' }).getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText('Our shared ideas stay connected.');
    await page.getByRole('checkbox', { name: 'Always show formatting toolbar' }).check();
    await page.reload();
    await expect(formatting).toHaveAttribute('aria-expanded', 'true');
    await expect(editor.locator('strong')).toHaveText('Our shared ideas stay connected.');
    await formatting.click();
    await editor.evaluate(node => { (window as any).originalWritingEditor = node; });
    await page.locator('.document-properties-disclosure summary').click();
    await expect(page.locator('.document-properties-content')).toContainText(path);
    await expect(page.getByText('Live · Editing', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rename A collaborative workspace with connected ideas', exact: true }).click();
    const renameTitle = page.getByRole('textbox', { name: 'Document title' });
    await renameTitle.fill('A clearer shared workspace');
    await renameTitle.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Could not rename this page' })).toBeVisible();
    await expect(renameTitle).toHaveValue('A clearer shared workspace');
    await expect(renameTitle).toBeFocused();
    expect(renameRequests).toBe(1);
    rejectRename = false; holdRename = true;
    await renameTitle.press('Enter');
    await expect.poll(() => renameRequests).toBe(2);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    expect(renameRequests).toBe(2);
    releaseRename!();
    await expect(page.getByRole('button', { name: 'Rename A clearer shared workspace', exact: true })).toBeVisible();
    await expect(page.locator('.document-properties-content')).toContainText('Projects/Prism/A clearer shared workspace');
    expect(await editor.evaluate(node => node === (window as any).originalWritingEditor)).toBe(true);

    await page.screenshot({ path: info.outputPath('collaborative-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor).toHaveText('Our shared ideas stay connected.');
    expect(await editor.evaluate(node => node === (window as any).originalWritingEditor)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('collaborative-phone.png'), fullPage: true });
    await editor.click();
    await formatting.click();
    await page.getByRole('group', { name: 'Text formatting' }).getByRole('button', { name: 'Heading 2', exact: true }).click();
    await expect(editor.locator('h2')).toHaveText('Our shared ideas stay connected.');
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Document outline' })).toContainText('Our shared ideas stay connected.');
    // The open outline is an overlay at this width and lies over the left of the heading (its lower edge ran
    // through the heading's centre to within half a pixel: Chromium's layout put the default click just below it,
    // WebKit's just inside it). A person taps the text they can see: the part of the heading clear of the overlay.
    // That tap is outside the outline, so it also closes it.
    const outline = page.getByRole('navigation', { name: 'Document outline' });
    const [headingBox, outlineBox] = [(await editor.locator('h2').boundingBox())!, (await outline.boundingBox())!];
    expect(outlineBox.x + outlineBox.width, 'the heading is not wholly covered').toBeLessThan(headingBox.x + headingBox.width - 12);
    await editor.locator('h2').click({ position: { x: headingBox.width - 6, y: headingBox.height / 2 } });
    await expect(outline).toHaveCount(0);
    await page.keyboard.press('End');
    await page.keyboard.type(' Together.');
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Document outline' })).toContainText('Together.');
    holdRename = false; uncertainRename = true;
    await page.getByRole('button', { name: 'Rename A clearer shared workspace', exact: true }).click();
    await renameTitle.fill('A locally queued title');
    await renameTitle.press('Enter');
    // A rename the server did not confirm (503) is a FAILURE, never "saved on this
    // device": renames are not queued (wave 2E re-review H4). The typed title stays for a retry.
    await expect(page.getByRole('alert').filter({ hasText: 'Could not rename this page' })).toBeVisible();
    await expect(renameTitle).toHaveValue('A locally queued title');
    await expect(page.getByText('Title change saved on this device. Waiting to sync.', { exact: true })).toHaveCount(0);
    expect(path).toBe('Projects/Prism/A clearer shared workspace');
    // Review H3: a partial rename offers a working "Finish move" on this page (the share route has no toasts).
    uncertainRename = false; partialRename = true;
    await renameTitle.press('Enter');
    await expect(page.getByRole('button', { name: 'Rename A locally queued title', exact: true })).toBeVisible();
    const finish = page.getByRole('button', { name: 'Finish move', exact: true });
    await expect(finish).toBeVisible();
    await finish.click();
    await expect.poll(() => finished).toEqual(['move-1']);
    await expect(finish).toHaveCount(0);
    level = 'view';
    await page.reload();
    await expect(page.locator('.tiptap[contenteditable=false]')).toBeVisible();
    await expect(formatting).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Rename / })).toHaveCount(0);
    await expect(page.locator('.document-properties-disclosure summary')).toBeVisible();
    const readonlyBody = await page.locator('.tiptap').innerHTML();
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    await page.getByRole('navigation', { name: 'Document outline' }).getByRole('button', { name: /Our shared ideas/ }).click();
    expect(await page.locator('.tiptap').innerHTML()).toBe(readonlyBody);
    await page.goto('/e2e-fixtures/workspace.html');
    await expect(page.getByRole('button', { name: 'Formatting', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.goto('about:blank');
  } finally { for (const socket of sockets) socket.terminate(); await server.destroy(); }
});
