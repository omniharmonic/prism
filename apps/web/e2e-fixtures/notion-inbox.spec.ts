import { test, expect, type Page } from "@playwright/test";

/** Notifications inbox (NP-CO-03) and delivery settings (NP-CO-04), over the in-page fake server. */
const SHOTS = process.env.INBOX_SHOTS;
const url = (q = "") => `/e2e-fixtures/notion-inbox.html${q}`;
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const inbox = (page: Page) => page.getByTestId("notifications-inbox");
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, unknown>>);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

// The fixtures seed items relative to "now" ("20 minutes ago" must be today, "26 hours ago" yesterday), so run
// every test at 15:00 local on the current day — otherwise the grouping changes around midnight.
test.beforeEach(async ({ page }) => {
  const pinAfternoon = new Date(); pinAfternoon.setHours(15, 0, 0, 0);
  await page.clock.setFixedTime(pinAfternoon); // fixes Date only; timers keep running natively
});

test("inbox lists mentions, replies, shares; mark read", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?reset&open=roadmap"));
  // Sidebar: Home + Inbox with the unread badge.
  await expect(nav(page).getByRole("button", { name: "Home", exact: true })).toBeVisible();
  const inboxRow = nav(page).getByRole("button", { name: "Inbox, 2 unread" });
  await expect(inboxRow).toBeVisible();
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("2");
  await inboxRow.click();

  await expect(inbox(page).getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  // Grouped by day; mention, reply and share all listed; archived item is not.
  await expect(inbox(page).getByRole("region", { name: "Today" })).toBeVisible();
  await expect(inbox(page).getByRole("region", { name: "Yesterday" })).toBeVisible();
  const rows = inbox(page).getByTestId("notification-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "Ada Park mentioned you in Roadmap" })).toHaveAttribute("data-unread", "true");
  await expect(rows.filter({ hasText: "Lee Chen replied to your thread on Launch plan" })).toContainText("I’ll take the first pass");
  await expect(rows.filter({ hasText: "shared a page with you: Field notes" })).toHaveAttribute("data-unread", "false");
  await expect(rows.filter({ hasText: "mentioned you in a comment" })).toHaveCount(0);
  await shot(page, "inbox-1440-light");

  // Filters.
  await inbox(page).getByRole("button", { name: "Mentions", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await inbox(page).getByRole("button", { name: "Replies", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await inbox(page).getByRole("button", { name: "All", exact: true }).click();
  await expect(rows).toHaveCount(4);

  // Mark one read from the row action → badge drops to 1.
  await rows.filter({ hasText: "Lee Chen replied" }).getByRole("button", { name: "Mark as read" }).click();
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("1");
  expect((await writes(page)).find((w) => w.read)).toMatchObject({ read: { ids: ["n2"] } });

  // Opening a mention jumps to the exact chip on its page and marks it read.
  await rows.filter({ hasText: "Ada Park mentioned you" }).getByRole("button", { name: /mentioned you in Roadmap/ }).click();
  await expect(page.locator('#workspace-document [data-mention-uid="m1"]')).toHaveAttribute("data-anchor-target", "true");
  await expect(nav(page).getByTestId("inbox-badge")).toHaveCount(0);
  await expect(nav(page).getByRole("button", { name: "Inbox", exact: true })).toBeVisible();

  // Back in the inbox: archive the share; it moves to Archived.
  await nav(page).getByRole("button", { name: "Inbox", exact: true }).click();
  await rows.filter({ hasText: "Field notes" }).getByRole("button", { name: "Archive" }).click();
  await expect(rows).toHaveCount(3);
  await inbox(page).getByRole("tab", { name: "Archived" }).click();
  await expect(rows.filter({ hasText: "Field notes" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "mentioned you in a comment on Launch plan" })).toHaveCount(1);
  // Mark all read is offered only in the Inbox tab.
  await inbox(page).getByRole("tab", { name: /^Inbox/ }).click();
  await expect(inbox(page).getByRole("button", { name: "Mark all read" })).toBeDisabled();

  // Phone layout: full-width rows, row actions always visible, no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const box = await rows.first().getByRole("button", { name: "Archive" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await shot(page, "inbox-390-light");

  // Push deep link (/inbox/<id>): the app opens that notification's page at its anchor.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?open=notifications&notification=n1"));
  await expect(page.locator('#workspace-document [data-mention-uid="m1"]')).toHaveAttribute("data-anchor-target", "true");
});

test("notification settings respected", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?reset&open=notifications&no-push"));
  await inbox(page).getByRole("button", { name: "Notification settings" }).click();
  const panel = page.getByTestId("notification-settings");
  await expect(panel).toBeVisible();
  // No push on this server: push toggles are disabled and say why; email is available.
  await expect(panel.getByLabel("Mentions push")).toBeDisabled();
  await expect(panel).toContainText("Push isn’t set up on this server.");
  await expect(panel.getByLabel("Mentions email")).toBeChecked();
  await expect(panel.getByLabel("Comments email")).not.toBeChecked();
  await panel.getByLabel("Mentions email").uncheck();
  await panel.getByLabel("Comments email").check();
  await panel.getByRole("button", { name: "Save settings" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  const saved = (await writes(page)).find((w) => w.settings) as { settings: Record<string, { push: boolean; email: boolean }> };
  expect(saved.settings.mention).toEqual({ push: true, email: false });
  expect(saved.settings.comment).toEqual({ push: true, email: true });
  await shot(page, "inbox-settings-1440-light");

  // The server keeps them: a reload shows the saved choices.
  await page.goto(url("?open=notifications"));
  await inbox(page).getByRole("button", { name: "Notification settings" }).click();
  await expect(page.getByTestId("notification-settings").getByLabel("Mentions email")).not.toBeChecked();
  await expect(page.getByTestId("notification-settings").getByLabel("Comments email")).toBeChecked();
  await expect(page.getByTestId("notification-settings").getByLabel("Mentions push")).toBeEnabled();
});

// NP-CO-03 — "Mark all read" clears the badge everywhere with one write.
test("mark all read clears the badge with one write", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url("?reset&open=notifications"));
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("2");
  await expect(inbox(page).locator('[data-testid="notification-row"][data-unread="true"]')).toHaveCount(2);
  // The reminder that fired is listed like any other item.
  await expect(inbox(page).getByTestId("notification-row").filter({ hasText: /remind/i })).toHaveCount(1);
  await inbox(page).getByRole("button", { name: "Mark all read" }).click();
  await expect(inbox(page).locator('[data-testid="notification-row"][data-unread="true"]')).toHaveCount(0);
  await expect(nav(page).getByTestId("inbox-badge")).toHaveCount(0);
  expect((await writes(page)).filter((w) => "read" in w).at(-1)).toMatchObject({ read: { all: true } });
  // Nothing left to mark: the control is disabled, and the tab no longer shows a count.
  await expect(inbox(page).getByRole("button", { name: "Mark all read" })).toBeDisabled();
  await expect(inbox(page).getByRole("tab", { name: "Inbox", exact: true })).toBeVisible();
});
