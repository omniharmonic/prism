/**
 * Control sizes (ui-tokens): desktop controls are drawn from the control tokens (tokens.css
 * --control-h-*), touch pointers and narrow windows get --touch-target. `min-h-11` (44 px) used to
 * be hard-coded on ~120 desktop buttons, making them a third taller than the controls beside them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

test.use({ timezoneId: "America/Denver" });
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date("2026-10-05T16:00:00Z")); });

const heights = (page: Page, names: string[]) => page.evaluate((names) => names.map((name) => {
  const b = [...document.querySelectorAll<HTMLElement>("button")].find((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === name);
  return b ? Math.round(b.getBoundingClientRect().height) : -1;
}), names);
const CALENDAR = ["Previous period", "Next period", "Today", "Month", "Week", "Day"];

test("desktop: calendar controls use the control size, not the touch size", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/calendar.html");
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
  for (const h of await heights(page, CALENDAR)) { expect(h).toBeGreaterThanOrEqual(28); expect(h).toBeLessThanOrEqual(36); }
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("phone: the same controls are ≥ 44 px touch targets", async ({ page }) => {
    await page.goto("/e2e-fixtures/calendar.html");
    await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
    for (const h of await heights(page, CALENDAR)) expect(h).toBeGreaterThanOrEqual(44);
  });
});

test("320 px: the calendar does not scroll the page sideways", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/e2e-fixtures/calendar.html");
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("source: no hard-coded 44 px touch size on desktop controls", () => {
  const roots = [path.resolve(here, "../../../packages/core/src"), path.resolve(here, "../src")];
  const offenders: string[] = [];
  const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".tsx") && /(?<![\w:-])(min-h-11|min-w-11|h-11 w-11)(?![\w-])/.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
  } };
  roots.forEach(walk);
  // Use `min-h-control` / `min-w-control` / `size-control` (tokens.css), or `coarse:` for touch-only sizes.
  expect(offenders).toEqual([]);
});
