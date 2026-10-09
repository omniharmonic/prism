import { test, expect } from "@playwright/test";

test.use({ timezoneId: "America/Denver" });
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z")); });

test("calendar opens exact meeting records and all stored transcript links without title guesses", async ({ page }) => {
  await page.goto("/e2e-fixtures/calendar.html");
  await page.getByRole("button", { name: "Design review", exact: true }).first().click();
  const transcripts = page.getByRole("region", { name: "Meeting transcripts" });
  await expect(transcripts.getByRole("button", { name: "First recording" })).toBeVisible();
  await expect(transcripts.getByRole("button", { name: "Second recording" })).toBeVisible();
  await expect(transcripts.getByRole("button")).toHaveCount(2);
  await page.getByRole("button", { name: "Meeting Notes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismCalendarUI.getState().activeTabId)).toBe("tab-meeting-one");
  await page.getByRole("button", { name: "Close event details", exact: true }).click();
  await page.getByRole("button", { name: "Design review", exact: true }).nth(1).click();
  await expect(transcripts).toContainText("No transcript linked to this meeting yet.");
  expect(await page.evaluate(() => [(window as any).prismCalendarFixture.searches, (window as any).prismCalendarFixture.writes])).toEqual([0, 0]);
});

test("transcript revocation hides previously displayed references on reopen", async ({ page }) => {
  await page.goto("/e2e-fixtures/calendar.html");
  await page.getByRole("button", { name: "Design review", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "First recording" })).toBeVisible();
  await page.getByRole("button", { name: "Close event details", exact: true }).click();
  await page.evaluate(() => { (window as any).prismCalendarFixture.deny = true; });
  await page.getByRole("button", { name: "Design review", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Meeting transcripts" })).toContainText("Some linked transcripts are unavailable");
  await expect(page.getByRole("button", { name: "First recording" })).toHaveCount(0);
});

test("phone calendar uses a full-width dismissible detail sheet and retains local all-day dates", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/calendar.html");
  // A phone opens on the agenda (calendar-phone.spec.ts); the day view is one tap away.
  await expect(page.getByRole("button", { name: "Agenda", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Day", exact: true }).click();
  const workshop = page.getByRole("button", { name: /All-day workshop/ });
  await expect(workshop).toBeVisible();
  await workshop.click();
  const dialog = page.getByRole("dialog", { name: "Calendar details" });
  await expect(dialog).toBeVisible();
  expect(Math.round((await dialog.boundingBox())!.width)).toBe(390);
  await expect(dialog).toContainText("Monday, October 5");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("calendar-details-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(workshop).toBeFocused();
  await page.getByRole("button", { name: "Previous period" }).click();
  await expect(workshop).toHaveCount(0);
});

test("editing an all-day event title preserves timing, guests, and occurrence notification controls", async ({ page }) => {
  await page.goto("/e2e-fixtures/calendar.html");
  await page.getByRole("button", { name: "All-day workshop", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByPlaceholder("Event title").fill("Revised workshop");
  await expect(page.getByText("Changes apply to this occurrence only.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Update Event", exact: true }).click();
  expect(await page.evaluate(() => (window as any).prismCalendarFixture.updates)).toEqual([{ eventId: "all-day-event", notify: true, title: "Revised workshop" }]);
});

test("multi-day and overnight events appear on each occupied day with exclusive ends", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/calendar.html?layout");
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.getByRole("button", { name: /Multi-day offsite/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Overnight handoff/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("calendar-agenda-mobile.png") });
  await page.getByRole("button", { name: "Next period" }).click();
  await expect(page.getByRole("button", { name: /Multi-day offsite/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Overnight handoff/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /All-day workshop/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Next period" }).click();
  await expect(page.getByRole("button", { name: /Multi-day offsite/ })).toHaveCount(0);
});

test("desktop separates concurrent meetings and clips overnight blocks to the local day", async ({ page }, testInfo) => {
  await page.goto("/e2e-fixtures/calendar.html?layout");
  await expect(page.getByRole("button", { name: "Previous-month meeting", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Day", exact: true }).click();
  const a = page.getByRole("button", { name: /^Overlapping A/ });
  const b = page.getByRole("button", { name: /^Overlapping B/ });
  const first = page.getByRole("button", { name: /^Design review/ }).first();
  await a.scrollIntoViewIfNeeded();
  const boxes = await Promise.all([first, a, b].map(button => button.boundingBox()));
  for (let i = 0; i < boxes.length - 1; i++) expect(boxes[i]!.x + boxes[i]!.width).toBeLessThanOrEqual(boxes[i + 1]!.x);
  const overnight = page.getByRole("button", { name: /^Overnight handoff/ });
  await expect(overnight).toHaveCSS("height", "48px"); // midnight → 1am, not a negative duration
  await page.screenshot({ path: testInfo.outputPath("calendar-overlap-desktop.png") });
});
