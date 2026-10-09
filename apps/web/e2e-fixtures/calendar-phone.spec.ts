/**
 * The Calendar tool on a phone (the iOS app is a WKWebView around this UI). Owner report after the
 * first device run: "Calendar UX could use some work in the iOS app." What was wrong at 390 / 320:
 *  - the header wrapped differently per view (the arrows and Today moved with the title's length);
 *  - "Today" (and any chosen day) covered the calendar with a full-screen day-list sheet;
 *  - the month grid was 45 px chips reading "Des…", "We…" with 30 px targets;
 *  - a long location ran off the side of the event sheet; the sheet had two close buttons, a 42 px
 *    close target, 13 px checkboxes, a 32 px submit button, and no safe-area padding;
 *  - "+" on another day's Day view created the event on today;
 *  - the time grids' hour labels ignored the 24-hour setting.
 * Fixture only: `calendar.html?phone` and its FAKE live-actions client — nothing reaches a calendar.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const seed = (page: Page, region: Record<string, unknown>) =>
  page.addInitScript((value) => { if (!localStorage.getItem("prism:region")) localStorage.setItem("prism:region", JSON.stringify(value)); }, { ...region, at: 1 });

async function open(page: Page) {
  await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
  await page.goto("/e2e-fixtures/calendar.html?phone");
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Weekly standup").first()).toBeVisible();
}
const view = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const fixture = (page: Page) => page.evaluate(() => { const c = (window as any).prismCalendarFixture; return { creates: c.creates, rsvps: c.rsvps, deletes: c.deletes, updates: c.updates }; });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Calendar details" });

/** Every visible control inside `root`: its box, plus anything that is too small or pokes outside the screen. */
async function controls(root: Locator) {
  return root.evaluate((el) => {
    const out: { name: string; x: number; y: number; w: number; h: number; shown: boolean }[] = [];
    for (const c of Array.from(el.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, label:has(input[type=checkbox])"))) {
      if (c instanceof HTMLInputElement && c.type === "checkbox") continue; // measured through its label
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(c).visibility === "hidden") continue;
      // `shown`: not scrolled out under the sheet's fixed header (its box is still there, only clipped).
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      out.push({ name: (c.getAttribute("aria-label") || c.getAttribute("placeholder") || c.getAttribute("title") || c.textContent || c.tagName).trim().slice(0, 40), x: r.x, y: r.y, w: r.width, h: r.height, shown: !!top && (c.contains(top) || top.contains(c)) });
    }
    return out;
  });
}
const tooSmall = (list: Awaited<ReturnType<typeof controls>>) => list.filter((c) => c.h < 43.5 || c.w < 43.5).map((c) => `${c.name} ${Math.round(c.w)}×${Math.round(c.h)}`);
const outside = (list: Awaited<ReturnType<typeof controls>>, width: number) => list.filter((c) => c.x < -0.5 || c.x + c.w > width + 0.5).map((c) => `${c.name} ${Math.round(c.x)}…${Math.round(c.x + c.w)}`);
function overlapping(all: Awaited<ReturnType<typeof controls>>) {
  const hits: string[] = [];
  const list = all.filter((c) => c.shown);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) hits.push(`${a.name} × ${b.name}`);
  }
  return hits;
}

for (const [width, height] of [[390, 844], [320, 568]] as const) {
  test.describe(`phone ${width}`, () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width, height }, timezoneId: "America/Denver" });

    test("opens on the agenda; the header is two fixed rows in every view", async ({ page }) => {
      await open(page);
      await expect(view(page, "Agenda")).toHaveAttribute("aria-pressed", "true");
      const header = page.locator(".calendar-phone-header");
      const places: Record<string, string> = {};
      for (const name of ["Agenda", "Day", "Week", "Month"]) {
        await view(page, name).click();
        await expect(view(page, name)).toHaveAttribute("aria-pressed", "true");
        expect(await overflow(page), `${name}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
        const list = await controls(header);
        expect(list.map((c) => c.name)).toEqual(["Previous period", "Next period", "Create event", "Agenda", "Day", "Week", "Month", "Today"]);
        expect(tooSmall(list), `${name}: 44 px targets`).toEqual([]);
        expect(outside(list, width), `${name}: inside the screen`).toEqual([]);
        expect(overlapping(list), `${name}: no control over another`).toEqual([]);
        // ONE tab style (visual pass w14), and the controls do not move from view to view.
        await expect(view(page, name)).toHaveClass(/prism-tab/);
        // (A selected tab is semibold, so its neighbours may sit a pixel over: the buttons are what must not move.)
        places[name] = list.filter((c) => !["Agenda", "Day", "Week", "Month"].includes(c.name)).map((c) => `${Math.round(c.x)},${Math.round(c.y)}`).join(" ");
        expect((await header.boundingBox())!.height).toBeLessThanOrEqual(100);
      }
      expect(new Set(Object.values(places)).size, JSON.stringify(places)).toBe(1);
    });

    test("agenda: the week ahead as one list — today first, an empty day says so, a cancelled event is not listed", async ({ page }) => {
      await open(page);
      const agenda = page.getByTestId("calendar-agenda");
      await expect(agenda.getByRole("region")).toHaveCount(7);
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Oct 5 – 11");
      await expect(agenda.getByRole("heading").first()).toHaveText("Today · Mon, Oct 5");
      await expect(agenda.getByRole("heading").nth(1)).toHaveText("Tomorrow · Tue, Oct 6");
      const monday = agenda.getByRole("region", { name: "Monday, October 5" });
      // All-day first, then by start; overlapping events are simply consecutive rows.
      expect((await monday.getByRole("button").allTextContents()).map((t) => t.replace(/^.*?[AP]M – .*?[AP]M|^All day/, "").slice(0, 14))).toEqual(
        ["All-day worksh", "Weekly standup", "Quarterly bior", "Design review", "Overlapping A", "Overlapping B", "Design review", "Monthly review", "Evening call"]);
      await expect(agenda.getByText("Cancelled sync")).toHaveCount(0);
      await expect(agenda.getByRole("region", { name: "Thursday, October 8" })).toContainText("No events");
      await expect(agenda.getByRole("region", { name: "Thursday, October 8" }).getByRole("button")).toHaveCount(0);
      await expect(agenda.getByRole("button", { name: /Weekly standup/ })).toHaveCount(4); // the repeating one, per occurrence
      await expect(agenda.getByRole("region", { name: "Saturday, October 10" }).getByRole("button", { name: /Multi-day offsite/ })).toBeVisible();
      // The long title and the unbreakable location wrap inside the card.
      const list = await controls(agenda);
      expect(outside(list, width)).toEqual([]);
      expect(tooSmall(list)).toEqual([]);
      expect(overlapping(list)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // A period is seven days.
      await page.getByRole("button", { name: "Next period" }).click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Oct 12 – 18");
      await expect(agenda.getByRole("heading").first()).toHaveText("Mon, Oct 12");
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Oct 5 – 11");
    });

    test("Today moves the calendar and never covers it with a sheet; the day view says which day is today", async ({ page }) => {
      await open(page);
      await view(page, "Day").click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Today · Mon, Oct 5");
      await page.getByRole("button", { name: "Next period" }).click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Tue, Oct 6");
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Today · Mon, Oct 5");
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /All-day workshop/ })).toBeVisible();
    });

    test("month: every day is one 44 px target; the chosen day's events are listed under the grid", async ({ page }) => {
      await open(page);
      await view(page, "Month").click();
      const days = page.getByRole("button", { name: /^Select / });
      await expect(days).toHaveCount(35);
      const boxes = await days.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right }; }));
      for (const b of boxes) { expect(b.w).toBeGreaterThanOrEqual(43.5); expect(b.h).toBeGreaterThanOrEqual(44); expect(b.right).toBeLessThanOrEqual(width + 0.5); }
      await expect(page.getByRole("button", { name: "Select October 5, 2026, 9 events" })).toHaveAttribute("aria-pressed", "true"); // today until a day is chosen
      const list = page.getByRole("region", { name: "Events on the selected day" });
      await expect(list.getByRole("heading")).toHaveText("Today · Mon, Oct 5");
      await page.getByRole("button", { name: "Select October 20, 2026, 5 events" }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(list.getByRole("heading")).toHaveText("Tue, Oct 20");
      await expect(list.getByRole("button", { name: /Busy day item/ })).toHaveCount(5);
      await page.getByRole("button", { name: "Select October 8, 2026", exact: true }).click();
      await expect(list).toContainText("No events");
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // An event opens its sheet; closing it comes back to the same day.
      await page.getByRole("button", { name: "Select October 20, 2026, 5 events" }).click();
      await list.getByRole("button", { name: /Busy day item 3/ }).click();
      await expect(sheet(page)).toBeVisible();
      await page.getByRole("button", { name: "Close calendar details" }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(list.getByRole("heading")).toHaveText("Tue, Oct 20");
      // The day's own "+" starts an event on that day.
      await list.getByRole("button", { name: "Add event on this day" }).click();
      await expect(page.getByLabel("Event date")).toHaveValue("2026-10-20");
    });

    test("week: the grid is kept, opens on the morning, and a day header opens that day", async ({ page }) => {
      await open(page);
      await view(page, "Week").click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Oct 4 – 10");
      await expect(page.getByText("8a", { exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: /^Weekly standup/ }).first()).toBeInViewport();
      expect(await overflow(page)).toBeLessThanOrEqual(0); // the grid scrolls in its own area
      await page.getByRole("button", { name: "Open Tuesday, October 6" }).click();
      await expect(view(page, "Day")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Tue, Oct 6");
      await expect(page.getByRole("button", { name: /Lunch with Riley/ })).toBeVisible();
      await expect(sheet(page)).toHaveCount(0);
    });

    test("event sheet: nothing runs off the side, one close button, 44 px actions; RSVP and delete go through the fake client", async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: /Quarterly bioregional/ }).click();
      const dialog = sheet(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("Event");
      const box = (await dialog.boundingBox())!;
      expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, width, height]);
      // The sheet pads itself for the status bar / home bar (it is in the top layer, outside the shell's padding).
      expect(await dialog.evaluate((el) => el.innerHTML.includes("safe-area-inset-top") && el.innerHTML.includes("safe-area-inset-bottom"))).toBe(true);
      // No text or control past the right edge (the location is one long unbreakable link).
      const wide = await dialog.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>("*")).filter((n) => n.getBoundingClientRect().right > innerWidth + 0.5).map((n) => `${n.tagName} ${n.textContent?.slice(0, 30)}`));
      expect(wide).toEqual([]);
      expect(await dialog.locator(".calendar-details-body").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      await expect(dialog.getByRole("button", { name: /^Close/ })).toHaveCount(1);
      await expect(dialog.getByRole("button", { name: "Close calendar details" })).toBeInViewport();

      await dialog.getByRole("button", { name: "Delete event" }).click();
      const confirm = dialog.getByRole("alertdialog", { name: "Confirm delete" });
      await confirm.scrollIntoViewIfNeeded();
      const list = await controls(dialog);
      expect(tooSmall(list)).toEqual([]);
      expect(outside(list, width)).toEqual([]);
      expect(overlapping(list)).toEqual([]);
      // The header stays while the body scrolls.
      await expect(dialog.getByRole("button", { name: "Close calendar details" })).toBeInViewport();

      await dialog.getByRole("button", { name: "Maybe", exact: true }).click();
      await expect(dialog).toContainText("Marked tentative");
      await confirm.getByRole("checkbox").uncheck();
      await expect(confirm).toContainText("Don't email guests");
      await confirm.getByRole("button", { name: "Delete this occurrence" }).click();
      await expect(dialog).toHaveCount(0);
      expect(await fixture(page)).toMatchObject({ rsvps: [{ eventId: "long-event", response: "tentative" }], deletes: [{ eventId: "long-event", notify: false }], creates: [], updates: [] });
    });

    test("a repeating series asks again before deleting every occurrence", async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: /Monthly review/ }).click();
      const dialog = sheet(page);
      await dialog.getByRole("button", { name: "Delete event" }).click();
      await dialog.getByRole("button", { name: "Delete this occurrence" }).click();
      const all = dialog.getByTestId("delete-all-occurrences");
      await all.scrollIntoViewIfNeeded();
      await expect(all).toBeInViewport({ ratio: 1 });
      expect(tooSmall(await controls(dialog.getByRole("alertdialog")))).toEqual([]);
      expect(outside(await controls(dialog), width)).toEqual([]);
      expect((await fixture(page)).deletes).toEqual([{ eventId: "series-master", notify: true }]);
      await all.click();
      await expect(dialog).toHaveCount(0);
      expect((await fixture(page)).deletes).toEqual([{ eventId: "series-master", notify: true }, { eventId: "series-master", notify: true, scope: "all" }]);
    });

    test("new event: the form is inside the screen, 16 px inputs, 44 px targets, and is for the day on screen", async ({ page }) => {
      await open(page);
      await view(page, "Day").click();
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next period" }).click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Thu, Oct 8");
      await expect(page.getByText("No events for this day.")).toBeVisible();
      await page.getByRole("button", { name: "Create event" }).click();
      const dialog = sheet(page);
      await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("New event");
      await expect(dialog.getByRole("button", { name: /^Close/ })).toHaveCount(1);
      await expect(dialog.getByLabel("Event date")).toHaveValue("2026-10-08"); // was today's date
      await dialog.getByPlaceholder("Event title").fill("Walk");
      await dialog.getByPlaceholder(/Attendees/).fill("morgan@example.test");
      const list = await controls(dialog);
      expect(tooSmall(list)).toEqual([]);
      expect(outside(list, width)).toEqual([]);
      expect(overlapping(list)).toEqual([]);
      const fonts = await dialog.locator("input:not([type=checkbox]), textarea").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
      expect(fonts.length).toBe(7);
      for (const size of fonts) expect(size).toBeGreaterThanOrEqual(16);
      // The whole form is reachable above the bottom edge: the sheet is the screen, its body scrolls.
      const box = (await dialog.boundingBox())!;
      expect(box.y).toBe(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      const submit = dialog.getByRole("button", { name: "Create Event" });
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeInViewport({ ratio: 1 });
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await submit.click();
      await expect(dialog).toHaveCount(0);
      const { creates } = await fixture(page);
      expect(creates).toEqual([{ title: "Walk", start: "2026-10-08T15:00:00.000Z", end: "2026-10-08T16:00:00.000Z", attendees: ["morgan@example.test"], notify: true }]);
    });

    test("edit: the form opens in the same sheet and Escape returns to the calendar", async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: /Quarterly bioregional/ }).click();
      const dialog = sheet(page);
      await dialog.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("Edit event");
      await expect(dialog.getByPlaceholder("Event title")).toHaveValue(/^Quarterly bioregional/);
      // Edit is at the bottom of a long event; the form still opens at its top.
      expect(await dialog.locator(".calendar-details-body").evaluate((el) => el.scrollTop)).toBe(0);
      const list = await controls(dialog);
      expect(tooSmall(list)).toEqual([]);
      expect(outside(list, width)).toEqual([]);
      expect(overlapping(list)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(view(page, "Agenda")).toHaveAttribute("aria-pressed", "true");
      expect((await fixture(page)).updates).toEqual([]);
    });

    test("regional preferences: Monday first and 24-hour times, in the list, the month and the week grid", async ({ page }) => {
      await seed(page, { weekStart: "monday", timeFormat: "24" });
      await open(page);
      const agenda = page.getByTestId("calendar-agenda");
      await expect(agenda.getByRole("button", { name: /Lunch with Riley/ })).toContainText("12:00 – 13:00");
      await expect(agenda).not.toContainText(/\d\s?[AP]M/);
      await view(page, "Month").click();
      expect(await page.locator(".grid.grid-cols-7").first().locator("> div").allTextContents()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
      expect(await page.getByRole("button", { name: /^Select / }).first().getAttribute("aria-label")).toBe("Select September 28, 2026");
      await view(page, "Week").click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Oct 5 – 11");
      await expect(page.getByText("13:00", { exact: true }).first()).toBeAttached(); // the hour label; was "1p" for everyone
      await expect(page.getByText("23:00", { exact: true })).toHaveCount(1);
      await expect(page.getByText(/^\d{1,2}[ap]$/)).toHaveCount(0);
    });
  });
}

test.describe("desktop is unchanged", () => {
  test.use({ viewport: { width: 1280, height: 800 }, timezoneId: "America/Denver" });

  test("month by default, the wrapping header and its three views, the side panel for a day", async ({ page }) => {
    await open(page);
    await expect(page.locator(".calendar-phone-header")).toHaveCount(0);
    await expect(view(page, "Agenda")).toHaveCount(0);
    await expect(page.getByTestId("calendar-agenda")).toHaveCount(0);
    await expect(view(page, "Month")).toHaveAttribute("aria-pressed", "true");
    await expect(view(page, "Month")).not.toHaveClass(/prism-tab/);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("October 2026");
    // The grid with its chips, as before.
    await expect(page.getByRole("button", { name: "Select October 5, 2026", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "+6 more" })).toBeVisible();
    await page.getByRole("button", { name: "Select October 20, 2026", exact: true }).click();
    await expect(sheet(page)).toHaveCount(0);
    const aside = page.locator("aside");
    await expect(aside).toContainText("Tuesday, October 20");
    await expect(aside.getByRole("button", { name: /Busy day item/ })).toHaveCount(5);
    // "Today" selects today in the side panel, as before.
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(aside).toContainText("Monday, October 5");
    // The form keeps its own header and close button there.
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(aside.getByRole("heading", { name: "New Event" })).toBeVisible();
    await expect(aside.getByRole("button", { name: "Close event details" })).toBeVisible();
    await expect(aside.getByLabel("Event date")).toHaveValue("2026-10-05");
    const sizes = await aside.locator("input:not([type=checkbox]), textarea, button").evaluateAll((els) => els.map((el) => `${el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent}: ${Math.round(el.getBoundingClientRect().height)}`));
    // Measured on the code before the phone pass: the touch sizes are `coarse:` only.
    expect(sizes).toEqual(["Close event details: 30", "Event title: 35", "Event date: 39", "Start time: 39", "End time: 39", "Location: 35", "Attendees (comma-separated emails): 35", "Description (optional): 77", "Create Event: 37"]);
  });

  test("time grids keep their short hour labels on System; week and day titles as before", async ({ page }) => {
    await open(page);
    await view(page, "Week").click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Week of Oct 4");
    await expect(page.getByText("1p", { exact: true })).toHaveCount(1);
    await view(page, "Day").click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Monday, October 5, 2026");
    await expect(page.getByText("1 PM", { exact: true })).toHaveCount(1);
    await expect(page.getByText("12 AM", { exact: true })).toHaveCount(1);
  });
});
