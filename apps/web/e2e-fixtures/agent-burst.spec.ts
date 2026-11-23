import { test, expect, type Page, type Browser, type BrowserContext } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

/**
 * L-1 (incident 2026-11-07): an agent made 42 suggestions in ~3½ min on a big page the owner had
 * open, and the Mac client's window went grey. Two amplifiers were on the client:
 *   (1) every note event refetched every mounted list — covered by `npm run verify:events`
 *       (this fixture bridges no /api/events: TREE_SUBSCRIBE=0);
 *   (2) local persistence re-wrote the WHOLE document to IndexedDB for every update — covered HERE,
 *       through the real server's collab socket: another participant makes 42 separate edits to a
 *       ~170 KB page the owner has open in the workspace, and the owner's device must write only
 *       what changed, never show an error screen, and end with every edit.
 */
let server: RealServer;
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());
test.setTimeout(240_000);

const editor = (page: Page) => page.locator(".tiptap").first();
async function device(browser: Browser, who: "owner" | "eve", url: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await connect(page, context, server, who);
  await page.goto(url);
  return { page, context };
}
/** The app's own module instance (Vite serves one per URL), read in the page. */
const stats = (page: Page) => page.evaluate(async (mod) => {
  const m = await import(/* @vite-ignore */ mod);
  return { ...m.localDocumentStats } as { writes: number; deltaWrites: number; compactions: number; bytesWritten: number };
}, "/src/collab/localDocument.ts");

test("42 remote edits to a big open page: no error screen, every edit arrives, local storage writes only the deltas", async ({ browser, browserName }) => {
  // ~170 KB, 130 paragraphs — the incident page's size.
  const para = (i: number) => `<p>Paragraph ${i}: ${"The bioregional plan keeps its working notes here, with long sentences that carry real weight. ".repeat(14)}</p>`;
  const content = Array.from({ length: Number(process.env.BURST_PARAS ?? 130) }, (_, i) => para(i)).join("");
  const id = `burst-${browserName}-${process.pid}`;
  // Under the shared "Plan" page: Eve edits it through that page share (sub-pages inherit).
  expect(await server.add({ id, path: `vault/Shared/Plan/Burst ${id}`, content, tags: ["team"] })).toBe(true);

  const owner = await device(browser, "owner", `/e2e-fixtures/collab-route.html?page=${id}`);
  // A 170 KB page converts in the server's worker: opening it live takes a few seconds on a busy machine.
  await expect(editor(owner.page)).toBeVisible({ timeout: 30_000 });
  await expect(owner.page.getByText(/^Live(?: · .+)?$/)).toBeVisible({ timeout: 30_000 });
  await expect(editor(owner.page)).toContainText("Paragraph 129", { timeout: 30_000 });
  if (browserName === "chromium") {
    await owner.page.evaluate(() => {
      (window as any).__longest = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__longest = Math.max((window as any).__longest, e.duration); }).observe({ type: "longtask", buffered: false });
    });
  }
  const eve = await device(browser, "eve", `/e2e-fixtures/collab-route.html?page=${id}`);
  await expect(editor(eve.page)).toContainText("Paragraph 129", { timeout: 30_000 });
  await owner.page.waitForTimeout(1_500); // the open's own writes settle
  const before = await stats(owner.page);

  // 42 separate edits, each in its own paragraph, a moment apart (the agent's pace, compressed).
  for (let i = 0; i < 42; i++) {
    await eve.page.getByText(`Paragraph ${i * 3}:`, { exact: false }).first().click();
    await eve.page.keyboard.press("Home");
    await eve.page.keyboard.type(`[S${i}] `);
    await eve.page.waitForTimeout(120);
  }
  // Every edit reached the owner's open page.
  for (const i of [0, 20, 41]) await expect(editor(owner.page)).toContainText(`[S${i}]`, { timeout: 20_000 });
  await owner.page.waitForTimeout(1_000);
  const after = await stats(owner.page);

  // No error screen of any kind on the owner's device.
  await expect(owner.page.getByRole("heading", { name: /Prism stopped working|Something went wrong/ })).toHaveCount(0);

  // Local storage wrote deltas, not the document again and again.
  const written = after.bytesWritten - before.bytesWritten;
  const writes = after.writes - before.writes;
  expect(writes).toBeGreaterThan(5);
  expect(after.deltaWrites - before.deltaWrites, "updates are stored as deltas").toBeGreaterThan(0);
  // Before L-1: every write stored the whole ~170 KB document (≈ writes × 170 KB). Now: the edits
  // plus at most a compaction or two.
  // The old design: ≈ writes × the page (here ~40 MB for one burst). Now: less than ONE page's worth.
  expect(written, `${writes} writes stored ${written} bytes (old design ≈ ${writes * content.length})`).toBeLessThan(content.length);
  test.info().annotations.push({ type: "L-1 local writes", description: `${writes} writes, ${written} bytes (${after.compactions - before.compactions} compactions); page ${content.length} chars` });

  if (browserName === "chromium") {
    const longest = await owner.page.evaluate(() => (window as any).__longest as number);
    test.info().annotations.push({ type: "L-1 longest main-thread task", description: `${Math.round(longest)} ms` });
    expect(longest, "no main-thread task near a stall").toBeLessThan(1_500);
  }
  await eve.context.close();
  await owner.context.close();
});
