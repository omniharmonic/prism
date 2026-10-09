import { test, expect, type Page } from "@playwright/test";

/** Wave 3 gaps #5: a Sign out control in the sidebar account menu and in
 *  Settings → Account. Both use the one existing sign-out path: the session is
 *  ended on the server and this device's offline caches are cleared. */
const seedCaches = (page: Page) => page.evaluate(() => {
  localStorage.setItem("prism:recent-searches:default", JSON.stringify(["workshop"]));
  localStorage.setItem("prism:offline-pinned:default", JSON.stringify(["agenda"]));
  // The Calendar's last listing, kept for a fast cold start (lib/calendar/meetingListing.ts).
  localStorage.setItem("prism:calendar-listing:default", JSON.stringify({ v: 1, at: Date.now(), events: [{ id: "e1", summary: "Private meeting", start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } }] }));
});
// The app reloads after signing out: a read that lands mid-navigation is retried by the poll.
const state = (page: Page) => page.evaluate(() => ({
  signedOut: sessionStorage.getItem("notion-shell-signed-out"),
  cached: Object.keys(localStorage).filter((k) => k.startsWith("prism:recent-searches:") || k.startsWith("prism:offline-") || k.startsWith("prism:calendar-listing:")),
})).catch(() => ({ signedOut: null as string | null, cached: ["navigating"] }));

test("sidebar account menu → Sign out ends the session and clears offline caches", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?account");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await seedCaches(page);
  const trigger = page.getByRole("button", { name: "Account menu" });
  await expect(trigger).toHaveText("You");
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  // Escape closes it and returns focus.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Sign out" }).click();
  await expect.poll(async () => (await state(page)).signedOut).toBe("1");
  await expect.poll(async () => (await state(page)).cached).toEqual([]);
});

test("Settings → Account → Sign out", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?account");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await seedCaches(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("tab", { name: /Account/ }).or(page.getByRole("button", { name: "Account", exact: true })).first().click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(async () => (await state(page)).signedOut).toBe("1");
  await expect.poll(async () => (await state(page)).cached).toEqual([]);
});

test("no account client (legacy desktop): no account menu", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);
});
