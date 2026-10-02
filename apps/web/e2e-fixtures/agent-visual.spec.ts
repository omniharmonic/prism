import { test, expect } from "@playwright/test";

for (const width of [1440, 390, 320]) test(`agent history, permissions and composer remain usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 });
  await page.goto("/e2e-fixtures/agent.html?history&permissions&visual");
  await expect(page.getByTestId("agent-conversation-title")).toHaveText("Shape the launch brief");
  await expect(page.getByTestId("agent-working-document")).toContainText("Draft brief");
  await expect(page.getByRole("combobox", { name: "Agent permissions" })).toHaveValue("read-only");
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("Keep this thoughtful follow-up while I review the page.");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.classList.toggle("light", theme === "light"), theme);
    await expect(page.getByTestId("agent-send")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`agent-workspace-${width}-${theme}.png`), animations: "disabled" });
  }
  if (width < 640) {
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await page.getByRole("textbox", { name: "Filter recent conversations" }).fill("launch");
    await expect(page.getByTestId("agent-session-row")).toHaveCount(1);
    await page.getByTestId("agent-session-row").click();
    await expect(input).toHaveValue("Keep this thoughtful follow-up while I review the page.");
  } else {
    await page.getByRole("textbox", { name: "Filter recent conversations" }).fill("weekly");
    await expect(page.getByTestId("agent-session-row")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Earlier", exact: true })).toContainText("Review the weekly plan");
    await expect(input).toHaveValue("Keep this thoughtful follow-up while I review the page.");
  }
});

test("session list errors offer recovery and a local filter cannot claim whole-history search", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html?history&permissions&visual&list-error");
  await expect(page.getByRole("alert")).toContainText("Couldn’t refresh conversations");
  await page.evaluate(() => { (window as any).prismAgentFixture.listFails = false; });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("agent-session-row")).toHaveCount(3);
  await page.getByRole("textbox", { name: "Filter recent conversations" }).fill("not-in-this-list");
  await expect(page.getByText("No recent conversations match this filter.", { exact: true })).toBeVisible();
});
