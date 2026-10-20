import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 3 · NP-PG-12: "A day-grouped list, preview, compare against current or previous,
 * and Restore with a consequence line … Phone: readable full-width compare."
 * Fixture flag `?days`: six saves five hours apart (four on Sep 29, two on Sep 28, UTC).
 */
test.use({ timezoneId: "UTC" });
const rows = ".prism-context-history button.prism-context-history-row";

/** The timeline as rendered: each day heading with the number of version rows under it. */
const groups = (page: Page) => page.locator(".prism-context-history").evaluate((root) => {
  const out: Array<{ day: string; rows: number }> = [];
  for (const el of root.querySelectorAll(".uppercase.tracking-wide, button.prism-context-history-row")) {
    if (el.matches("button")) { if (out.length) out[out.length - 1]!.rows++; else out.push({ day: "(none)", rows: 1 }); }
    else out.push({ day: (el.textContent ?? "").trim(), rows: 0 });
  }
  return out;
});
const open = async (page: Page, index: number) => {
  await page.locator(rows).nth(index).click();
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Full text", exact: true })).toBeVisible();
  return dialog;
};

test("NP-PG-12: versions are grouped by the day they were saved", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-03T12:00:00Z"));
  await page.goto("/e2e-fixtures/context-history.html?days");
  await expect(page.locator(rows)).toHaveCount(6);
  // Saved 15:00, 10:00, 05:00 and 00:00 on Sep 29; 19:00 on Sep 28 and the oldest one before it.
  expect(await groups(page)).toEqual([{ day: "Tuesday, Sep 29", rows: 4 }, { day: "Monday, Sep 28", rows: 2 }]);
});

test("NP-PG-12: recent days read Today and Yesterday", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-29T22:00:00Z"));
  await page.goto("/e2e-fixtures/context-history.html?days");
  await expect(page.locator(rows)).toHaveCount(6);
  expect(await groups(page)).toEqual([{ day: "Today", rows: 4 }, { day: "Yesterday", rows: 2 }]);
});

test("NP-PG-12: compare with the current note or with the version before; restore states its consequence", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-history.html");
  await expect(page.locator(rows)).toHaveCount(3);
  const dialog = await open(page, 0);
  const current = dialog.getByRole("button", { name: "Current note", exact: true });
  const before = dialog.getByRole("button", { name: "Version before", exact: true });
  // Default: what restoring would do — this version against the current note.
  await expect(current).toHaveAttribute("aria-pressed", "true");
  await expect(before).toHaveAttribute("aria-pressed", "false");
  await expect(dialog).toContainText("Current");
  await expect(dialog).toContainText("collaborative");
  await expect(dialog).toContainText("Earlier");
  await expect(dialog).not.toContainText("brief 2.");
  // Switched: what THAT save changed — this version against the one before it.
  await before.click();
  await expect(before).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).toContainText("2");
  await expect(dialog).toContainText("1");
  await expect(dialog).not.toContainText("collaborative");
  await expect(dialog).not.toContainText("Current research");
  // The two saves differ only in their number: one edited line, shown as a removal and an addition.
  const edited = dialog.locator(".whitespace-pre-wrap").filter({ hasText: "Earlier research brief" });
  await expect(edited).toHaveCount(1);
  expect(await edited.locator("span").evaluateAll((spans) => spans.filter((s) => getComputedStyle(s).textDecorationLine.includes("line-through")).map((s) => s.textContent))).toEqual(["2"]);
  await expect(dialog).toContainText("+1 −1 lines");
  // And back.
  await current.click();
  await expect(dialog).toContainText("collaborative");
  // The oldest version has nothing before it: that comparison is not offered.
  await dialog.getByRole("button", { name: "Older version" }).click();
  await dialog.getByRole("button", { name: "Older version" }).click();
  await expect(dialog.getByRole("button", { name: "Version before", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Older version" })).toBeDisabled();
  // The consequence line: nothing is lost by restoring.
  await expect(dialog).toContainText("Restoring replaces the note's text and properties; tags and location stay as they are. The current version is saved to history first, so you can undo.");
  // Restore is two steps and can be backed out of; nothing was written.
  await dialog.getByRole("button", { name: "Restore this version" }).click();
  await expect(dialog.getByRole("button", { name: "Confirm restore" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Restore this version" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).contextHistory.writes.length)).toBe(0);
});

test("NP-PG-12: a reader is told restoring needs edit access", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-history.html?readonly");
  const dialog = await open(page, 0);
  await expect(dialog).toContainText("You can view this version, but restoring needs edit access.");
  await expect(dialog).not.toContainText("so you can undo");
});

test("NP-PG-12: phone — the compare is full width and readable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/context-history.html");
  const dialog = await open(page, 0);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeLessThanOrEqual(1);
  expect(box.width).toBeGreaterThanOrEqual(388);
  expect(box.height).toBeGreaterThanOrEqual(700);
  // Both sides of the comparison are on screen, at a readable size, with nothing cut off sideways.
  const added = dialog.getByText("collaborative", { exact: false }).first();
  await expect(added).toBeVisible();
  expect(parseFloat(await added.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13); // the app's body text size; never shrunk for the phone
  for (const line of await dialog.locator(".whitespace-pre-wrap").all()) {
    const b = (await line.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The compare switch, stepping and Restore are all reachable without sideways scrolling.
  for (const name of ["Current note", "Version before", "Older version", "Restore this version", "Close"]) {
    const control = dialog.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    const b = (await control.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  await dialog.getByRole("button", { name: "Version before", exact: true }).click();
  await expect(dialog).toContainText("+1 −1 lines");
  await expect(dialog).toContainText("The current version is saved to history first, so you can undo.");
});
