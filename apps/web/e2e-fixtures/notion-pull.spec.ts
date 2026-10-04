import { test, expect, type Locator, type Page } from "@playwright/test";
import { touchDrag, touchRelease } from "./browser-compat";

/**
 * NP-MB-06 — phone gestures with synthesized touch events:
 *  pull-to-refresh on the Inbox, Messages, the Trash and the page tree (each with a Refresh
 *  button), and row swipes on Messages (email: archive / mark read) and the Trash (restore).
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Drag from a point inside `target` by (dx, dy); `hold` leaves the finger down. */
async function drag(page: Page, target: Locator, dx: number, dy: number, opts: { hold?: boolean; yOffset?: number } = {}) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + (opts.yOffset ?? Math.min(box.height / 2, 24));
  await touchDrag(page, { x, y, dx, dy, hold: !!opts.hold });
}
const release = (target: Locator) => touchRelease(target);
const ptr = (scope: Page | Locator) => scope.getByTestId("pull-to-refresh");
const said = (scope: Page | Locator) => ptr(scope).locator(".prism-ptr-status");

test("Inbox: pulling the list down refetches it and says so; a short pull does nothing; Refresh is the button", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
  const inbox = page.getByTestId("notifications-inbox");
  const rows = page.getByTestId("notification-row");
  await expect(rows).toHaveCount(4);
  const reads = () => page.evaluate(() => (window as any).prismFixtureListReads.count as number);
  const before = await reads();
  // The browser's own pull-to-refresh / overscroll never runs alongside.
  expect(await inbox.evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe("contain");

  // Short: nothing.
  await drag(page, rows.first(), 0, 70);
  await page.waitForTimeout(200);
  expect(await reads()).toBe(before);
  // Past the threshold the indicator arms; letting go refreshes.
  await drag(page, rows.first(), 0, 110, { hold: true });
  await expect(ptr(page)).toHaveAttribute("data-state", "pulling");
  await expect(ptr(page)).toContainText("Pull to refresh");
  await release(rows.first());
  expect(await reads()).toBe(before); // released early: no refresh
  await drag(page, rows.first(), 0, 220, { hold: true });
  await expect(ptr(page)).toHaveAttribute("data-state", "armed");
  await expect(ptr(page)).toContainText("Release to refresh");
  await release(rows.first());
  await expect(said(page)).toHaveText("Inbox updated");
  await expect.poll(reads).toBe(before + 1);
  await expect(said(page)).toHaveAttribute("aria-live", "polite");
  // The swipe on a row still works, and a pull did not open the row.
  await expect(rows).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).prismFixtureUI.getState().activeTabId)).toBe("tab-notifications");

  // The button does the same (a gesture is never the only way).
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(reads).toBe(before + 2);
  await expect(said(page)).toHaveText("Inbox updated");
});

test("Messages: pull to refresh — not when scrolled, not while a text field has focus, not for a sideways drag; reduced motion", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-gestures.html");
  const scroller = page.getByTestId("messages-scroller");
  const first = page.locator(".prism-message-row").first();
  await expect(first).toBeVisible();
  const reads = () => page.evaluate(() => (window as any).prismGestures.reads.emails as number);
  const before = await reads();

  await drag(page, first, 0, 220);
  await expect(said(page)).toHaveText("Messages updated");
  await expect.poll(reads).toBe(before + 1);

  // Scrolled down: the list scrolls, nothing refreshes.
  await scroller.evaluate((el) => { el.scrollTop = 120; });
  await drag(page, scroller, 0, 220, { yOffset: 200 });
  await page.waitForTimeout(200);
  expect(await reads()).toBe(before + 1);
  await scroller.evaluate((el) => { el.scrollTop = 0; });

  // A text field has focus (the keyboard is up): never.
  await page.getByRole("textbox", { name: "Search inbox" }).focus();
  await drag(page, first, 0, 220);
  await page.waitForTimeout(200);
  expect(await reads()).toBe(before + 1);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());

  // A sideways drag is a row swipe, not a pull.
  await drag(page, first, 150, 20);
  await page.waitForTimeout(200);
  expect(await reads()).toBe(before + 1);

  // A refresh that fails says so.
  await page.evaluate(() => { (window as any).prismGestures.failRefresh = true; });
  await drag(page, first, 0, 220);
  await expect(said(page)).toHaveText("Couldn’t refresh messages");
  await page.evaluate(() => { (window as any).prismGestures.failRefresh = false; });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(said(page)).toHaveText("Messages updated");

  // Reduced motion: nothing follows the finger; the label shows in place.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await drag(page, first, 0, 220, { hold: true });
  await expect(ptr(page)).toHaveAttribute("data-still", "true");
  const pill = ptr(page).locator(".prism-ptr-pill");
  await expect(pill).toHaveText("Release to refresh");
  expect(await pill.evaluate((el) => (el as HTMLElement).style.transform)).toBe("");
  const afterStill = await reads();
  await release(first);
  await expect.poll(reads).toBe(afterStill + 1);
});

test("Messages: an email row swipes right to mark read (never to archive); the row has a Mark as read button; chat rows have no swipe", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-gestures.html");
  const row = (name: string) => page.locator(".prism-message-row").filter({ hasText: name }).first();
  const acts = () => page.evaluate(() => (window as any).prismGestures.actions as Array<{ action: string; noteId: string; read?: boolean }>);
  await expect(row("Budget question 1")).toBeVisible();

  // Archiving moves mail in the real mailbox with no undo: it is never a swipe.
  await drag(page, row("Budget question 2"), -100, 0, { hold: true });
  await expect(row("Budget question 2").locator(".prism-swipe-hint")).toHaveCount(0);
  await release(row("Budget question 2"));
  await page.waitForTimeout(150);
  expect(await acts()).toEqual([]);

  await drag(page, row("Budget question 1"), 100, 0, { hold: true });
  await expect(row("Budget question 1").locator(".prism-swipe-hint")).toHaveText("Mark as read");
  await release(row("Budget question 1"));
  await expect.poll(acts).toEqual([{ action: "mark-read", noteId: "mail-1", read: true }]);
  await expect.poll(() => page.evaluate(() => (window as any).prismGesturesToast())).toBe("Marked read");
  // The swipe did not open the conversation, and the row is no longer unread (its list was updated).
  await expect(page.getByText("Choose a conversation")).toBeAttached();
  await expect(page.getByRole("button", { name: "Mark Budget question 1 as read" })).toHaveCount(0);

  // The same action as a button on the row (a gesture is never the only way).
  await page.getByRole("button", { name: "Mark Budget question 2 as read" }).click();
  await expect.poll(acts).toEqual([{ action: "mark-read", noteId: "mail-1", read: true }, { action: "mark-read", noteId: "mail-2", read: true }]);
  await expect(page.getByRole("button", { name: "Mark Budget question 2 as read" })).toHaveCount(0);
  await expect(page.getByText("Choose a conversation")).toBeAttached();
  // An email that is already read has neither.
  await expect(page.getByRole("button", { name: "Mark Budget question 5 as read" })).toHaveCount(0);
  // A chat thread has no email action: no swipe at all.
  await drag(page, row("Team room"), 100, 0, { hold: true });
  await expect(row("Team room").locator(".prism-swipe-hint")).toHaveCount(0);
  await release(row("Team room"));
  await page.waitForTimeout(150);
  expect(await acts()).toHaveLength(2);

  // No live email actions in this shell: no swipe, no button.
  await page.goto("/e2e-fixtures/notion-gestures.html?noactions");
  await expect(row("Budget question 1")).toBeVisible();
  await drag(page, row("Budget question 1"), 100, 0, { hold: true });
  await expect(row("Budget question 1").locator(".prism-swipe-hint")).toHaveCount(0);
  await release(row("Budget question 1"));
  await expect(page.getByRole("button", { name: /Mark .* as read/ })).toHaveCount(0);
  expect(await acts()).toHaveLength(0);
});

test("Trash: a row swipes to restore, the list pulls to refresh, and both have buttons", async ({ page }) => {
  await page.goto("/e2e-fixtures/pages-nav.html");
  await expect(page.locator(".tiptap").first()).toBeVisible();
  // Put two pages in the Trash on the "server".
  await page.evaluate(async () => {
    for (const id of ["weekly", "archive"]) await fetch(`/api/notes/${id}/trash`, { method: "POST", body: "{}" });
  });
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await drawer.getByRole("button", { name: "Trash", exact: true }).click();
  const trash = page.getByRole("dialog", { name: "Trash" });
  const rows = trash.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  const reads = () => page.evaluate(() => (window as any).prismFixtureReads.trash as number);

  // The list holds list items only (the pull indicator is outside it).
  expect(await trash.getByRole("list", { name: "Pages in Trash" }).evaluate((el) => [...el.children].every((c) => c.getAttribute("role") === "listitem"))).toBe(true);
  // Pull to refresh (the search field is not focused on a touch device, so the keyboard stays down).
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
  const before = await reads();
  await drag(page, rows.first(), 0, 220);
  await expect(said(trash)).toHaveText("Trash updated");
  await expect.poll(reads).toBe(before + 1);
  await trash.getByRole("button", { name: "Refresh the Trash" }).click();
  await expect.poll(reads).toBe(before + 2);

  // Swipe a row: restore (the Restore button is still there for everyone else).
  const weekly = rows.filter({ hasText: "Weekly review" });
  await expect(weekly.getByRole("button", { name: "Restore Weekly review" })).toBeVisible();
  await drag(page, weekly, -100, 0, { hold: true });
  await expect(weekly.locator(".prism-swipe-hint")).toHaveText("Restore");
  await release(weekly);
  await expect(page.getByRole("status").filter({ hasText: "Restored “Weekly review”" })).toBeVisible();
  await expect(rows).toHaveCount(1);
  expect(await page.evaluate(() => ((window as any).prismFixtureNotes.find((n: any) => n.id === "weekly").tags as string[]).includes("prism-trashed"))).toBe(false);
  // A short swipe does nothing; deleting for good is never a swipe.
  await drag(page, rows.first(), 40, 0);
  await page.waitForTimeout(150);
  await expect(rows).toHaveCount(1);
});

test("Page tree (Browse drawer): pulling down refetches the tree; the Refresh button does the same", async ({ page }) => {
  await page.goto("/e2e-fixtures/pages-nav.html");
  await expect(page.locator(".tiptap").first()).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer).toBeVisible();
  const reads = () => page.evaluate(() => (window as any).prismFixtureReads.tree as number);
  const before = await reads();
  await drag(page, drawer.getByRole("navigation", { name: "Workspace destinations" }), 0, 220);
  await expect(said(drawer)).toHaveText("Pages updated");
  await expect.poll(reads).toBeGreaterThan(before);
  const afterPull = await reads();
  await drawer.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(reads).toBeGreaterThan(afterPull);
});
