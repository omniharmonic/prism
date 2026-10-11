// Run against the fictional workspace fixture, never a production vault.
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const origin = process.env.PRISM_PROFILE_ORIGIN || 'http://127.0.0.1:5198';
  await page.goto(`${origin}/e2e-fixtures/workspace.html?navigation&large-navigation`);
  await page.locator('.tiptap').waitFor();
  await page.waitForTimeout(1500); // Allow startup/idle work; measure only the opening action.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (let trial = 0; trial < 3; trial++) {
    console.log(JSON.stringify(await page.evaluate(async () => {
      const longTasks = [];
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => Math.round(e.duration))));
      observer.observe({ type: 'longtask' });
      const frames = []; let done = false; const start = performance.now(); let firstFrame = null;
      function frame() {
        const now = performance.now(); frames.push(now);
        if (firstFrame === null && document.querySelector('dialog[open] .page-tree-row')) firstFrame = Math.round(now - start);
        if (!done) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      window.prismFixtureUI.setState({ sidebarOpen: true });
      await new Promise(resolve => setTimeout(resolve, 2000));
      done = true; observer.disconnect();
      return { firstFrame, maxFrameGap: Math.max(0, ...frames.slice(1).map((t, i) => Math.round(t - frames[i]))), longTasks, rows: document.querySelectorAll('.page-tree-row').length };
    })));
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await page.waitForTimeout(450);
  }
} finally { await browser.close(); }
