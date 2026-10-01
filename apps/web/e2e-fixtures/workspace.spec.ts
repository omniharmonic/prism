import { test, expect } from "@playwright/test";

test("shared workspace keeps writing and navigation available", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await expect(page.getByText("A shared place to think, write, and build with the same context.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Agent unavailable")).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-desktop.png", fullPage: true, animations: "disabled" });
});

test("mobile workspace fits the viewport and opens navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/workspace-mobile-document.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("button", { name: "Inbox" })).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-mobile.png", fullPage: true, animations: "disabled" });
});

test("mobile collaborative title keeps full width with presence and comment controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html?header");
  const title = page.getByRole("heading", { name: "prism-native-workspace-20261001" });
  const titleBox = await title.boundingBox();
  const statusBox = await page.getByText("Live · Editing", { exact: true }).boundingBox();
  expect(titleBox!.width).toBeGreaterThan(300);
  expect(statusBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height);
  await expect(page.getByRole("button", { name: "Comments" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("mobile-collaborative-title.png") });
});

test("mobile agent panel fills the screen and restores navigation focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  await agent.click();
  const panel = page.getByRole("dialog", { name: "Document panel" });
  await expect(panel).toBeVisible();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(390);
  await expect(panel.getByRole("tab", { name: "Agent", exact: true })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: "Agent", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByRole("tab", { name: "Details", exact: true })).toBeFocused();
  await expect(panel.getByRole("tab", { name: "Properties" })).toBeVisible();
  await panel.getByRole("tab", { name: "Agent", exact: true }).click();
  await expect(panel.getByText("Agent unavailable")).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-mobile-agent.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(agent).toBeFocused();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("button", { name: "Files", exact: true })).toBeFocused();
});

test("document title supports keyboard rename and cancel", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const title = page.getByRole("button", { name: "Rename A living workspace" });
  await title.focus();
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "Document title" });
  await expect(input).toBeFocused();
  await input.fill("Temporary title");
  await input.press("Escape");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  expect(await page.locator(".prose-editor ul").first().evaluate((node) => getComputedStyle(node).listStyleType)).toBe("disc");
});

test("document autosave waits through unrelated workspace rerenders", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" A new idea.");
  // Updating the shared font registration used to flush the debounce early.
  await page.getByRole("button", { name: "Serif", exact: true }).click();
  const contentWrites = () => page.evaluate(() => (window as unknown as { prismFixtureWrites: Array<{ content?: string }> }).prismFixtureWrites.filter((w) => w.content !== undefined));
  expect(await contentWrites()).toHaveLength(0);
  await page.clock.runFor(1900);
  expect(await contentWrites()).toHaveLength(0);
  await page.clock.runFor(200);
  await expect.poll(async () => (await contentWrites()).length).toBe(1);
  expect((await contentWrites())[0].content).toContain("A new idea.");
  await page.clock.resume();
  await expect(page.getByText(/^Saved /)).toBeVisible();
});

test("failed document saves remain retryable without losing the typed content", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.evaluate(() => { (window as unknown as { prismFixtureControls: { rejectWrite: boolean } }).prismFixtureControls.rejectWrite = true; });
  await editor.click();
  await editor.pressSequentially("Keep this draft. ");
  await editor.press("ControlOrMeta+s");
  await expect(page.getByRole("alert")).toContainText("Changes could not be saved");
  await expect(editor).toContainText("Keep this draft.");
  await page.evaluate(() => { (window as unknown as { prismFixtureControls: { rejectWrite: boolean } }).prismFixtureControls.rejectWrite = false; });
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/^Saved /)).toBeVisible();
  const writes = await page.evaluate(() => (window as unknown as { prismFixtureWrites: Array<{ content?: string }> }).prismFixtureWrites.filter((w) => w.content !== undefined));
  expect(writes).toHaveLength(2);
  expect(writes[1].content).toBe(writes[0].content);
});

test("command search opens usable phone settings and Escape closes the modal", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill("Settings");
  await search.getByRole("option", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(search).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Appearance", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await settings.getByRole("button", { name: "Close settings" }).focus();
  await page.screenshot({ path: testInfo.outputPath("settings-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
});

test("rich-text bold shortcut edits the document without closing navigation", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("button", { name: "Inbox", exact: true })).toBeVisible();
  const editor = page.locator(".tiptap[contenteditable=true]");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("BOLD_SHORTCUT_FIXTURE");
  await expect(editor.locator("strong")).toContainText("BOLD_SHORTCUT_FIXTURE");
  await expect(page.getByRole("button", { name: "Inbox", exact: true })).toBeVisible();
});


test("linked document choices survive desktop/mobile layout changes", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureOpenLink());
  const picker = page.getByRole("dialog", { name: "Open linked document" });
  const choice = picker.getByRole("button", { name: "Duplicate Projects/Prism/Field notes" });
  await expect(choice).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Files", exact: true })).toBeAttached();
  await expect(choice).toBeVisible();
  expect(await picker.evaluate(e => (e as HTMLDialogElement).open)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Files", exact: true })).toHaveCount(0);
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Field notes", exact: true }).first()).toBeVisible();
});
