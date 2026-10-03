import { test, expect, type Locator, type Page } from "@playwright/test";

/** Wave 3 gaps #11: swipe actions on list rows on a phone (synthetic touch events).
 *  Inbox rows: left = archive, right = mark read. Page-tree rows: right = favorite,
 *  left = the page's actions menu. Reduced-motion aware; never inside a sideways
 *  scroller; the row's buttons remain the alternatives. */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test.beforeEach(async ({ page }) => {
  const pinAfternoon = new Date(); pinAfternoon.setHours(15, 0, 0, 0);
  await page.clock.setFixedTime(pinAfternoon);
});

/** Drag from the middle of `row` by (dx, dy); `hold` leaves the finger down (no touchend). */
async function swipe(page: Page, row: Locator, dx: number, opts: { dy?: number; hold?: boolean; fromX?: number } = {}) {
  const box = (await row.boundingBox())!;
  const x = opts.fromX ?? box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 20);
  await page.evaluate(({ x, y, dx, dy, hold }) => {
    const target = document.elementFromPoint(x, y) ?? document.body;
    const touch = (cx: number, cy: number) => new Touch({ identifier: 1, target, clientX: cx, clientY: cy });
    const fire = (type: string, cx: number, cy: number, end = false) =>
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: end ? [] : [touch(cx, cy)], changedTouches: [touch(cx, cy)] }));
    fire("touchstart", x, y);
    for (let i = 1; i <= 8; i++) fire("touchmove", x + (dx * i) / 8, y + (dy * i) / 8);
    if (!hold) fire("touchend", x + dx, y + dy, true);
  }, { x, y, dx, dy: opts.dy ?? 0, hold: !!opts.hold });
}
const release = (_page: Page, row: Locator) => row.evaluate((el) => el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [] })));
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, unknown>>);

test("inbox rows: swipe right marks read, swipe left archives; short or vertical drags do nothing", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
  const rows = page.getByTestId("notifications-inbox").getByTestId("notification-row");
  await expect(rows).toHaveCount(4);
  const mention = rows.filter({ hasText: "Ada Park mentioned you in Roadmap" });
  await expect(mention).toHaveAttribute("data-unread", "true");
  const before = (await writes(page)).length;

  // Mid-drag: the row follows the finger and the action label shows in the gap.
  await swipe(page, mention, 90, { hold: true });
  await expect(mention.locator(".prism-swipe-hint")).toHaveText("Mark as read");
  await expect(mention.locator(".prism-swipe-hint")).toHaveAttribute("data-armed", "true");
  expect(await mention.evaluate((el) => (el as HTMLElement).style.transform)).toBe("translateX(90px)");
  await release(page, mention);
  await expect(mention).toHaveAttribute("data-unread", "false");
  expect(await mention.evaluate((el) => (el as HTMLElement).style.transform)).toBe("");
  // Releasing did not open the notification's page.
  await expect(page.getByTestId("notifications-inbox")).toBeVisible();

  // Too short, mostly vertical, or starting in the back-swipe edge zone: nothing happens.
  const reply = rows.filter({ hasText: "Lee Chen replied" });
  const count = (await writes(page)).length;
  await swipe(page, reply, -40);
  await swipe(page, reply, -90, { dy: 120 });
  await page.waitForTimeout(150);
  expect((await writes(page)).length).toBe(count);
  await expect(rows).toHaveCount(4);
  // A drag that starts at the screen edge belongs to the shell (Browse / back), not the row.
  await swipe(page, reply, 120, { fromX: 10 });
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await expect(drawer).toHaveCount(0);
  expect((await writes(page)).length).toBe(count);
  // A read row has no "mark read" swipe.
  await swipe(page, mention, 100);
  await page.waitForTimeout(100);
  expect((await writes(page)).length).toBe(count);

  // Swipe left: archived (it leaves the Inbox tab).
  await swipe(page, reply, -100);
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Lee Chen replied" })).toHaveCount(0);
  expect((await writes(page)).length).toBeGreaterThan(before);
  // No sideways page scroll was introduced.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("reduced motion: the row does not slide, the label shows in place, the action still runs", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
  const rows = page.getByTestId("notifications-inbox").getByTestId("notification-row");
  const mention = rows.filter({ hasText: "Ada Park mentioned you in Roadmap" });
  await swipe(page, mention, 90, { hold: true });
  await expect(mention.locator(".prism-swipe-hint")).toHaveAttribute("data-still", "true");
  expect(await mention.evaluate((el) => (el as HTMLElement).style.transform)).toBe("");
  await release(page, mention);
  await expect(mention).toHaveAttribute("data-unread", "false");
});

test("never inside a sideways scroller", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
  const rows = page.getByTestId("notifications-inbox").getByTestId("notification-row");
  await expect(rows).toHaveCount(4);
  // Put the list inside a horizontally scrollable ancestor (a board column, a wide table).
  await rows.first().evaluate((el) => {
    const list = el.parentElement!;
    list.style.overflowX = "auto";
    const wide = document.createElement("li");
    wide.style.cssText = "width:1200px;height:1px;list-style:none";
    list.append(wide);
  });
  const mention = rows.filter({ hasText: "Ada Park mentioned you in Roadmap" });
  await swipe(page, mention, 100);
  await swipe(page, mention, -100);
  await page.waitForTimeout(150);
  await expect(mention).toHaveAttribute("data-unread", "true");
  await expect(rows).toHaveCount(4);
});

test("page tree rows: swipe right favorites the page, swipe left opens its actions", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.getByRole("button", { name: /Browse|Open navigation|Notes/ }).first().click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer).toBeVisible();
  const row = drawer.locator(".page-tree-row").filter({ hasText: "Workshop agenda" });
  if (!(await row.count())) {
    for (const folder of ["Library"]) await drawer.locator(".page-tree-row").filter({ hasText: folder }).first().click();
  }
  await expect(row).toBeVisible();
  await swipe(page, row, 90, { hold: true });
  await expect(row.locator(".prism-swipe-hint")).toHaveText("Favorite");
  await release(page, row);
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.preferences.favorites)).toContain("agenda");
  // The swipe did not open the page.
  expect(await page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("workspace");
  // Left: the page's actions (a bottom sheet on a phone).
  await swipe(page, row, -100);
  await expect(page.getByRole("dialog", { name: "Workshop agenda" })).toBeVisible();
});
