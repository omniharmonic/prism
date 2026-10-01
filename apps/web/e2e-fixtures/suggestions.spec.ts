import { test, expect } from "@playwright/test";

for (const action of ["accept", "reject"] as const) {
  test(`${action} reviews one complete replacement without touching adjacent suggestions`, async ({ page }) => {
    await page.goto("/e2e-fixtures/suggestions.html");
    await expect(page.locator('[data-suggestion-id="change-one"]')).toHaveCount(2);
    await page.getByRole("button", { name: "Reload saved HTML" }).click();
    await expect(page.locator('[data-suggestion-id="change-one"]')).toHaveCount(2);
    await expect(page.locator('[data-suggestion-id="change-one"]').first()).toHaveAttribute("data-turn-id", "turn-fixture");
    await page.evaluate(() => (window as any).prismSuggestionsFixture.select("Old one"));
    await page.getByRole("button", { name: action === "accept" ? "Accept selected change" : "Reject selected change" }).click();
    await expect(page.locator('[data-suggestion-id="change-one"]')).toHaveCount(0);
    await expect(page.locator('[data-suggestion-id="change-two"]')).toHaveCount(2);
    await expect(page.locator(".tiptap")).toHaveText(action === "accept" ? "New oneOld twoNew two" : "Old oneOld twoNew two");
  });
}

test("legacy adjacent suggestions from different people remain independently reviewable", async ({ page }) => {
  await page.goto("/e2e-fixtures/suggestions.html?legacy");
  await expect(page.locator('[data-user="Alex"]')).toBeVisible();
  await page.evaluate(() => (window as any).prismSuggestionsFixture.select("First"));
  await page.getByRole("button", { name: "Accept selected change" }).click();
  await expect(page.locator('[data-user="Alex"]')).toHaveCount(0);
  await expect(page.locator('[data-user="Morgan"]')).toHaveText("Second");
  await expect(page.locator(".tiptap")).toHaveText("FirstSecond");
});
