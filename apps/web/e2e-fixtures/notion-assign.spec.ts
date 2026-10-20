import { test, expect, type Page } from "@playwright/test";

/**
 * NP-CO-16 — "assigned you to <page>" in the Inbox, the Assigned filter, the
 * property deep link and the Assignments delivery setting; NP-CO-04 — the
 * per-page notification level (page ⋯ menu and the comments sidebar header);
 * NP-CO-03 — archive, filter by type, an empty state per filter, and the
 * "Mark all read" shortcut. Over the in-page fake server (notion-inbox) and the
 * comments fixture; the producers themselves are pinned in
 * apps/server/test/notifications-assign.test.ts.
 */
const url = (q = "") => `/e2e-fixtures/notion-inbox.html${q}`;
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const inbox = (page: Page) => page.getByTestId("notifications-inbox");
const rows = (page: Page) => inbox(page).getByTestId("notification-row");
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, any>>);
const chip = (page: Page, name: string) => inbox(page).getByRole("group", { name: "Filter notifications" }).getByRole("button", { name, exact: true });

test.beforeEach(async ({ page }) => {
  const pinAfternoon = new Date(); pinAfternoon.setHours(15, 0, 0, 0);
  await page.clock.setFixedTime(pinAfternoon); // "5 minutes ago" must be today
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("assigned you: listed with its own icon and copy, counted in the badge, filtered by Assigned, and it opens the page on the property", async ({ page }) => {
  await page.goto(url("?reset&assign&open=notifications"));
  // The unread assignment counts in the sidebar badge (two older unread + this one).
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("3");
  const mine = rows(page).filter({ hasText: "Ada Park assigned you to Write release notes" });
  await expect(mine).toHaveAttribute("data-unread", "true");
  await expect(mine).toHaveAttribute("data-type", "assigned");
  await expect(mine.locator('[data-icon="assigned"] svg')).toBeVisible();
  // No account behind the write (a share-link guest): "Someone".
  await expect(rows(page).filter({ hasText: "Someone assigned you to Review access requests" })).toHaveCount(1);
  // A comment on a page you follow ("All updates").
  await expect(rows(page).filter({ hasText: "Lee Chen commented on Launch plan" })).toContainText("Should we move the date?");

  // The Assigned filter holds exactly the assignments; Replies holds the followed-page comment too.
  await chip(page, "Assigned").click();
  await expect(chip(page, "Assigned")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(2);
  for (const row of await rows(page).all()) await expect(row).toHaveAttribute("data-type", "assigned");
  await chip(page, "Replies").click();
  await expect(rows(page)).toHaveCount(2);
  await chip(page, "Assigned").click();

  // Opening it marks it read and lands on the property it names, highlighted.
  await mine.getByRole("button", { name: /assigned you to Write release notes/ }).click();
  const property = page.locator('#workspace-document [data-property-key="assigned"]');
  await expect(property).toHaveAttribute("data-anchor-target", "true");
  await expect(property).toHaveClass(/prism-anchor-flash/);
  await expect(property).toBeInViewport();
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("2");
  expect((await writes(page)).filter((w) => w.read).at(-1)).toMatchObject({ read: { ids: ["n6"] } });
});

test("NP-CO-03: archive moves an item out of every inbox filter and into Archived; filter by type; one empty state per filter", async ({ page }) => {
  await page.goto(url("?reset&assign&open=notifications"));
  await chip(page, "Assigned").click();
  await expect(rows(page)).toHaveCount(2);
  // Archive from the row: it leaves the filtered list, the badge drops (archiving reads it).
  await rows(page).filter({ hasText: "Ada Park assigned you" }).getByRole("button", { name: "Archive" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("2");
  expect((await writes(page)).find((w) => w.archive)).toMatchObject({ archive: { ids: ["n6"], archived: true } });
  // Archived keeps it, under the same filter; the other filters do not show it.
  await inbox(page).getByRole("tab", { name: "Archived" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Ada Park assigned you to Write release notes");
  await chip(page, "Reminders").click();
  await expect(rows(page)).toHaveCount(0);
  await expect(inbox(page).getByTestId("inbox-empty")).toContainText("Nothing archived under Reminders");
  await chip(page, "All").click();
  await expect(rows(page)).toHaveCount(2); // the seeded archived mention + this one
  // Move it back.
  await rows(page).filter({ hasText: "Ada Park assigned you" }).getByRole("button", { name: "Move to Inbox" }).click();
  await inbox(page).getByRole("tab", { name: /^Inbox/ }).click();
  await chip(page, "Assigned").click();
  await expect(rows(page)).toHaveCount(2);
  expect((await writes(page)).filter((w) => w.archive).at(-1)).toMatchObject({ archive: { ids: ["n6"], archived: false } });
  // Every type filter narrows to its own types.
  const expected: Record<string, string[]> = { Mentions: ["mention"], Assigned: ["assigned"], Replies: ["comment_reply", "comment_thread"], Reminders: ["reminder"], Requests: ["share"] };
  for (const [name, types] of Object.entries(expected)) {
    await chip(page, name).click();
    await expect(rows(page).first()).toBeVisible();
    const seen = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
    expect(seen.every((t) => types.includes(t!)), `${name}: ${seen.join(",")}`).toBe(true);
  }

  // Someone with nothing: each filter says what it would hold (not one generic line).
  await page.goto(url("?reset&as=member&open=notifications"));
  const empty = inbox(page).getByTestId("inbox-empty");
  await expect(empty).toContainText("You’re all caught up");
  const copy: Record<string, string> = { Mentions: "No mentions", Assigned: "Nothing assigned to you", Replies: "No replies", Reminders: "No reminders", Requests: "No requests" };
  const seenCopy = new Set<string>();
  for (const [name, title] of Object.entries(copy)) {
    await chip(page, name).click();
    await expect(empty).toContainText(title);
    await expect(empty).toHaveAttribute("data-filter", name.toLowerCase());
    seenCopy.add((await empty.textContent())!);
  }
  expect(seenCopy.size).toBe(5);
  await expect(empty).toContainText("Pages shared with you and access requests show up here.");
});

test("Mark all read has a keyboard shortcut (Shift+A) that the button states; it never fires while typing", async ({ page }) => {
  await page.goto(url("?reset&assign&open=notifications"));
  const button = inbox(page).getByRole("button", { name: "Mark all read" });
  await expect(button).toHaveAttribute("aria-keyshortcuts", "Shift+A");
  await expect(button.locator("kbd")).toHaveText("⇧A");
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("3");
  // In a field of the inbox (the settings panel's checkbox is an input): not taken.
  await inbox(page).getByRole("button", { name: "Notification settings" }).click();
  await page.getByTestId("notification-settings").getByLabel("Mentions email").focus();
  await page.keyboard.press("Shift+A");
  await expect(nav(page).getByTestId("inbox-badge")).toHaveText("3");
  await page.getByTestId("notification-settings").getByRole("button", { name: "Close" }).click();
  // With the Inbox focused it marks everything read with ONE write.
  await inbox(page).getByRole("heading", { name: "Inbox", level: 1 }).focus();
  await page.keyboard.press("Shift+A");
  await expect(nav(page).getByTestId("inbox-badge")).toHaveCount(0);
  await expect(inbox(page).locator('[data-testid="notification-row"][data-unread="true"]')).toHaveCount(0);
  const reads = (await writes(page)).filter((w) => w.read);
  expect(reads).toHaveLength(1);
  expect(reads[0]).toMatchObject({ read: { all: true } });
  await expect(button).toBeDisabled();
});

test("settings: an Assignments row with push and email, saved with the rest; a server from before it does not offer the row", async ({ page }) => {
  await page.goto(url("?reset&open=notifications"));
  await inbox(page).getByRole("button", { name: "Notification settings" }).click();
  const panel = page.getByTestId("notification-settings");
  await expect(panel.getByText("Someone adds you to a task or a person property")).toBeVisible();
  await expect(panel.getByLabel("Assignments push")).toBeChecked();
  await expect(panel.getByLabel("Assignments email")).toBeChecked();
  await panel.getByLabel("Assignments email").uncheck();
  await panel.getByRole("button", { name: "Save settings" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  const saved = (await writes(page)).find((w) => w.settings)!.settings as Record<string, { push: boolean; email: boolean }>;
  expect(saved.assignment).toEqual({ push: true, email: false });
  expect(saved.mention).toEqual({ push: true, email: true });
  // Kept across a reload.
  await page.goto(url("?open=notifications"));
  await inbox(page).getByRole("button", { name: "Notification settings" }).click();
  await expect(page.getByTestId("notification-settings").getByLabel("Assignments email")).not.toBeChecked();
  await expect(page.getByTestId("notification-settings").getByLabel("Assignments push")).toBeChecked();

  // An older server has no such category: no row, and a save sends no key it would refuse.
  await page.goto(url("?reset&oldsettings&open=notifications"));
  await inbox(page).getByRole("button", { name: "Notification settings" }).click();
  const old = page.getByTestId("notification-settings");
  await expect(old.getByLabel("Mentions push")).toBeVisible();
  await expect(old.getByLabel("Assignments push")).toHaveCount(0);
  await old.getByRole("button", { name: "Save settings" }).click();
  await expect(old.getByRole("status")).toHaveText("Saved");
  expect(Object.keys((await writes(page)).find((w) => w.settings)!.settings).sort()).toEqual(["access", "comment", "mention", "reminder"]);
});

test("page ⋯ → Notifications: shows the current level, saves another, says what 'Nothing' still lets through; absent for a share-link guest", async ({ page }) => {
  await page.goto(url("?reset&open=roadmap"));
  const open = async () => {
    await page.getByRole("button", { name: "Page actions", exact: true }).first().click();
    return page.getByRole("menu", { name: "Actions for Roadmap" });
  };
  let menu = await open();
  const item = (name: string) => menu.getByRole("menuitem", { name: new RegExp(`^Notify me: ${name}`) });
  // The default is "Replies and @mentions", marked Current.
  await expect(item("all updates")).toBeVisible();
  await expect(item("replies and @mentions")).toContainText("Current");
  await expect(item("all updates")).not.toContainText("Current");
  // "Nothing" says, in the menu itself, what still arrives.
  await expect(item("nothing")).toContainText("Mentions of you and assignments still arrive");
  await item("nothing").click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await writes(page)).find((w) => w.pageLevel)).toMatchObject({ pageLevel: "roadmap", level: "none" });
  menu = await open();
  await expect(item("nothing")).toContainText("Current");
  await expect(item("replies and @mentions")).not.toContainText("Current");
  await item("all updates").click();
  // The server keeps it per person and per page: a reload shows it; another page has the default.
  await page.goto(url("?open=roadmap"));
  menu = await open();
  await expect(item("all updates")).toContainText("Current");
  await page.keyboard.press("Escape");
  await page.goto(url("?open=launch"));
  await page.getByRole("button", { name: "Page actions", exact: true }).first().click();
  menu = page.getByRole("menu", { name: "Actions for Launch plan" });
  await expect(item("replies and @mentions")).toContainText("Current");
  await page.keyboard.press("Escape");

  // A share-link guest has no inbox (the route answers 401): the group is not offered at all.
  await page.goto(url("?reset&nolevels&open=roadmap"));
  menu = await open();
  await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Notify me/ })).toHaveCount(0);
});

test("comments sidebar header: the page's notification level, changed in place; hidden where the viewer has no inbox", async ({ page }) => {
  const comments = (q = "") => `/e2e-fixtures/notion-comments.html${q}`;
  let level = "mentions";
  const puts: unknown[] = [];
  await page.route("**/api/notifications/pages/**", async (route) => {
    const req = route.request();
    expect(new URL(req.url()).pathname).toBe("/api/notifications/pages/page-1");
    if (req.method() === "PUT") { puts.push(req.postDataJSON()); level = (req.postDataJSON() as { level: string }).level; }
    await route.fulfill({ json: { level } });
  });
  await page.goto(comments("?note=page-1"));
  const control = page.getByTestId("page-notification-level");
  const button = control.getByRole("button", { name: "Notifications for this page: Replies and @mentions" });
  await expect(button).toBeVisible();
  await button.click();
  const menu = control.getByRole("menu", { name: "Notifications for this page" });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(menu.getByRole("menuitemradio", { name: /Replies and @mentions/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: /Replies and @mentions/ })).toBeFocused();
  // The UI states what "Nothing" does not silence.
  await expect(menu.getByRole("menuitemradio", { name: /^Nothing/ })).toContainText("Mentions of you, assignments and answers to your suggestions still arrive.");
  // Keyboard: arrow to "Nothing", choose it; focus returns to the button, which now says so.
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: /^Nothing/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  const now = control.getByRole("button", { name: "Notifications for this page: Nothing" });
  await expect(now).toBeFocused();
  await expect(control).toHaveAttribute("data-level", "none");
  expect(puts).toEqual([{ level: "none" }]);
  // Escape closes without a write.
  await now.click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(puts).toHaveLength(1);

  // A share-link guest (401) and a host that names no page: no control.
  await page.unroute("**/api/notifications/pages/**");
  await page.route("**/api/notifications/pages/**", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.goto(comments("?note=page-1"));
  await expect(page.getByText("Comments", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("page-notification-level")).toHaveCount(0);
  await page.goto(comments());
  await expect(page.getByText("Comments", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("page-notification-level")).toHaveCount(0);
});
