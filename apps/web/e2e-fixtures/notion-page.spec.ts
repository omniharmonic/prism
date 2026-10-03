import { test, expect } from "@playwright/test";

/** Wave 2E · NP-PG-06: one quiet header row with save state and labelled actions. */
test("header carries save state, Share, Agent, ⋯", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const saved = page.locator(".sync-state-header");
  const share = page.getByRole("button", { name: "Share", exact: true });
  const agent = page.getByRole("button", { name: "AI Agent", exact: true });
  const more = page.getByRole("button", { name: "Page actions", exact: true });
  const star = page.getByRole("button", { name: "Add to Favorites" });
  await expect(saved).toHaveText("Saved");
  await expect(share).toHaveText("Share");
  await expect(agent).toHaveText("Agent");
  await expect(more).toBeVisible();
  await expect(star).toBeVisible();
  const boxes = await Promise.all([saved, share, agent, more, star].map((l) => l.boundingBox()));
  const centre = boxes[0]!.y + boxes[0]!.height / 2;
  for (const b of boxes) expect(Math.abs(b!.y + b!.height / 2 - centre)).toBeLessThanOrEqual(3);
  await agent.click();
  await expect(page.getByLabel("Document companion")).toBeVisible();
  await page.screenshot({ path: info.outputPath("header-desktop.png") });
  await page.evaluate(() => { document.documentElement.classList.replace("light", "dark"); });
  await page.screenshot({ path: info.outputPath("header-desktop-dark.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sync-state-phone")).toHaveAttribute("data-sync-state", "saved");
  await expect(page.locator(".sync-state-phone .sync-state-dot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Page actions", exact: true })).toBeVisible();
  await expect(page.getByText("A living workspace").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("header-phone-dark.png") });
});
