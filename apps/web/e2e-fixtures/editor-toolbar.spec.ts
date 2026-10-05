import { test, expect, type Page } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;
const html = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);

const selected = (page: Page) => page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; const { from, to } = e.state.selection; return e.state.doc.textBetween(from, to) as string; });

/**
 * Select a block's text and wait until the EDITOR holds that selection.
 *
 * `selectText()` writes the DOM selection from outside, which no person can do. ProseMirror
 * re-syncs the DOM to its own selection ~20 ms after it gains focus, and TipTap refocuses the
 * editor one frame after a toolbar command: a scripted selection made in that moment is undone
 * before the editor reads it (the editor then keeps the caret, or the previous selection, for
 * good — this was the intermittent failure of this file). So the selection is made again until
 * the editor's state has it; what is asserted afterwards is unchanged.
 */
async function select(page: Page, text: string) {
  const target = page.getByText(text, { exact: true });
  await expect(async () => {
    await target.click();
    await target.selectText();
    await expect.poll(() => selected(page), { timeout: 1000 }).toBe(text);
  }).toPass({ timeout: 10_000 });
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
      "Turn into (now Text)", "Bold selection", "Italic selection", "Underline selection", "Strikethrough selection", "Code selection", "Link", "Text color and highlight", "Mention a person, page or date",
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
    await expect.poll(() => html(page)).toContain("<p><code>Foxtrot closing</code></p>");
  });

  // NP-ED-05: the keyboard shortcuts themselves (the test above drives the buttons).
  test("⌘B ⌘I ⌘U ⌘⇧S ⌘E toggle marks from the keyboard", async ({ page }) => {
    const cases: Array<[string, string]> = [["b", "strong"], ["i", "em"], ["u", "u"], ["Shift+s", "s"], ["e", "code"]];
    for (const [key, tag] of cases) {
      await select(page, "Bravo paragraph");
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await expect.poll(() => html(page), { message: `Mod+${key} applies <${tag}>` }).toContain(`<p><${tag}>Bravo paragraph</${tag}></p>`);
      await expect(page.locator(".tiptap")).toBeFocused(); // the shortcut never moves focus to app chrome (⌘B is not "toggle sidebar" here)
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await expect.poll(() => html(page), { message: `Mod+${key} again removes it` }).toContain("<p>Bravo paragraph</p>");
    }
  });

  // NP-ED-05 / NP-ED-18: ⌘K with a text selection opens the inline link editor (no selection → quick find, the
  // shell's key); ⌘⇧H applies the highlight — the colour last picked in the toolbar. Replace moved to ⌘⌥F.
  test("⌘K link, ⌘⇧H highlight", async ({ page }) => {
    await select(page, "Bravo paragraph");
    await page.keyboard.press("ControlOrMeta+Shift+h");
    await expect.poll(() => html(page)).toContain("<p><mark>Bravo paragraph</mark></p>");
    await expect(page.getByRole("search", { name: "Find in note" })).toHaveCount(0); // not Replace any more
    await page.keyboard.press("ControlOrMeta+Shift+h");
    await expect.poll(() => html(page)).toContain("<p>Bravo paragraph</p>");
    // The last colour picked in the toolbar is what the shortcut applies next.
    await page.getByRole("button", { name: "Text color and highlight" }).click();
    await page.getByRole("menuitemradio", { name: "Blue highlight" }).click();
    const picked = (await html(page)).match(/<mark data-color="([^"]+)"/)![1];
    await select(page, "Foxtrot closing");
    await page.keyboard.press("ControlOrMeta+Shift+h");
    await expect.poll(() => html(page)).toContain(`<mark data-color="${picked}" style="background-color: ${picked}; color: inherit;">Foxtrot closing</mark>`);
    // ⌘K → the link field, typed and applied from the keyboard only.
    await select(page, "Echo quote");
    await page.keyboard.press("ControlOrMeta+k");
    const field = page.getByRole("textbox", { name: /link/i });
    await expect(field).toBeFocused();
    await page.keyboard.type("example.test/k");
    await page.keyboard.press("Enter");
    await expect.poll(() => html(page)).toContain('href="https://example.test/k"');
    // ⌘⌥F opens find with the replace row.
    await page.getByText("Alpha", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Alt+f");
    await expect(page.getByRole("textbox", { name: "Replace with" })).toBeVisible();
  });

  // NP-ED-17: Mention in the selection toolbar opens the @ menu right after the selection.
  test("the Mention button opens the @ menu after the selection", async ({ page }) => {
    const bubble = await select(page, "Bravo paragraph");
    await bubble.getByRole("button", { name: "Mention a person, page or date" }).click();
    await expect(page.getByRole("listbox", { name: "Mention a person, page or date" })).toBeVisible();
    await expect.poll(() => html(page)).toContain("<p>Bravo paragraph @</p>");
    await expect(page.locator(".tiptap")).toBeFocused();
    await page.keyboard.type("Road");
    await page.getByRole("option", { name: /Roadmap/ }).first().click();
    await expect.poll(() => html(page)).toMatch(/<p>Bravo paragraph <span[^>]*data-type="mention"[^>]*data-kind="page"[^>]*data-id="roadmap"/);
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
    await expect.poll(() => html(page)).toContain('href="https://example.test/docs"');
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
    await expect.poll(() => html(page)).toContain('<span data-text-color="red">Bravo paragraph</span>');
    await select(page, "Bravo paragraph");
    await page.getByRole("button", { name: "Text color and highlight" }).click();
    await page.getByRole("menuitemradio", { name: "Yellow highlight" }).click();
    await expect.poll(() => html(page)).toMatch(/<mark data-color="var\(--prism-color-yellow-bg\)"[^>]*>/);
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
    await expect.poll(() => html(page)).toContain("<h2>Foxtrot closing</h2>");
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
    // NP-ED-02: the block menu's Comment opens the same composer on the whole block.
    await page.keyboard.press("Enter");
    await page.keyboard.type("A second block to comment on");
    await page.getByText("A second block to comment on", { exact: true }).hover();
    await page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
    await page.getByRole("menuitem", { name: "Comment" }).click();
    await page.getByPlaceholder(/Add a comment/).fill("Whole block");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect.poll(() => html(page)).toMatch(/<span[^>]*data-comment[^>]*>A second block to comment on<\/span>/);
    const bubble = await select(page, "Shared sentence to discuss");
    await expect(bubble.getByRole("button", { name: "Bold selection" })).toBeVisible();
    await bubble.getByRole("button", { name: "Comment on selection" }).click();
    await page.getByPlaceholder(/Add a comment/).fill("Can we tighten this?");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect.poll(async () => ((await html(page)).match(/<span[^>]*data-comment/g) ?? []).length).toBe(2);
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
