import { test, expect, type Page, type Locator } from "@playwright/test";
import { grantClipboard } from "./browser-compat";
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
    // ⌘/ / Ctrl+/ opens the block menu for the caret's block (the shortcut sheet is ⌘⇧/).
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

  // NP-ED-06: block keyboard. Esc selects the block; ↑/↓ move the selection; ⌘⇧↑/↓ move the block;
  // ⌘D duplicates; ⌘↵ checks a to-do; Backspace deletes the selected block; ⌘/ opens Turn into.
  test("⌘⇧↑↓, ⌘D, ⌘/, Esc block selection", async ({ page }) => {
    const mod = "ControlOrMeta";
    const selected = () => page.evaluate(() => [...document.querySelectorAll(".tiptap > .ProseMirror-selectednode, .tiptap > .prism-block-selected")].map((el) => el.textContent));
    await clickInto(page, "Bravo paragraph");
    await page.keyboard.press("Escape");
    await expect.poll(selected).toEqual(["Bravo paragraph"]);
    await expect(page.locator(".document-selection-actions:visible")).toHaveCount(0); // a block selection is not a text selection
    await page.keyboard.press("ArrowUp");
    await expect.poll(selected).toEqual(["Alpha"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(selected).toEqual(["Charlie itemDelta item"]);
    // ⌘⇧↑ moves the SELECTED block and keeps it selected; one step each.
    await recordTransactions(page);
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    expect((await blockTexts(page)).slice(1, 3)).toEqual(["bulletList:Charlie itemDelta item", "paragraph:Bravo paragraph"]);
    await expect.poll(selected).toEqual(["Charlie itemDelta item"]);
    await page.keyboard.press(`${mod}+Shift+ArrowDown`);
    expect((await blockTexts(page)).slice(1, 3)).toEqual(["paragraph:Bravo paragraph", "bulletList:Charlie itemDelta item"]);
    expect((await txLog(page)).every((steps) => steps === 1)).toBe(true);
    // Shift+↓ extends the selection; ⌘D duplicates both blocks after them.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(selected).toEqual(["Bravo paragraph", "Charlie itemDelta item"]);
    await page.keyboard.press(`${mod}+d`);
    expect(await blockTexts(page)).toEqual([
      "heading:Alpha", "paragraph:Bravo paragraph", "bulletList:Charlie itemDelta item", "paragraph:Bravo paragraph", "bulletList:Charlie itemDelta item", "blockquote:Echo quote", "paragraph:Foxtrot closing",
    ]);
    // Backspace deletes the selected blocks (the copies stay selected after ⌘D).
    await expect.poll(selected).toEqual(["Bravo paragraph", "Charlie itemDelta item"]);
    await page.keyboard.press("Backspace");
    expect(await blockTexts(page)).toEqual(["heading:Alpha", "paragraph:Bravo paragraph", "bulletList:Charlie itemDelta item", "blockquote:Echo quote", "paragraph:Foxtrot closing"]);
    // Enter returns to the text of a selected block; typing then edits it.
    await clickInto(page, "Foxtrot closing");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type("!");
    expect((await blockTexts(page)).at(-1)).toBe("paragraph:Foxtrot closing!");
    // With only a caret: ⌘⇧↑ moves the block, ⌘D duplicates the list ITEM, not the whole list.
    await clickInto(page, "Bravo paragraph");
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    expect((await blockTexts(page)).slice(0, 2)).toEqual(["paragraph:Bravo paragraph", "heading:Alpha"]);
    await clickInto(page, "Delta item");
    await page.keyboard.press(`${mod}+d`);
    expect(await blockTexts(page)).toContain("bulletList:Charlie itemDelta itemDelta item");
    // ⌘↵ checks and unchecks a to-do.
    await page.goto("/e2e-fixtures/editor-blocks.html?content=" + encodeURIComponent('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Ship it</p></li></ul><p>after</p>'));
    await clickInto(page, "Ship it");
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.locator('.tiptap li[data-checked="true"]')).toHaveCount(1);
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.locator('.tiptap li[data-checked="true"]')).toHaveCount(0);
    // ⌘/ in a block opens its menu on Turn into (the row's own words) — never the shortcut sheet.
    await page.keyboard.press(`${mod}+/`);
    await expect(page.getByRole("menu", { name: "Block actions" }).getByRole("menuitem", { name: "Turn into" })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menu", { name: "Turn into" }).getByRole("menuitemradio", { name: "Bulleted list" }).click();
    await expect(page.locator(".tiptap > ul:not([data-type])").filter({ hasText: "Ship it" })).toHaveCount(1);
    await expect(page.getByRole("menu")).toHaveCount(0);
    // The shortcut sheet stays reachable from inside the editor: ⌘⇧/ opens it; "?" there types.
    await clickInto(page, "Ship it");
    await page.keyboard.press(`${mod}+Shift+/`);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await expect(page.getByRole("menu", { name: "Block actions" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await clickInto(page, "after");
    await page.keyboard.press("End");
    await page.keyboard.type("?");
    await expect(page.locator(".tiptap").getByText("after?", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    // Outside a text field a bare "?" opens it.
    await page.getByRole("button", { name: "Outline", exact: true }).focus();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    // Tab / Shift+Tab nest and un-nest a list item.
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await clickInto(page, "Delta item");
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML())).toContain("<li><p>Charlie item</p><ul><li><p>Delta item</p></li></ul></li>");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML())).toContain("<li><p>Charlie item</p></li><li><p>Delta item</p></li>");
  });

  // Review L5: Esc is taken only by the editor's OWN visible popups; inside a row peek Esc stays the peek's.
  test("Esc block selection ignores unrelated popups and leaves a row peek's Esc alone", async ({ page }) => {
    const selected = () => page.locator(".tiptap > .ProseMirror-selectednode").count();
    // An unrelated listbox and menu mounted elsewhere in the app (and a hidden editor menu) do not block it.
    await page.evaluate(() => {
      const box = document.createElement("div"); box.setAttribute("role", "listbox"); box.textContent = "Unrelated list"; document.body.appendChild(box);
      const menu = document.createElement("div"); menu.setAttribute("role", "menu"); menu.textContent = "Unrelated menu"; document.body.appendChild(menu);
      const hidden = document.createElement("div"); hidden.className = "editor-menu"; hidden.style.display = "none"; document.body.appendChild(hidden);
    });
    await clickInto(page, "Bravo paragraph");
    await page.keyboard.press("Escape");
    await expect.poll(selected).toBe(1);
    // The editor's own slash menu owns Escape: it closes, the block is not selected.
    await clickInto(page, "Foxtrot closing");
    await page.keyboard.press("End");
    await page.keyboard.type(" /");
    await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "Insert block" })).toHaveCount(0);
    expect(await selected()).toBe(0);
    // Inside a row peek the first Escape is the peek's: it closes the peek, no block selection.
    await clickInto(page, "Bravo paragraph");
    await page.evaluate(() => {
      document.querySelector(".tiptap")!.closest("main")!.classList.add("db-peek"); // the editor now sits in a peek
      (window as any).__esc = [];
      window.addEventListener("keydown", (e) => { if (e.key === "Escape") (window as any).__esc.push(e.defaultPrevented); });
    });
    await expect(page.locator(".tiptap")).toBeFocused();
    await page.keyboard.press("Escape");
    // (ProseMirror marks every Escape typed in an editor as used; the peek gets a fresh, unused one.)
    await expect.poll(() => page.evaluate(() => (window as any).__esc)).toEqual([true, false]);
    expect(await selected()).toBe(0);
    await expect(page.locator(".tiptap")).not.toBeFocused();
  });

  // Review L6: a duplicated block's mention chips get new uids and no reminder (both belong to the original chip).
  test("duplicate gives mention chips new uids and drops reminders", async ({ page }) => {
    await page.goto("/e2e-fixtures/editor-blocks.html?content=" + encodeURIComponent('<p>Ping <span data-type="mention" data-kind="date" data-date="2026-10-09" data-reminder="rem_1" data-mention-uid="uidoriginal00001">@2026-10-09</span> and <span data-type="mention" data-kind="page" data-id="roadmap" data-mention-uid="uidoriginal00002">@page</span></p><p>after</p>'));
    const chips = () => page.evaluate(() => {
      const out: Array<{ uid: string; reminder: string | null; kind: string }> = [];
      (document.querySelector(".tiptap") as any).editor.state.doc.descendants((n: any) => { if (n.type.name === "mention") out.push({ uid: n.attrs.uid, reminder: n.attrs.reminder, kind: n.attrs.kind }); });
      return out;
    });
    await page.locator(".tiptap p").first().click({ position: { x: 4, y: 8 } });
    await expect(page.locator(".tiptap")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+d");
    await expect.poll(async () => (await chips()).length).toBe(4);
    let all = await chips();
    expect(all.slice(0, 2)).toEqual([{ uid: "uidoriginal00001", reminder: "rem_1", kind: "date" }, { uid: "uidoriginal00002", reminder: null, kind: "page" }]);
    expect(new Set(all.map((c) => c.uid)).size).toBe(4);
    expect(all.slice(2).every((c) => c.reminder === null && /^[a-z0-9]{8,}$/i.test(c.uid))).toBe(true);
    // The block menu's Duplicate and a duplicated block selection do the same.
    const gutter = await gutterFor(page, "after");
    await page.locator(".tiptap p").first().hover({ position: { x: 4, y: 8 } });
    await page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await expect.poll(async () => (await chips()).length).toBe(6);
    all = await chips();
    expect(new Set(all.map((c) => c.uid)).size).toBe(6);
    expect(all.filter((c) => c.reminder).length).toBe(1);
    void gutter;
  });

  // NP-ED-01: a multi-block selection drags as one, with a drop line, in one step.
  test("a multi-block selection drags as one block group in one undo step", async ({ page }) => {
    await clickInto(page, "Bravo paragraph");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    const gutter = await gutterFor(page, "Charlie item");
    await recordTransactions(page);
    const grip = gutter.getByRole("button", { name: /Drag to move/ });
    // Drive the drag by hand to see the drop line mid-flight.
    const from = (await grip.boundingBox())!;
    const target = (await page.getByText("Foxtrot closing", { exact: true }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 4, target.y + target.height - 3, { steps: 8 });
    await expect(page.locator('.block-drop-indicator[data-drop="line"]')).toBeVisible();
    await page.mouse.up();
    await expect.poll(() => blockTexts(page)).toEqual([
      "heading:Alpha", "blockquote:Echo quote", "paragraph:Foxtrot closing", "paragraph:Bravo paragraph", "bulletList:Charlie itemDelta item", "paragraph:",
    ]);
    expect((await txLog(page))[0]).toBe(1); // one replace step for both blocks
    await expect(page.locator(".block-drop-indicator")).toHaveCount(0);
    // The moved blocks stay selected; one ⌘Z puts both back.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll(".tiptap > .prism-block-selected")].map((el) => el.textContent))).toEqual(["Bravo paragraph", "Charlie itemDelta item"]);
    // After a drop the keyboard belongs to the editor again (it returns a frame later: until
    // then the keys would go to the handle that was dragged, and nothing would be undone).
    await expect(page.locator(".tiptap")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+z"); // (the trailing paragraph the list needed at the end)
    await expect.poll(async () => (await blockTexts(page)).slice(0, 5)).toEqual(["heading:Alpha", "paragraph:Bravo paragraph", "bulletList:Charlie itemDelta item", "blockquote:Echo quote", "paragraph:Foxtrot closing"]);
  });

  // NP-ED-09: dropping a block on the far right (or the left margin) of another makes columns.
  test("drag block to side creates columns", async ({ page }) => {
    const html = () => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
    const dragBeside = async (text: string, onto: string, side: "left" | "right") => {
      const gutter = await gutterFor(page, text);
      const grip = (await gutter.getByRole("button", { name: /Drag to move/ }).boundingBox())!;
      const target = (await page.locator(".tiptap > *", { hasText: onto }).first().boundingBox())!;
      const editor = (await page.locator(".tiptap").boundingBox())!;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      const x = side === "right" ? editor.x + editor.width - 12 : editor.x - 80;
      await page.mouse.move(grip.x + grip.width / 2 + 2, grip.y + grip.height / 2 - 4, { steps: 2 }); // starts the drag
      await page.mouse.move(x, target.y + target.height / 2, { steps: 8 });
      await page.mouse.move(x, target.y + target.height / 2 + 1);
      await page.mouse.up();
    };
    await recordTransactions(page);
    await dragBeside("Foxtrot closing", "Bravo paragraph", "right");
    await expect.poll(html).toContain('<div data-type="columns" data-count="2"><div data-type="column"><p>Bravo paragraph</p></div><div data-type="column"><p>Foxtrot closing</p></div></div>');
    expect(await txLog(page)).toHaveLength(1); // one transaction → one undo step
    // A third block dropped on the left margin of the layout becomes its first column.
    await dragBeside("Echo quote", "Bravo paragraph", "left");
    await expect.poll(html).toMatch(/<div data-type="columns" data-count="3"><div data-type="column"><blockquote><p>Echo quote<\/p><\/blockquote><\/div><div data-type="column"><p>Bravo paragraph<\/p><\/div><div data-type="column"><p>Foxtrot closing<\/p><\/div><\/div>/);
    expect(await html()).not.toMatch(/<\/div><blockquote>/); // moved, not copied
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/columns-from-drag-1440.png` });
    await page.getByText("Alpha", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(html).toContain('data-count="2"');
    await expect.poll(() => page.evaluate(() => (window as any).prismBlockWrites.at(-1)?.content ?? ""), { timeout: 6000 }).toContain('data-type="columns"');
  });

  // NP-ED-02: the block menu is searchable and has Copy and Move to (another page).
  test("block menu Move to another page", async ({ page, context, browserName }) => {
    await grantClipboard(context, browserName);
    let gutter = await gutterFor(page, "Echo quote");
    await gutter.getByRole("button", { name: /Drag to move/ }).click();
    const menu = page.getByRole("menu", { name: "Block actions" });
    await expect(menu.getByRole("menuitem").evaluateAll((els) => els.map((el) => el.querySelector(".editor-menu-label")?.textContent))).resolves.toEqual(
      ["Turn into", "Unwrap", "Color", "Duplicate", "Copy", "Move to", "Move up", "Move down", "Delete"],
    );
    // Type to search from the focused item: actions, Turn into kinds and colours are all found.
    await expect(menu.getByRole("menuitem", { name: "Turn into" })).toBeFocused();
    await page.keyboard.type("head");
    const search = page.getByRole("searchbox", { name: "Search actions" }); // above the menu, not one of its items
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("head");
    await expect(menu.getByRole("menuitem")).toHaveText(["Turn into Heading 1", "Turn into Heading 2", "Turn into Heading 3"]);
    await search.fill("zzz");
    await expect(page.locator(".editor-menu").getByRole("status")).toHaveText("No results");
    await search.fill("copy");
    await page.keyboard.press("Enter"); // runs the first match
    await expect(page.getByRole("status").filter({ hasText: "Copied block" })).toBeVisible();
    const clip = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return { html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
    });
    expect(clip.html).toContain("<blockquote><p>Echo quote</p></blockquote>");
    expect(clip.text).toBe("> Echo quote");
    expect(await blockTexts(page)).toContain("blockquote:Echo quote"); // a copy, the block stays
    // Move to: a searchable page list. The SERVER appends (POST /api/notes/:id/blocks/append — through the
    // live document when that page is open); the block leaves this page only on a confirmed 200.
    const calls: Array<{ url: string; body: { html: string; requestId: string } }> = [];
    let answer: { status: number; body: unknown } | "abort" = { status: 200, body: { ok: true, live: true } };
    await page.route("**/api/notes/*/blocks/append", async (route) => {
      calls.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      if (answer === "abort") return route.abort("internetdisconnected");
      await route.fulfill({ status: answer.status, json: answer.body });
    });
    const moveTo = async (text: string) => {
      const g = await gutterFor(page, text);
      await g.getByRole("button", { name: /Drag to move/ }).click();
      await page.getByRole("menuitem", { name: "Move to" }).click();
    };
    await moveTo("Echo quote");
    const pages = page.getByRole("menu", { name: "Move to" });
    await expect(pages.getByRole("menuitem", { name: "Roadmap" })).toBeVisible();
    await expect(pages.getByRole("menuitem", { name: "Block editor" })).toHaveCount(0); // never the page itself
    await page.getByRole("searchbox", { name: "Search pages" }).fill("road"); // above the menu, not one of its items
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/block-move-to-1440.png` });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Moved to Roadmap" })).toBeVisible();
    expect(await blockTexts(page)).not.toContain("blockquote:Echo quote");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/notes/roadmap/blocks/append");
    expect(calls[0].body.html).toBe("<blockquote><p>Echo quote</p></blockquote>");
    expect(calls[0].body.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // The page's own client never wrote the target (no GET → PATCH of its body, no outbox).
    expect(await page.evaluate(() => (window as any).prismBlockWrites.filter((w: any) => w.id === "roadmap"))).toEqual([]);
    // M3: anything but a confirmed 200 {ok:true} keeps the block — a queued/accepted answer, a refusal, no network.
    for (const [reply, message] of [
      [{ status: 202, body: { queued: true } }, "Couldn’t move to Roadmap. The block is still here."],
      [{ status: 200, body: { queued: true } }, "Couldn’t move to Roadmap. The block is still here."],
      [{ status: 409, body: { error: "locked" } }, "Roadmap is locked. The block is still here."],
      [{ status: 403, body: { error: "forbidden" } }, "You can’t add to Roadmap. The block is still here."],
      ["abort", "You’re offline — nothing was moved. The block is still here."],
    ] as const) {
      answer = reply as typeof answer;
      await moveTo("Bravo paragraph");
      await page.getByRole("menuitem", { name: "Roadmap" }).click();
      await expect(page.getByRole("status").filter({ hasText: message })).toBeVisible();
      expect(await blockTexts(page)).toContain("paragraph:Bravo paragraph");
    }
    // Each invocation carries its own idempotency key.
    expect(new Set(calls.map((c) => c.body.requestId)).size).toBe(calls.length);
  });

  // M6: a moved block's files are given to the target page (attachment copy route), or the limitation is said.
  test("Move to carries the block's files to the target page, or says it could not", async ({ page }) => {
    await page.route("**/api/notes/*/blocks/append", (route) => route.fulfill({ status: 200, json: { ok: true, live: false } }));
    await page.goto("/e2e-fixtures/editor-blocks.html?copy&content=" + encodeURIComponent('<p>Intro</p><div data-type="attachment" data-kind="file" data-src="/api/attachments/a_0123456789abcdefghijkl" data-name="plan.zip" data-mime="application/zip"><a href="/api/attachments/a_0123456789abcdefghijkl">plan.zip</a></div><p>Tail</p>'));
    const move = async () => {
      await page.locator(".tiptap .prism-attachment, .tiptap [data-type=attachment]").first().hover();
      await page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
      await page.getByRole("menuitem", { name: "Move to" }).click();
      await page.getByRole("menuitem", { name: "Roadmap" }).click();
    };
    await move();
    await expect(page.getByRole("status").filter({ hasText: /^Moved to Roadmap$/ })).toBeVisible();
    expect(await page.evaluate(() => (window as any).prismBlockCopies)).toEqual(["roadmap"]);
    // The copy route refuses (the target is open live, a quota…): the move stands and the limitation is stated.
    await page.goto("/e2e-fixtures/editor-blocks.html?copy=fail&content=" + encodeURIComponent('<p>Intro</p><div data-type="attachment" data-kind="file" data-src="/api/attachments/a_0123456789abcdefghijkl" data-name="plan.zip" data-mime="application/zip"><a href="/api/attachments/a_0123456789abcdefghijkl">plan.zip</a></div><p>Tail</p>'));
    await move();
    await expect(page.getByRole("status").filter({ hasText: "Moved to Roadmap. Its files still belong to the original page" })).toBeVisible();
    // A block with no files asks for no copy.
    await page.locator(".tiptap").getByText("Intro").hover();
    await page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
    await page.getByRole("menuitem", { name: "Move to" }).click();
    await page.getByRole("menuitem", { name: "Roadmap" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Moved to Roadmap$/ })).toBeVisible();
    expect(await page.evaluate(() => (window as any).prismBlockCopies)).toEqual(["roadmap"]);
  });

  // NP-ED-07: ⌘/ outside a block (and ⌘⇧/ or ? anywhere outside a text field) opens the shortcut sheet for the
  // current platform; no key is listed with two meanings.
  test("shortcut sheet lists editor shortcuts", async ({ page }) => {
    await page.getByRole("button", { name: "Outline", exact: true }).focus(); // focus is outside the editor
    await page.keyboard.press("ControlOrMeta+/"); // outside a block (NP-ED-07): the sheet — and no block menu
    await expect(page.getByRole("menu", { name: "Block actions" })).toHaveCount(0);
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    for (const title of ["Text formatting", "Blocks", "Markdown while typing", "Find", "Navigation", "Databases"]) await expect(sheet.getByRole("region", { name: title })).toBeVisible();
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    const row = (label: string) => sheet.locator(".prism-shortcuts-row").filter({ has: page.getByText(label, { exact: true }) });
    await expect(row("Bold")).toContainText(mac ? "⌘B" : "Ctrl+B");
    await expect(row("Link (with text selected)")).toContainText(mac ? "⌘K" : "Ctrl+K");
    await expect(row("Highlight (last colour)")).toContainText(mac ? "⌘⇧H" : "Ctrl+Shift+H");
    await expect(row("Find and replace")).toContainText(mac ? "⌘⌥F" : "Ctrl+Alt+F");
    await expect(row("Duplicate block")).toContainText(mac ? "⌘D" : "Ctrl+D");
    await expect(row("Move block up")).toContainText(mac ? "⌘⇧↑" : "Ctrl+Shift+↑");
    await expect(row("Quick find (no text selected)")).toContainText(mac ? "⌘K" : "Ctrl+K");
    await expect(row("Toggle sidebar")).toContainText(mac ? "⌘\\" : "Ctrl+\\");
    await expect(row("Toggle side panel")).toContainText(mac ? "⌘⇧\\" : "Ctrl+Shift+\\");
    // ⌘/ is the one key with two contexts, like ⌘K: listed ONCE as a key (the block menu, with its context in the
    // row) and named in the sheet's own row, whose keys are ⌘⇧/ and ?.
    await expect(row("Block menu / Turn into (caret in a block)").locator("kbd")).toHaveText([mac ? "⌘/" : "Ctrl+/"]);
    await expect(row(`Keyboard shortcuts (also ${mac ? "⌘/" : "Ctrl+/"} outside a block)`).locator("kbd")).toHaveText([mac ? "⌘⇧/" : "Ctrl+Shift+/", "?"]);
    // No shortcut appears twice with two meanings (Markdown rows are typed text, not keys).
    const keys = await sheet.locator(".prism-shortcuts-body section:not([aria-label='Markdown while typing']) kbd").allTextContents();
    // Context keys only: Tab (lists vs tables), Esc/Enter (block vs peek), and ⌘K — link WITH a text selection, quick find without (the decided rule).
    const allowed = new Set(["Tab", "Shift+Tab", "⇧Tab", "Esc", "Enter", "↵", "⌘K", "Ctrl+K"]);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i && !allowed.has(k));
    expect(dup).toEqual([]);
    await expect(row("Toggle")).toContainText(">>");
    await expect(row("Select all rows (table)")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/shortcut-sheet-1440.png` });
    // Searchable; Esc closes and gives focus back.
    await expect(sheet.getByRole("searchbox", { name: "Search shortcuts" })).toBeFocused();
    await page.keyboard.type("duplic");
    await expect(sheet.locator(".prism-shortcuts-row")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Outline", exact: true })).toBeFocused();
    // Phone: fits the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("ControlOrMeta+Shift+/");
    await expect(sheet).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
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

  test("the block menu acts on its block even after an edit above it", async ({ page }) => {
    const gutter = await gutterFor(page, "Foxtrot closing");
    await gutter.getByRole("button", { name: /Drag to move/ }).click();
    await expect(page.getByRole("menu", { name: "Block actions" })).toBeVisible();
    await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.insertContentAt(0, "<p>Inserted above</p>"));
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const texts = await blockTexts(page);
    expect(texts).not.toContain("paragraph:Foxtrot closing");
    expect(texts).toContain("blockquote:Echo quote");
    expect(texts[0]).toBe("paragraph:Inserted above");
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

test.describe("live collaborative editor: concurrent edits around block moves", () => {
  let server: Server;
  const sockets: WebSocket[] = [];
  test.beforeEach(async () => {
    server = new Server({ address: "127.0.0.1", port: 0, quiet: true, debounce: 10, async onAuthenticate() { return { fixture: true }; } });
    await server.listen();
  });
  test.afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await server.destroy();
  });

  /** A client whose outgoing frames can be held (to make edits truly concurrent). */
  async function client(browser: import("@playwright/test").Browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const ctl = { hold: false, queue: [] as (string | Buffer)[], socket: null as WebSocket | null };
    await page.routeWebSocket(/\/collab(\?|$)/, (route) => {
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket); ctl.socket = socket;
      const pending: (string | Buffer)[] = [];
      route.onMessage((m) => { if (ctl.hold) ctl.queue.push(m); else if (socket.readyState === WebSocket.OPEN) socket.send(m); else pending.push(m); });
      socket.on("open", () => { for (const m of pending) socket.send(m); });
      socket.on("message", (m, binary) => route.send(binary ? Buffer.from(m as Buffer) : m.toString()));
      route.onClose(() => socket.close()); socket.on("close", () => route.close({ code: 1000 }));
    });
    await page.route("**/auth/me", (r) => r.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
    await page.route("**/api/notes/denied-note", (r) => r.fulfill({ json: { id: "denied-note", path: "Projects/Prism/Shared", content: "", _level: "own", metadata: {}, tags: [] } }));
    await page.route("**/api/federated/**", (r) => r.fulfill({ status: 204 }));
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    const release = () => { ctl.hold = false; for (const m of ctl.queue.splice(0)) ctl.socket!.send(m); };
    return { context, page, ctl, release };
  }
  const order = (p: Page) => p.evaluate(() => { const out: string[] = []; (document.querySelector(".tiptap") as any).editor.state.doc.forEach((n: any) => out.push(n.textContent)); return out; });
  /** Put the caret at the end of the top-level block whose text is `text`. */
  const caretIn = async (p: Page, text: string) => {
    await p.evaluate((t) => {
      const editor = (document.querySelector(".tiptap") as any).editor;
      let at = -1;
      editor.state.doc.forEach((n: any, offset: number) => { if (at < 0 && n.textContent === t) at = offset + n.nodeSize - 1; });
      editor.chain().focus().setTextSelection(at).run();
    }, text);
    await expect(p.locator(".tiptap")).toBeFocused();
    await expect.poll(() => p.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe(text);
  };

  async function seed(browser: import("@playwright/test").Browser) {
    const a = await client(browser);
    await a.page.locator(".tiptap[contenteditable=true]").click();
    await a.page.keyboard.type("one");
    for (const w of ["two", "three", "four"]) { await a.page.keyboard.press("Enter"); await a.page.keyboard.type(w); }
    const b = await client(browser);
    await expect.poll(() => order(b.page)).toEqual(["one", "two", "three", "four"]);
    return { a, b };
  }

  test("a move is two transactions, undoes as one step, and concurrent typing never lands in another block", async ({ browser }) => {
    const { a, b } = await seed(browser);
    // A types into "one" while its frames are held; B moves "one" down meanwhile.
    await caretIn(a.page, "one");
    a.ctl.hold = true;
    await a.page.keyboard.type("XX");
    await caretIn(b.page, "one");
    await b.page.evaluate(() => {
      const editor = (document.querySelector(".tiptap") as any).editor;
      (window as any).moveTx = [] as number[];
      editor.on("transaction", ({ transaction }: any) => { if (transaction.docChanged && !transaction.getMeta("y-sync$")) (window as any).moveTx.push(transaction.steps.length); });
    });
    await b.page.keyboard.press("Alt+Shift+ArrowDown");
    expect(await b.page.evaluate(() => (window as any).moveTx)).toEqual([1, 1]); // delete, then insert
    a.release();
    await expect.poll(async () => JSON.stringify(await order(a.page))).toBe(JSON.stringify(await order(b.page)));
    const final = await order(b.page);
    test.info().annotations.push({ type: "converged", description: JSON.stringify(final) });
    // "XX" belonged to "one": it is never grafted onto a neighbour ("XXtwo"/"twoXX").
    for (const text of final) expect(["one", "oneXX", "two", "three", "four"]).toContain(text);
    expect(final.filter((t) => t.startsWith("one"))).toHaveLength(1);
    // One undo restores the order.
    await caretIn(b.page, "three");
    const beforeUndo = await order(b.page);
    await b.page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => order(b.page)).not.toEqual(beforeUndo);
    expect((await order(b.page)).map((t) => t.replace("XX", ""))).toEqual(["one", "two", "three", "four"]);
    await a.context.close(); await b.context.close();
  });

  test("an open block menu follows its block when a collaborator inserts above, and closes if it is deleted", async ({ browser }) => {
    const { a, b } = await seed(browser);
    await a.page.getByText("three", { exact: true }).hover();
    await a.page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
    await expect(a.page.getByRole("menu", { name: "Block actions" })).toBeVisible();
    // B inserts a block at the very top.
    await b.page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.insertContentAt(0, "<p>zero</p>"));
    await expect.poll(() => order(a.page)).toEqual(["zero", "one", "two", "three", "four"]);
    await a.page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(() => order(b.page)).toEqual(["zero", "one", "two", "four"]);
    // Now the reverse: A's menu is open on "two" and B deletes "two".
    await a.page.getByText("two", { exact: true }).hover();
    await a.page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
    await expect(a.page.getByRole("menu", { name: "Block actions" })).toBeVisible();
    await b.page.getByText("two", { exact: true }).hover();
    await b.page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
    await b.page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(() => order(a.page)).toEqual(["zero", "one", "four"]);
    await expect(a.page.getByRole("menu", { name: "Block actions" })).toHaveCount(0);
    await a.context.close(); await b.context.close();
  });
});

test.describe("block menu safety", () => {
  test("Turn into is refused for a callout holding an image; Unwrap keeps everything", async ({ page }) => {
    await page.goto("/e2e-fixtures/editor-blocks.html?content=" + encodeURIComponent('<div data-type="callout" data-emoji="💡"><p>Caption text</p><img src="/e2e-fixtures/fixture-image.svg" alt="chart"></div><p>After</p>'));
    const gutter = await gutterFor(page, "Caption text");
    await gutter.getByRole("button", { name: /Drag to move/ }).click();
    const menu = page.getByRole("menu", { name: "Block actions" });
    await expect(menu.getByRole("menuitem", { name: "Turn into" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Unwrap (keeps images and tables)" }).click();
    expect(await blockTexts(page)).toEqual(["paragraph:Caption text", "image:", "paragraph:After"]);
  });

  test("dropping a dragged block outside the editor changes nothing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/e2e-fixtures/editor-blocks.html");
    const before = await blockTexts(page);
    const gutter = await gutterFor(page, "Echo quote");
    await gutter.getByRole("button", { name: /Drag to move/ }).dragTo(page.getByRole("button", { name: "Outline", exact: true }));
    expect(await blockTexts(page)).toEqual(before);
  });
});
