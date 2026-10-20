import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 3 · NP-CO-12: "Accept or reject one at a time with previous/next, or all; Undo
 * after accept". One at a time is asserted in suggestion-review.spec / suggestions.spec; here:
 * the live editor's Suggesting mode, Accept all, Reject all, and Undo after an accept.
 * Fixture: notion-mentions.html?comments&review (the live editor with review rights on a local Y.Doc).
 *
 * NOT asserted — a behaviour gap, see PARITY-GAPS a.1: there is no "Needs refresh" state for a
 * stale suggestion. A change that was reviewed or edited elsewhere leaves the queue with the
 * notice "This change has already been reviewed or changed." (suggestion-review.spec › "another
 * reviewer can remove the active change…").
 */
const marks = (page: Page) => page.locator(".ProseMirror [data-suggestion]");
const text = (page: Page) => page.locator(".ProseMirror").first().innerText();

async function suggestTwoChanges(page: Page) {
  await page.goto("/e2e-fixtures/notion-mentions.html?comments&review");
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("The rollout plan is ready for review.");
  // Suggesting mode: typing is tracked, not applied.
  await page.getByRole("button", { name: "Editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Suggesting", exact: true })).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Ship it on Friday.");
  await page.evaluate(() => (window as any).prismMentionsFixture.select("rollout"));
  await page.keyboard.press("Backspace");
  await page.keyboard.type("launch");
  // An insertion at the end, and a replacement (a deletion paired with an insertion).
  await expect(page.locator('.ProseMirror [data-suggestion="insert"]', { hasText: "Ship it on Friday." })).toBeVisible();
  await expect(page.locator('.ProseMirror [data-suggestion="delete"]', { hasText: "rollout" })).toBeVisible();
  await expect(page.locator('.ProseMirror [data-suggestion="insert"]', { hasText: "launch" })).toBeVisible();
  // Attributed to the person who made them.
  for (const who of await marks(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-user")))) expect(who).toBe("You");
  // Back to editing for the review.
  await page.getByRole("button", { name: "Suggesting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Editing", exact: true })).toBeVisible();
  // A person does not review within half a second of typing: undo groups edits made closer together than that.
  await page.waitForTimeout(900);
  return editor;
}

test("NP-CO-12: Accept all applies every suggestion at once; Undo brings them back for review", async ({ page }) => {
  const editor = await suggestTwoChanges(page);
  const pending = await marks(page).count();
  expect(pending).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Accept all suggestions" }).click();
  await expect(marks(page)).toHaveCount(0);
  await expect(editor).toHaveText("The launch plan is ready for review. Ship it on Friday.");
  // Undo after accept: the changes are suggestions again (nothing was lost, nothing half-applied).
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(marks(page)).toHaveCount(pending);
  await expect(page.locator('.ProseMirror [data-suggestion="delete"]', { hasText: "rollout" })).toBeVisible();
  await expect(page.locator('.ProseMirror [data-suggestion="insert"]', { hasText: "launch" })).toBeVisible();
  await expect(page.locator('.ProseMirror [data-suggestion="insert"]', { hasText: "Ship it on Friday." })).toBeVisible();
  // And redo accepts them again.
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(marks(page)).toHaveCount(0);
  await expect(editor).toHaveText("The launch plan is ready for review. Ship it on Friday.");
});

/**
 * NP-CO-12 · "A Suggesting mode marks inserts and deletes with attribution."
 * Was a behaviour gap (PARITY-GAPS a.1 — seen failing 2026-10-03): while Suggesting, TYPING OVER a
 * selection removes the selected text outright — only Backspace / Delete are tracked
 * (`SuggestionMode.handleKeyDown`, packages/core/src/editor/suggestions.ts); the replaced words are
 * gone with no deletion mark, so a reviewer cannot see or reject that half of the change.
 */
test("NP-CO-12: typing over a selection while Suggesting keeps the replaced text as a tracked deletion", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-mentions.html?comments&review");
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("The rollout plan is ready for review.");
  await page.getByRole("button", { name: "Editing", exact: true }).click();
  await editor.click();
  await page.evaluate(() => (window as any).prismMentionsFixture.select("rollout"));
  await page.keyboard.type("launch");
  await expect(page.locator('.ProseMirror [data-suggestion="insert"]', { hasText: "launch" })).toBeVisible();
  await expect(page.locator('.ProseMirror [data-suggestion="delete"]', { hasText: "rollout" })).toBeVisible();
  await page.getByRole("button", { name: "Suggesting", exact: true }).click();
  await page.getByRole("button", { name: "Reject all suggestions" }).click();
  await expect(editor).toHaveText("The rollout plan is ready for review.");
});

test("NP-CO-12: Reject all discards every suggestion and leaves the original text", async ({ page }) => {
  const editor = await suggestTwoChanges(page);
  await page.getByRole("button", { name: "Reject all suggestions" }).click();
  await expect(marks(page)).toHaveCount(0);
  await expect(editor).toHaveText("The rollout plan is ready for review.");
  expect(await text(page)).not.toContain("Friday");
});

test("NP-CO-12: Undo after accepting ONE change restores just that suggestion", async ({ page }) => {
  const editor = await suggestTwoChanges(page);
  const pending = await marks(page).count();
  const review = page.locator("details.prism-suggestion-review");
  await review.locator("summary").click();
  await expect(review.locator("summary")).toHaveText("3 suggested changes"); // the addition, the removal, the new word
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(review.locator("summary")).toHaveText("2 suggested changes");
  const afterOne = await marks(page).count();
  expect(afterOne).toBeLessThan(pending);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(marks(page)).toHaveCount(pending);
  await expect(review.locator("summary")).toHaveText("3 suggested changes");
});
