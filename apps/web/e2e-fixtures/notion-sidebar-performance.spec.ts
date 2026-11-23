import { test, expect } from "./browser-compat";

/** NP-SB-13 */
// Trace snapshots/screenshots add browser work to the measured click-to-focus interval.
// Keep this real-time budget uninstrumented; the other sidebar journeys retain traces.
test.use({ trace: "off" });
test("one action → focused untitled page", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const nav = page.locator(".workspace-navigation");
  // Warm-up: the first create in a fresh page also pays for one-off work (module
  // evaluation, first title-edit render) that a user's workspace has long since done.
  await nav.getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Document title" })).toHaveValue("Untitled (2)");
  await page.getByRole("textbox", { name: "Document title" }).press("Escape");
  // The row's budget is < 300 ms from the action to a focused title. Measured in the
  // page (click → the title input taking focus), so Playwright's own round trips don't count.
  await page.evaluate(() => {
    const w = window as any;
    w.prismNewPageMs = null;
    let clicked = 0;
    document.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest?.('button[aria-label="New page"], button[title="New page"]') || (e.target as HTMLElement).closest?.("button")?.textContent?.trim() === "New page") clicked = performance.now(); }, true);
    document.addEventListener("focusin", (e) => { if (clicked && w.prismNewPageMs === null && (e.target as HTMLElement).getAttribute?.("aria-label") === "Document title") w.prismNewPageMs = performance.now() - clicked; }, true);
  });
  await nav.getByRole("button", { name: "New page", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await expect(title).toBeFocused();
  const elapsed = await page.evaluate(() => (window as any).prismNewPageMs as number | null);
  expect(elapsed).not.toBeNull();
  expect(elapsed!).toBeLessThan(300); // no dialog and no read-back in between
  await expect(title).toHaveValue("Untitled (3)"); // "Untitled" and the warm-up page already exist beside it
  await expect(page.getByRole("dialog", { name: "New page", exact: true })).toHaveCount(0);
  // Created next to the page you were on, and you can just type the name.
  await title.fill("Sprint notes");
  await title.press("Enter");
  await expect(page.getByRole("button", { name: "Rename Sprint notes", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismShell.note("created-2")?.path)).toBe("Projects/Prism/Sprint notes");
  // The type/location chooser is one click away, never in the way.
  await nav.getByRole("button", { name: "Choose page type", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New page", exact: true })).toBeVisible();
});

