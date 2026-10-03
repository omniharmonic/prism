import { test, expect, type Page } from "@playwright/test";

/** Wave 2E · NP-OF-01 / NP-SB-15: one truthful save state in every header. */
async function typeInEditor(page: Page, text: string) {
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}
const shell = (page: Page) => page.evaluate(() => (window as any).prismShell);

test("desktop header: Saving… until the server confirms, Save failed · Retry, offline copy", async ({ page, context }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const badge = page.locator(".sync-state-header");
  await expect(badge).toHaveText("Saved");
  await page.evaluate(() => { (window as any).prismShell.hold = true; });
  await typeInEditor(page, " Held edit.");
  await expect(badge).toHaveText("Saving…");
  await expect.poll(async () => (await shell(page)).writes.length, { timeout: 8000 }).toBe(1);
  // The write is on the wire, not confirmed: never "Saved" yet.
  await page.waitForTimeout(300);
  await expect(badge).toHaveText("Saving…");
  await page.evaluate(() => { const s = (window as any).prismShell; s.hold = false; s.release.splice(0).forEach((r: () => void) => r()); });
  await expect(badge).toHaveText("Saved");

  await page.evaluate(() => { (window as any).prismShell.failStatus = 422; });
  await typeInEditor(page, " Refused edit.");
  const retry = page.getByRole("button", { name: "Save failed · Retry: retry saving" });
  await expect(retry).toBeVisible({ timeout: 8000 });
  await page.evaluate(() => { (window as any).prismShell.failStatus = 0; });
  await retry.click();
  await expect(badge).toHaveText("Saved");
  expect(((await shell(page)).writes.at(-1).body.content as string)).toContain("Refused edit.");

  await context.setOffline(true);
  await typeInEditor(page, " Offline edit.");
  await expect(page.getByRole("button", { name: /Offline · changes saved on this device/ })).toBeVisible({ timeout: 8000 });
  // Truthful: the change really is in the durable on-device outbox, not paused in memory.
  await expect(page.locator(".offline-indicator-pill")).toContainText("1 change saved on this device");
  await page.screenshot({ path: info.outputPath("header-offline.png") });
  await context.setOffline(false);
  await expect(badge).toHaveText("Saved", { timeout: 15000 });
  expect(((await shell(page)).writes.at(-1).body.content as string)).toContain("Offline edit.");
});

test("phone header sync state", async ({ page, context }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/notion-shell.html");
  const badge = page.locator(".sync-state-phone");
  await expect(badge).toHaveAttribute("data-sync-state", "saved");
  await expect(badge.locator(".sync-state-dot")).toBeVisible();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await context.setOffline(true);
  await typeInEditor(page, " Phone offline edit.");
  await expect(page.locator(".sync-state-phone")).toHaveText("Saved on this device", { timeout: 8000 });
  // The saved-changes pill sits above the bottom bar, never on it.
  const pill = page.locator(".offline-indicator-pill");
  await expect(pill).toBeVisible();
  const bar = await page.getByRole("navigation").last().boundingBox();
  const pillBox = await pill.boundingBox();
  if (bar && pillBox && bar.y > 600) expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(bar.y + 1);
  await page.screenshot({ path: info.outputPath("phone-offline.png") });
  await context.setOffline(false);
  await expect(page.locator(".sync-state-phone")).toHaveAttribute("data-sync-state", "saved", { timeout: 15000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("footer reflects sync state", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const footer = page.locator(".workspace-navigation .sync-state-footer");
  // Mounted by Navigation.tsx (group 2A owns it this wave; see the 2E report hunk).
  test.skip(await footer.count() === 0, "sidebar footer badge not mounted on this branch");
  await expect(footer).toHaveText("Synced");
  await page.evaluate(() => { (window as any).prismShell.hold = true; });
  await typeInEditor(page, " Footer edit.");
  await expect(footer).toHaveText("Saving…");
  await page.evaluate(() => { const s = (window as any).prismShell; s.hold = false; s.release.splice(0).forEach((r: () => void) => r()); });
  await expect(footer).toHaveText("Synced", { timeout: 8000 });
});

test("a save that conflicts with a newer server copy goes to review, never to an overwriting Retry", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".sync-state-header")).toHaveText("Saved");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.evaluate(() => (window as any).prismShell.serverEdit("workspace", "<p>Changed on another device.</p>"));
  await typeInEditor(page, " My conflicting edit.");
  await expect(page.getByRole("button", { name: "Needs review: review saved changes" })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole("button", { name: /Retry: retry saving/ })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "This page changed somewhere else" })).toBeVisible();
  // The footer's own Retry cannot overwrite either: the server copy is untouched, the draft is kept for review.
  await page.getByRole("button", { name: "Retry save" }).click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).prismShell.note("workspace").content)).toBe("<p>Changed on another device.</p>");
  await page.getByRole("button", { name: "Needs review: review saved changes" }).click();
  await expect(page.getByRole("dialog").getByText("Needs review")).toBeVisible();
});
