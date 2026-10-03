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

/** Wave 2E · NP-PG-08 */
test("full width, small text, font persist per page", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  const main = page.locator("#workspace-document");
  const measure = () => page.locator(".prose-editor").first().evaluate((n) => n.getBoundingClientRect().width);
  const narrow = await measure();
  const menu = () => page.getByRole("button", { name: "Page actions", exact: true }).click();
  await menu();
  await page.getByRole("menuitem", { name: /Full width/ }).click();
  await expect(main).toHaveAttribute("data-page-full", "true");
  expect(await measure()).toBeGreaterThan(narrow + 40);
  await menu();
  await page.getByRole("menuitem", { name: /Small text/ }).click();
  await expect(main).toHaveAttribute("data-page-small", "true");
  await menu();
  await page.getByRole("menuitem", { name: /Serif font/ }).click();
  await expect(page.locator("[data-content-font=serif]").first()).toBeVisible();
  // Style writes are metadata-only and never touch the body.
  const writes = await page.evaluate(() => (window as any).prismShell.writes as Array<{ path: string; body: any }>);
  expect(writes.filter((w) => w.path.endsWith("/meta")).every((w) => !("content" in w.body) && w.body.set.prism_page_style)).toBe(true);
  expect(writes.some((w) => "content" in w.body)).toBe(false);
  await page.screenshot({ path: info.outputPath("page-style-desktop.png") });
  // Another device (a fresh page) honours the stored style.
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(main).toHaveAttribute("data-page-full", "true");
  await expect(main).toHaveAttribute("data-page-small", "true");
  await expect(page.locator("[data-content-font=serif]").first()).toBeVisible();
  // Turning one flag off keeps the other.
  await menu();
  await page.getByRole("menuitem", { name: /Full width/ }).click();
  await expect(main).not.toHaveAttribute("data-page-full", "true");
  await expect(main).toHaveAttribute("data-page-small", "true");
  // Other pages keep their own style.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(page.getByText("Saturday: opening discussion", { exact: false })).toBeVisible();
  await expect(main).not.toHaveAttribute("data-page-small", "true");
});
