import { test, expect } from "@playwright/test";

/** Wave 2E · NP-SB-12 */
test("collapsed sidebar peeks on edge hover", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html?collapsed");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const peek = page.getByRole("complementary", { name: "Sidebar preview" });
  await expect(peek).toHaveCount(0);
  await page.mouse.move(400, 400);
  await page.mouse.move(3, 400, { steps: 4 });
  await expect(peek).toBeVisible();
  await expect(peek.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("sidebar-peek.png") });
  // Floating: the document keeps its width underneath.
  const zone = await page.getByTestId("sidebar-peek-zone").boundingBox();
  expect(zone!.width).toBeLessThanOrEqual(12);
  await page.mouse.move(900, 400, { steps: 6 });
  await expect(peek).toHaveCount(0);
  await page.mouse.move(3, 300, { steps: 4 });
  await expect(peek).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  // The pinned sidebar replaces the peek entirely.
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(page.getByTestId("sidebar-peek-zone")).toHaveCount(0);
});

test("the sidebar peek is reachable and dismissible from the keyboard", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?collapsed");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const trigger = page.getByRole("button", { name: "Show sidebar preview" });
  await trigger.focus();
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Enter");
  const peek = page.getByRole("complementary", { name: "Sidebar preview" });
  await expect(peek).toBeVisible();
  expect(await peek.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  // Mouse-out does not take a keyboard-opened preview away.
  await page.mouse.move(900, 400);
  await page.waitForTimeout(350);
  await expect(peek).toBeVisible();
  // Only one navigation exists at a time.
  await expect(page.locator(".workspace-navigation")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show sidebar preview" })).toBeFocused();
});

/** NP-SB-11 */
test("⌘\\ collapses and width persists", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?persisted");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  const nav = page.locator(".workspace-navigation");
  await expect(nav).toBeVisible();
  // ⌘\ works from inside the editor too (⌘B there is bold).
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(nav).toHaveCount(0);
  await expect(page.getByTestId("sidebar-peek-zone")).toBeVisible();
  // ⌘⇧\ is the info panel now; it leaves the sidebar alone.
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  await expect(page.getByRole("button", { name: "Info panel (⌘⇧\\)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(nav).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  // Collapsed survives a reload.
  await page.reload();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(nav).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(nav).toBeVisible();
  // Drag the divider: the new width survives a reload, clamped to 200–400.
  const before = (await nav.boundingBox())!;
  await page.mouse.move(before.x + before.width + 2, 300);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 62, 300, { steps: 5 });
  await page.mouse.up();
  const dragged = (await nav.boundingBox())!.width;
  expect(dragged).toBeGreaterThan(before.width + 40);
  await page.reload();
  await expect(nav).toBeVisible();
  expect(Math.abs((await nav.boundingBox())!.width - dragged)).toBeLessThanOrEqual(1);
});

/**
 * The shortcut sheet (⌘⇧/, or ?) and the handler read one table (`lib/shortcuts.ts`):
 * every shell row the sheet lists is pressed exactly as written, and must work.
 * ⌘B is Bold only — it never moves the sidebar, inside an editor or out.
 */
test("the shortcut sheet's shell rows are the working bindings", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  const nav = page.locator(".workspace-navigation");
  await expect(nav).toBeVisible();
  const ui = () => page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return { panel: s.contextPanelOpen as boolean, settings: s.settingsOpen as boolean, tab: s.activeTabId as string | null }; });

  await page.getByRole("button", { name: "Page actions", exact: true }).focus(); // outside the editor
  await page.keyboard.press("ControlOrMeta+Shift+/");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  const keysOf = async (label: string) => sheet.locator(".prism-shortcuts-row").filter({ has: page.getByText(label, { exact: true }) }).locator("kbd").allTextContents();
  // "⌘⇧\\" / "Ctrl+Shift+\\" → a Playwright chord.
  const chord = (text: string) => {
    const mods: string[] = [];
    let rest = text;
    for (const [sym, word, name] of [["⌘", "Ctrl+", "ControlOrMeta"], ["⇧", "Shift+", "Shift"], ["⌥", "Alt+", "Alt"]] as const) {
      if (rest.includes(sym)) { rest = rest.replace(sym, ""); mods.push(name); }
      else if (rest.includes(word)) { rest = rest.replace(word, ""); mods.push(name); }
    }
    const key = ({ "\\": "Backslash", "[": "BracketLeft", "]": "BracketRight", ",": "Comma", "/": "Slash" } as Record<string, string>)[rest] ?? rest;
    return [...mods, key].join("+");
  };
  const rows = {
    sidebar: await keysOf("Toggle sidebar"),
    panel: await keysOf("Toggle side panel"),
    history: await keysOf("Back / forward"),
    settings: await keysOf("Settings"),
    // Its row names the ⌘/ exception ("also ⌘/ outside a block"); its own keys are ⌘⇧/ and ?.
    sheet: await sheet.locator(".prism-shortcuts-row").filter({ hasText: /^Keyboard shortcuts \(also / }).locator("kbd").allTextContents(),
    bold: await keysOf("Bold"),
  };
  expect(rows.sidebar).toHaveLength(1);
  expect(rows.panel).toHaveLength(1);
  expect(rows.history).toHaveLength(2);
  expect(rows.bold.map(chord)).toEqual(["ControlOrMeta+B"]);
  // No sheet row gives ⌘B a second meaning.
  expect(await sheet.locator("kbd").filter({ hasText: /^(⌘B|Ctrl\+B)$/ }).count()).toBe(1);
  // The sheet's own key closes it again.
  await page.keyboard.press(chord(rows.sheet[0]));
  await expect(sheet).toHaveCount(0);

  // Sidebar: the listed key works from the page chrome AND from inside the editor.
  await page.keyboard.press(chord(rows.sidebar[0]));
  await expect(nav).toHaveCount(0);
  await editor.click();
  await page.keyboard.press(chord(rows.sidebar[0]));
  await expect(nav).toBeVisible();
  // ⌘B: bold in the editor, nothing outside it — the sidebar stays put either way.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press(chord(rows.bold[0]));
  await page.keyboard.type("BOLD_ONLY");
  await expect(editor.locator("strong").filter({ hasText: "BOLD_ONLY" })).toBeVisible();
  await expect(nav).toBeVisible();
  await page.keyboard.press(chord(rows.bold[0]));
  await page.getByRole("button", { name: "Page actions", exact: true }).focus();
  await page.keyboard.press(chord(rows.bold[0]));
  await expect(nav).toBeVisible();

  // Side panel.
  expect((await ui()).panel).toBe(false);
  await page.keyboard.press(chord(rows.panel[0]));
  await expect.poll(async () => (await ui()).panel).toBe(true);
  await expect(nav).toBeVisible();
  await page.keyboard.press(chord(rows.panel[0]));
  await expect.poll(async () => (await ui()).panel).toBe(false);

  // Back / forward: open a second page, then walk the history with the listed keys.
  const first = (await ui()).tab;
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect.poll(async () => (await ui()).tab).not.toBe(first);
  const second = (await ui()).tab;
  await page.getByRole("button", { name: "Page actions", exact: true }).focus();
  await page.keyboard.press(chord(rows.history[0]));
  await expect.poll(async () => (await ui()).tab).toBe(first);
  await page.keyboard.press(chord(rows.history[1]));
  await expect.poll(async () => (await ui()).tab).toBe(second);

  // Settings.
  await page.keyboard.press(chord(rows.settings[0]));
  await expect.poll(async () => (await ui()).settings).toBe(true);
});

/** NP-SB-05 */
test("recents are capped at 12 in the sidebar", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  // Visit 14 more pages.
  for (let i = 1; i <= 14; i++) {
    await page.evaluate((n) => {
      (window as any).prismShell.serverCreate(`Journal/Day ${n}`, `<p>Entry ${n}</p>`);
      (window as any).prismShellUI.getState().openTab(`foreign-${n}`, `Day ${n}`, "document");
    }, i);
    await expect(page.locator(".tiptap")).toContainText(`Entry ${i}`);
  }
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.preferences.recents.length)).toBe(15);
  const recent = page.locator(".workspace-navigation").getByRole("region", { name: "Recent", exact: true });
  const toggle = recent.getByRole("button", { name: "Recent", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const rows = recent.locator(".workspace-nav-row");
  await expect(rows).toHaveCount(12);
  // Most recent first; the oldest visits have dropped off the list.
  await expect(rows.first()).toContainText("Day 14");
  await expect(recent).not.toContainText("Day 2");
  await expect(recent).not.toContainText("A living workspace");
  // ⌘K's empty state lists recent pages too (its own, shorter cut).
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("group", { name: "Recent pages" });
  await expect(palette.getByRole("option").first()).toContainText("Day 14");
  expect(await palette.getByRole("option").count()).toBeLessThanOrEqual(12);
});

/** w16 (defect 23): no desktop status bar. What it held lives elsewhere: Settings in the sidebar
 *  footer (and ⌘, / ⌘K), the reading font in the page ⋯ menu, the note count and service health in
 *  Settings → Services. */
test("no status bar; its controls are reachable elsewhere", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(page.getByText(/^\d+ notes?$/)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Document font" })).toHaveCount(0);
  await expect(page.locator('button[title="Settings"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Serif font/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
});
