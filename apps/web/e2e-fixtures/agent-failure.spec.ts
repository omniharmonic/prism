/**
 * w16 — an agent run that FAILS says what happened and what to do, everywhere.
 *
 * The incident: "Summarize" on a message thread answered only
 *   The summary ended with status “error”. Your original reply is unchanged.
 * because the server's `claude` CLI could not sign in. Every entry point now shows the
 * shared copy (packages/core/src/lib/agent/failure.ts) and offers Try again where
 * retrying can help; the person's own text is never touched.
 *
 * Fixtures: messages.html (fake AgentClient, `prismReplyAgent.failNext`) and
 * notion-page-agent.html (fake HostServices.agentText, `prismPageAgent.failCode`).
 */
import { test, expect, type Page } from "@playwright/test";

const AUTH = "The agent couldn’t sign in on the server. Try again; if it keeps happening, sign in to Claude on the server (run `claude` there and log in).";

test("thread summary: a sign-in failure reads as one, keeps the instructions, and Try again produces the summary", async ({ page }) => {
  await page.goto("/e2e-fixtures/messages.html?email&agent&authfail");
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  const instructions = page.getByRole("textbox", { name: "Summary instructions" });
  await expect(instructions).toBeEnabled();
  await instructions.fill("Focus on decisions.");
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();

  const outcome = page.getByTestId("agent-draft-outcome");
  await expect(outcome).toContainText(AUTH);
  await expect(outcome).toContainText("No summary was saved; your instructions are kept.");
  await expect(outcome).toHaveAttribute("role", "alert");
  await expect(outcome).toHaveAttribute("data-error-code", "auth");
  // Never the bare status word, never the CLI's line as if it were the summary.
  await expect(page.getByText("ended with status", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Saved summary", exact: true })).toHaveCount(0);
  await expect(page.getByText("OAuth token", { exact: false })).toHaveCount(0);
  await expect(instructions).toHaveValue("Focus on decisions.");

  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("region", { name: "Saved summary", exact: true })).toContainText("The team agreed to meet Tuesday.");
  await expect(outcome).toHaveCount(0);
  const sends = await page.evaluate(() => (window as any).prismReplyAgent.sends as Array<{ prompt: string; requestId?: string }>);
  expect(sends).toHaveLength(2);
  expect(sends[1]!.prompt).toBe(sends[0]!.prompt); // the same instructions…
  expect(sends[1]!.requestId).not.toBe(sends[0]!.requestId); // …as a NEW request (replaying the old one would hand back the failure)
  expect(await page.evaluate(() => (window as any).prismMessagesFixture.attempts)).toBe(0); // nothing was sent to anyone
});

const doc = (page: Page) => page.locator("#workspace-document .tiptap").first();
const panel = (page: Page) => page.getByRole("dialog", { name: /^Agent · / });
const setRun = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => Object.assign((window as any).prismPageAgent, p), patch);
async function summarize(page: Page) {
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Summarize page", exact: true }).click();
}

test("page panel: sign-in failure copy + Try again; a failure retrying cannot fix offers none; the page is unchanged", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-page-agent.html?open=brief");
  await expect(doc(page)).toBeVisible();
  const before = await doc(page).innerText();

  await setRun(page, { fail: true, failCode: "auth" });
  await summarize(page);
  const alert = panel(page).getByRole("alert");
  await expect(alert).toHaveText(`${AUTH} Nothing was changed.`);
  await expect(alert).toHaveAttribute("data-error-code", "auth");
  await expect(panel(page)).not.toContainText("Working…"); // no spinner left behind
  await expect(panel(page).getByRole("region", { name: "Agent result" })).toHaveCount(0);
  expect(await doc(page).innerText()).toBe(before);

  await setRun(page, { fail: false });
  await panel(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(panel(page).getByRole("region", { name: "Agent result" })).toContainText("First point of the summary.");
  await panel(page).getByRole("button", { name: "Discard", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);

  // Usage limit: its own sentence, still retryable (later).
  await setRun(page, { fail: true, failCode: "usage_limit" });
  await summarize(page);
  await expect(panel(page).getByRole("alert")).toHaveText("Claude’s usage limit was reached. Try again later. Nothing was changed.");
  await expect(panel(page).getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await panel(page).getByRole("button", { name: /^(Close|Discard|Cancel)$/ }).first().click();
  await expect(panel(page)).toHaveCount(0);

  // The CLI is not installed on the server: trying again cannot help, so it is not offered.
  await setRun(page, { fail: true, failCode: "cli_missing" });
  await summarize(page);
  await expect(panel(page).getByRole("alert")).toContainText("The agent isn’t installed on the server");
  await expect(panel(page).getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  expect(await doc(page).innerText()).toBe(before);
});
