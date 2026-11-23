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

test("review list pairs replacements, names their author, and uses current positions after remote edits", async ({ page }) => {
  await page.goto("/e2e-fixtures/suggestions.html");
  await page.getByText("2 suggested changes", { exact: true }).click();
  const changes = page.getByRole("region", { name: "Change by Alex (agent)" });
  await expect(changes).toHaveCount(1);
  await expect(page.getByText("Change 1 of 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next suggested change" }).click();
  await expect(changes).toContainText("Old two");
  await expect(page.getByText("Change 2 of 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous suggested change" }).click();
  await expect(changes.first()).toContainText("Old one");
  await expect(changes.first()).toContainText("New one");
  await expect(changes.first()).toContainText("Agent suggestion");
  await page.evaluate(() => (window as any).prismSuggestionsFixture.prepend());
  await changes.first().getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.locator('[data-suggestion-id="change-one"]')).toHaveCount(0);
  await expect(page.locator('[data-suggestion-id="change-two"]')).toHaveCount(2);
  await expect(page.locator(".tiptap")).toContainText("Another collaborator wrote here. New one");
  await expect(page.getByText("1 suggested change", { exact: true })).toBeVisible();
  await changes.first().getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.locator(".tiptap")).toHaveText("Another collaborator wrote here. New oneOld two");
  await expect(page.getByRole("status")).toContainText("Rejected change by Alex (agent).");
});

test("review list remains inspectable without edit access and fits a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/suggestions.html?viewer");
  await page.getByText("2 suggested changes", { exact: true }).click();
  const changes = page.getByRole("region", { name: "Change by Alex (agent)" });
  await expect(changes.first().getByRole("button", { name: "Show in document" })).toBeVisible();
  await expect(changes.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await expect(changes.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
  await expect(page.getByText("You can inspect changes.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("suggestion-review-mobile.png") });
});
