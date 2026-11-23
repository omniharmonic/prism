import { test, expect } from "@playwright/test";
test.use({ timezoneId: "UTC" });

test("web live messages paginate by source ID, distinguish same-name senders and preserve history position", async ({ page }) => {
  await page.goto("/e2e-fixtures/live-thread.html");
  const thread = page.getByRole("region", { name: "Conversation messages" });
  await expect(thread.locator("[data-message-id]")).toHaveCount(100);
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(thread.locator("[data-message-id]")).toHaveCount(120);
  await page.getByRole("button", { name: "View latest messages" }).click();
  await expect(thread.locator("[data-message-id]")).toHaveCount(50);
  await expect(thread.getByText("@alex-design:example.test", { exact: true }).first()).toBeVisible();
  await expect(thread.getByText("@alex-engineering:example.test", { exact: true }).first()).toBeVisible();
  await thread.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
  const marker = thread.locator('[data-message-id="event-20"]');
  const before = await marker.boundingBox();
  // Use the DOM click so Playwright does not scroll the reader to the button.
  await page.getByRole("button", { name: "Load earlier messages" }).evaluate(node => (node as HTMLButtonElement).click());
  await expect(thread.locator("[data-message-id]")).toHaveCount(70);
  expect(Math.abs((await marker.boundingBox())!.y - before!.y)).toBeLessThan(2);
  await expect(thread.getByRole("separator")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).prismLiveThreadFixture.reads)).toEqual([undefined, "older"]);
});

test("failed live reads never masquerade as saved messages and retry keeps source text safe", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/live-thread.html");
  await page.evaluate(() => (window as any).prismLiveThreadFixture.fail = true);
  await page.getByRole("button", { name: "View latest messages" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be refreshed");
  const thread = page.getByRole("region", { name: "Conversation messages" });
  await expect(thread.locator("[data-message-id]")).toHaveCount(0);
  await page.evaluate(() => (window as any).prismLiveThreadFixture.fail = false);
  await page.getByRole("button", { name: "Retry messages" }).click();
  await expect(thread.locator("[data-message-id]")).toHaveCount(50);
  const link = thread.getByRole("link", { name: "https://example.test/plan" });
  await expect(link).toHaveAttribute("href", "https://example.test/plan");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(thread.locator("img,script")).toHaveCount(0);
  await expect(thread.getByText('Literal <img', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("live-thread-mobile.png") });
  await page.getByRole("button", { name: "View saved history" }).click();
  await expect(thread.locator("[data-message-id]")).toHaveCount(100);
});

test("read-only message renderers cannot change status, read the live connector or send", async ({ page }) => {
  await page.goto("/e2e-fixtures/live-thread.html?readonly");
  await expect(page.getByRole("combobox", { name: "Thread status" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "View latest messages" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).prismLiveThreadFixture.reads)).toEqual([]);
  expect(await page.evaluate(() => (window as any).prismLiveThreadFixture.writes)).toBe(0);
});
