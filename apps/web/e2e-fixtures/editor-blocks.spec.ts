import { test, expect, type Page, type Locator } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;

/** Text of each top-level block, in document order. */
const blockTexts = (page: Page) => page.evaluate(() => {
  const editor = (window as any).prismEditor?.() ?? (document.querySelector(".tiptap") as any).editor;
  const out: string[] = [];
  editor.state.doc.forEach((n: any) => out.push(`${n.type.name}:${n.textContent}`));
  return out;
});

/** Record every doc-changing transaction's step count from now on. */
const recordTransactions = (page: Page) => page.evaluate(() => {
  const editor = (document.querySelector(".tiptap") as any).editor;
  const log: number[] = [];
  (window as any).prismTxLog = log;
  editor.on("transaction", ({ transaction }: any) => { if (transaction.docChanged) log.push(transaction.steps.length); });
});
const txLog = (page: Page) => page.evaluate(() => (window as any).prismTxLog as number[]);

/** Click into a block's text and wait until the editor state follows (selectionchange is async). */
async function clickInto(page: Page, text: string) {
  await page.getByText(text, { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe(text);
}

async function gutterFor(page: Page, text: string): Promise<Locator> {
  await page.getByText(text, { exact: true }).hover();
  const gutter = page.locator(".block-gutter");
  await expect(gutter).toBeVisible();
  return gutter;
}

test.describe("plain editor block handles", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  });

  test("hovering a block shows + and ⋮⋮; dragging reorders top-level blocks in one step and saves", async ({ page }) => {
    const gutter = await gutterFor(page, "Echo quote");
    await expect(gutter.getByRole("button", { name: "Insert block below" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/block-hover-1440.png` });
    await recordTransactions(page);
    await gutter.getByRole("button", { name: /Drag to move/ }).dragTo(page.getByText("Alpha", { exact: true }), { targetPosition: { x: 4, y: 2 } });
    await expect.poll(() => blockTexts(page)).toEqual([
      "blockquote:Echo quote", "heading:Alpha", "paragraph:Bravo paragraph", "bulletList:Charlie itemDelta item", "paragraph:Foxtrot closing",
    ]);
    expect(await txLog(page)).toEqual([1]);
    // A list moves as one block, to the end (the trailing-node rule then adds an empty paragraph after it).
    const list = await gutterFor(page, "Charlie item");
    await list.getByRole("button", { name: /Drag to move/ }).dragTo(page.getByText("Foxtrot closing", { exact: true }), { targetPosition: { x: 4, y: 20 } });
    await expect.poll(() => blockTexts(page)).toEqual([
      "blockquote:Echo quote", "heading:Alpha", "paragraph:Bravo paragraph", "paragraph:Foxtrot closing", "bulletList:Charlie itemDelta item", "paragraph:",
    ]);
    expect((await txLog(page)).slice(0, 2)).toEqual([1, 1]);
    await expect.poll(() => page.evaluate(() => (window as any).prismBlockWrites.at(-1)?.content ?? ""), { timeout: 6000 })
      .toMatch(/^<blockquote><p>Echo quote<\/p><\/blockquote><h2>Alpha<\/h2>.*<p>Foxtrot closing<\/p><ul>/);
  });

  test("Alt/Option+Shift+↑/↓ moves the current block, and a list item within its list", async ({ page }) => {
    await clickInto(page, "Bravo paragraph");
    await recordTransactions(page);
    await page.keyboard.press("Alt+Shift+ArrowUp");
    expect((await blockTexts(page)).slice(0, 2)).toEqual(["paragraph:Bravo paragraph", "heading:Alpha"]);
    await page.keyboard.press("Alt+Shift+ArrowUp"); // already first: no change, caret stays
    await page.keyboard.type("!");
    expect((await blockTexts(page))[0]).toMatch(/^paragraph:Bravo.*!/);
    await clickInto(page, "Charlie item");
    await page.keyboard.press("Alt+Shift+ArrowDown");
    expect(await blockTexts(page)).toContain("bulletList:Delta itemCharlie item");
    expect((await txLog(page)).filter((steps) => steps !== 1)).toEqual([]);
  });

  test("the block menu turns blocks into every kind, colours, duplicates and deletes — keyboard first", async ({ page }) => {
    await clickInto(page, "Bravo paragraph");
    // ⌘/ / Ctrl+/ opens the block menu for the caret's block.
    await page.keyboard.press("ControlOrMeta+/");
    const menu = page.getByRole("menu", { name: "Block actions" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Turn into" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const turn = page.getByRole("menu", { name: "Turn into" });
    await expect(turn.getByRole("menuitemradio", { name: "Text" })).toHaveAttribute("aria-checked", "true");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/block-turn-into-1440.png` });
    await turn.getByRole("menuitemradio", { name: "Heading 1" }).click();
    expect((await blockTexts(page))[1]).toBe("heading:Bravo paragraph");
    await expect(menu).toHaveCount(0);
    for (const [label, type] of [["Callout", "callout"], ["Toggle", "toggle"], ["To-do list", "taskList"], ["Quote", "blockquote"], ["Code", "codeBlock"], ["Numbered list", "orderedList"], ["Text", "paragraph"]] as const) {
      const gutter = await gutterFor(page, "Bravo paragraph");
      await gutter.getByRole("button", { name: /Drag to move/ }).click();
      await page.getByRole("menuitem", { name: "Turn into" }).click();
      await page.getByRole("menuitemradio", { name: label, exact: true }).click();
      expect((await blockTexts(page))[1], label).toBe(`${type}:Bravo paragraph`);
    }
    // Colour, then the Escape path returns focus to the handle.
    let gutter = await gutterFor(page, "Bravo paragraph");
    await gutter.getByRole("button", { name: /Drag to move/ }).click();
    await page.getByRole("menuitem", { name: "Color" }).click();
    await page.getByRole("menuitemradio", { name: "Blue background" }).click();
    await expect(page.locator('.tiptap p[data-block-color="blue_background"]')).toHaveText("Bravo paragraph");
    gutter = await gutterFor(page, "Bravo paragraph");
    const grip = gutter.getByRole("button", { name: /Drag to move/ });
    await grip.click();
    await expect(page.getByRole("menu", { name: "Block actions" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(grip).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    expect((await blockTexts(page)).filter((t) => t === "paragraph:Bravo paragraph")).toHaveLength(2);
    gutter = await gutterFor(page, "Foxtrot closing");
    await gutter.getByRole("button", { name: /Drag to move/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    expect(await blockTexts(page)).not.toContain("paragraph:Foxtrot closing");
    await expect.poll(() => page.evaluate(() => (window as any).prismBlockWrites.at(-1)?.content ?? ""), { timeout: 6000 })
      .toContain('<p data-block-color="blue_background">Bravo paragraph</p><p data-block-color="blue_background">Bravo paragraph</p>');
  });

  test("+ inserts an empty block below and opens the slash menu there", async ({ page }) => {
    const gutter = await gutterFor(page, "Bravo paragraph");
    await gutter.getByRole("button", { name: "Insert block below" }).click();
    await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
    await page.keyboard.type("callout");
    await page.keyboard.press("Enter");
    expect((await blockTexts(page))[2]).toBe("callout:");
    await page.keyboard.type("Inside the callout");
    expect((await blockTexts(page))[2]).toBe("callout:Inside the callout");
  });

  test("read-only documents show no block handles", async ({ page }) => {
    await page.goto("/e2e-fixtures/editor-blocks.html?readonly");
    await page.getByText("Bravo paragraph", { exact: true }).hover();
    await page.waitForTimeout(200);
    await expect(page.locator(".block-gutter")).toHaveCount(0);
  });

  test("phones: no hover affordance — the caret's block gets a tap target that opens the same menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await page.getByText("Alpha", { exact: true }).hover();
    await page.waitForTimeout(150);
    await expect(page.locator(".block-gutter")).toHaveCount(0);
    await clickInto(page, "Bravo paragraph");
    const actions = page.getByRole("button", { name: "Block actions" });
    await expect(actions).toBeVisible();
    const box = await actions.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(32);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    // It sits in the margin, not over the text.
    const text = await page.getByText("Bravo paragraph", { exact: true }).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(text!.x + 1);
    await actions.click();
    const menu = page.getByRole("menu", { name: "Block actions" });
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/block-menu-390.png` });
    await menu.getByRole("menuitem", { name: "Move down" }).click();
    expect((await blockTexts(page)).slice(1, 3)).toEqual(["bulletList:Charlie itemDelta item", "paragraph:Bravo paragraph"]);
    // Insert without a keyboard: the menu offers it and opens the slash menu.
    await clickInto(page, "Bravo paragraph");
    await page.getByRole("button", { name: "Block actions" }).click();
    await page.getByRole("menuitem", { name: "Insert block below" }).click();
    await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
    await page.getByRole("option", { name: /^To-do list/ }).click();
    expect((await blockTexts(page))[3]).toBe("taskList:");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test("live collaborative editor: a block move reaches the other client and the shared document stays consistent", async ({ browser }) => {
  const server = new Server({ address: "127.0.0.1", port: 0, quiet: true, debounce: 10, async onAuthenticate() { return { fixture: true }; } });
  await server.listen();
  const sockets: WebSocket[] = [];
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await page.routeWebSocket(/\/collab(\?|$)/, (route) => {
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage((m) => (socket.readyState === WebSocket.OPEN ? socket.send(m) : pending.push(m)));
      socket.on("open", () => { for (const m of pending) socket.send(m); });
      socket.on("message", (m, binary) => route.send(binary ? Buffer.from(m as Buffer) : m.toString()));
      route.onClose(() => socket.close()); socket.on("close", () => route.close({ code: 1000 }));
    });
    await page.route("**/auth/me", (r) => r.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
    await page.route("**/api/notes/denied-note", (r) => r.fulfill({ json: { id: "denied-note", path: "Projects/Prism/Shared blocks", content: "", _level: "own", metadata: {}, tags: [] } }));
    await page.route("**/api/federated/**", (r) => r.fulfill({ status: 204 }));
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    return { context, page };
  };
  try {
    const a = await open();
    const editor = a.page.locator(".tiptap[contenteditable=true]");
    await editor.click();
    await a.page.keyboard.type("One");
    for (const word of ["Two", "Three", "Four"]) { await a.page.keyboard.press("Enter"); await a.page.keyboard.type(word); }
    const b = await open();
    const order = (p: Page) => p.evaluate(() => { const out: string[] = []; (document.querySelector(".tiptap") as any).editor.state.doc.forEach((n: any) => out.push(n.textContent)); return out; });
    await expect.poll(() => order(b.page)).toEqual(["One", "Two", "Three", "Four"]);
    // Drag in A (handle) …
    await a.page.getByText("Four", { exact: true }).hover();
    await a.page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).dragTo(a.page.getByText("One", { exact: true }), { targetPosition: { x: 4, y: 2 } });
    await expect.poll(() => order(a.page)).toEqual(["Four", "One", "Two", "Three"]);
    await expect.poll(() => order(b.page)).toEqual(["Four", "One", "Two", "Three"]);
    // … keyboard in B, while A keeps typing in another block.
    await clickInto(b.page, "Two");
    await b.page.keyboard.press("Alt+Shift+ArrowDown");
    await clickInto(a.page, "One");
    await a.page.keyboard.press("End");
    await a.page.keyboard.type(" edited");
    await expect.poll(() => order(a.page)).toEqual(["Four", "One edited", "Three", "Two"]);
    await expect.poll(() => order(b.page)).toEqual(["Four", "One edited", "Three", "Two"]);
    // The handle is off while suggesting (moves would be untracked raw edits).
    await b.page.getByRole("button", { name: "Editing", exact: true }).click();
    await expect(b.page.getByRole("button", { name: "Suggesting", exact: true })).toBeVisible();
    await b.page.getByText("Three", { exact: true }).hover();
    await b.page.waitForTimeout(150);
    await expect(b.page.locator(".block-gutter")).toHaveCount(0);
    if (SHOTS) await a.page.screenshot({ path: `${SHOTS}/collab-reorder-1280.png` });
    await a.context.close(); await b.context.close();
  } finally {
    for (const s of sockets) s.close();
    await server.destroy();
  }
});
