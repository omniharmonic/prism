import { test, expect } from '@playwright/test';

for (const collab of [false, true]) {
  for (const appearance of ['desktop', 'phone', 'dark'] as const) {
    test(`canvas surfaces remain usable ${collab ? 'collaborative' : 'plain'} ${appearance}`, async ({ page }, info) => {
      await page.setViewportSize(appearance === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 860 });
      await page.goto(`/e2e-fixtures/canvas.html?visual${collab ? '&collab' : ''}${appearance === 'dark' ? '&dark' : ''}`);
      await expect(page.locator('.excalidraw')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add notes', exact: true })).toHaveAttribute('aria-expanded', 'false');
      // CollabDoc already owns its PageHeader; the embedded toolbar does not repeat it.
      await expect(page.locator('.prism-canvas-heading')).toHaveCount(collab ? 0 : 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (appearance === 'phone') {
        for (const label of ['Add notes', 'Show links', 'Browse cards', 'Focus canvas']) {
          const box = await page.getByRole('button', { name: label, exact: true }).boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
        }
      }
      await page.getByRole('button', { name: 'Show links', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Hide links', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Add notes', exact: true }).click();
      await page.getByRole('textbox', { name: 'Find canvas notes' }).fill('Morgan');
      const filterBox = await page.getByRole('combobox', {name: 'Filter canvas notes by tag'}).boundingBox();
      // Control-size tokens (tokens.css): 28–36 px on a desktop, the 44 px touch target on a phone.
      if (appearance === 'phone') expect(filterBox?.height).toBeGreaterThanOrEqual(44);
      else { expect(filterBox?.height).toBeGreaterThanOrEqual(28); expect(filterBox?.height).toBeLessThanOrEqual(36); }
      const note = page.getByRole('button', { name: 'Conversation with Morgan People/Conversation with Morgan', exact: true });
      await expect(note).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect.poll(()=>page.evaluate(()=>(window as any).prismCanvasFixture.syncAttempts.length)).toBeGreaterThan(0);
      await expect(page.getByText('Updating relationships…', {exact:true})).not.toBeVisible();
      if (info.project.name === 'webkit') await page.screenshot({ path: info.outputPath(`${collab ? 'collab' : 'plain'}-${appearance}-drawer.png`) });
      await note.click();
      await expect(page.getByRole('button', { name: 'Conversation with Morgan On canvas', exact: true })).toBeDisabled();
      await page.getByRole('textbox', { name: 'Find canvas notes' }).press('Escape');
      await page.getByRole('button', { name: 'Browse cards', exact: true }).click();
      await page.getByRole('textbox', { name: 'Find a card' }).fill('Morgan');
      await expect(page.getByRole('button', { name: 'Open Conversation with Morgan', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Find Conversation with Morgan on canvas', exact: true }).click();
      await expect(page.getByRole('complementary', { name: 'Notes on canvas' })).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Browse cards', exact: true })).toBeFocused();
      await expect.poll(()=>page.evaluate(()=>(window as any).prismCanvasFixture.syncAttempts.length)).toBeGreaterThan(0);
      await expect(page.getByText('Updating relationships…', {exact:true})).not.toBeVisible();

      const overlay = page.locator('canvas.interactive');
      await overlay.hover({position:{x:30,y:250}});
      await expect(overlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await page.mouse.down();
      await expect(overlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await page.mouse.up();
      if (info.project.name === 'webkit') await page.screenshot({ path: info.outputPath(`${collab ? 'collab' : 'plain'}-${appearance}-scene.png`) });
    });
  }
}
