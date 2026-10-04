import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 3 (slice G) — mentions, reminders, comments and the inbox:
 *   NP-RF-02  an ISO date through the @ menu
 *   NP-RF-06  the inbox item opens the page scrolled to the chip · a reminder's time is edited
 *   NP-RF-07  a PERSON mention shows on that person's profile (their backlinks)
 *   NP-CO-01  delete own comment (and only your own)
 *   NP-CO-03  accepted / declined / resolved-suggestion items in the Inbox
 * Fixtures: notion-mentions.html (in-page fake server), notion-inbox.html.
 */
async function openEditor(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/notion-mentions.html${query}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible();
  return editor;
}
async function typeAtEnd(page: Page, editor: ReturnType<Page["locator"]>, text: string) {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}
const saved = (page: Page, id: string) => page.evaluate((noteId) => (window as any).prismFixtureNotes.find((n: any) => n.id === noteId).content as string, id);
const menu = (page: Page) => page.getByRole("listbox", { name: "Mention a person, page or date" });

/** NP-RF-02 · Dates ("today", "tomorrow", "next Monday", ISO dates). */
test("NP-RF-02: an ISO date typed after @ becomes a date chip for that day", async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 9, 1, 10, 0) });
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Ship by @2026-12-24");
  const dates = menu(page).getByRole("group", { name: "Dates" });
  await expect(dates.getByRole("option", { name: "Dec 24", exact: true })).toBeVisible();
  // An ISO date is a date and nothing else: no person or page is offered for it.
  await expect(menu(page).getByRole("group", { name: "People" })).toHaveCount(0);
  await expect(menu(page).getByRole("group", { name: "Pages" })).toHaveCount(0);
  await dates.getByRole("option", { name: "Dec 24", exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  const chip = editor.locator('[data-type="mention"][data-kind="date"]');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("Dec 24");
  await expect(chip.getByRole("button", { name: /Thursday, December 24, 2026/ })).toBeVisible();
  // The typed text was replaced by the chip, and the stored page keeps the calendar day.
  await expect(editor).not.toContainText("@2026-12-24");
  await expect.poll(() => saved(page, "plan"), { timeout: 10_000 }).toContain('data-date="2026-12-24"');

  // With a time: "<ISO date> 9am".
  await page.keyboard.type(" then @2027-01-05 9am");
  await expect(menu(page).getByRole("option", { name: "Jan 5, 2027 9:00", exact: true })).toBeVisible();
  await menu(page).getByRole("option", { name: "Jan 5, 2027 9:00", exact: true }).click();
  await expect(editor.locator('[data-type="mention"][data-kind="date"]')).toHaveCount(2);
  await expect(editor.locator('[data-type="mention"][data-kind="date"]').nth(1)).toContainText("Jan 5, 2027 9:00");
  await expect.poll(() => saved(page, "plan"), { timeout: 10_000 }).toMatch(/data-date="2027-01-05T09:00:00[+-]\d\d:\d\d"/);

  // A date that does not exist is not offered.
  await page.keyboard.type(" never @2026-02-31");
  await expect(menu(page).getByRole("group", { name: "Dates" })).toHaveCount(0);
});

/** NP-RF-02: the same, chosen with the keyboard. */
test("NP-RF-02: Enter chooses the ISO date", async ({ page }) => {
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Ship by @2031-12-24");
  await expect(menu(page).getByRole("group", { name: "Dates" }).getByRole("option", { name: "Dec 24, 2031", exact: true })).toBeVisible();
  await expect(menu(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(menu(page).getByRole("option").first()).toHaveText(/Dec 24, 2031/);
  await page.keyboard.press("Enter");
  await expect(menu(page)).toHaveCount(0);
  await expect(editor.locator('[data-type="mention"][data-kind="date"]')).toContainText("Dec 24, 2031");
  await expect(editor).not.toContainText("@2031-12-24");
});

/** NP-RF-06 · "Tapping it opens the page scrolled to the block." */
test("NP-RF-06: the reminder's inbox item opens the page scrolled to its date chip", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.clock.install({ time: new Date(2026, 9, 2, 9, 5) });
  await openEditor(page, "?open=retro");
  // A long page whose reminder chip is far below the fold; its reminder fired five minutes ago.
  await page.evaluate(() => {
    const plan = (window as any).prismFixtureNotes.find((n: any) => n.id === "plan");
    const filler = Array.from({ length: 90 }, (_, i) => `<p>Paragraph ${i + 1} of the launch plan.</p>`).join("");
    plan.content = `${filler}<p>Follow up <span data-type="mention" data-kind="date" data-date="2026-10-02T09:00:00+00:00" data-reminder="r1" data-mention-uid="u-rem">@x</span> with the venue.</p><p>The end.</p>`;
    (window as any).prismFixtureReminders.push({ id: "r1", noteId: "plan", at: new Date(2026, 9, 2, 9, 0).getTime(), tz: "UTC", dateOnly: false, uid: "u-rem", status: "scheduled" });
  });
  const nav = page.locator(".workspace-navigation").first();
  await nav.getByRole("button", { name: /^Inbox/ }).click();
  const row = page.getByTestId("notification-row").filter({ hasText: "Reminder:" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Launch plan");
  await row.getByRole("button", { name: /Reminder: Launch plan/ }).click();
  // The page opened, and the view moved to the chip (it was ~90 paragraphs down).
  const chip = page.locator('#workspace-document [data-reminder="r1"]');
  await expect(chip).toHaveAttribute("data-anchor-target", "true");
  await expect(chip).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#workspace-document").getByText("Paragraph 1 of the launch plan.", { exact: true })).not.toBeInViewport();
  const centre = await chip.evaluate((el) => { const b = el.getBoundingClientRect(); return (b.top + b.height / 2) / innerHeight; });
  expect(centre).toBeGreaterThan(0.2);
  expect(centre).toBeLessThan(0.8);
  expect(await page.evaluate(() => (window as any).prismFixtureUI.getState().openTabs.find((t: any) => t.id === (window as any).prismFixtureUI.getState().activeTabId).noteId)).toBe("plan");
});

/** NP-RF-06 · "Reminders can be cancelled and edited." */
test("NP-RF-06: editing the chip's time moves the same reminder", async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 9, 1, 10, 0) });
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Follow up @remind tomorrow 9am");
  await page.getByRole("option", { name: "Remind me Tomorrow 9:00" }).click();
  const chip = editor.locator('[data-type="mention"][data-kind="date"]');
  await expect(chip).toHaveAttribute("data-reminder", "r1");
  // Edit the time from the chip.
  await chip.locator(".prism-mention-chip").click();
  const dialog = page.getByRole("dialog", { name: "Edit date" });
  await expect(dialog.getByLabel("Remind me")).toBeChecked();
  await dialog.getByLabel("Time", { exact: true }).fill("14:30");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(chip).toContainText("Tomorrow 14:30");
  await expect(chip).toHaveAttribute("data-reminder", "r1");
  // ONE reminder, moved — not a second one.
  const state = await page.evaluate(() => ({ reminders: (window as any).prismFixtureReminders, writes: (window as any).prismFixtureWrites.filter((w: any) => w.reminder) }));
  expect(state.reminders).toHaveLength(1);
  expect(state.reminders[0]).toMatchObject({ id: "r1", status: "scheduled", dateOnly: false });
  expect(state.reminders[0].at).toBe(new Date(2026, 9, 2, 14, 30).getTime());
  expect(state.writes).toHaveLength(2); // the create, then the edit of r1
  expect(state.writes[1]).toMatchObject({ reminder: "r1", dateOnly: false });
  expect(String(state.writes[1].method)).toMatch(/^(PATCH|PUT)$/);
  expect(new Date(state.writes[1].at).getTime()).toBe(new Date(2026, 9, 2, 14, 30).getTime());
  await expect.poll(() => saved(page, "plan"), { timeout: 10_000 }).toMatch(/data-date="2026-10-02T14:30:00[+-]\d\d:\d\d"/);
  // It fires at the NEW time, not the old one.
  const inbox = () => page.evaluate(async () => (await (await fetch("/api/notifications")).json()).items);
  await page.clock.setSystemTime(new Date(2026, 9, 2, 9, 1));
  expect(await inbox()).toEqual([]);
  await page.clock.setSystemTime(new Date(2026, 9, 2, 14, 31));
  expect(await inbox()).toHaveLength(1);
  // And the date itself can move: the reminder follows to another day.
  await chip.locator(".prism-mention-chip").click();
  await dialog.getByLabel("Date").fill("2026-10-09");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismFixtureReminders.map((r: any) => [r.id, r.at]))).toEqual([["r1", new Date(2026, 9, 9, 14, 30).getTime()]]);
});

/** NP-RF-07 · "a page or person mention adds a vault link, so it appears in the target's backlinks". */
test("NP-RF-07: a person mention shows on that person's profile", async ({ page }) => {
  const editor = await openEditor(page);
  // Before: nothing links to Grace.
  expect(await page.evaluate(async () => (await (await fetch("/api/people/p-grace")).json()).related)).toEqual([]);
  await typeAtEnd(page, editor, "Review with @gra");
  await page.getByRole("option", { name: /Grace Hopper/ }).click();
  const chip = editor.locator('[data-type="mention"][data-kind="person"]');
  await expect(chip).toHaveText("@Grace Hopper");
  await expect.poll(() => saved(page, "plan"), { timeout: 10_000 }).toContain('data-id="p-grace"');
  // The stored page now links to the person …
  const link = await page.evaluate(async () => (await (await fetch("/api/notes/plan?include_links=true")).json()).links);
  expect(link).toEqual([expect.objectContaining({ sourceId: "plan", targetId: "p-grace", relationship: "mentions" })]);
  // … and her profile lists the mentioning page, opened from the chip itself.
  await page.mouse.move(0, 0);
  await chip.locator(".prism-mention-chip").click();
  await expect(page.getByRole("heading", { name: "Grace Hopper", exact: true })).toBeVisible();
  const record = page.getByRole("button", { name: /Launch plan/ }).filter({ hasText: /mentions/i });
  await expect(record).toBeVisible();
  // Someone who was not mentioned has no such record.
  expect(await page.evaluate(async () => (await (await fetch("/api/people/p-ada")).json()).related.map((r: any) => r.id))).toEqual(["refs"]);
  // Opening the record goes back to the mentioning page.
  await record.click();
  await expect.poll(() => page.evaluate(() => { const s = (window as any).prismFixtureUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("plan");
});

/** NP-CO-01 · "Reply, edit own, delete own, resolve and reopen." */
test("NP-CO-01: you can delete your own comment, and only your own", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-mentions.html?comments");
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("The rollout plan is ready");
  await editor.click();
  await page.evaluate(() => (window as any).prismMentionsFixture.select("rollout plan"));
  await page.getByRole("button", { name: "Comment on selection" }).click();
  const box = page.getByRole("textbox", { name: "Comment" });
  await box.pressSequentially("Is this final?");
  await page.keyboard.press("ControlOrMeta+Enter");
  const panel = page.getByRole("complementary", { name: "Comments panel" });
  await expect(panel).toContainText("Is this final?");
  const reply = panel.getByRole("textbox", { name: "Reply" });
  await reply.pressSequentially("Second thought");
  await reply.press("Enter");
  await expect(panel).toContainText("Second thought");
  const threads = () => page.evaluate(() => (window as any).prismMentionsFixture.comments() as Record<string, { comments: Array<{ author: string; text: string }> }>);
  const id = Object.keys(await threads())[0]!;
  await page.evaluate((threadId) => (window as any).prismMentionsFixture.foreignReply(threadId, "From Lee: looks good"), id);
  await expect(panel).toContainText("From Lee: looks good");
  // Edit and Delete are offered on MY two comments, not on Lee's.
  await expect(panel.getByRole("button", { name: "Delete comment" })).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "Edit comment" })).toHaveCount(2);
  expect((await threads())[id]!.comments.map((c) => c.author)).toEqual(["You", "You", "Lee Chen"]);
  // Deleting asks once more; moving away cancels.
  const deleteSecond = panel.getByRole("button", { name: "Delete comment" }).nth(1);
  await deleteSecond.click();
  await expect(panel.getByRole("button", { name: "Delete?" })).toBeVisible();
  await reply.click();
  await expect(panel.getByRole("button", { name: "Delete?" })).toHaveCount(0);
  await expect(panel).toContainText("Second thought");
  // Confirmed: only that comment goes; the thread, its anchor and the others stay.
  await panel.getByRole("button", { name: "Delete comment" }).nth(1).click();
  await panel.getByRole("button", { name: "Delete?" }).click();
  await expect(panel).not.toContainText("Second thought");
  await expect(panel).toContainText("Is this final?");
  await expect(panel).toContainText("From Lee: looks good");
  expect((await threads())[id]!.comments.map((c) => c.text)).toEqual(["Is this final?", "From Lee: looks good"]);
  await expect(editor.locator("[data-comment-id]")).toHaveText("rollout plan");
  await expect(panel.getByRole("button", { name: "Delete comment" })).toHaveCount(1);
  // Deleting my first comment leaves Lee's reply (and the thread) in place.
  await panel.getByRole("button", { name: "Delete comment" }).click();
  await panel.getByRole("button", { name: "Delete?" }).click();
  await expect(panel).not.toContainText("Is this final?");
  await expect(panel).toContainText("From Lee: looks good");
  await expect(panel.getByRole("button", { name: "Delete comment" })).toHaveCount(0);
  expect(Object.keys(await threads())).toEqual([id]);
});

/** NP-CO-01: deleting your only comment removes the thread and its highlight. */
test("NP-CO-01: deleting the last comment removes the thread and its anchor", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-mentions.html?comments");
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("The rollout plan is ready");
  await editor.click();
  await page.evaluate(() => (window as any).prismMentionsFixture.select("rollout plan"));
  await page.getByRole("button", { name: "Comment on selection" }).click();
  await page.getByRole("textbox", { name: "Comment" }).pressSequentially("Only one");
  await page.keyboard.press("ControlOrMeta+Enter");
  const panel = page.getByRole("complementary", { name: "Comments panel" });
  await expect(panel).toContainText("Only one");
  await expect(editor.locator("[data-comment-id]")).toHaveCount(1);
  await panel.getByRole("button", { name: "Delete comment" }).click();
  await panel.getByRole("button", { name: "Delete?" }).click();
  await expect(panel).not.toContainText("Only one");
  await expect(editor.locator("[data-comment-id]")).toHaveCount(0);
  await expect(editor).toContainText("The rollout plan is ready for review.");
  expect(await page.evaluate(() => Object.keys((window as any).prismMentionsFixture.comments()))).toEqual([]);
});

/** NP-CO-03 · the Inbox shows "… accepted or rejected suggestions …". */
test("NP-CO-03: accepted, declined and resolved suggestions are inbox items that open their page", async ({ page }) => {
  const pin = new Date(); pin.setHours(15, 0, 0, 0);
  await page.clock.setFixedTime(pin);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=roadmap");
  await expect(page.locator(".workspace-navigation").first().getByRole("button", { name: "Inbox, 2 unread" })).toBeVisible();
  // The server produced three suggestion outcomes for this account (producer: server notifications.test).
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fixture-inbox")!);
    const base = { anchor: null, preview: null, readAt: null, archivedAt: null, to: "owner" };
    state.items.push(
      { ...base, id: "s1", type: "suggestion_accepted", noteId: "launch", actor: { name: "Ada Park" }, createdAt: Date.now() - 5 * 60_000 },
      { ...base, id: "s2", type: "suggestion_rejected", noteId: "field", actor: { name: "Lee Chen" }, createdAt: Date.now() - 6 * 60_000 },
      { ...base, id: "s3", type: "suggestion_resolved", noteId: "roadmap", actor: null, createdAt: Date.now() - 7 * 60_000 },
    );
    localStorage.setItem("fixture-inbox", JSON.stringify(state));
  });
  await page.goto("/e2e-fixtures/notion-inbox.html?open=notifications");
  const nav = page.locator(".workspace-navigation").first();
  const inbox = page.getByTestId("notifications-inbox");
  const rows = inbox.getByTestId("notification-row");
  await expect(nav.getByTestId("inbox-badge")).toHaveText("5");
  await expect(rows).toHaveCount(7);
  const accepted = rows.filter({ hasText: "Ada Park accepted your suggestion on Launch plan" });
  const declined = rows.filter({ hasText: "Lee Chen declined your suggestion on Field notes" });
  const resolved = rows.filter({ hasText: "resolved your suggestion on Roadmap" });
  for (const row of [accepted, declined, resolved]) {
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-unread", "true");
  }
  // The neutral outcome names nobody (the server could not tell who decided).
  await expect(resolved).not.toContainText("Ada Park");
  await expect(resolved).not.toContainText("Lee Chen");
  // They are neither mentions nor replies.
  await inbox.getByRole("button", { name: "Mentions", exact: true }).click();
  await expect(rows.filter({ hasText: "your suggestion" })).toHaveCount(0);
  await inbox.getByRole("button", { name: "All", exact: true }).click();
  // Opening one goes to its page and marks it read.
  await accepted.getByRole("button", { name: /accepted your suggestion on Launch plan/ }).click();
  await expect.poll(() => page.evaluate(() => { const s = (window as any).prismFixtureUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("launch");
  await expect(nav.getByTestId("inbox-badge")).toHaveText("4");
  expect((await page.evaluate(() => (window as any).prismFixtureWrites as Array<{ read?: { ids?: string[] } }>)).some((w) => w.read?.ids?.includes("s1"))).toBe(true);
});

/** NP-CO-03 · "deep links to the block": the item opens its page with the block on screen. */
test("NP-CO-03: a mention notification opens the page with the mention on screen", async ({ page }) => {
  const pin = new Date(); pin.setHours(15, 0, 0, 0);
  await page.clock.setFixedTime(pin);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
  const rows = page.getByTestId("notifications-inbox").getByTestId("notification-row");
  await rows.filter({ hasText: "Ada Park mentioned you in Roadmap" }).getByRole("button", { name: /mentioned you in Roadmap/ }).click();
  const chip = page.locator('#workspace-document [data-mention-uid="m1"]');
  await expect(chip).toHaveAttribute("data-anchor-target", "true");
  await expect(chip).toContainText("Robin Vale");
  await expect(chip).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => { const s = (window as any).prismFixtureUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("roadmap");
});
