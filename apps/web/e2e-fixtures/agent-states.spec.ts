import { test, expect } from "@playwright/test";
async function open(page: import("@playwright/test").Page) {
  await page.goto("/e2e-fixtures/agent-states.html");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
}
test("activity outcomes and long summaries remain readable with compact reconnect feedback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(() => { (window as any).prismAgentStates.activity(); (window as any).prismAgentStates.reconnect(); });
  await expect(page.getByTestId("agent-tool-chip").first()).toContainText("Completed");
  await expect(page.getByTestId("agent-tool-chip").last()).toContainText("In progress");
  await expect(page.getByRole("status")).toContainText("Reconnecting…");
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Keep this follow-up during reconnect.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("agent-activity-reconnect-mobile.png"), animations: "disabled" });
});
test("double Stop remains one request and waits for authoritative completion", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Stop", exact: true }).dblclick();
  await expect(page.getByRole("button", { name: "Stop requested", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).prismAgentStates.settle(true));
  await expect(page.getByRole("button", { name: "Stop requested", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismAgentStates.stops)).toEqual(["first-turn"]);
  await page.evaluate(() => (window as any).prismAgentStates.finish());
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-turn-problem")).toContainText("Cancelled.");
});
test("terminal status before a late stop failure does not resurrect stop state or show a false error", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => { (window as any).prismAgentStates.finish(); (window as any).prismAgentStates.fail(); });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop requested", exact: true })).toHaveCount(0);
});
test("a failed stop keeps the live turn and draft, with an explicit uncertainty message", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Keep my unsent follow-up.");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => (window as any).prismAgentStates.fail());
  await expect(page.getByRole("alert")).toContainText("Stopping was not confirmed");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toHaveValue("Keep my unsent follow-up.");
});
for (const target of ["Switch session", "Unmount"]) test(`late stop response after ${target.toLowerCase()} cannot affect another conversation`, async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: target, exact: true }).click();
  await page.evaluate(() => (window as any).prismAgentStates.fail());
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismAgentStates.stops)).toEqual(["first-turn"]);
  if (target === "Switch session") await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
});


test("an unaccepted stop refreshes authoritative state without claiming completion", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => (window as any).prismAgentStates.settle(false));
  await expect(page.getByRole("alert")).toContainText("Stopping was not confirmed");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(page.getByTestId("agent-turn")).toHaveAttribute("data-status", "running");
});
