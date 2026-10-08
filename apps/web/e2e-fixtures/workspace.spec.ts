import { test, expect } from "@playwright/test";

test("shared workspace keeps writing and navigation available", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await expect(page.getByText("A shared place to think, write, and build with the same context.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Messages" })).toBeVisible();
  await expect(page.getByText("Agent unavailable")).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-desktop.png", fullPage: true, animations: "disabled" });
});

test("mobile workspace fits the viewport and opens navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/workspace-mobile-document.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Messages" })).toBeVisible();
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
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("button", { name: "Notes", exact: true })).toBeFocused();
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
  // Pause a little AHEAD of now: the page's clock keeps running while this call travels, and
  // pausing at a time it has already passed is refused ("Cannot fast-forward to the past").
  await page.clock.pauseAt(new Date(Date.now() + 5_000));
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" A new idea.");
  // Updating the shared font registration used to flush the debounce early. (The font lives in the
  // page ⋯ menu since the status bar went, w16.)
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Serif font/ }).click();
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

// A 409 is NOT retryable (wave 2E review): it goes to conflict review — see
// notion-sync-state.spec.ts. Any other refusal keeps the draft and offers Retry.
test("failed document saves remain retryable without losing the typed content", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.evaluate(() => { (window as unknown as { prismFixtureControls: { rejectWrite: boolean; rejectWriteStatus: number } }).prismFixtureControls.rejectWriteStatus = 422; (window as unknown as { prismFixtureControls: { rejectWrite: boolean } }).prismFixtureControls.rejectWrite = true; });
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
  await expect(page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Messages", exact: true })).toBeVisible();
  const editor = page.locator(".tiptap[contenteditable=true]");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("BOLD_SHORTCUT_FIXTURE");
  await expect(editor.locator("strong")).toContainText("BOLD_SHORTCUT_FIXTURE");
  await expect(page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Messages", exact: true })).toBeVisible();
});


test("linked document choices survive desktop/mobile layout changes", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureOpenLink());
  const picker = page.getByRole("dialog", { name: "Open linked document" });
  const choice = picker.getByRole("button", { name: "Duplicate Projects/Prism/Field notes" });
  await expect(choice).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Notes", exact: true })).toBeAttached();
  await expect(choice).toBeVisible();
  expect(await picker.evaluate(e => (e as HTMLDialogElement).open)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Notes", exact: true })).toHaveCount(0);
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Field notes", exact: true }).first()).toBeVisible();
});

test("sharing survives the complete desktop/mobile workspace layout and restores focus", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("Invite people", { exact: true }).fill("unsent@example.test");
  await page.getByLabel("Collaborator permission").selectOption("suggest");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Notes", exact: true })).toBeAttached();
  await expect(page.getByLabel("Invite people", { exact: true })).toHaveValue("unsent@example.test");
  await expect(page.getByLabel("Collaborator permission")).toHaveValue("suggest");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Notes", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Invite people", { exact: true })).toHaveValue("unsent@example.test");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeFocused();
});


test("phone thread composer stays above the mobile workspace navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html?thread");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();
  const input = (await composer.boundingBox())!;
  const navigation = (await page.locator(".prism-mobile-navigation").boundingBox())!;
  expect(input.y + input.height).toBeLessThan(navigation.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator(".prism-mobile-navigation")).toHaveCount(0);
  await expect(composer).toBeVisible();
  expect(await composer.locator("..").locator("..").evaluate(e => getComputedStyle(e).paddingBottom)).toBe("12px");
});


test("the same editor and unsaved text survive both responsive breakpoints", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 5_000)); // ahead of now: the page clock runs while the call travels
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" RESPONSIVE_DRAFT_STAYS");
  await page.evaluate(() => (window as any).prismEditorBeforeResize = document.querySelector(".tiptap[contenteditable=true]"));
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".prism-mobile-navigation")).toHaveCount(width === 390 ? 1 : 0);
    expect(await page.evaluate(() => (window as any).prismEditorBeforeResize === document.querySelector(".tiptap[contenteditable=true]"))).toBe(true);
    await expect(editor).toContainText("RESPONSIVE_DRAFT_STAYS");
    expect(await page.evaluate(() => (window as any).prismFixtureWrites.filter((w: any) => w.content !== undefined))).toEqual([]);
  }
  await page.clock.runFor(2100);
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureWrites.filter((w: any) => w.content !== undefined).length)).toBe(1);
  await page.clock.resume();
});


test("live thread view survives desktop and phone layout changes", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?thread&live");
  await page.getByRole("button", { name: "View latest messages" }).click();
  await expect(page.getByText("LIVE_RESPONSIVE_THREAD_FIXTURE", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).prismThreadBeforeResize = document.querySelector(".workspace-message-thread"));
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".prism-mobile-navigation")).toHaveCount(width === 390 ? 1 : 0);
    await expect(page.getByText("LIVE_RESPONSIVE_THREAD_FIXTURE", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).prismThreadBeforeResize === document.querySelector(".workspace-message-thread"))).toBe(true);
  }
});

test("focused canvas remains mounted and keeps new mobile controls inert until it closes", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?session&canvas");
  await expect(page.getByText("Open a document", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("focus-canvas", "Canvas fixture", "canvas"));
  await page.getByRole("button", { name: "Focus canvas", exact: true }).click();
  await page.evaluate(() => (window as any).prismCanvasBeforeResize = document.querySelector(".excalidraw"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".prism-mobile-navigation")).toHaveCount(1);
  const focused = page.getByRole("dialog", { name: "Focused canvas" });
  await expect(focused).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismCanvasBeforeResize === document.querySelector(".excalidraw"))).toBe(true);
  expect(await page.locator(".prism-mobile-navigation").evaluate(e => !!e.closest("[inert]"))).toBe(true);
  expect((await focused.boundingBox())!.width).toBe(390);
  await focused.getByRole("button", { name: "Back to document", exact: true }).click();
  expect(await page.locator(".prism-mobile-navigation").evaluate(e => !!e.closest("[inert]"))).toBe(false);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
});


test("focused canvas owns shortcuts until it closes without trapping search behind it", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?session&canvas");
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("focus-canvas", "Canvas fixture", "canvas"));
  await page.getByRole("button", { name: "Focus canvas", exact: true }).click();
  const focused = page.getByRole("dialog", { name: "Focused canvas" });
  await expect(focused).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Search workspace", includeHidden: true })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+w");
  await expect(focused).toBeVisible();
  await focused.getByRole("button", { name: "Back to document", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
  await expect(page.getByRole("combobox")).toBeFocused();
});
