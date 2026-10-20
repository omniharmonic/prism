import { test, expect, type Page } from "@playwright/test";

/**
 * NP-AX-09 (settings half): Settings → Appearance → Language & region — Start week on, Date
 * format, Time format. Every date in the app is written by `@prism/core` `lib/datetime/format`,
 * which reads the choice; "system" for all three is what the app always showed. The pure module
 * is unit-tested across locales and DST in apps/server/test/datetime-format.test.ts; here the
 * setting is driven and real surfaces are read. (Database views are another track's follow-up.)
 */
const seed = (page: Page, region: Record<string, unknown>) =>
  page.addInitScript((value) => { if (!localStorage.getItem("prism:region")) localStorage.setItem("prism:region", JSON.stringify(value)); }, { ...region, at: 1 });
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("prism:region") || "null"));

async function openRegion(page: Page) {
  await page.waitForFunction(() => !!(window as any).prismFixtureUI);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  const group = dialog.getByTestId("region-settings");
  await expect(group.getByRole("heading", { name: "Language & region" })).toBeVisible();
  return group;
}

test("Settings → Appearance offers start of week, date format and time format; choices apply at once and survive a reload", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 4, 15, 5));
  await page.goto("/e2e-fixtures/workspace.html");
  const group = await openRegion(page);
  const week = group.getByRole("combobox", { name: "Start week on" });
  const date = group.getByRole("combobox", { name: "Date format" });
  const time = group.getByRole("combobox", { name: "Time format" });
  const sample = group.getByTestId("region-sample");

  // Nothing chosen: all three on System, nothing stored, the sample is the locale's own.
  await expect(week).toHaveValue("system");
  await expect(date).toHaveValue("system");
  await expect(time).toHaveValue("system");
  await expect(week.locator("option")).toHaveText([/^System locale \((Sunday|Monday|Saturday)\)$/, "Sunday", "Monday"]);
  await expect(date.locator("option")).toHaveText(["System", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "Oct 4, 2026"]);
  await expect(time.locator("option")).toHaveText(["System", "12-hour", "24-hour"]);
  expect(await stored(page)).toBeNull();
  await expect(sample).toHaveText(/^Oct 4, 2026 · 3:05\sPM$/);

  await date.selectOption("iso");
  await expect(sample).toHaveText(/^2026-10-04 · 3:05\sPM$/);
  await time.selectOption("24");
  await expect(sample).toHaveText("2026-10-04 · 15:05");
  await date.selectOption("dmy");
  await expect(sample).toHaveText("04/10/2026 · 15:05");
  await date.selectOption("mdy");
  await expect(sample).toHaveText("10/04/2026 · 15:05");
  await date.selectOption("long");
  await time.selectOption("12");
  await expect(sample).toHaveText(/^Oct 4, 2026 · 3:05\sPM$/);
  await week.selectOption("monday");
  expect(await stored(page)).toMatchObject({ weekStart: "monday", dateFormat: "long", timeFormat: "12" });

  await page.reload();
  const again = await openRegion(page);
  await expect(again.getByRole("combobox", { name: "Start week on" })).toHaveValue("monday");
  await expect(again.getByRole("combobox", { name: "Date format" })).toHaveValue("long");
  await expect(again.getByRole("combobox", { name: "Time format" })).toHaveValue("12");

  // Back to System removes the choice (not "stores system").
  await again.getByRole("combobox", { name: "Date format" }).selectOption("system");
  await again.getByRole("combobox", { name: "Time format" }).selectOption("system");
  await again.getByRole("combobox", { name: "Start week on" }).selectOption("system");
  const cleared = await stored(page);
  expect(Object.keys(cleared).sort()).toEqual(["at"]);
});

test.describe("calendar", () => {
  test.use({ timezoneId: "America/Denver" });
  const headers = (page: Page) => page.locator(".grid.grid-cols-7").first().locator("> div").allTextContents();
  const firstCell = (page: Page) => page.getByRole("button", { name: /^Select / }).first().getAttribute("aria-label");

  test("Start week on: the Calendar's month grid starts on the chosen day (System = the locale's)", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
    await page.goto("/e2e-fixtures/calendar.html");
    await expect(page.getByRole("button", { name: /^Select October 5, 2026$/ })).toBeVisible();
    // en-US, System: Sunday first, as before the setting existed. October 2026 starts on a Thursday.
    expect(await headers(page)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(await firstCell(page)).toBe("Select September 27, 2026");
  });

  test("Start week on Monday: headers, leading days and the week view all start on Monday", async ({ page }) => {
    await seed(page, { weekStart: "monday" });
    await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
    await page.goto("/e2e-fixtures/calendar.html");
    await expect(page.getByRole("button", { name: /^Select October 5, 2026$/ })).toBeVisible();
    expect(await headers(page)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(await firstCell(page)).toBe("Select September 28, 2026");
    // Every row is Monday…Sunday: the 7th cell is a Sunday.
    const labels = await page.getByRole("button", { name: /^Select / }).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")!.replace("Select ", "")));
    expect(labels.length % 7).toBe(0);
    expect(new Date(labels[0]).getDay()).toBe(1);
    expect(new Date(labels[6]).getDay()).toBe(0);
    expect(labels).toContain("October 31, 2026");
    expect(new Set(labels).size, "no day twice, none missing").toBe(labels.length);
  });

  test("Time format 24-hour: event times in the Calendar", async ({ page }) => {
    await seed(page, { timeFormat: "24" });
    await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
    await page.goto("/e2e-fixtures/calendar.html");
    await page.getByRole("button", { name: "Design review", exact: true }).first().click();
    const body = page.locator("body");
    await expect(body).toContainText("10:00 – 11:00"); // "10:00 AM – 11:00 AM" on System
    await expect(body).not.toContainText(/\d{1,2}:\d{2}\s?[AP]M/);
  });
});

test.describe("inbox", () => {
  const pin = async (page: Page) => { const at = new Date(); at.setHours(15, 0, 0, 0); await page.clock.setFixedTime(at); };
  const meta = (page: Page) => page.getByTestId("notifications-inbox").locator(".prism-inbox-meta").allTextContents();

  test("System: today's items show a locale time, older ones a short date (unchanged)", async ({ page }) => {
    await pin(page);
    await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
    await expect(page.getByTestId("notification-row").first()).toBeVisible();
    const labels = await meta(page);
    expect(labels.some((l) => /^\d{1,2}:\d{2}\s[AP]M$/.test(l)), labels.join(" | ")).toBe(true);
    expect(labels.some((l) => /^[A-Z][a-z]{2} \d{1,2}$/.test(l)), labels.join(" | ")).toBe(true);
  });

  test("Date format YYYY-MM-DD + 24-hour: the same rows follow the choice", async ({ page }) => {
    await seed(page, { dateFormat: "iso", timeFormat: "24" });
    await pin(page);
    await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
    await expect(page.getByTestId("notification-row").first()).toBeVisible();
    const labels = await meta(page);
    expect(labels.some((l) => /^\d{2}:\d{2}$/.test(l)), labels.join(" | ")).toBe(true);
    expect(labels.some((l) => /^\d{2}-\d{2}$/.test(l)), labels.join(" | ")).toBe(true);
    expect(labels.some((l) => /[AP]M|[A-Z][a-z]{2} \d/.test(l)), labels.join(" | ")).toBe(false);
  });
});
