import { test, expect } from "@playwright/test";

test("tablet companion overlays instead of squeezing the document and restores focus", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.goto("/e2e-fixtures/workspace.html");
  const panel = page.getByRole("dialog", { name: "Document panel" });
  await expect(panel).toBeVisible();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(420);
  const canvas = page.locator("#workspace-document");
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(700);
  await page.screenshot({ path: info.outputPath("tablet-companion.png") });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  const opener = page.getByRole("button", { name: "Info panel (⌘⇧\\)", exact: true });
  await opener.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
});

test("resizing preserves the editor, unsent agent draft, binding and saved widths", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/workspace.html?agent");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await editor.fill("RESPONSIVE_DOCUMENT_DRAFT");
  await page.evaluate(() => { (window as any).prismEditorBeforeResize = document.querySelector(".tiptap"); });
  const prompt = page.getByPlaceholder("Ask the agent…");
  await expect(prompt).toBeVisible();
  await prompt.fill("RESPONSIVE_AGENT_DRAFT");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByRole("dialog", { name: "Document panel" })).toBeVisible();
  await expect(prompt).toHaveValue("RESPONSIVE_AGENT_DRAFT");
  await expect(editor).toContainText("RESPONSIVE_DOCUMENT_DRAFT");
  expect(await page.evaluate(() => (window as any).prismEditorBeforeResize === document.querySelector(".tiptap"))).toBe(true);
  await page.screenshot({ path: info.outputPath("tablet-agent-draft.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog", { name: "Document panel" })).toHaveCount(0);
  await expect(prompt).toHaveValue("RESPONSIVE_AGENT_DRAFT");
  expect(await page.evaluate(() => (window as any).prismEditorBeforeResize === document.querySelector(".tiptap"))).toBe(true);
  expect(await page.evaluate(() => { const state = (window as any).prismFixtureUI.getState(); return [state.sidebarWidth, state.contextPanelWidth]; })).toEqual([240, 360]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(prompt).toHaveValue("RESPONSIVE_AGENT_DRAFT");
  await page.keyboard.press("Escape");
  await expect(editor).toContainText("RESPONSIVE_DOCUMENT_DRAFT");
  expect(await page.evaluate(() => (window as any).prismEditorBeforeResize === document.querySelector(".tiptap"))).toBe(true);
});
