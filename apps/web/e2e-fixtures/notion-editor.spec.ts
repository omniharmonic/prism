import { test, expect, type Page } from "@playwright/test";

/** Wave 2B editor depth: code blocks (ED-11), images (ED-12), TOC (ED-19), find & replace (ED-23). */
const SHOTS = process.env.PRISM_EDITOR_SHOTS;
const html = (page: Page, i = 0) => page.evaluate((i) => (document.querySelectorAll(".tiptap")[i] as any).editor.getHTML() as string, i);
const open = (page: Page, query = "") => page.goto(`/e2e-fixtures/notion-media.html${query}`);
const enc = encodeURIComponent;
/** Click into a block and wait until the caret is really there (a bare click races the editor under load). */
async function clickInto(page: Page, text: string) {
  await page.getByText(text, { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe(text);
}

test("code block language picker, copy, wrap", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, `?content=${enc('<pre><code class="language-javascript">const answer = 42;\nfunction go() { return answer; }</code></pre><p>after</p>')}`);
  const block = page.locator(".prism-code-block");
  await expect(block).toBeVisible();
  await expect(block.locator(".prism-code-lang")).toHaveText("JavaScript");
  await expect(block.locator(".hljs-keyword").first()).toBeVisible(); // highlighted, not plain text
  // Searchable language picker.
  await block.locator(".prism-code-lang").click();
  const picker = page.getByRole("dialog", { name: "Code language" });
  await expect(picker).toBeVisible();
  await picker.getByRole("searchbox", { name: "Search languages" }).fill("typescr");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(block.locator(".prism-code-lang")).toHaveText("TypeScript");
  expect(await html(page)).toContain('class="language-typescript"');
  // Copy.
  await block.getByRole("button", { name: "Copy code" }).click();
  await expect(block.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const answer = 42;\nfunction go() { return answer; }");
  // Wrap is a view toggle.
  const wrap = block.getByRole("button", { name: "Wrap lines" });
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(block).toHaveAttribute("data-wrap", "");
  // Tab indents inside the block.
  await page.evaluate(() => { const ed = (document.querySelector(".tiptap") as any).editor; ed.chain().focus().setTextSelection(1).run(); });
  await expect(page.locator(".tiptap")).toBeFocused();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.from)).toBe(1);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.doc.firstChild.textContent as string)).toMatch(/^ {2}const answer/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/code-block-light.png` });
  await open(page, `?dark&content=${enc('<pre><code class="language-typescript">const n: number = 1; // note</code></pre>')}`);
  await expect(page.locator(".prism-code-block .hljs-keyword").first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/code-block-dark.png` });
});

test("image resize, caption, lightbox", async ({ page }) => {
  await open(page, `?content=${enc('<p>Intro</p><img src="/e2e-fixtures/media/cover.png" alt="Atlas"><p>End</p>')}`);
  const figure = page.locator("figure.prism-image");
  await expect(figure.locator("img")).toBeVisible();
  await figure.hover();
  await figure.getByRole("button", { name: "Align left" }).click();
  await expect.poll(() => html(page)).toContain('data-align="left"');
  // Drag the right handle 80 px to the left → a narrower stored width.
  const before = (await figure.locator(".prism-image-frame").boundingBox())!.width;
  await figure.hover();
  const handle = figure.locator('.prism-image-handle[data-side="right"]');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => html(page)).toMatch(/width="\d+"/);
  const width = Number((await html(page)).match(/width="(\d+)"/)![1]);
  expect(width).toBeLessThan(before - 40);
  // Caption.
  await figure.hover();
  await figure.getByRole("button", { name: "Caption" }).click();
  await figure.getByRole("textbox", { name: "Image caption" }).fill("River map, 2026");
  await page.keyboard.press("Enter");
  await expect(figure.locator("figcaption")).toHaveText("River map, 2026");
  expect(await html(page)).toContain('data-caption="River map, 2026"');
  // Lightbox from the toolbar, Esc closes and returns focus.
  await figure.hover();
  await figure.getByRole("button", { name: "View full screen" }).click();
  const lightbox = page.getByRole("dialog", { name: "Image: Atlas" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox).toContainText("River map, 2026");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/image-lightbox.png` });
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  // Read-only: a tap opens the lightbox; no handles, no toolbar.
  await open(page, `?readonly&content=${enc('<img src="/e2e-fixtures/media/cover.png" alt="Atlas" data-caption="Saved caption">')}`);
  await expect(page.locator("figure.prism-image figcaption")).toHaveText("Saved caption");
  await expect(page.getByRole("button", { name: "Align left" })).toBeHidden();
  await page.locator("figure.prism-image img").click();
  await expect(page.getByRole("dialog", { name: "Image: Atlas" })).toBeVisible();
});

test("toc block tracks headings", async ({ page }) => {
  await open(page, `?content=${enc('<div data-type="toc"></div><h1>Field guide</h1><p>a</p><h2>Birds</h2>' + "<p>filler</p>".repeat(40) + "<h3>Waders</h3><p>end</p>")}`);
  const toc = page.getByRole("navigation", { name: "Table of contents" });
  await expect(toc.getByRole("button")).toHaveText(["Field guide", "Birds", "Waders"]);
  // Nested levels are indented.
  const pad = (name: string) => toc.getByRole("button", { name }).evaluate((b) => parseFloat(getComputedStyle(b.parentElement!).paddingInlineStart));
  expect(await pad("Waders")).toBeGreaterThan(await pad("Birds"));
  // Live: a new heading appears without reload.
  await expect(toc.getByRole("button")).toHaveCount(3);
  await clickInto(page, "end");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe("");
  await page.keyboard.type("## Herons");
  await expect(toc.getByRole("button")).toHaveText(["Field guide", "Birds", "Waders", "Herons"]);
  // Click scrolls to the heading.
  await page.locator(".document-writing-scroll").evaluate((el) => el.scrollTo(0, 0));
  await toc.getByRole("button", { name: "Waders" }).click();
  await expect.poll(async () => {
    const r = await page.locator(".tiptap h3", { hasText: "Waders" }).boundingBox();
    return r ? r.y >= 0 && r.y < 500 : false;
  }).toBe(true);
  // Stored HTML is just the marker; headings are never duplicated into it.
  expect(await html(page)).toContain('<div data-type="toc"></div>');
});

test("replace and replace all", async ({ page }) => {
  await open(page);
  await page.getByText("Alpha paragraph about the river.").click();
  await page.keyboard.press("ControlOrMeta+Alt+f");
  const bar = page.getByRole("search", { name: "Find in note" });
  await bar.getByRole("textbox", { name: "Find in note" }).fill("heron");
  await expect(bar).toContainText("1 / 3");
  await bar.getByRole("textbox", { name: "Replace with" }).fill("egret");
  await bar.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(bar).toContainText("1 / 2");
  expect((await html(page)).match(/egret/g)?.length).toBe(1);
  await bar.getByRole("button", { name: "Replace all" }).click();
  await expect(bar.getByRole("status")).toHaveText("Replaced 2 matches");
  const after = await html(page);
  expect(after).not.toMatch(/heron/i);
  expect(after.match(/egret/g)?.length).toBe(3);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/find-replace.png` });
  // Replace all is ONE undo step.
  await page.keyboard.press("Escape");
  await page.locator(".tiptap").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await html(page)).match(/heron/g)?.length ?? 0).toBe(2);
  // Read-only: find works, replace is not offered.
  await open(page, "?readonly");
  await page.locator(".document-writing-surface").evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true, bubbles: true })));
  const ro = page.getByRole("search", { name: "Find in note" });
  await ro.getByRole("textbox", { name: "Find in note" }).fill("heron");
  await expect(ro).toContainText("1 / 3");
  await expect(ro.getByRole("button", { name: "Show replace" })).toHaveCount(0);
  await expect(ro.getByRole("textbox", { name: "Replace with" })).toHaveCount(0);
});

test("replace all in a live document reaches the other client as one undo step", async ({ page }) => {
  await open(page, "?live");
  const a = page.getByRole("region", { name: "Client A" });
  await expect(page.getByRole("region", { name: "Client B" }).locator(".tiptap")).toContainText("Closing heron note.");
  await a.getByText("Alpha paragraph about the river.").click();
  await page.keyboard.press("ControlOrMeta+Alt+f");
  const bar = page.getByRole("search", { name: "Find in note" });
  await bar.getByRole("textbox", { name: "Find in note" }).fill("heron");
  await expect(bar).toContainText("1 / 3");
  await bar.getByRole("textbox", { name: "Replace with" }).fill("egret");
  await bar.getByRole("button", { name: "Replace all" }).click();
  await expect.poll(() => html(page, 1)).not.toMatch(/heron/i);
  expect((await html(page, 1)).match(/egret/g)?.length).toBe(3);
  await page.keyboard.press("Escape");
  await a.locator(".tiptap").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await html(page, 1)).match(/heron/gi)?.length ?? 0).toBe(3);
  expect(await html(page, 1)).not.toContain("egret");
});

test("replace keeps offsets, deletes only the match, and never edits hidden link targets or chips", async ({ page }) => {
  // "İ" lower-cases to two code units: offsets must come from the original text.
  await open(page, `?content=${enc("<p>İİİ heron İ heron</p><p>heron</p><p>See [[heron|the bird]] and [[Projects/heron]] here: heron</p>")}`);
  await clickInto(page, "heron");
  await page.keyboard.press("ControlOrMeta+Alt+f");
  const bar = page.getByRole("search", { name: "Find in note" });
  await bar.getByRole("textbox", { name: "Find in note" }).fill("heron");
  // 2 in the first paragraph, 1 alone, 1 after the links — the two inside [[…]] are not matches.
  await expect(bar).toContainText("1 / 4");
  const marked = await page.locator(".prism-search-match").allTextContents();
  expect(marked).toEqual(["heron", "heron", "heron", "heron"]); // exact text, no off-by-one from "İ"
  // Empty replacement = delete the match only: the paragraph that was just "heron" stays (empty).
  await bar.getByRole("button", { name: "Replace all" }).click();
  const after = await html(page);
  expect(after).toContain("<p>İİİ  İ </p>");
  expect(after).toContain("<p></p>");
  expect(after).toContain("[[heron|the bird]]");
  expect(after).toContain("[[Projects/heron]]");
  expect((after.match(/<p/g) ?? []).length).toBe(3);
});

test("inline database: slash → new table view, and a linked view of an existing database", async ({ page }) => {
  await open(page, `?content=${enc("<p>Plan</p><p></p>")}`);
  await page.locator(".tiptap p").nth(1).click();
  await page.keyboard.type("/database");
  await expect(page.getByRole("option", { name: /^Table view/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New table database" });
  await dialog.getByRole("textbox").fill("not a tag!");
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Use a tag name");
  expect(await page.evaluate(() => (window as any).prismMediaCreates.length)).toBe(0);
  await dialog.getByRole("textbox").fill("book");
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog).toHaveCount(0);
  // Created as a sub-page of this page, embedded as an atom block that renders the database.
  const created = await page.evaluate(() => (window as any).prismMediaCreates[0]);
  expect(created.path).toBe("Projects/Prism/Field guide/book database");
  expect(created.metadata.prism_type).toBe("database");
  const block = page.locator(".prism-database-block");
  await expect(block).toHaveCount(1);
  await expect(block.getByRole("button", { name: "Braiding Sweetgrass" })).toBeVisible();
  let stored = await html(page);
  expect(stored).toMatch(/<div data-prism-database="new1" data-view="v[a-z0-9]+"><\/div>/);
  expect(stored).not.toContain("Braiding"); // rows are never copied into the page

  // Linked view of an existing database.
  await page.evaluate(() => { const ed = (document.querySelector(".tiptap") as any).editor; ed.chain().focus("end").insertContent("<p></p>").run(); });
  await expect(page.locator(".tiptap")).toBeFocused();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe("");
  await page.keyboard.type("/linked");
  await expect(page.getByRole("option", { name: /^Linked view of database/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  const link = page.getByRole("dialog", { name: "Link a database" });
  await link.getByRole("textbox", { name: "Search databases" }).fill("read");
  await link.getByRole("option", { name: "Reading list" }).click();
  await expect(page.locator(".prism-database-block")).toHaveCount(2);
  stored = await html(page);
  expect(stored).toMatch(/<div data-prism-database="db1" data-view="v[a-z0-9]+"><\/div>/);
  // The linked view was added to the database itself (so the block keeps its own layout).
  expect(await page.evaluate(() => (window as any).prismMediaVault.find((n: any) => n.id === "db1").metadata.prism_database.views.length)).toBe(2);

  // Reload from stored HTML: both blocks come back. A database the reader cannot open says so (no title, no rows).
  await open(page, `?readonly&content=${enc(stored)}`);
  await expect(page.locator(".prism-database-block")).toHaveCount(2);
  await expect(page.locator(".prism-database-block").first()).toContainText("This database is unavailable");
  await expect(page.locator(".prism-database-block").nth(1).getByRole("button", { name: "Braiding Sweetgrass" })).toBeVisible();
  expect(await html(page)).toBe(stored);
});

/* ───────────────────────── wave 3D verification rows ─────────────────────────
 * NP-ED-04 (markdown shortcuts), NP-ED-20 (undo/redo), NP-ED-21 (paste fidelity),
 * NP-ED-22 (find in page). Clauses the product does not meet are `test.fixme`
 * with the gap named — they are NOT weakened to pass. */

const editorDoc = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  (document.querySelector(".tiptap") as any).editor.state.doc.forEach((n: any) => out.push(`${n.type.name}:${n.textContent}`));
  return out;
});
async function emptyDoc(page: Page) {
  await open(page, `?content=${enc("<p></p>")}`);
  await page.locator(".tiptap[contenteditable=true]").click();
  await expect(page.locator(".tiptap")).toBeFocused();
}

const BLOCK_SHORTCUTS: Array<{ keys: string; html: RegExp; literal: string }> = [
  { keys: "# ", html: /^<h1[^>]*>x<\/h1>/, literal: "# x" },
  { keys: "## ", html: /^<h2[^>]*>x<\/h2>/, literal: "## x" },
  { keys: "### ", html: /^<h3[^>]*>x<\/h3>/, literal: "### x" },
  { keys: "- ", html: /^<ul[^>]*><li><p>x<\/p><\/li><\/ul>/, literal: "- x" },
  { keys: "* ", html: /^<ul[^>]*><li><p>x<\/p><\/li><\/ul>/, literal: "* x" },
  { keys: "+ ", html: /^<ul[^>]*><li><p>x<\/p><\/li><\/ul>/, literal: "+ x" },
  { keys: "1. ", html: /^<ol[^>]*><li><p>x<\/p><\/li><\/ol>/, literal: "1. x" },
  { keys: "[] ", html: /^<ul[^>]*data-type="taskList"/, literal: "[] x" },
  { keys: "> ", html: /^<blockquote[^>]*><p>x<\/p><\/blockquote>/, literal: "> x" },
  { keys: "``` ", html: /^<pre[^>]*><code[^>]*>x<\/code><\/pre>/, literal: "``` x" },
];
const INLINE_SHORTCUTS: Array<{ keys: string; html: RegExp }> = [
  { keys: "**b** ", html: /<strong>b<\/strong>/ },
  { keys: "*i* ", html: /<em>i<\/em>/ },
  { keys: "`c` ", html: /<code>c<\/code>/ },
  { keys: "~~s~~ ", html: /<s>s<\/s>/ },
];

test("markdown shortcuts convert as you type", async ({ page }) => {
  test.setTimeout(90_000);
  // Every block prefix converts as it is typed (`>` is a quote by design, checklist §1.3).
  for (const s of BLOCK_SHORTCUTS) {
    await emptyDoc(page);
    await page.keyboard.type(s.keys);
    await page.keyboard.type("x");
    await expect.poll(() => html(page), { message: `"${s.keys}" converts` }).toMatch(s.html);
  }
  // `---` becomes a divider.
  await emptyDoc(page);
  await page.keyboard.type("---");
  await expect.poll(() => html(page)).toContain("<hr");
  // Inline marks convert when the closing delimiter is typed; the delimiters disappear.
  for (const s of INLINE_SHORTCUTS) {
    await emptyDoc(page);
    await page.keyboard.type(s.keys);
    await expect.poll(() => html(page), { message: `"${s.keys}" converts` }).toMatch(s.html);
    expect(await html(page)).not.toMatch(/\*\*|~~|`/);
  }
});

// NP-ED-04: ⌘Z after a conversion gives the literal characters back (EditorKeys' input-rule undo).
test("markdown shortcuts convert and undo to literal", async ({ page }) => {
  // ⌘Z right after a conversion gives the literal characters back (not an empty line, not the converted block).
  for (const s of BLOCK_SHORTCUTS) {
    await emptyDoc(page);
    await page.keyboard.type(s.keys);
    await expect.poll(() => editorDoc(page), { message: `"${s.keys}" converted before undo` }).not.toEqual(["paragraph:"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await editorDoc(page)).map((b) => b.trimEnd()), { message: `undo of "${s.keys}" restores the literal characters` }).toEqual([`paragraph:${s.keys.trimEnd()}`]);
  }
});

// NP-ED-04: `>>` + space is the toggle shortcut (Typography's » is off); ⌘Z gives ">> " back; `>` alone stays a quote.
test("markdown shortcuts: >> + space makes a toggle", async ({ page }) => {
  await emptyDoc(page);
  await page.keyboard.type(">> x");
  await expect.poll(() => html(page)).toMatch(/^<details data-type="toggle"><summary>x<\/summary>/);
  await emptyDoc(page);
  await page.keyboard.type(">> ");
  await expect.poll(() => editorDoc(page)).toEqual(["toggle:", "paragraph:"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await editorDoc(page)).map((b) => b.trimEnd())).toEqual(["paragraph:>>"]);
  await emptyDoc(page);
  await page.keyboard.type("> q");
  await expect.poll(() => html(page)).toMatch(/^<blockquote><p>q<\/p><\/blockquote>/);
});

test("undo covers block ops; collab undo is per-user", async ({ page }) => {
  test.setTimeout(90_000);
  const mod = "ControlOrMeta";
  const start = ["paragraph:one", "paragraph:two", "paragraph:three"];
  const fresh = async () => {
    await open(page, `?content=${enc("<p>one</p><p>two</p><p>three</p>")}`);
    await clickInto(page, "two");
    await page.keyboard.press("End");
  };
  const undoRedo = async (label: string, changed: (doc: string[], html: string) => boolean) => {
    const after = { doc: await editorDoc(page), html: await html(page) };
    expect(changed(after.doc, after.html), `${label}: the change happened`).toBe(true);
    const base = await page.evaluate(() => (window as any).__base as string);
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => html(page), { message: `${label}: one ⌘Z restores the document` }).toBe(base);
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect.poll(() => html(page), { message: `${label}: ⌘⇧Z redoes it` }).toBe(after.html);
  };
  const mark = () => page.evaluate(() => { (window as any).__base = (document.querySelector(".tiptap") as any).editor.getHTML(); });
  const run = (fn: string) => page.evaluate((fn) => { const editor = (document.querySelector(".tiptap") as any).editor; new Function("editor", fn)(editor); }, fn);

  // Typing.
  await fresh(); await mark();
  await page.keyboard.type(" typed");
  await undoRedo("typing", (doc) => doc[1] === "paragraph:two typed");
  // Block move (Alt+Shift+↓).
  await fresh(); await mark();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await undoRedo("block move", (doc) => doc.join() === ["paragraph:one", "paragraph:three", "paragraph:two"].join());
  // Turn into (heading shortcut).
  await fresh(); await mark();
  await page.keyboard.press(`${mod}+Alt+1`);
  await undoRedo("turn into", (doc) => doc[1] === "heading:two");
  // Block colour.
  await fresh(); await mark();
  // The block menu's Color item dispatches exactly this (setTopBlockColor); the menu itself is driven in editor-blocks.spec.
  await run(`let at = -1; editor.state.doc.forEach((n, o) => { if (n.textContent === "two") at = o; }); const n = editor.state.doc.nodeAt(at); editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...n.attrs, blockColor: "blue" }));`);
  await undoRedo("colour", (_d, h) => /data-block-color="blue"/.test(h));
  // Delete a block's text.
  await fresh(); await mark();
  await page.getByText("two", { exact: true }).selectText();
  await page.keyboard.press("Backspace");
  await undoRedo("delete", (doc) => doc[1] === "paragraph:");
  // Table edit: adding a row is its own undo step.
  await open(page, `?content=${enc("<table><tbody><tr><th><p>Name</p></th><th><p>Role</p></th></tr><tr><td><p>Ada</p></td><td><p>Lead</p></td></tr></tbody></table><p>after</p>")}`);
  await clickInto(page, "Ada");
  await mark();
  await run(`editor.chain().focus().addRowAfter().run()`);
  await undoRedo("table edit", (_d, h) => (h.match(/<tr/g) ?? []).length === 3);
  expect(start).toHaveLength(3);

  // Collab: undo reverts only MY changes — the other person's concurrent edit stays.
  await open(page, "?live");
  const a = page.getByRole("region", { name: "Client A" });
  const b = page.getByRole("region", { name: "Client B" });
  await expect(b.locator(".tiptap")).toContainText("Closing heron note.");
  await a.getByText("Alpha paragraph about the river.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A-EDIT");
  await expect(b.locator(".tiptap")).toContainText("river. A-EDIT");
  await b.getByText("Closing heron note.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" B-EDIT");
  await expect(a.locator(".tiptap")).toContainText("note. B-EDIT");
  await page.keyboard.press(`${mod}+z`); // focus is in B
  await expect(b.locator(".tiptap")).not.toContainText("B-EDIT");
  await expect(a.locator(".tiptap")).not.toContainText("B-EDIT");
  await expect(a.locator(".tiptap")).toContainText("A-EDIT");
  await expect(b.locator(".tiptap")).toContainText("A-EDIT");
  // …and B's redo brings back only B's edit.
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(a.locator(".tiptap")).toContainText("note. B-EDIT");
});

async function pasteClipboard(page: Page, data: Record<string, string>) {
  await page.evaluate((data) => {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    document.querySelector(".tiptap")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
}

/** What each source app puts on the clipboard for the same small document (wrappers and class noise as they emit it). */
const RICH_BODY = '<h2>Plan</h2><p>Intro with <a href="https://example.test/doc">a link</a>.</p><ul><li>First</li><li>Second</li></ul><ol><li>Step</li></ol><table><tbody><tr><td>Name</td><td>Role</td></tr><tr><td>Ada</td><td>Lead</td></tr></tbody></table><pre><code>const a = 1;</code></pre><img src="https://example.test/pic.png" alt="Pic">';
const PASTE_SOURCES: Record<string, string> = {
  notion: `<meta charset="utf-8">${RICH_BODY.replace("<h2>", '<h2 class="notion-header-block">')}<ul class="to-do-list"><li><input type="checkbox" checked> Ship</li></ul>`,
  gdocs: `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234">${RICH_BODY.replace(/<(p|li|h2)>/g, '<$1 dir="ltr" style="line-height:1.38;margin-top:0pt;"><span style="font-size:11pt;font-family:Arial;">').replace(/<\/(p|li|h2)>/g, "</span></$1>")}</b>`,
  word: `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment-->${RICH_BODY.replace(/<p>/g, '<p class="MsoNormal">')}<!--EndFragment--></body></html>`,
  web: `<div><article>${RICH_BODY}</article></div>`,
};

test("paste fidelity from Notion/GDocs/Markdown", async ({ page }) => {
  for (const [source, clip] of Object.entries(PASTE_SOURCES)) {
    await emptyDoc(page);
    await pasteClipboard(page, { "text/html": clip, "text/plain": "Plan" });
    const out = await html(page);
    const say = (what: string) => `${source}: ${what} survives the paste`;
    expect(out, say("heading")).toMatch(/<h2[^>]*>Plan<\/h2>/);
    expect(out, say("link")).toMatch(/<a [^>]*href="https:\/\/example\.test\/doc"[^>]*>a link<\/a>/);
    expect(out, say("bulleted list")).toMatch(/<ul[^>]*><li><p>First<\/p><\/li><li><p>Second<\/p><\/li><\/ul>/);
    expect(out, say("numbered list")).toMatch(/<ol[^>]*><li><p>Step<\/p><\/li><\/ol>/);
    expect(out, say("table")).toMatch(/<table[\s\S]*Ada[\s\S]*Lead[\s\S]*<\/table>/);
    expect(out, say("code")).toMatch(/<pre[^>]*><code[^>]*>const a = 1;<\/code><\/pre>/);
    expect(out, say("image")).toMatch(/<img [^>]*src="https:\/\/example\.test\/pic\.png"/);
    expect(out, `${source}: no source-app styling is stored`).not.toMatch(/MsoNormal|docs-internal-guid|font-family|notion-header-block/);
  }
  // Wikilinks survive a paste as text the editor still recognises.
  await emptyDoc(page);
  await pasteClipboard(page, { "text/plain": "See [[Projects/Prism/Roadmap]] today" });
  expect(await html(page)).toContain("[[Projects/Prism/Roadmap]]");
});

// NP-ED-21: checkbox lists (Notion, GitHub, Markdown exports) paste as to-do lists with their checked state.
test("paste fidelity: a pasted to-do list stays a to-do list", async ({ page }) => {
  await emptyDoc(page);
  await pasteClipboard(page, { "text/html": '<ul class="to-do-list"><li><input type="checkbox" checked> Ship</li></ul>', "text/plain": "Ship" });
  expect(await html(page)).toMatch(/<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span><\/span><\/label><div><p>Ship<\/p><\/div><\/li><\/ul>/);
  // Notion's own markup (a div checkbox) and a mixed list (not every item has a box → stays a bullet list).
  await emptyDoc(page);
  await pasteClipboard(page, { "text/html": '<ul class="to-do-list"><li><div class="checkbox checkbox-off"></div> Draft</li><li><div class="checkbox checkbox-on"></div> Review</li></ul>', "text/plain": "Draft" });
  expect((await editorDoc(page))[0]).toBe("taskList:DraftReview");
  expect((await html(page)).match(/data-checked="(true|false)"/g)).toEqual(['data-checked="false"', 'data-checked="true"']);
  await emptyDoc(page);
  await pasteClipboard(page, { "text/html": '<ul><li><input type="checkbox"> Boxed</li><li>Plain</li></ul>', "text/plain": "x" });
  expect((await editorDoc(page))[0]).toMatch(/^bulletList:/);
});

// NP-ED-21: plain-text Markdown (no HTML flavour on the clipboard) becomes blocks; prose and code blocks stay literal.
test("paste fidelity: pasted Markdown text becomes blocks", async ({ page }) => {
  await emptyDoc(page);
  await pasteClipboard(page, { "text/plain": "## Plan\n\n- First\n- Second\n\n```\nconst a = 1;\n```\n" });
  const out = await html(page);
  expect(out).toMatch(/<h2[^>]*>Plan<\/h2>/);
  expect(out).toMatch(/<ul[^>]*><li><p>First<\/p><\/li>/);
  expect(out).toMatch(/<pre><code>const a = 1;<\/code><\/pre>/);
  // Task items, inline marks and a wikilink in Markdown text.
  await emptyDoc(page);
  await pasteClipboard(page, { "text/plain": "- [x] Done **now**\n- [ ] Later, see [[Projects/my_page|My page]]\n" });
  const todo = await html(page);
  expect(todo).toMatch(/data-type="taskList"/);
  expect(todo).toMatch(/data-checked="true"[\s\S]*<strong>now<\/strong>/);
  expect(todo).toContain("[[Projects/my_page|My page]]");
  // Ordinary prose is not parsed (a lone asterisk or underscore is just text).
  await emptyDoc(page);
  await pasteClipboard(page, { "text/plain": "2 * 3 = 6 and snake_case_name" });
  expect(await html(page)).toBe("<p>2 * 3 = 6 and snake_case_name</p>");
  // Inside a code block Markdown stays source.
  await open(page, `?content=${enc("<pre><code>x</code></pre>")}`);
  await page.locator(".tiptap pre code").click();
  await pasteClipboard(page, { "text/plain": "## not a heading" });
  expect(await html(page)).not.toContain("<h2");
});

// NP-ED-21: a copy carries rich text (text/html) and Markdown (text/plain).
test("copy fidelity: copying out gives rich text and Markdown", async ({ page }) => {
  await open(page, `?content=${enc('<h2>Plan</h2><ul><li><p>First</p></li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Ship <strong>it</strong></p></li></ul><p>See [[Projects/Prism/Roadmap]] and <a href="https://example.test/x">a link</a></p><pre><code class="language-ts">const a = 1;</code></pre>')}`);
  const copied = await page.evaluate(() => {
    const editor = (document.querySelector(".tiptap") as any).editor;
    editor.chain().focus().selectAll().run();
    const dt = new DataTransfer();
    document.querySelector(".tiptap")!.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return { html: dt.getData("text/html"), text: dt.getData("text/plain") };
  });
  expect(copied.html).toContain("<h2");
  expect(copied.text).toContain("## Plan");
  expect(copied.text).toContain("- First");
  expect(copied.text).toContain("- [x] Ship **it**");
  expect(copied.text).toContain("See [[Projects/Prism/Roadmap]] and [a link](https://example.test/x)");
  expect(copied.text).toContain("```ts\nconst a = 1;\n```");
  // A selection inside one block copies as its plain text (no Markdown markers).
  const inline = await page.evaluate(() => {
    const editor = (document.querySelector(".tiptap") as any).editor;
    let at = -1;
    editor.state.doc.descendants((n: any, pos: number) => { if (n.isText && n.text === "Ship ") at = pos; });
    editor.chain().focus().setTextSelection({ from: at, to: at + 7 }).run();
    const dt = new DataTransfer();
    document.querySelector(".tiptap")!.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData("text/plain");
  });
  expect(inline).toBe("Ship it");
});

test("find in page counts and steps", async ({ page }) => {
  await open(page);
  await clickInto(page, "Alpha paragraph about the river.");
  await page.keyboard.press("ControlOrMeta+f"); // the real key, in an editable page
  const bar = page.getByRole("search", { name: "Find in note" });
  const field = bar.getByRole("textbox", { name: "Find in note" });
  await expect(field).toBeFocused();
  await field.fill("heron");
  await expect(bar).toContainText("1 / 3");
  // Every match is highlighted, and exactly one is the current match.
  await expect(page.locator(".prism-search-match")).toHaveCount(3);
  const current = () => page.evaluate(() => {
    const all = [...document.querySelectorAll(".prism-search-match")];
    return all.map((el, i) => (el.classList.contains("prism-search-match-active") ? i : -1)).filter((i) => i >= 0);
  });
  expect(await current()).toEqual([0]);
  // Next / previous by button, wrapping at both ends.
  await bar.getByRole("button", { name: "Next match" }).click();
  await expect(bar).toContainText("2 / 3");
  expect(await current()).toEqual([1]);
  await bar.getByRole("button", { name: "Next match" }).click();
  await expect(bar).toContainText("3 / 3");
  await bar.getByRole("button", { name: "Next match" }).click();
  await expect(bar).toContainText("1 / 3");
  await bar.getByRole("button", { name: "Previous match" }).click();
  await expect(bar).toContainText("3 / 3");
  expect(await current()).toEqual([2]);
  // …and by keyboard from the field.
  await field.focus();
  await page.keyboard.press("Enter");
  await expect(bar).toContainText("1 / 3");
  await page.keyboard.press("Shift+Enter");
  await expect(bar).toContainText("3 / 3");
  // No match is stated, not left as a stale count.
  await field.fill("zebra");
  await expect(bar).not.toContainText("/ 3");
  await expect(page.locator(".prism-search-match")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Next match" })).toBeDisabled();
  // Esc closes and clears the highlights.
  await field.fill("heron");
  await expect(page.locator(".prism-search-match")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(page.locator(".prism-search-match")).toHaveCount(0);
});

// NP-ED-22: on a phone (no ⌘F) the page ⋯ sheet opens the same find bar.
test("find in page: phone reaches it from ⋯", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("button", { name: "Find in page" }).or(page.getByRole("menuitem", { name: "Find in page" })).click();
  const bar = page.getByRole("search", { name: "Find in note" });
  const field = bar.getByRole("textbox", { name: "Find in note" });
  await expect(field).toBeFocused();
  await field.fill("workshop");
  await expect(bar).toContainText(/1 \/ \d+/);
  await expect(page.locator(".prism-search-match").first()).toBeVisible();
  const box = (await bar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await bar.getByRole("button", { name: "Close find" }).click();
  await expect(bar).toHaveCount(0);
  // Desktop: the same entry sits in the ⋯ menu, and ⌘K with no selection is still quick find (NP-SB-02).
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Find in page" }).click();
  await expect(page.getByRole("search", { name: "Find in note" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".tiptap[contenteditable=true]").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("textbox", { name: "Link address" })).toHaveCount(0);
  await expect(page.getByRole("dialog").first()).toBeVisible(); // the command bar / quick find
  // Help → Keyboard shortcuts lives there too (NP-ED-07).
  await page.keyboard.type("Keyboard Shortcuts");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

// NP-ED-25: placeholders on the focused empty block, per block type; nothing when unfocused or read-only.
test("placeholders: empty document, empty line, headings and list items", async ({ page }) => {
  const hint = (selector: string) => page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const before = getComputedStyle(el, "::before");
    return { text: el.getAttribute("data-placeholder"), shown: before.content !== "none" && before.content !== "normal" && Number(before.opacity) > 0.1 };
  }, selector);
  await open(page, `?content=${enc("<p></p>")}`);
  // An empty document shows its hint before it is focused.
  await expect.poll(() => hint(".tiptap p.is-editor-empty")).toEqual({ text: "Start writing, or press / for commands...", shown: true });
  await open(page);
  await clickInto(page, "Closing heron note.");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => hint(".tiptap p.is-empty")).toEqual({ text: "Type '/' for commands", shown: true });
  await page.keyboard.type("## ");
  await expect.poll(() => hint(".tiptap h2.is-empty")).toEqual({ text: "Heading 2", shown: true });
  await page.keyboard.press("ControlOrMeta+Alt+0");
  await page.keyboard.type("- ");
  await expect.poll(() => hint(".tiptap li p.is-empty")).toEqual({ text: "List", shown: true });
  await page.keyboard.press("Enter"); // leaves the list
  await page.keyboard.type("[] ");
  await expect.poll(() => hint('.tiptap li[data-checked] p.is-empty')).toEqual({ text: "To-do", shown: true });
  await page.keyboard.press("Enter");
  await page.keyboard.type(">> ");
  await expect.poll(() => hint(".tiptap summary.is-empty")).toEqual({ text: "Toggle", shown: true });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/placeholders-light.png` });
  // Only the block holding the caret is hinted, the hint is never stored, and blur hides it.
  expect(await page.locator(".tiptap .is-empty").count()).toBe(1);
  expect(await html(page)).not.toMatch(/placeholder|is-empty/);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect.poll(async () => (await hint(".tiptap summary.is-empty"))?.shown).toBe(false);
  // Typing removes it; a focused editor draws no box around the document.
  await page.locator(".tiptap summary").click();
  await page.keyboard.type("x");
  await expect(page.locator(".tiptap .is-empty")).toHaveCount(0);
  expect(await page.locator(".tiptap").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  // Read-only: no hints.
  await open(page, `?readonly&content=${enc("<p>one</p><p></p>")}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  expect(await page.evaluate(() => [...document.querySelectorAll(".tiptap *")].some((el) => { const b = getComputedStyle(el, "::before"); return el.hasAttribute("data-placeholder") && b.content !== "none" && Number(b.opacity) > 0.1; }))).toBe(false);
});

// NP-PG-15: slash /page creates the sub-page in place and shows it as a link row; the row stores the id only.
test("child page block appears in parent body", async ({ page }) => {
  await open(page);
  await clickInto(page, "Alpha paragraph about the river.");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/page");
  await page.getByRole("option", { name: /^Page Add a sub-page/ }).click();
  const row = page.getByRole("button", { name: "Open sub-page: Untitled" });
  await expect(row).toBeVisible();
  // Created INSIDE this page, once.
  expect(await page.evaluate(() => (window as any).prismMediaCreates.map((c: any) => c.path))).toEqual(["Projects/Prism/Field guide/Untitled"]);
  // The stored block is the id and nothing else: no title, no path.
  const stored = await html(page);
  expect(stored).toContain('<p>Alpha paragraph about the river.</p><div data-page-id="new1" data-type="child-page"></div>');
  expect(stored).not.toMatch(/Untitled/);
  // The title follows the page (resolved live), like a page mention.
  await page.evaluate(() => { const n = (window as any).prismMediaVault.find((x: any) => x.id === "new1"); n.path = "Projects/Prism/Field guide/Trip plan"; n.metadata = { ...n.metadata, title: "Trip plan", icon: "🧭" }; });
  await open(page, `?content=${enc('<p>Top</p><div data-type="child-page" data-page-id="db1"></div><div data-type="child-page" data-page-id="ghost"></div><div data-type="child-page" data-page-id="../x"></div>')}`);
  await expect(page.getByRole("button", { name: "Open sub-page: Reading list" })).toBeVisible();
  // A page the reader cannot see names nothing; an invalid id is never a block.
  const ghost = page.locator('.tiptap .prism-child-page[data-state="missing"]');
  await expect(ghost).toHaveText("No access");
  await expect(page.locator(".tiptap .prism-child-page")).toHaveCount(2);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/child-page-rows.png` });
  // Deleting a row offers to move that page to Trash (it names no page); Keep leaves it alone.
  const removeRow = (id: string) => page.evaluate((id) => {
    const editor = (document.querySelector(".tiptap") as any).editor;
    let at = -1;
    editor.state.doc.descendants((n: any, pos: number) => { if (n.type.name === "childPage" && n.attrs.pageId === id) at = pos; });
    editor.chain().focus().setNodeSelection(at).run();
  }, id);
  await removeRow("db1");
  await page.keyboard.press("Backspace");
  const offer = page.getByRole("alertdialog", { name: "Sub-page link removed" });
  await expect(offer).toBeVisible();
  await expect(offer).not.toContainText("Reading list");
  await offer.getByRole("button", { name: "Keep page" }).click();
  await expect(offer).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismMediaTrashed)).toEqual([]);
  // Undo brings the row back; deleting again and choosing Trash moves the page.
  await page.locator(".tiptap").focus();
  await expect(page.locator(".tiptap")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("button", { name: "Open sub-page: Reading list" })).toBeVisible();
  await removeRow("db1");
  await page.keyboard.press("Backspace");
  await page.getByRole("alertdialog", { name: "Sub-page link removed" }).getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.getByText("Moved to Trash.")).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismMediaTrashed)).toEqual(["db1"]);
  // A page created inside this one elsewhere (tree +, "Add a page inside") gets its row too — once.
  await page.locator(".tiptap").getByText("Top").click();
  await page.evaluate(() => {
    const detail = { id: "b1", parentPath: "Projects/Prism/Field guide" };
    window.dispatchEvent(new CustomEvent("prism:page-created", { detail }));
    window.dispatchEvent(new CustomEvent("prism:page-created", { detail }));
    window.dispatchEvent(new CustomEvent("prism:page-created", { detail: { id: "db1", parentPath: "Somewhere/Else" } }));
  });
  await expect.poll(async () => ((await html(page)).match(/data-page-id="b1"/g) ?? []).length).toBe(1);
  expect(await html(page)).not.toContain('data-page-id="db1"');
  // Read-only pages show the row as a link and offer no /page.
  await open(page, `?readonly&content=${enc('<div data-type="child-page" data-page-id="b1"></div>')}`);
  await expect(page.getByRole("button", { name: "Open sub-page: Braiding Sweetgrass" })).toBeVisible();
});

// NP-RF-01: `[[` rows carry an icon and the path; "Create page '<query>'" makes the page and links it.
test("[[ create page from query", async ({ page }) => {
  await open(page);
  await clickInto(page, "Closing heron note.");
  await page.keyboard.press("End");
  await page.keyboard.type(" [[Read");
  const list = page.getByRole("listbox", { name: "Link to a document" });
  await expect(list.getByRole("option").first()).toContainText("Reading list");
  await expect(list.getByRole("option").first()).toContainText("Projects/Prism/Reading list");
  await expect(list.getByRole("option").first().locator("[data-wikilink-icon]")).toBeVisible();
  // An exact title offers no duplicate "create".
  await page.keyboard.type("ing list");
  await expect(list.getByRole("option", { name: /Create page/ })).toHaveCount(0);
  for (let i = 0; i < "Reading list".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Heron census 2026");
  const create = list.getByRole("option", { name: "Create page “Heron census 2026” A new page inside this one" });
  await expect(create).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => html(page)).toContain("[[new1|Heron census 2026]]");
  expect(await page.evaluate(() => (window as any).prismMediaCreates.map((c: any) => [c.path, c.metadata?.title]))).toEqual([["Projects/Prism/Field guide/Heron census 2026", "Heron census 2026"]]);
  await expect(list).toHaveCount(0);
  // A path-like query is a typed link, not a title to create.
  await page.keyboard.type("[[Projects/Nowhere");
  await expect(page.getByRole("option", { name: /Create page/ })).toHaveCount(0);
  // A refused create keeps what was typed and says so.
  await open(page, "?nocreate");
  await clickInto(page, "Closing heron note.");
  await page.keyboard.press("End");
  await page.keyboard.type(" [[Private plan");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t create that page" })).toBeVisible();
  expect(await html(page)).toContain("[[Private plan");
  // Read-only pages offer no create.
});

// NP-ED-18: a URL pasted over selected text links that text (it does not replace it).
test("paste URL over selection links the text", async ({ page }) => {
  await open(page);
  await page.getByText("Closing heron note.", { exact: true }).selectText();
  await expect.poll(() => page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; return e.state.doc.textBetween(e.state.selection.from, e.state.selection.to); })).toBe("Closing heron note.");
  await pasteClipboard(page, { "text/plain": "https://example.test/herons" });
  await expect.poll(() => html(page)).toMatch(/<a [^>]*href="https:\/\/example\.test\/herons"[^>]*>Closing heron note\.<\/a>/);
  await expect(page.getByRole("menu", { name: /Paste as/i })).toHaveCount(0);
  // A script URL is never a link.
  await page.getByText("Heron and heron again.", { exact: true }).selectText();
  await pasteClipboard(page, { "text/plain": "javascript:alert(1)" });
  expect(await html(page)).not.toMatch(/href="javascript/i);
});

// NP-ED-01 / NP-ED-06 in a LIVE document: a block selection moves as a group, reaches the other client,
// undoes as one step, and ⌘Z after a Markdown conversion restores the typed characters there too.
test("live document: block selection moves as a group; markdown undo restores the literal", async ({ page }) => {
  await open(page, "?live");
  const a = page.getByRole("region", { name: "Client A" });
  const b = page.getByRole("region", { name: "Client B" });
  const blocks = (i: number) => page.evaluate((i) => {
    const out: string[] = [];
    (document.querySelectorAll(".tiptap")[i] as any).editor.state.doc.forEach((n: any) => out.push(`${n.type.name}:${n.textContent}`));
    return out;
  }, i);
  await expect(b.locator(".tiptap")).toContainText("Closing heron note.");
  const start = await blocks(0);
  const clickA = async (text: string) => {
    await a.getByText(text, { exact: true }).click();
    await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe(text);
  };
  await clickA("Alpha paragraph about the river.");
  await page.keyboard.press("Escape");
  await expect(a.locator(".tiptap > .ProseMirror-selectednode")).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(a.locator(".tiptap > .prism-block-selected")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
  const moved = [start[0], start[3], start[1], start[2], ...start.slice(4)];
  await expect.poll(() => blocks(0)).toEqual(moved);
  await expect.poll(() => blocks(1)).toEqual(moved); // the collaborator sees the same order
  await expect(a.locator(".tiptap > .prism-block-selected")).toHaveCount(2); // still selected where they landed
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blocks(1)).toEqual(start);
  // Markdown undo in the shared document.
  await clickA("Closing heron note.");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## ");
  await expect.poll(() => blocks(0)).toContain("heading:");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await blocks(0)).map((t) => t.trimEnd())).toContain("paragraph:##");
  await expect.poll(async () => (await blocks(1)).map((t) => t.trimEnd())).toContain("paragraph:##");
});
