import { test, expect } from "@playwright/test";

test("fixture server has no live gateway", async ({ page, request }) => {
  await page.goto("/e2e-fixtures/harness.html");
  await expect(page.getByRole("heading", { name: "Prism isolated fixtures" })).toBeVisible();
  const response = await request.get("/api/notes");
  expect(response.status()).toBeGreaterThanOrEqual(500);
});
