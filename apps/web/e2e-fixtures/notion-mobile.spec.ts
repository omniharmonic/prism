import { test, expect, type Page } from "@playwright/test";
import { touchDrag } from "./browser-compat";

/** Wave 2E · NP-MB-06 edge swipe (synthetic touch events; the visible Back and
 *  Browse buttons stay the alternatives). */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function swipe(page: Page, fromX: number, toX: number, y = 420) {
  await touchDrag(page, { x: fromX, y, dx: toX - fromX, steps: 6, cancelable: false });
}

test("edge swipe goes back, else opens the drawer; mid-screen swipes are left to the page", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await swipe(page, 120, 300);
  await expect(drawer).toHaveCount(0);
  await swipe(page, 6, 200);
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await expect(drawer).toHaveCount(0);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.getByText("Field notes", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeEnabled();
  await swipe(page, 6, 220);
  await expect.poll(() => page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("workspace");
  await expect(drawer).toHaveCount(0);
  // A sideways scroller that reaches the screen edge keeps its own drag.
  await page.evaluate(() => {
    const scroller = document.createElement("div");
    scroller.id = "wide";
    scroller.style.cssText = "position:fixed;left:0;top:380px;width:200px;height:80px;overflow-x:auto;z-index:5";
    scroller.innerHTML = '<div style="width:900px;height:60px"></div>';
    document.body.append(scroller);
  });
  await swipe(page, 6, 220);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("workspace");
  await expect(drawer).toHaveCount(0);
});

test("keyboard toolbar complete", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.locator("p").first().tap();
  const toolbar = page.getByRole("toolbar", { name: "Editing toolbar" });
  await expect(toolbar).toBeVisible();
  for (const name of ["Insert block", "Turn into", "Bold", "Italic", "Underline", "Strikethrough", "Link", "To-do", "Indent", "Outdent", "Mention", "Image", "Undo", "Redo", "Dismiss keyboard"]) {
    await expect(toolbar.getByRole("button", { name, exact: true })).toHaveCount(1);
  }
  for (const box of await toolbar.getByRole("button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  // A software keyboard (visualViewport shrinks): the toolbar rides on it, the bottom bar hides, the caret stays visible.
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, "height", { configurable: true, get: () => 480 });
    vv.dispatchEvent(new Event("resize"));
  });
  await expect(toolbar).toHaveAttribute("data-keyboard-inset", String(844 - 480));
  const bar = await toolbar.boundingBox();
  expect(Math.round(bar!.y + bar!.height)).toBeLessThanOrEqual(481);
  await expect(page.getByRole("navigation", { name: "Mobile workspace" })).toBeHidden();
  // The caret's line is fully visible: above the toolbar and not under any other chrome.
  await expect.poll(() => page.evaluate(() => {
    const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
    const hit = document.elementFromPoint(40, r.top + r.height / 2);
    return r.bottom <= document.querySelector('[aria-label="Editing toolbar"]')!.getBoundingClientRect().top && !!hit?.closest(".tiptap");
  })).toBe(true);
  await page.screenshot({ path: info.outputPath("keyboard-toolbar.png") });
  // Commands act on the editor without losing it.
  await page.keyboard.press("End");
  await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
  await page.keyboard.type(" strong words");
  await expect(editor.locator("strong")).toHaveText("strong words");
  await toolbar.getByRole("button", { name: "Turn into", exact: true }).click();
  await page.getByRole("group", { name: "Turn into" }).getByRole("button", { name: "Heading 3" }).click();
  await expect(editor.locator("h3")).toContainText("strong words");
  await toolbar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor.locator("h3")).toHaveCount(0);
  await toolbar.getByRole("button", { name: "To-do", exact: true }).click();
  await expect(editor.locator("ul[data-type=taskList]")).toHaveCount(1);
  await toolbar.getByRole("button", { name: "Insert block", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
  await page.keyboard.press("Escape");
  await toolbar.getByRole("button", { name: "Dismiss keyboard", exact: true }).click();
  await expect(toolbar).toHaveCount(0);
  await expect(editor).not.toBeFocused();
});

test("the bottom bar carries Inbox with its unread badge; Messages moves to More", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?inbox");
  const bar = page.getByRole("navigation", { name: "Mobile workspace" });
  const inbox = bar.getByRole("button", { name: "Inbox, 3 unread" });
  await expect(inbox).toBeVisible();
  await expect(inbox).toContainText("Inbox");
  await expect(inbox.locator(".prism-inbox-badge")).toHaveText("3");
  await expect(bar.getByRole("button", { name: "Messages", exact: true })).toHaveCount(0);
  await expect(bar.getByRole("button")).toHaveCount(5);
  await inbox.click();
  await expect(inbox).toHaveAttribute("aria-pressed", "true");
  await bar.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("button", { name: "Messages", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("without a notifications inbox the bar keeps Messages", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const bar = page.getByRole("navigation", { name: "Mobile workspace" });
  await expect(bar.getByRole("button", { name: "Messages", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: /Inbox/ })).toHaveCount(0);
});

/** NP-MB-02 */
test("phone new page focuses title", async ({ page, context }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const bar = page.getByRole("navigation", { name: "Mobile workspace" });
  await bar.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("Untitled (2)");
  await expect(page.locator(".sync-state-phone")).toHaveAttribute("data-sync-state", "saved");
  await title.press("Escape");
  // Offline, the new page is a local draft and the header says so.
  await context.setOffline(true);
  await bar.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
  await expect(page.locator(".sync-state-phone")).toHaveText("Saved on this device");
  await context.setOffline(false);
  await expect(page.locator(".sync-state-phone")).toHaveAttribute("data-sync-state", "saved", { timeout: 15000 });
  expect(await page.evaluate(() => (window as any).prismShell.writes.filter((w: any) => w.method === "POST" && w.path === "/api/notes").length)).toBe(2);
});

/** NP-MB-03: the page sheet also carries Share, Find and Agent. */
test("page sheet rows: Share, Find in page, Agent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const open = async () => {
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "A living workspace" });
    await expect(sheet).toBeVisible();
    return sheet;
  };
  let sheet = await open();
  for (const name of ["Add to Favorites", "Share", "Copy link", "Move to…", "Lock page", "Version history", "Find in page", "Export as Markdown", "Move to Trash", "Agent"]) {
    const item = sheet.getByRole("button", { name, exact: true });
    await expect(item, name).toBeVisible();
    expect(await item.evaluate((el) => el.getBoundingClientRect().height), `${name} row height`).toBeGreaterThanOrEqual(44);
  }
  // Find opens the page's own find bar.
  await sheet.getByRole("button", { name: "Find in page", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /find/i }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  // Share opens the sharing dialog for this page.
  sheet = await open();
  await sheet.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /share/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /share/i })).toHaveCount(0);
  // Agent opens the companion on the agent tab.
  sheet = await open();
  await sheet.getByRole("button", { name: "Agent", exact: true }).click();
  await expect.poll(() => page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return [s.contextPanelOpen, s.contextPanelTab]; })).toEqual([true, "agent"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
