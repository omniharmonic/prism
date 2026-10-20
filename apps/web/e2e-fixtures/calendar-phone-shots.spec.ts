/**
 * Calendar on a phone: the review screenshots in qa/screenshots/calendar-phone/<before|after>/.
 * Defines NO tests unless CAL_SHOTS=before|after (the default suite count must not change):
 *   cd apps/web && CAL_SHOTS=after E2E_PORT=5223 npx playwright test e2e-fixtures/calendar-phone-shots.spec.ts
 * Fixture only (calendar.html?phone) — the live-actions client is the fixture's fake.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const run = process.env.CAL_SHOTS;
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../qa/screenshots/calendar-phone", run ?? "after");

if (run) for (const [width, height] of [[390, 844], [320, 568]] as const) {
  test.describe(`${width}`, () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width, height }, timezoneId: "America/Denver" });
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(out, `${width}-${name}.jpg`), type: "jpeg", quality: 80 });
    const open = async (page: Page) => {
      await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z"));
      await page.goto("/e2e-fixtures/calendar.html?phone");
      await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
      await expect(page.getByText("Weekly standup").first()).toBeVisible();
    };
    const view = async (page: Page, name: string) => { await page.getByRole("button", { name, exact: true }).or(page.getByRole("tab", { name, exact: true })).first().click(); await page.waitForTimeout(250); };
    const event = (page: Page, name: RegExp) => page.getByRole("button", { name }).first();

    test("views", async ({ page }) => {
      await open(page);
      await shot(page, "01-default");
      for (const v of ["Agenda", "Day", "Week", "Month"]) {
        if (!(await page.getByRole("button", { name: v, exact: true }).or(page.getByRole("tab", { name: v, exact: true })).count())) continue;
        await view(page, v);
        await shot(page, `02-${v.toLowerCase()}`);
      }
      // Month: tap a date.
      await page.getByRole("button", { name: /^Select October 20, 2026/ }).click();
      await page.waitForTimeout(250);
      await shot(page, "03-month-day-selected");
    });

    test("empty day", async ({ page }) => {
      await open(page);
      await view(page, "Day");
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Previous period" }).or(page.getByRole("button", { name: "Next period" })).last().click();
      await page.waitForTimeout(250);
      await shot(page, "04-empty-day");
    });

    test("detail, RSVP, delete", async ({ page }) => {
      await open(page);
      await view(page, "Day");
      await event(page, /Quarterly bioregional/).click();
      await expect(page.getByRole("button", { name: "Meeting Notes" })).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, "05-detail-top");
      await page.getByRole("button", { name: "Yes", exact: true }).scrollIntoViewIfNeeded();
      await page.getByRole("button", { name: "Yes", exact: true }).click();
      await page.waitForTimeout(200);
      await shot(page, "06-detail-actions-rsvp");
      await page.getByRole("button", { name: "Delete event" }).click();
      await page.getByRole("alertdialog", { name: "Confirm delete" }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(page, "07-delete-confirm");
    });

    test("delete a series", async ({ page }) => {
      await open(page);
      await view(page, "Day");
      await event(page, /Monthly review/).click();
      await page.getByRole("button", { name: "Delete event" }).click();
      await page.getByRole("button", { name: "Delete this occurrence" }).click();
      await page.getByTestId("delete-all-occurrences").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(page, "08-delete-series");
    });

    test("create and edit", async ({ page }) => {
      await open(page);
      await page.getByRole("button", { name: /^(Create|New) event$/ }).click();
      await expect(page.getByPlaceholder("Event title")).toBeVisible();
      await page.waitForTimeout(250);
      await shot(page, "09-create-form");
      await page.getByPlaceholder(/Attendees/).fill("morgan@example.test");
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `${width}-10-create-form-full.jpg`), type: "jpeg", quality: 80, fullPage: true });
      await page.keyboard.press("Escape");
      await view(page, "Day");
      await event(page, /Quarterly bioregional/).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByPlaceholder("Event title")).toBeVisible();
      await page.waitForTimeout(250);
      await shot(page, "11-edit-form");
    });
  });
}
