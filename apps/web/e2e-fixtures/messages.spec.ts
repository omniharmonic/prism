import { test, expect } from "@playwright/test";
import { parseLegacyThread } from "../../../packages/core/src/lib/messages/legacyThread";

test("legacy transcripts retain multiline content and colon-bearing identities in UTC", () => {
  const parsed = parseLegacyThread("# Conversation\n\n[2026-10-01 10:15] @morgan:example.test: First line\nSecond line\n\n- A list\n[2026-10-01 10:16] Alex: Next message");
  expect(parsed.preamble).toBe("# Conversation");
  expect(parsed.messages).toHaveLength(2);
  expect(parsed.messages[0].sender).toBe("@morgan:example.test");
  expect(parsed.messages[0].body).toBe("First line\nSecond line\n\n- A list");
  expect(parsed.messages[0].timestamp).toBe(Date.UTC(2026, 9, 1, 10, 15));
  expect(parsed.messages[0].source).toBe("legacy");
  const prepended = parseLegacyThread("[2026-09-30 10:15] Alex: Earlier\n" + "[2026-10-01 10:15] @morgan:example.test: First line\nSecond line\n\n- A list\n[2026-10-01 10:16] Alex: Next message");
  expect(prepended.messages[1].event_id).toBe(parsed.messages[0].event_id);
  expect(parseLegacyThread("[2026-02-31 10:15] Alex: Invalid date").messages[0].timestamp).toBe(0);
});

test("failed sends retain a draft and acknowledged sends clear it once", async ({ page }) => {
  await page.goto("/e2e-fixtures/messages.html");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Please keep this reply.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is kept here");
  await expect(input).toHaveValue("Please keep this reply.");
  await page.evaluate(() => { (window as unknown as { prismMessagesFixture: { reject: boolean } }).prismMessagesFixture.reject = false; });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("Please keep this reply.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { prismMessagesFixture: { attempts: number } }).prismMessagesFixture.attempts)).toBe(2);
});

test("reading position survives incoming messages and prepended history", async ({ page }) => {
  await page.goto("/e2e-fixtures/messages.html");
  const thread = page.getByRole("region", { name: "Conversation messages" });
  await expect(thread.locator("article")).toHaveCount(30);
  await thread.evaluate((node) => { node.scrollTop = 200; node.dispatchEvent(new Event("scroll")); });
  await page.getByRole("button", { name: "Receive message" }).click();
  expect(await thread.evaluate((node) => node.scrollTop)).toBe(200);
  await expect(page.getByRole("button", { name: "New messages" })).toBeVisible();
  const before = await thread.locator('[data-message-id="event-12"]').boundingBox();
  await page.getByRole("button", { name: "Prepend history" }).click();
  const after = await thread.locator('[data-message-id="event-12"]').boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  await page.getByRole("button", { name: "New messages" }).click();
  expect(await thread.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
});

test("mobile messages wrap without losing line breaks or sender labels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/messages.html");
  await expect(page.getByRole("region", { name: "Conversation messages" })).toBeVisible();
  expect(await page.locator(".workspace-message-body").first().evaluate((node) => getComputedStyle(node).whiteSpace)).toBe("pre-wrap");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "test-results/messages-mobile.png", animations: "disabled" });
});


test("saved thread renders all lines and unavailable reply cannot clear a draft", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?thread");
  await expect(page.getByRole("region", { name: "Conversation messages" })).toBeVisible();
  await expect(page.locator(".workspace-message-body").first()).toContainText("Second line");
  await expect(page.getByText("@morgan:example.test", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeDisabled();
  await expect(page.getByText("Replying is unavailable for this thread on this connection.")).toBeVisible();
});
