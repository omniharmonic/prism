import { test, expect } from "@playwright/test";
import { threadStatus } from "../../../packages/core/src/lib/messages/triage";

test("each tag combination has one consistent visible classification", () => {
  expect(threadStatus(["urgent", "handled"])).toBe("handled");
  expect(threadStatus(["low", "triaged"])).toBe("low");
  expect(threadStatus(["triaged"])).toBe("triaged");
  expect(threadStatus(["social"])).toBe("social");
  expect(threadStatus([])).toBe("unclassified");
});

test("Inbox counts unique conversations, keeps reviewed items visible and fits a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/inbox.html");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("4 conversations", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Urgent/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Handled/ }).click();
  await expect(page.getByRole("button", { name: /Direct discussion/ })).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search inbox" }).fill("reviewed");
  await expect(page.getByRole("button", { name: /Reviewed discussion/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Direct discussion/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("textbox", { name: "Search inbox" }).fill("");
  await page.screenshot({ path: testInfo.outputPath("inbox-mobile.png") });
});

test("People compose requires an explicit conversation and never uses a platform alias as recipient", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html");
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("button", { name: /Morgan/ }).click();
  await expect(page.getByText("2 threads", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Message destination" }).selectOption("group");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Only the selected group");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Message destination" })).toHaveCount(0);
  const sends = await page.evaluate(() => (window as any).prismInboxFixture.sends);
  expect(sends).toHaveLength(1);
  expect(sends[0].room).toBe("!group:example.test");
  expect(sends[0].key).toBeTruthy();
});

test("People compose remains unavailable when the server cannot send", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?unavailable");
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("button", { name: /Morgan/ }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await expect(page.getByText("Messaging is unavailable on this connection.")).toBeVisible();
});

test("a failed Inbox read offers recovery instead of claiming the list is complete", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?failed");
  await expect(page.getByRole("alert")).toContainText("couldn't load");
  await page.evaluate(() => { (window as any).prismInboxFixture.denyThreads = false; });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("4 conversations", { exact: true })).toBeVisible();
});
