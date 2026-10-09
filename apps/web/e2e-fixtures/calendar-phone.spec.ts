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
        expect(list.map((c) => c.name)).toEqual(["Refresh calendar", "Previous period", "Next period", "Create event", "Agenda", "Day", "Week", "Month", "Today"]);
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

      // RSVP is near the top — after the time and place, before the guests, notes, transcripts and Delete —
      // and on a phone it is on screen as the event opens.
      const order = await dialog.evaluate((el) => {
        const y = (n: Element | null | undefined) => (n ? Math.round(n.getBoundingClientRect().top) : NaN);
        const text = (t: string) => Array.from(el.querySelectorAll("span, div")).find((n) => n.children.length === 0 && n.textContent?.trim().startsWith(t));
        return { time: y(text("9:00 AM")), place: y(text("Conference room B")), rsvp: y(el.querySelector("[data-testid=event-rsvp]")), guests: y(text("Attendees")), notes: y(text("Agenda:")), transcripts: y(el.querySelector("[aria-label='Meeting transcripts']")), remove: y(el.querySelector("[aria-label='Delete event']")) };
      });
      expect(Object.entries(order).sort((a, b) => a[1] - b[1]).map(([k]) => k), JSON.stringify(order)).toEqual(["time", "place", "rsvp", "guests", "notes", "transcripts", "remove"]);
      await expect(dialog.getByTestId("event-rsvp").getByRole("button", { name: "Yes", exact: true })).toBeInViewport({ ratio: 1 });

      await dialog.getByRole("button", { name: "Maybe", exact: true }).click();
      await expect(dialog.getByTestId("event-rsvp")).toContainText("Marked tentative");
      await dialog.getByRole("button", { name: "Delete event" }).click();
      const confirm = dialog.getByRole("alertdialog", { name: "Confirm delete" });
      await confirm.scrollIntoViewIfNeeded();
      const list = await controls(dialog);
      expect(tooSmall(list)).toEqual([]);
      expect(outside(list, width)).toEqual([]);
      expect(overlapping(list)).toEqual([]);
      // The header stays while the body scrolls.
      await expect(dialog.getByRole("button", { name: "Close calendar details" })).toBeInViewport();

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

/**
 * Owner report from the real phone: "Events loading slowly with two loading animations" — the Day
 * view said "No events for this day." under a sync icon AND a spinner. Every day/week/view change
 * was a new query (the whole `meeting` listing again, the screen emptied meanwhile) plus a Google
 * sync on the server (`gog`, seconds), and a finished sync listed everything a second time.
 * Here the vault listing and the sync are FAKES with a delay (`calendar.tsx`): `list` / `sync` ms.
 */
const loading = (page: Page) => page.evaluate(() => { const c = (window as any).prismCalendarFixture; return { lists: c.lists as number, syncs: c.syncs as { from: string; to: string }[] }; });
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh calendar" });
/** Everything on the page that says "working": busy regions and anything spinning. */
const indicators = (page: Page) => page.evaluate(() => ({
  busy: document.querySelectorAll("[aria-busy=true]").length,
  spinning: Array.from(document.querySelectorAll<HTMLElement>(".animate-spin")).filter((el) => el.getBoundingClientRect().width > 0).length,
  named: Array.from(document.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label")!).filter((n) => /sync|loading/i.test(n)),
}));
async function openWith(page: Page, params: string) {
  await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
  await page.goto(`/e2e-fixtures/calendar.html?phone&${params}`);
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
}

for (const [label, viewport, mobile] of [["phone", { width: 390, height: 844 }, true], ["desktop", { width: 1280, height: 800 }, false]] as const) {
  test.describe(`loading (${label})`, () => {
    test.use({ viewport, timezoneId: "America/Denver", ...(mobile ? { hasTouch: true, isMobile: true } : {}) });

    test("events already in the vault show at once while a slow sync runs behind them, with ONE indicator", async ({ page }) => {
      await openWith(page, "sync=4000&syncadds");
      // The sync takes four seconds; the events are there long before it answers.
      await expect(page.getByText("Weekly standup").first()).toBeVisible({ timeout: 1500 });
      await expect(refresh(page)).toHaveAttribute("aria-busy", "true");
      expect(await indicators(page)).toEqual({ busy: 1, spinning: 1, named: [] });
      expect((await loading(page)).syncs).toHaveLength(1);
      await expect(page.getByText("Synced later")).toHaveCount(0);
      // When it finishes, what it brought merges in and the indicator rests.
      await expect(page.getByText("Synced later").first()).toBeVisible({ timeout: 8000 });
      await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
      expect(await indicators(page)).toEqual({ busy: 0, spinning: 0, named: [] });
      await expect(page.getByText("Weekly standup").first()).toBeVisible();
    });

    test("nothing says a day is empty until the load has finished", async ({ page }) => {
      await openWith(page, "list=1500&sync=200");
      await view(page, "Day").click();
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next period" }).click(); // Thu, Oct 8: no events
      await expect(refresh(page)).toHaveAttribute("aria-busy", "true");
      await expect(page.getByText(/No events/)).toHaveCount(0);
      expect(await indicators(page)).toEqual({ busy: 1, spinning: 1, named: [] });
      if (mobile) {
        await expect(page.getByTestId("calendar-skeleton")).toBeVisible();
        await view(page, "Agenda").click();
        await expect(page.getByTestId("calendar-agenda").getByRole("region")).toHaveCount(7);
        await expect(page.getByText(/No events/)).toHaveCount(0);
        await view(page, "Month").click();
        await expect(page.getByText(/No events/)).toHaveCount(0);
        await view(page, "Day").click();
        for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next period" }).click();
        await expect(page.getByRole("heading", { level: 2 })).toHaveText("Thu, Oct 8");
        // Loaded: now the empty day says so, and the placeholder is gone.
        await expect(page.getByText("No events for this day.")).toBeVisible();
        await expect(page.getByTestId("calendar-skeleton")).toHaveCount(0);
      } else {
        await page.getByRole("button", { name: "Month", exact: true }).click();
        await page.getByRole("button", { name: "Select October 8, 2026", exact: true }).click();
        await expect(page.locator("aside")).toContainText("Thursday, October 8");
        await expect(page.getByText(/No events/)).toHaveCount(0);
        await expect(page.locator("aside")).toContainText("No events");
      }
      await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
    });

    test("moving between days, weeks and views asks for nothing again; a range never ingested is synced once", async ({ page }) => {
      await openWith(page, "sync=50");
      await expect(page.getByText("Weekly standup").first()).toBeVisible();
      await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
      await view(page, "Day").click();
      await page.getByRole("button", { name: "Next period" }).click();
      // Tuesday's events are on screen with the tap itself (no waiting here): there is no request behind it.
      expect(await page.getByRole("button", { name: /Partner call/ }).count()).toBe(1);
      for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Next period" }).click();
      await view(page, "Week").click();
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await page.waitForTimeout(1200); // longer than the settle delay of a navigation sync
      expect(await loading(page)).toMatchObject({ lists: 1, syncs: [{}] }); // one listing, the one sync of the open
      expect(await indicators(page)).toEqual({ busy: 0, spinning: 0, named: [] });

      // Two months ahead is outside what the server ingests on its own: synced once, after the taps settle.
      await view(page, "Month").click();
      await page.getByRole("button", { name: "Next period" }).click();
      await page.getByRole("button", { name: "Next period" }).click();
      await expect.poll(async () => (await loading(page)).syncs.length).toBe(2);
      expect((await loading(page)).syncs[1].from).toMatch(/^2026-1[12]-/);
      await page.getByRole("button", { name: "Previous period" }).click();
      await page.getByRole("button", { name: "Next period" }).click();
      await page.waitForTimeout(1200);
      expect((await loading(page)).syncs).toHaveLength(2); // the same range again, inside the throttle window

      // The indicator is the refresh button: a tap re-reads the vault and syncs what is on screen.
      await refresh(page).click();
      await expect.poll(async () => (await loading(page)).syncs.length).toBe(3);
      await expect.poll(async () => (await loading(page)).lists).toBe(2);
      await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
    });

    test("a failed sync keeps the events and leaves one small notice", async ({ page }) => {
      await openWith(page, "sync=300&syncfail");
      await expect(page.getByText("Weekly standup").first()).toBeVisible();
      const notice = page.getByTestId("calendar-sync-notice");
      await expect(notice).toHaveText("Couldn't reach Google Calendar — showing saved events.");
      await expect(page.getByText("Weekly standup").first()).toBeVisible();
      await expect(refresh(page)).toHaveAttribute("aria-busy", "false");
      expect((await notice.boundingBox())!.height).toBeLessThan(40);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // It clears when a later sync works.
      await page.evaluate(() => { (window as any).prismCalendarFixture.syncFail = false; });
      await refresh(page).click();
      await expect(notice).toHaveCount(0);
      await expect(page.getByText("Weekly standup").first()).toBeVisible();
    });
  });
}

test.describe("desktop is unchanged", () => {
  test.use({ viewport: { width: 1280, height: 800 }, timezoneId: "America/Denver" });

  test("event panel: RSVP sits after the time and place, above the guests, in the side panel", async ({ page }) => {
    await open(page);
    await view(page, "Day").click(); // the month cell shows three chips; this one is under "+6 more"
    await page.getByRole("button", { name: /^Quarterly bioregional/ }).first().click();
    const aside = page.locator("aside");
    const rsvp = aside.getByTestId("event-rsvp");
    await expect(rsvp.getByRole("button")).toHaveText(["Yes", "Maybe", "No"]);
    const top = async (l: Locator) => (await l.boundingBox())!.y;
    expect(await top(rsvp)).toBeGreaterThan(await top(aside.getByText(/^Conference room B/)));
    expect(await top(rsvp)).toBeLessThan(await top(aside.getByText("Attendees", { exact: true })));
    expect(await top(rsvp)).toBeLessThan(await top(aside.getByRole("button", { name: "Delete event" })));
    // The panel keeps its width and nothing runs out of it.
    const box = (await aside.boundingBox())!;
    const r = (await rsvp.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(box.x);
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width);
    expect(await aside.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await rsvp.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(rsvp).toContainText("Accepted");
    expect((await fixture(page)).rsvps).toEqual([{ eventId: "long-event", response: "accepted" }]);
  });

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
