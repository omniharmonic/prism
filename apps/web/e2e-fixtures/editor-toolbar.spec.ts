import { test, expect, type Page } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;
const html = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);

/** Select a block's text and wait for the editor state (selectionchange is async). */
async function select(page: Page, text: string) {
  await page.getByText(text, { exact: true }).click();
  await page.getByText(text, { exact: true }).selectText();
  await expect.poll(() => page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; const { from, to } = e.state.selection; return e.state.doc.textBetween(from, to); })).toBe(text);
  const bubble = page.locator(".document-selection-actions:visible, .cd-bubble:visible").first();
  await expect(bubble).toBeVisible();
  return bubble;
}

test.describe("plain editor selection toolbar", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  });

  test("Notion-like order: turn into, marks, link, colour", async ({ page }) => {
    const bubble = await select(page, "Bravo paragraph");
    const names = await bubble.getByRole("button").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    expect(names).toEqual([
      "Turn into (now Text)", "Bold selection", "Italic selection", "Underline selection", "Strikethrough selection", "Code selection", "Link", "Text color and highlight",
    ]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/selection-toolbar-1440.png` });
  });

  test("bold, italic, underline, strikethrough and code toggle on the selection", async ({ page }) => {
    const bubble = await select(page, "Bravo paragraph");
    for (const name of ["Bold", "Italic", "Underline", "Strikethrough"]) {
      await bubble.getByRole("button", { name: `${name} selection` }).click();
      await expect(bubble.getByRole("button", { name: `${name} selection` })).toHaveAttribute("aria-pressed", "true");
    }
    const out = await html(page);
    for (const tag of ["strong", "em", "u", "s"]) expect(out, tag).toMatch(new RegExp(`<${tag}>`));
    // Inline code excludes other marks (TipTap's code mark), so it replaces them.
    await select(page, "Foxtrot closing");
    await page.getByRole("button", { name: "Code selection" }).click();
    expect(await html(page)).toContain("<p><code>Foxtrot closing</code></p>");
  });

  test("links are typed inline, validated, applied and removable", async ({ page }) => {
    let bubble = await select(page, "Bravo paragraph");
    await bubble.getByRole("button", { name: "Link", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Link address" });
    await expect(field).toBeFocused();
    await field.fill("javascript:alert(1)");
    await field.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Use a web, mail or page link." })).toBeVisible();
    expect(await html(page)).not.toContain("javascript");
    await field.fill("//evil.example.test/x");
    await field.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Use a web, mail or page link." })).toBeVisible();
    expect(await html(page)).not.toContain("evil");
    await field.fill("example.test/docs");
    await field.press("Enter");
    expect(await html(page)).toContain('href="https://example.test/docs"');
    bubble = await select(page, "Bravo paragraph");
    await expect(bubble.getByRole("button", { name: "Link", exact: true })).toHaveAttribute("aria-pressed", "true");
    await bubble.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Link address" })).toHaveValue("https://example.test/docs");
    await page.getByRole("button", { name: "Remove link" }).click();
    expect(await html(page)).not.toContain("<a ");
    // Escape cancels without changing anything.
    bubble = await select(page, "Foxtrot closing");
    await bubble.getByRole("button", { name: "Link", exact: true }).click();
    await page.getByRole("textbox", { name: "Link address" }).press("Escape");
    await expect(page.getByRole("textbox", { name: "Link address" })).toHaveCount(0);
  });

  test("text colour and highlight come from the token palette", async ({ page }) => {
    const bubble = await select(page, "Bravo paragraph");
    const color = bubble.getByRole("button", { name: "Text color and highlight" });
    await color.click();
    const menu = page.getByRole("menu", { name: "Color" });
    await expect(menu.getByRole("menuitemradio", { name: "Default" })).toHaveAttribute("aria-checked", "true");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/selection-color-1440.png` });
    await menu.getByRole("menuitemradio", { name: "Red", exact: true }).click();
    expect(await html(page)).toContain('<span data-text-color="red">Bravo paragraph</span>');
    await select(page, "Bravo paragraph");
    await page.getByRole("button", { name: "Text color and highlight" }).click();
    await page.getByRole("menuitemradio", { name: "Yellow highlight" }).click();
    expect(await html(page)).toMatch(/<mark data-color="var\(--prism-color-yellow-bg\)"[^>]*>/);
    // Keyboard: Escape closes the menu and returns focus to its button.
    await select(page, "Foxtrot closing");
    const again = page.getByRole("button", { name: "Text color and highlight" });
    await again.click();
    await expect(page.getByRole("menu", { name: "Color" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "Color" })).toHaveCount(0);
    await expect(again).toBeFocused();
  });

  test("turn into re-shapes the selected block", async ({ page }) => {
    const bubble = await select(page, "Foxtrot closing");
    await bubble.getByRole("button", { name: /^Turn into/ }).click();
    await page.getByRole("menuitemradio", { name: "Heading 2" }).click();
    expect(await html(page)).toContain("<h2>Foxtrot closing</h2>");
  });

  test("phones: the toolbar stays on screen with 44px targets", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/e2e-fixtures/editor-blocks.html");
    const bubble = await select(page, "Bravo paragraph");
    const box = await bubble.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    const bold = await bubble.getByRole("button", { name: "Bold selection" }).boundingBox();
    expect(bold!.height).toBeGreaterThanOrEqual(44);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/selection-toolbar-390.png` });
  });
});

test("live editor: the toolbar carries Comment, which anchors a thread on the selection", async ({ page }) => {
  const server = new Server({ address: "127.0.0.1", port: 0, quiet: true, debounce: 10, async onAuthenticate() { return { fixture: true }; } });
  await server.listen();
  const sockets: WebSocket[] = [];
  try {
    await page.routeWebSocket(/\/collab(\?|$)/, (route) => {
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage((m) => (socket.readyState === WebSocket.OPEN ? socket.send(m) : pending.push(m)));
      socket.on("open", () => { for (const m of pending) socket.send(m); });
      socket.on("message", (m, binary) => route.send(binary ? Buffer.from(m as Buffer) : m.toString()));
      route.onClose(() => socket.close()); socket.on("close", () => route.close({ code: 1000 }));
    });
    await page.route("**/auth/me", (r) => r.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
    await page.route("**/api/notes/denied-note", (r) => r.fulfill({ json: { id: "denied-note", path: "Projects/Prism/Shared", content: "", _level: "own", metadata: {}, tags: [] } }));
    await page.route("**/api/federated/**", (r) => r.fulfill({ status: 204 }));
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    const editor = page.locator(".tiptap[contenteditable=true]");
    await editor.click();
    await page.keyboard.type("Shared sentence to discuss");
    const bubble = await select(page, "Shared sentence to discuss");
    await expect(bubble.getByRole("button", { name: "Bold selection" })).toBeVisible();
    await bubble.getByRole("button", { name: "Comment on selection" }).click();
    await page.getByPlaceholder(/Add a comment/).fill("Can we tighten this?");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect.poll(() => html(page)).toMatch(/data-comment/);
    // While suggesting, untracked decorations (link, colour) are not offered.
    await page.getByRole("button", { name: "Editing", exact: true }).click();
    await expect(page.getByRole("button", { name: "Suggesting", exact: true })).toBeVisible();
    const suggestingBubble = await select(page, "Shared sentence to discuss");
    await expect(suggestingBubble.getByRole("button", { name: "Bold selection" })).toBeVisible();
    await expect(suggestingBubble.getByRole("button", { name: "Link", exact: true })).toHaveCount(0);
    await expect(suggestingBubble.getByRole("button", { name: "Text color and highlight" })).toHaveCount(0);
    await expect(suggestingBubble.getByRole("button", { name: /^Turn into/ })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/collab-comment-1280.png` });
  } finally {
    for (const s of sockets) s.close();
    await server.destroy();
  }
});
