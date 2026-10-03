import { test, expect, type Page } from "@playwright/test";

/** Home (NP-SB-03): recents, upcoming reminders + events, open tasks, mentions, quick create. */
const SHOTS = process.env.INBOX_SHOTS;
const url = (q = "") => `/e2e-fixtures/notion-inbox.html${q}`;
const home = (page: Page) => page.getByTestId("home");
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

// The fixtures seed items relative to "now" ("20 minutes ago" must be today, "26 hours ago" yesterday), so run
// every test at 15:00 local on the current day — otherwise the grouping changes around midnight.
test.beforeEach(async ({ page }) => {
  const pinAfternoon = new Date(); pinAfternoon.setHours(15, 0, 0, 0);
  await page.clock.setFixedTime(pinAfternoon); // fixes Date only; timers keep running natively
});

test("home shows recents, upcoming events, my tasks", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // "Start with last open document" off → the app launches on Home.
  await page.addInitScript(() => localStorage.setItem("prism-settings", JSON.stringify({ state: { startWithLastDocument: false }, version: 0 })));
  await page.goto(url("?reset"));
  await expect(home(page)).toBeVisible();
  await expect(home(page).getByRole("heading", { level: 1 })).toHaveText(/Good (morning|afternoon|evening)/);

  const recents = home(page).getByRole("region", { name: "Recently visited" });
  await expect(recents.getByRole("button", { name: "Roadmap" })).toBeVisible();
  await expect(recents.getByRole("button", { name: "Launch plan" })).toBeVisible();

  const upcoming = home(page).getByRole("region", { name: "Upcoming" });
  await expect(upcoming.getByRole("button", { name: /Design sync/ })).toContainText("Tomorrow");
  await expect(upcoming.locator('[data-kind="reminder"]')).toContainText("Roadmap");
  await expect(upcoming).not.toContainText("Old retro");

  const tasks = home(page).getByRole("region", { name: "My tasks" });
  await expect(tasks.getByRole("button", { name: /Write release notes/ })).toBeVisible();
  await expect(tasks.getByRole("button", { name: /Review access requests/ })).toBeVisible();
  await expect(tasks).not.toContainText("Old cleanup");
  // Wave 3: only tasks assigned to the viewer (resolved server-side through /api/query).
  await expect(tasks).toHaveAttribute("data-scope", "assigned");
  await expect(tasks).not.toContainText("Order catering");
  expect(await page.evaluate(() => (window as any).prismQueries?.some((q: { assignedToMe?: boolean; tags: string[] }) => q.assignedToMe === true && q.tags[0] === "task"))).toBe(true);

  const mentions = home(page).getByRole("region", { name: "Mentions of you" });
  await expect(mentions.getByRole("button", { name: /Ada Park · Roadmap/ })).toBeVisible();
  await expect(home(page).getByRole("button", { name: "Inbox · 2 unread" })).toBeVisible();
  await shot(page, "home-1440-light");

  // Quick create: one action → an "Untitled" page with its title focused (NP-SB-13, wave 2E).
  await home(page).getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Document title" })).toHaveValue("Untitled");
  await page.keyboard.press("Escape");
  await page.locator(".workspace-navigation").first().getByRole("button", { name: "Home", exact: true }).click();

  // Recents open the page.
  await recents.getByRole("button", { name: "Field notes" }).click();
  await expect(page.locator("#workspace-document")).toContainText("River survey");

  // Phone layout: one column, no horizontal scroll.
  await page.locator(".workspace-navigation").first().getByRole("button", { name: "Home", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(home(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await shot(page, "home-390-light");
});

test("my tasks: an older server (no assignedToMe) keeps the list of every open task", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("prism-settings", JSON.stringify({ state: { startWithLastDocument: false }, version: 0 })));
  await page.goto(url("?reset&oldserver"));
  const tasks = home(page).getByRole("region", { name: "My tasks" });
  await expect(tasks.getByRole("button", { name: /Order catering/ })).toBeVisible();
  await expect(tasks).toHaveAttribute("data-scope", "all");
});

test("my tasks: an owner with no owner identity set sees every open task and a hint, never an empty list", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("prism-settings", JSON.stringify({ state: { startWithLastDocument: false }, version: 0 })));
  await page.goto(url("?reset&ownerunset"));
  const tasks = home(page).getByRole("region", { name: "My tasks" });
  await expect(tasks.getByRole("button", { name: /Order catering/ })).toBeVisible();
  await expect(tasks.getByRole("button", { name: /Write release notes/ })).toBeVisible();
  await expect(tasks.getByTestId("my-tasks-hint")).toContainText("Set the owner identity");
  await expect(tasks).toHaveAttribute("data-scope", "all");
});
