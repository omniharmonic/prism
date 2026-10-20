/**
 * The meeting listing is ONE query shared by the Calendar tool, Home, the dashboard widget, the
 * sidebar's CalendarMini and the event page (`lib/calendar/meetingListing.ts`), and its last answer
 * is kept on the device so a cold start shows events at once and refreshes behind them.
 *
 * What these tests hold: the device copy is on screen before the vault answers and is REPLACED by
 * the fresh listing (a deleted event goes); a failed refresh keeps it and says so; it never says a
 * day is empty; another account / vault never sees it; nobody signed in keeps nothing; a refused
 * listing removes it; it is bounded in size, window, age and number of accounts; sign-out clears it.
 * Fixture only (`calendar.html`, a FAKE vault client with a delay) — nothing leaves the page.
 */
import { test, expect, type Page } from "@playwright/test";

const PREFIX = "prism:calendar-listing:";
const KEY = `${PREFIX}calendar-fixture-owner-vault`;
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh calendar" });
const lists = (page: Page) => page.evaluate(() => (window as any).prismCalendarFixture.lists as number);
const keys = (page: Page) => page.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)).sort(), PREFIX);
const stored = (page: Page, key = KEY) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null") as { v: number; at: number; events: { vaultNoteId: string; summary: string; description?: string | null; start: { dateTime?: string | null; date?: string | null } }[] } | null, key);
const release = (page: Page) => page.evaluate(() => (window as any).prismCalendarFixture.release());
const agenda = (page: Page) => page.getByTestId("calendar-agenda");

async function open(page: Page, params = "") {
  await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
  await page.goto(`/e2e-fixtures/calendar.html?phone&${params}`);
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
}
/** A first visit: the vault answers and the listing is written to the device. */
async function visitOnce(page: Page, params = "") {
  await open(page, params);
  await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toBeVisible();
  await expect.poll(async () => (await stored(page, params.includes("scope=") ? `${PREFIX}${new URLSearchParams(params).get("scope")}` : KEY))?.events.length ?? 0).toBeGreaterThan(10);
}

// Each test here starts the app two or three times (that is what a cold start is): three page
// loads do not fit the default 30 s when the fixture server is still compiling its first page.
test.describe.configure({ timeout: 90_000 });

test.describe("the last listing on this device (phone)", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, timezoneId: "America/Denver" });

  test("cold start: saved events are on screen before the vault answers, then the fresh listing replaces them", async ({ page }) => {
    await visitOnce(page);
    // The app is started again. The vault has lost "Partner call" and renamed "Planning", and does not answer yet.
    await open(page, "hold&gone=tue-a&retitle=wed-a:Planning%20(moved)");
    // "Partner call" exists only in the device copy: seeing it means the copy was drawn.
    await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toBeVisible();
    await expect(agenda(page).getByRole("button", { name: /Weekly standup/ })).toHaveCount(4);
    await expect(refresh(page)).toHaveAttribute("aria-busy", "true");
    expect(await lists(page)).toBe(1); // asked once, not answered yet
    // The copy never says a day is empty (Thursday has no events in it either).
    await expect(page.getByText(/No events/)).toHaveCount(0);
    await expect(page.getByTestId("calendar-skeleton")).toHaveCount(0);
    // The vault answers: the deleted event disappears, the renamed one changes, the empty day says so.
    await release(page);
    await expect(agenda(page).getByRole("button", { name: /Planning \(moved\)/ })).toBeVisible();
    await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toHaveCount(0);
    await expect(agenda(page).getByRole("region", { name: "Thursday, October 8" })).toContainText("No events");
    await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
    expect(await lists(page)).toBe(1);
    // …and the device copy is the fresh listing too.
    await expect.poll(async () => (await stored(page))!.events.map((e) => e.summary).includes("Planning (moved)")).toBe(true);
    expect((await stored(page))!.events.map((e) => e.vaultNoteId)).not.toContain("tue-a");
  });

  test("cold start: an open event from the saved copy follows the fresh listing, and closes when the vault no longer has it", async ({ page }) => {
    await visitOnce(page);
    await open(page, "hold&gone=tue-a&retitle=wed-a:Planning%20(moved)");
    await agenda(page).getByRole("button", { name: /Planning/ }).click();
    const sheet = page.getByRole("dialog", { name: "Calendar details" });
    await expect(sheet).toContainText("Planning");
    await expect(sheet).not.toContainText("Planning (moved)");
    await release(page);
    await expect(sheet).toContainText("Planning (moved)");
    await sheet.getByRole("button", { name: "Close calendar details" }).click();

    await open(page, "hold&gone=wed-a");
    await agenda(page).getByRole("button", { name: /Planning \(moved\)/ }).click();
    await expect(sheet).toContainText("Planning (moved)");
    await release(page);
    await expect(sheet).toHaveCount(0);
    await expect(agenda(page).getByRole("button", { name: /Planning/ })).toHaveCount(0);
  });

  test("a refresh that fails keeps the saved events, says it is not connected, and calls no day empty", async ({ page }) => {
    await visitOnce(page);
    await open(page, "hold&listfail");
    await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toBeVisible();
    await expect(refresh(page)).toHaveAttribute("aria-busy", "true");
    await release(page);
    await expect(page.getByRole("status").filter({ hasText: "Not connected" })).toBeVisible({ timeout: 15_000 });
    await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
    await expect(agenda(page).getByRole("button", { name: /Weekly standup/ })).toHaveCount(4);
    await expect(page.getByText(/No events/)).toHaveCount(0);
    await expect(agenda(page).getByRole("region", { name: "Thursday, October 8" })).toContainText("Couldn't load");
    expect((await stored(page))!.events.length).toBeGreaterThan(10); // still on the device for the next start
    // It recovers from the same button.
    await page.evaluate(() => { (window as any).prismCalendarFixture.listFail = false; });
    await refresh(page).click();
    await expect(agenda(page).getByRole("region", { name: "Thursday, October 8" })).toContainText("No events");
    await expect(page.getByText("Not connected")).toHaveCount(0);
  });

  test("another account or vault never sees it, and nobody signed in keeps nothing", async ({ page }) => {
    await visitOnce(page);
    // Another account + vault on the same device: nothing until ITS vault answers.
    await open(page, "scope=someone-else-other-vault&hold");
    await expect(refresh(page)).toHaveAttribute("aria-busy", "true");
    await expect(agenda(page).getByRole("region")).toHaveCount(7);
    await expect(agenda(page).getByRole("button")).toHaveCount(0);
    await release(page);
    await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toBeVisible();
    await expect.poll(() => keys(page)).toEqual([KEY, `${PREFIX}someone-else-other-vault`].sort());
    // No account (signed out / a share-link viewer / the legacy desktop): nothing is read…
    await open(page, "scope=&hold");
    await expect(refresh(page)).toHaveAttribute("aria-busy", "true");
    await expect(agenda(page).getByRole("region")).toHaveCount(7);
    await expect(agenda(page).getByRole("button")).toHaveCount(0);
    await release(page);
    await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toBeVisible();
    // …and nothing is written.
    await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
    expect(await keys(page)).toEqual([KEY, `${PREFIX}someone-else-other-vault`].sort());
  });

  test("a listing the server refuses removes the saved copy and stops showing it", async ({ page }) => {
    await visitOnce(page);
    await open(page, "hold&denied");
    await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toBeVisible();
    await release(page);
    await expect.poll(() => keys(page), { timeout: 15_000 }).toEqual([]);
    await expect(agenda(page).getByRole("button")).toHaveCount(0);
    await expect(agenda(page).getByRole("region", { name: "Monday, October 5" })).toContainText("Couldn't load");
    await expect(page.getByText(/No events/)).toHaveCount(0);
  });

  test("the saved copy is bounded: near today only, a capped number of events and characters, no long descriptions, not kept past its age", async ({ page }) => {
    await open(page, "many=3000");
    await expect(agenda(page).getByRole("button", { name: /Bulk meeting/ }).first()).toBeVisible();
    await expect.poll(async () => (await stored(page))?.events.length ?? 0).toBeGreaterThan(0);
    const bounds = await page.evaluate(() => { const m = (window as any).prismMeetingListing; return { events: m.MEETING_LISTING_MAX_EVENTS as number, chars: m.MEETING_LISTING_MAX_CHARS as number, back: m.MEETING_LISTING_DAYS_BACK as number, ahead: m.MEETING_LISTING_DAYS_AHEAD as number, description: m.MEETING_LISTING_MAX_DESCRIPTION as number, age: m.MEETING_LISTING_MAX_AGE_MS as number, scopes: m.MEETING_LISTING_MAX_SCOPES as number }; });
    expect(bounds).toEqual({ events: 400, chars: 200_000, back: 31, ahead: 92, description: 2000, age: 7 * 86_400_000, scopes: 4 });
    const copy = (await stored(page))!;
    const raw = await page.evaluate((k) => localStorage.getItem(k)!.length, KEY);
    // The vault listed more than 3000 meetings over two years, most with a long description.
    expect(copy.events.length).toBeLessThanOrEqual(bounds.events);
    expect(copy.events.length).toBeGreaterThan(50);
    expect(raw).toBeLessThanOrEqual(bounds.chars);
    const now = Date.parse("2026-10-05T16:00:00Z");
    const day = 86_400_000;
    for (const e of copy.events) {
      const at = Date.parse((e.start.dateTime ?? e.start.date)!);
      expect(at, e.summary).toBeGreaterThan(now - (bounds.back + 1) * day);
      expect(at, e.summary).toBeLessThan(now + (bounds.ahead + 1) * day);
      expect((e.description ?? "").length, e.summary).toBeLessThanOrEqual(bounds.description);
    }
    // Nearest first: today's events are in it whatever else had to go.
    expect(copy.events.map((e) => e.summary)).toContain("Weekly standup");

    // Older than its age: not shown, and deleted when it is found.
    await page.evaluate(({ k, age }) => { const v = JSON.parse(localStorage.getItem(k)!); localStorage.setItem(k, JSON.stringify({ ...v, at: Date.now() - age - 60_000 })); }, { k: KEY, age: bounds.age });
    await open(page, "hold");
    await expect(refresh(page)).toHaveAttribute("aria-busy", "true");
    await expect(agenda(page).getByRole("region")).toHaveCount(7);
    await expect(agenda(page).getByRole("button")).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
    await release(page);
    await expect(agenda(page).getByRole("button", { name: /Partner call/ })).toBeVisible();

    // A copy somebody made larger than the bound, or dated in the future, is not trusted either.
    expect(await page.evaluate(({ k, max }) => {
      const m = (window as any).prismMeetingListing;
      const event = { id: "x", vaultNoteId: "x", summary: "x", start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } };
      localStorage.setItem(k, JSON.stringify({ v: 1, at: Date.now(), events: Array.from({ length: max + 1 }, () => event) }));
      const tooMany = m.readStoredMeetings("calendar-fixture-owner-vault");
      localStorage.setItem(k, JSON.stringify({ v: 1, at: Date.now() + 3_600_000, events: [event] }));
      const future = m.readStoredMeetings("calendar-fixture-owner-vault");
      return { tooMany, future, left: localStorage.getItem(k) };
    }, { k: KEY, max: bounds.events })).toEqual({ tooMany: null, future: null, left: null });

    // At most four accounts/vaults keep a copy on one device: the newest.
    expect(await page.evaluate((prefix) => {
      const m = (window as any).prismMeetingListing;
      for (let i = 0; i < 7; i++) m.storeMeetings(`account-${i}`, [], Date.now() - (7 - i) * 1000);
      return Object.keys(localStorage).filter((k) => k.startsWith(prefix)).sort();
    }, PREFIX)).toEqual([3, 4, 5, 6].map((i) => `${PREFIX}account-${i}`));
  });

  test("the host's sign-out announcement clears every account's copy", async ({ page }) => {
    await visitOnce(page);
    await page.evaluate(() => (window as any).prismMeetingListing.storeMeetings("another-account", []));
    expect((await keys(page)).length).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new Event("prism:signed-out")));
    expect(await keys(page)).toEqual([]);
  });
});

test.describe("one listing for every surface", () => {
  test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Denver" });

  test("Home, the sidebar calendar, the dashboard widget, the event page and the Calendar tool make ONE request between them", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
    await page.goto("/e2e-fixtures/calendar.html?phone&surfaces&list=400");
    // Each surface shows today's events out of the same listing.
    await expect(page.getByRole("region", { name: "Sidebar calendar" })).toContainText("Weekly standup");
    await expect(page.getByRole("region", { name: "Dashboard calendar widget" })).toContainText("Weekly standup");
    await expect(page.getByRole("region", { name: "Upcoming" })).toContainText("Evening call");
    await expect(page.getByRole("region", { name: "Event page" })).toContainText("Weekly standup");
    await expect(page.getByRole("button", { name: "Select October 5, 2026", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Weekly standup" }).first()).toBeVisible();
    await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
    expect(await lists(page)).toBe(1);
    // The widgets used to list "today" only: an event on another day is not in them.
    await expect(page.getByRole("region", { name: "Dashboard calendar widget" })).not.toContainText("Partner call");
    await expect(page.getByRole("region", { name: "Sidebar calendar" })).not.toContainText("Partner call");
    // Moving the event page to another week and the Calendar to another month asks for nothing more.
    await page.getByRole("button", { name: "Next period" }).click();
    await page.waitForTimeout(500);
    expect(await lists(page)).toBe(1);
    // One refresh re-reads it once, for all of them.
    await refresh(page).click();
    await expect.poll(() => lists(page)).toBe(2);
    await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
    expect(await lists(page)).toBe(2);
  });
});
