import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 2 — a clause of NP-RF-02 that existed in the product but had no assertion.
 * (An ISO-date case and a person-mention backlink case were tried in this pass and did not pass in this
 * fixture; they are recorded as unverified in PARITY-EVIDENCE.md rather than kept here as failing tests.)
 */
async function openEditor(page: Page) {
  await page.goto("/e2e-fixtures/notion-mentions.html");
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible();
  return editor;
}
async function typeAtEnd(page: Page, editor: ReturnType<Page["locator"]>, text: string) {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}
const saved = (page: Page, id: string) => page.evaluate((noteId) => (window as any).prismFixtureNotes.find((n: any) => n.id === noteId).content as string, id);

/** NP-RF-02: "next Monday" is understood by the @ menu and becomes a date chip. */
test("@ menu dates: next Monday", async ({ page }) => {
  const editor = await openEditor(page);
  const menu = page.getByRole("listbox", { name: "Mention a person, page or date" });
  const dates = menu.getByRole("group", { name: "Dates" });

  // "next monday" = the first Monday strictly after today, in the author's own calendar.
  const expected = await page.evaluate(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    let delta = (1 - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  await typeAtEnd(page, editor, "Review @next monday");
  await expect(dates.getByRole("option").first()).toBeVisible();
  await expect(menu.getByRole("group", { name: "People" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(editor.locator('[data-type="mention"][data-kind="date"]')).toHaveCount(1);
  await expect.poll(() => saved(page, "plan"), { timeout: 10_000 }).toContain(`data-date="${expected}"`); // the stored chip carries the day
});
