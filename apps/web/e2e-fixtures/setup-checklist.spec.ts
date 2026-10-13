import { test, expect, type Page } from "@playwright/test";

const open = async (page: Page, query = "") => {
  await page.goto(`/e2e-fixtures/setup-checklist.html${query}`);
  await expect(page.getByRole("region", { name: "Setup" })).toBeVisible();
};
const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`);
const finish = (page: Page, id: string) => page.evaluate((which) => (window as any).setupFixture.done(which), id);

test("the checklist says what is left, group by group, and ticks a step when it is finished elsewhere", async ({ page }) => {
  await open(page);
  const setup = page.getByRole("region", { name: "Setup" });
  // Optional steps never count as "left".
  await expect(setup.getByRole("heading", { name: "5 steps left" })).toBeVisible();
  await expect(setup).toContainText("Finish the first group to start using Prism.");
  await expect(page.getByRole("group", { name: "Your workspace" })).toContainText("3 of 4");
  await expect(step(page, "vault")).toHaveAttribute("data-done", "true");
  await expect(step(page, "secrets")).toContainText("SECRETS_KEY is not set");
  // An agent finishes the step somewhere else: nobody presses anything here.
  await finish(page, "secrets");
  await expect(step(page, "secrets")).toHaveAttribute("data-done", "true");
  await expect(setup.getByRole("heading", { name: "4 steps left" })).toBeVisible();
  await expect(setup).toContainText("Prism is ready to use.");
  await expect(step(page, "secrets").getByRole("button")).toHaveCount(0);
  for (const id of ["agent-token", "agent-connected", "reachable", "device"]) await finish(page, id);
  await expect(setup.getByRole("heading", { name: "Setup is complete" })).toBeVisible();
  // Still offered, never required.
  await expect(step(page, "integration:matrix")).toContainText("Messages (Matrix)");
  await expect(step(page, "integration:matrix")).toHaveAttribute("data-done", "false");
});

test("each unfinished step can be handed to an agent or done by hand", async ({ page }) => {
  await open(page);
  const row = step(page, "reachable");
  await row.getByRole("button", { name: "Have your agent do it" }).click();
  await expect(row.getByRole("button", { name: "Copied. Paste it to your agent" })).toBeVisible();
  const prompt = await page.evaluate(() => (window as any).setupFixture.copied.at(-1) as string);
  // The prompt names the step the setup skill keys on, where it stands and which server.
  expect(prompt).toContain("prism-setup skill");
  expect(prompt).toContain("Step: reachable — Reachable from other devices.");
  expect(prompt).toContain("A phone needs an https address");
  expect(prompt).toContain("http://localhost:8787");
  const mine = row.getByRole("button", { name: "Do it myself" });
  await expect(mine).toHaveAttribute("aria-expanded", "false");
  await mine.click();
  await expect(mine).toHaveAttribute("aria-expanded", "true");
  await expect(row).toContainText("Install Tailscale on this computer and your phone");
});

test("a server that stops answering keeps the last list on screen and says so", async ({ page }) => {
  await open(page);
  await expect(step(page, "vault")).toBeVisible();
  await page.evaluate(() => { (window as any).setupFixture.fail = true; });
  await expect(page.getByText("Setup progress could not be refreshed. Showing what was last read.")).toBeVisible();
  await expect(step(page, "vault")).toHaveAttribute("data-done", "true");
  await page.evaluate(() => { (window as any).setupFixture.fail = false; });
  await expect(page.getByText("Setup progress could not be refreshed.")).toHaveCount(0);
});

for (const width of [1280, 390])
  test(`the checklist fits ${width}px without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
