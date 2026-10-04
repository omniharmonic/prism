import { test, expect, type Page } from "@playwright/test";
import { grantClipboard } from "./browser-compat";

/**
 * NP-AX-03 (live regions): outcomes that happen without a focus change are in a live region
 * (`role="status"` / `role="alert"` / `aria-live`), so a screen reader has something to announce.
 * This asserts the markup and its text; whether VoiceOver/TalkBack actually speak it is a device check.
 */
const live = (page: Page, text: string | RegExp) => page.locator('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]').filter({ hasText: text });

test.describe("live regions announce async outcomes", () => {
  test("save state: saving, failed (with retry), saved, offline", async ({ page, context }) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    const editor = page.locator(".tiptap[contenteditable=true]");
    await expect(editor).toBeVisible();
    const region = page.locator(".sync-state-region").first();
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).toHaveAttribute("aria-live", "polite");
    await expect(live(page, "Saved").first()).toBeVisible();
    await page.evaluate(() => { (window as any).prismShell.failStatus = 422; });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Refused.");
    await expect(live(page, /Save failed/).first()).toBeVisible({ timeout: 8000 });
    await page.evaluate(() => { (window as any).prismShell.failStatus = 0; });
    await page.getByRole("button", { name: /retry saving/ }).first().click();
    await expect(live(page, "Saved").first()).toBeVisible();
    await context.setOffline(true);
    await page.keyboard.type(" Offline.");
    await expect(live(page, /Offline/).first()).toBeVisible({ timeout: 8000 });
    await context.setOffline(false);
  });

  test("moved to Trash (with Undo) and Link copied", async ({ page, context, browserName }) => {
    await grantClipboard(context, browserName);
    await page.goto("/e2e-fixtures/pages-nav.html");
    const nav = page.locator(".workspace-navigation").first();
    await nav.getByRole("button", { name: "Page actions for Plan", exact: true }).click();
    await page.getByRole("menuitem", { name: "Copy link" }).click();
    await expect(live(page, "Link copied")).toBeVisible();
    await nav.getByRole("button", { name: "Page actions for Plan", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to Trash" }).click();
    const toast = live(page, /to Trash/);
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(nav.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
  });

  test("share dialog: copying a link is announced", async ({ page, context, browserName }) => {
    await grantClipboard(context, browserName);
    await page.goto("/e2e-fixtures/sharing.html?page");
    await page.getByRole("button", { name: "Share fixture", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share document" });
    await expect(dialog).toBeVisible();
    const status = dialog.getByTestId("share-copy-status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveText("");
    const copy = dialog.getByRole("button", { name: /^Copy / }).first();
    if (!(await copy.count())) { await dialog.getByRole("tab", { name: "Link access", exact: true }).click(); const create = dialog.getByRole("button", { name: /Create|Generate/ }).first(); if (await create.count()) await create.click(); }
    await dialog.getByRole("button", { name: /^Copy / }).first().click();
    await expect(status).toHaveText(/copied$/);
  });

  test("inbox: archiving keeps focus in the list", async ({ page }) => {
    const pin = new Date(); pin.setHours(15, 0, 0, 0); await page.clock.setFixedTime(pin);
    await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
    const rows = page.getByTestId("notifications-inbox").getByTestId("notification-row");
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    await rows.first().getByRole("button", { name: "Archive" }).focus();
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(n - 1);
    await expect(rows.first().getByRole("button", { name: "Archive" })).toBeFocused();
  });
});
