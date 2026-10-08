import { test, expect, type Page } from "@playwright/test";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;
const editorHtml = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
const lastWrite = (page: Page) => page.evaluate(() => (window as any).prismBlockWrites.at(-1)?.content ?? "");

/** Put the caret at the end of the document on a fresh empty line. */
async function newLine(page: Page) {
  const editor = page.locator(".tiptap[contenteditable=true]");
  await editor.click();
  await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.focus("end"));
  await page.keyboard.press("Enter");
}

async function slash(page: Page, query: string) {
  await page.keyboard.type(`/${query}`);
  const menu = page.getByRole("listbox", { name: "Insert block" });
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/editor-blocks.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
});

test("the slash menu is grouped, shows shortcut hints and is a keyboard-driven listbox", async ({ page }) => {
  await newLine(page);
  const menu = await slash(page, "");
  await expect(menu.locator(".editor-menu-section")).toHaveText(["Basic blocks", "Media", "Database", "Advanced"]);
  const options = menu.getByRole("option");
  for (const name of ["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "To-do list", "Toggle", "Quote", "Callout", "Divider", "Image", "Code", "Table", "Link to page", "2 columns", "3 columns"]) {
    expect(await options.filter({ hasText: new RegExp(`^${name}`) }).count(), name).toBeGreaterThan(0);
  }
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(options.filter({ hasText: /^Heading 1/ }).locator("kbd")).toHaveText(/⌘⌥1|Ctrl\+Alt\+1/);
  // The editor keeps focus and points at the active option.
  const editor = page.locator(".tiptap");
  await expect(editor).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  expect(await editor.getAttribute("aria-activedescendant")).toBe(await options.nth(1).getAttribute("id"));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/slash-menu-1440.png` });
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp"); // wraps to the last item
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor).not.toHaveAttribute("aria-activedescendant", /.+/);
});

test("fuzzy search ranks the intended block first", async ({ page }) => {
  await newLine(page);
  const cases: Array<[string, string]> = [["h2", "Heading 2"], ["tbl", "Table"], ["callo", "Callout"], ["todo", "To-do list"], ["cols", "2 columns"], ["3col", "3 columns"], ["div", "Divider"], ["pic", "Image"], ["togg", "Toggle"], ["page", "Page"], ["link", "Link to page"], ["4col", "4 columns"], ["5col", "5 columns"], ["subpage", "Page"]];
  for (const [query, expected] of cases) {
    const menu = await slash(page, query);
    await expect(menu.getByRole("option").first(), query).toHaveAccessibleName(new RegExp(`^${expected}`));
    await page.keyboard.press("Escape");
    for (let i = 0; i <= query.length; i++) await page.keyboard.press("Backspace");
  }
  await page.keyboard.type("/zzzz");
  await expect(page.getByRole("listbox", { name: "Insert block" })).toHaveCount(0);
});

test("a block's name can be typed in full: several words keep the menu open, prose closes it", async ({ page }) => {
  await newLine(page);
  const menu = page.getByRole("listbox", { name: "Insert block" });
  for (const [query, expected] of [["toggle heading 2", "Toggle heading 2"], ["table of", "Table of contents"], ["2 col", "2 columns"], ["to-do list", "To-do list"], ["link to", "Link to page"]] as const) {
    await page.keyboard.type(`/${query}`);
    await expect(menu.getByRole("option").first(), query).toHaveAccessibleName(new RegExp(`^${expected}`));
    for (let i = 0; i <= query.length; i++) await page.keyboard.press("Backspace");
  }
  // Enter on a several-word query inserts that block and removes the typed command.
  await page.keyboard.type("/toggle heading 2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Section");
  expect(await editorHtml(page)).toMatch(/<details[^>]*data-heading-level="2"[^>]*><summary>Section<\/summary>/);
  expect(await editorHtml(page)).not.toContain("/toggle");
  // Ordinary writing after a "/" is not a command: no menu, Enter is a new line and the text stays.
  await newLine(page);
  await page.keyboard.type("/usr and local paths");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.type("next");
  expect(await editorHtml(page)).toContain("<p>/usr and local paths</p><p>next</p>");
  // A space straight after the "/" never opens it.
  await newLine(page);
  await page.keyboard.type("/ table");
  await expect(menu).toHaveCount(0);
});

test("every slash block inserts the node it names and the stored HTML keeps it", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept("https://images.example.test/chart.png"));
  const run = async (query: string, after?: string) => {
    await newLine(page);
    await slash(page, query);
    await page.keyboard.press("Enter");
    if (after) await page.keyboard.type(after);
  };
  await run("h1", "Big title");
  await run("callout", "Mind the gap");
  await run("toggle", "Show details");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Hidden body");
  await run("quote", "Quoted");
  await run("todo", "A task");
  await run("divider");
  await run("code", "x = 1");
  await run("table");
  await page.keyboard.type("Header A");
  await run("2col", "Left side");
  await run("3col", "First of three");
  await run("image");
  const html = await editorHtml(page);
  expect(html).toContain("<h1>Big title</h1>");
  expect(html).toMatch(/<div data-emoji="💡" data-type="callout"><p>Mind the gap<\/p><\/div>/);
  expect(html).toMatch(/<details data-type="toggle"><summary>Show details<\/summary><p>Hidden body<\/p><\/details>/);
  expect(html).toContain("<blockquote><p>Quoted</p></blockquote>");
  expect(html).toMatch(/data-type="taskItem"[^>]*>.*A task/);
  expect(html).toContain("<hr>");
  expect(html).toMatch(/<pre><code[^>]*>x = 1<\/code><\/pre>/);
  expect(html).toMatch(/<table[\s\S]*<th[^>]*><p>Header A<\/p><\/th>/);
  expect(html).toMatch(/<div data-type="columns" data-count="2"><div data-type="column"><p>Left side<\/p><\/div><div data-type="column"><p><\/p><\/div><\/div>/);
  expect(html).toMatch(/<div data-type="columns" data-count="3"><div data-type="column"><p>First of three<\/p>/);
  expect(html).toContain('<img src="https://images.example.test/chart.png">');
  await expect.poll(() => lastWrite(page), { timeout: 6000 }).toBe(html);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/slash-blocks-1440.png`, fullPage: true });
});

test("collapsing a toggle hides its body locally and never writes to the document", async ({ page }) => {
  await newLine(page);
  await slash(page, "toggle");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Summary line");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Secret body");
  await expect(page.getByText("Secret body")).toBeVisible();
  const before = await editorHtml(page);
  const txs = await page.evaluate(() => { const log: number[] = []; (document.querySelector(".tiptap") as any).editor.on("transaction", ({ transaction }: any) => { if (transaction.docChanged) log.push(1); }); (window as any).toggleTx = log; });
  void txs;
  await page.getByRole("button", { name: "Collapse toggle" }).click();
  await expect(page.getByText("Secret body")).toBeHidden();
  expect(await editorHtml(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).toggleTx.length)).toBe(0);
  expect(before).toMatch(/<details data-type="toggle"><summary>Summary line<\/summary><p>Secret body<\/p><\/details>/);
  await page.getByRole("button", { name: "Expand toggle" }).click();
  await expect(page.getByText("Secret body")).toBeVisible();
});

test("Link to page opens the wikilink picker", async ({ page }) => {
  await newLine(page);
  await slash(page, "link");
  await page.keyboard.press("Enter");
  expect(await editorHtml(page)).toContain("[[");
  await page.keyboard.type("Road");
  await expect(page.getByText("Roadmap").first()).toBeVisible();
});

test("phones: the slash menu fits the screen and uses large targets; columns stack", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/editor-blocks.html");
  await newLine(page);
  const menu = await slash(page, "");
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const option = await menu.getByRole("option").first().boundingBox();
  expect(option!.height).toBeGreaterThanOrEqual(44);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/slash-menu-390.png` });
  await page.keyboard.type("2col");
  await page.keyboard.press("Enter");
  const columns = page.locator('.tiptap div[data-type="column"]');
  const [a, b] = [await columns.nth(0).boundingBox(), await columns.nth(1).boundingBox()];
  expect(b!.y).toBeGreaterThan(a!.y); // stacked, not side by side
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// #32 (w16): on a phone the menu opens BELOW the caret — never above it over the title — and when
// the caret is low the page scrolls it up first; the list ends in a scroll cue.
test("phones: a caret low on the screen still gets the menu below it, inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const paras = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i + 1} of a long page.</p>`).join("");
  await page.goto("/e2e-fixtures/editor-blocks.html?content=" + encodeURIComponent(paras));
  await page.locator(".tiptap[contenteditable=true]").click();
  // An empty line after paragraph 20, then the page scrolled so that line sits at the bottom of the screen.
  await page.evaluate(() => {
    const ed = (document.querySelector(".tiptap") as any).editor;
    let end = 0; let n = 0;
    ed.state.doc.forEach((node: any, offset: number) => { n++; if (n === 20) end = offset + node.nodeSize - 1; });
    ed.chain().focus().setTextSelection(end).run();
  });
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const ed = (document.querySelector(".tiptap") as any).editor;
    const by = ed.view.coordsAtPos(ed.state.selection.from).bottom - 800;
    let el: HTMLElement | null = ed.view.dom.parentElement;
    while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
    if (el) el.scrollTop += by; else window.scrollBy(0, by);
  });
  const menu = await slash(page, "");
  await expect.poll(async () => {
    const caret = await page.evaluate(() => { const ed = (document.querySelector(".tiptap") as any).editor; return ed.view.coordsAtPos(ed.state.selection.from).bottom as number; });
    const box = (await menu.boundingBox())!;
    return box.y >= caret && box.y + box.height <= 844 && box.height >= 120;
  }).toBe(true);
  expect(await menu.evaluate((el) => getComputedStyle(el, "::after").position)).toBe("sticky");
});

// NP-ED-08: toggle headings (H1–H3 summaries) from the slash menu; the level is stored, open/closed stays view state.
test("toggle headings", async ({ page }) => {
  await newLine(page);
  await slash(page, "toggleh");
  await page.getByRole("option", { name: /^Toggle heading 2/ }).click();
  await page.keyboard.type("Chapter one");
  await expect.poll(() => editorHtml(page)).toContain('<details data-heading-level="2" data-type="toggle"><summary>Chapter one</summary><p></p></details>');
  const toggle = page.locator('.tiptap .prism-toggle[data-heading-level="2"]');
  await expect(toggle).toBeVisible();
  // The summary reads as a heading (larger than body text), and the body takes nested blocks.
  const sizes = await page.evaluate(() => ({
    summary: parseFloat(getComputedStyle(document.querySelector(".tiptap .prism-toggle[data-heading-level] summary")!).fontSize),
    body: parseFloat(getComputedStyle(document.querySelector(".tiptap p")!).fontSize),
  }));
  expect(sizes.summary).toBeGreaterThan(sizes.body * 1.3);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("- nested item");
  await expect.poll(() => editorHtml(page)).toMatch(/<details data-heading-level="2" data-type="toggle"><summary>Chapter one<\/summary><ul><li><p>nested item<\/p><\/li><\/ul>/);
  // Collapsing hides the body and is NOT an edit; ⌘↵ flips it from the keyboard.
  const before = await editorHtml(page);
  await toggle.getByRole("button", { name: "Collapse toggle" }).click();
  await expect(toggle.locator("ul")).toBeHidden();
  expect(await editorHtml(page)).toBe(before);
  await toggle.locator("summary").click();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.type.name)).toBe("toggleSummary"); // selectionchange is async
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(toggle.locator("ul")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(toggle.locator("ul")).toBeHidden();
  expect(await editorHtml(page)).toBe(before);
  // Levels 1 and 3 exist too; each is saved.
  for (const level of [1, 3]) {
    await newLine(page);
    await slash(page, "toggleh");
    await page.getByRole("option", { name: new RegExp(`^Toggle heading ${level}`) }).click();
    await expect.poll(() => editorHtml(page)).toContain(`data-heading-level="${level}"`);
  }
  await expect.poll(() => lastWrite(page), { timeout: 6000 }).toContain('<details data-heading-level="2" data-type="toggle"><summary>Chapter one</summary>');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/toggle-headings-1440.png` });
  // A stored page that contains toggles opens (the node view used to need a mounted view), old toggles included.
  await page.goto("/e2e-fixtures/editor-blocks.html?content=" + encodeURIComponent('<details data-type="toggle" data-heading-level="1"><summary>Stored</summary><p>Body</p></details><details><summary>Old toggle</summary><p>Kept</p></details>'));
  await expect(page.locator('.tiptap .prism-toggle[data-heading-level="1"] summary')).toHaveText("Stored");
  await expect(page.locator(".tiptap .prism-toggle:not([data-heading-level]) summary")).toHaveText("Old toggle");
});

// NP-ED-09: up to five columns from the slash menu; the gutter resizes two neighbours in one undo step.
test("4 and 5 columns insert; dragging the gutter resizes and saves", async ({ page }) => {
  for (const n of [4, 5]) {
    await newLine(page);
    await slash(page, `${n}col`);
    await page.keyboard.press("Enter");
    await expect(page.locator(`.tiptap div[data-type="columns"][data-count="${n}"] > div[data-type="column"]`)).toHaveCount(n);
  }
  await page.goto("/e2e-fixtures/editor-blocks.html?content=" + encodeURIComponent('<div data-type="columns" data-count="2"><div data-type="column"><p>Left column</p></div><div data-type="column"><p>Right column</p></div></div><p>after</p>'));
  const cols = page.locator('.tiptap div[data-type="column"]');
  await expect(cols).toHaveCount(2);
  const handle = page.getByRole("separator", { name: "Resize columns 1 and 2" });
  await expect(handle).toBeAttached();
  const before = (await cols.nth(0).boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 10, { steps: 6 });
  expect(await editorHtml(page)).not.toContain("data-col-width"); // nothing is written while dragging
  await page.mouse.up();
  await expect.poll(() => editorHtml(page)).toMatch(/data-col-width="1\.\d+"[^>]*style="flex-grow: 1\.\d+;?"[^>]*><p>Left column/);
  await expect.poll(async () => (await cols.nth(0).boundingBox())!.width).toBeGreaterThan(before + 80);
  const html = await editorHtml(page);
  const [l, r] = [...html.matchAll(/data-col-width="([\d.]+)"/g)].map((m) => Number(m[1]));
  expect(l + r).toBeCloseTo(2, 2); // the pair's total share is unchanged
  // One undo step; the keyboard resizes too.
  await page.locator(".tiptap").getByText("Left column").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => editorHtml(page)).not.toContain("data-col-width");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => editorHtml(page)).toMatch(/data-col-width="0\.9\d*"/);
  await expect.poll(() => lastWrite(page), { timeout: 6000 }).toContain("data-col-width");
  // Read-only: no handles.
  await page.goto("/e2e-fixtures/editor-blocks.html?readonly&content=" + encodeURIComponent('<div data-type="columns" data-count="2"><div data-type="column" data-col-width="1.5"><p>L</p></div><div data-type="column" data-col-width="0.5"><p>R</p></div></div>'));
  await expect(page.locator('.tiptap div[data-type="column"]')).toHaveCount(2);
  await expect(page.getByRole("separator")).toHaveCount(0);
  const [a, b] = [await page.locator('.tiptap div[data-type="column"]').nth(0).boundingBox(), await page.locator('.tiptap div[data-type="column"]').nth(1).boundingBox()];
  expect(a!.width).toBeGreaterThan(b!.width * 2); // stored widths are honoured without the editor chrome
});
