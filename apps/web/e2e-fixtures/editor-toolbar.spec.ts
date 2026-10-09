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

/**
 * Put the caret in a block and wait until the EDITOR has it there (focused, an empty selection inside that
 * block). A click made while a link field or card is closing can leave the editor's caret where it was — inside
 * the link just made — and ⌘K there is "open this link's card", not the caret's ⌘K the test means to press.
 */
async function caretIn(page: Page, text: string) {
  const target = page.getByText(text, { exact: true });
  await expect(async () => {
    await target.click();
    await expect.poll(() => page.evaluate(() => {
      const e = (document.querySelector(".tiptap") as any).editor;
      return e.isFocused && e.state.selection.empty ? (e.state.selection.$from.parent.textContent as string) : null;
    }), { timeout: 1000 }).toBe(text);
  }).toPass({ timeout: 10_000 });
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
    await caretIn(page, "Alpha");
    await page.keyboard.press("ControlOrMeta+Alt+f");
    await expect(page.getByRole("textbox", { name: "Replace with" })).toBeVisible();
  });

  // NP-ED-05, every clause: each binding of the row with the platform's modifier (⌘ on Apple, Ctrl on
  // Windows/Linux — the other modifier family does nothing), each consumed by the page so no browser
  // menu acts on it, and ⌘K as Notion has it: the link field with text selected, quick find without.
  for (const os of ["apple", "windows"] as const) {
    test(`NP-ED-05: ⌘B ⌘I ⌘U ⌘⇧S ⌘E ⌘K ⌘⇧H as written — ${os} modifiers`, async ({ page }) => {
      await page.addInitScript((platform) => { Object.defineProperty(navigator, "platform", { get: () => platform }); }, os === "apple" ? "MacIntel" : "Win32");
      await page.goto("/e2e-fixtures/editor-blocks.html");
      await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
      const mod = os === "apple" ? "Meta" : "Control";
      const other = os === "apple" ? "Control" : "Meta";
      // What reached the window, and whether the page had consumed it by then.
      //
      // The listener also stands in for the app shell, which this fixture does not mount: the shell takes the ⌘K the
      // editor leaves alone (quick find) and consumes it (`useKeyboardShortcuts`). Without that, the key's HOST default
      // ran — on a Mac, Ctrl+K is "delete to the end of the paragraph", so under the emulated Windows modifier the
      // caret's ⌘K merged "Alpha" into the next block and the rest of the test waited for a heading that was gone.
      // (No Windows or Linux browser has that default, and on a Mac the app's modifier is ⌘.)
      await page.evaluate(() => {
        (window as any).prismKeys = [];
        (window as any).prismQuickFind = 0;
        window.addEventListener("keydown", (e) => {
          if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
          (window as any).prismKeys.push([e.key.toLowerCase(), e.defaultPrevented]);
          if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.defaultPrevented) {
            e.preventDefault();
            (window as any).prismQuickFind++;
          }
        });
      });
      const consumed = async (key: string) => (await page.evaluate(() => (window as any).prismKeys as Array<[string, boolean]>)).filter(([k]) => k === key).at(-1)?.[1];
      const cases: Array<[string, string, string]> = [["b", "b", "strong"], ["i", "i", "em"], ["u", "u", "u"], ["Shift+s", "s", "s"], ["e", "e", "code"], ["Shift+h", "h", "mark"]];
      for (const [chord, key, tag] of cases) {
        await select(page, "Bravo paragraph");
        await page.keyboard.press(`${mod}+${chord}`);
        await expect.poll(() => html(page), { message: `${mod}+${chord} applies <${tag}>` }).toContain(`<p><${tag}>Bravo paragraph</${tag}></p>`);
        expect(await consumed(key), `${mod}+${chord} is consumed by the editor`).toBe(true);
        await page.keyboard.press(`${mod}+${chord}`);
        await expect.poll(() => html(page), { message: `${mod}+${chord} again removes it` }).toContain("<p>Bravo paragraph</p>");
      }
      // ⌘K with text selected: the link field, applied from the keyboard.
      await select(page, "Echo quote");
      await page.keyboard.press(`${mod}+k`);
      expect(await consumed("k")).toBe(true);
      const field = page.getByRole("textbox", { name: /link/i });
      await expect(field).toBeFocused();
      await page.keyboard.type("example.test/np-ed-05");
      await page.keyboard.press("Enter");
      await expect.poll(() => html(page)).toMatch(/<a [^>]*href="https:\/\/example\.test\/np-ed-05"[^>]*>Echo quote<\/a>/);
      // ⌘K with only a caret is not "link" (it is the shell's quick find — NP-SB-02): no link field, nothing linked.
      await caretIn(page, "Alpha");
      const beforeQuickFind = await html(page);
      await page.keyboard.press(`${mod}+k`);
      await expect(field).toHaveCount(0);
      expect(await consumed("k"), "the editor leaves a caret's ⌘K to the shell").toBe(false);
      expect(await page.evaluate(() => (window as any).prismQuickFind), "…which received it exactly once").toBe(1);
      expect(await html(page), "and the document is untouched").toBe(beforeQuickFind);
      expect((await html(page)).match(/<a /g)).toHaveLength(1);
      await page.keyboard.press("Escape");
      await caretIn(page, "Alpha");
      // The sheet writes each key once, in this platform's notation.
      await page.keyboard.press(`${mod}+Shift+/`);
      const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      const row = (label: string) => sheet.locator(".prism-shortcuts-row").filter({ has: page.getByText(label, { exact: true }) }).locator("kbd");
      const apple = os === "apple";
      for (const [label, keys] of [["Bold", apple ? "⌘B" : "Ctrl+B"], ["Italic", apple ? "⌘I" : "Ctrl+I"], ["Underline", apple ? "⌘U" : "Ctrl+U"], ["Strikethrough", apple ? "⌘⇧S" : "Ctrl+Shift+S"], ["Inline code", apple ? "⌘E" : "Ctrl+E"], ["Link (with text selected)", apple ? "⌘K" : "Ctrl+K"], ["Highlight (last colour)", apple ? "⌘⇧H" : "Ctrl+Shift+H"], ["Quick find (no text selected)", apple ? "⌘K" : "Ctrl+K"]] as const) {
        await expect(row(label)).toHaveText([keys]);
      }
      await page.keyboard.press("Escape");
      // The other modifier family is not a second binding. (Checked with Apple's modifiers only: under the emulated
      // Windows platform this Mac's own browser would still act on ⌘B natively.)
      if (os === "apple") {
        await select(page, "Bravo paragraph");
        await page.keyboard.press(`${other}+b`);
        expect(await html(page)).toContain("<p>Bravo paragraph</p>");
      }
    });
  }

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
    // The composer HOLDS the keyboard — also a frame later. Selecting the block's text used to
    // schedule an editor focus for the next frame, which took the keyboard back with the block
    // selected: the comment a person typed replaced the block's text in the document.
    const composer = page.getByPlaceholder(/Add a comment/);
    await expect(composer).toBeFocused();
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await expect(composer).toBeFocused();
    await page.keyboard.type("Whole block");
    await expect(composer).toHaveValue("Whole block");
    expect(await html(page)).toContain("A second block to comment on");
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
