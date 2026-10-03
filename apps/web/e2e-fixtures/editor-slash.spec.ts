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
  await expect(menu.locator(".editor-menu-section")).toHaveText(["Basic blocks", "Media", "Advanced"]);
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
  const cases: Array<[string, string]> = [["h2", "Heading 2"], ["tbl", "Table"], ["callo", "Callout"], ["todo", "To-do list"], ["cols", "2 columns"], ["3col", "3 columns"], ["div", "Divider"], ["pic", "Image"], ["togg", "Toggle"], ["page", "Link to page"]];
  for (const [query, expected] of cases) {
    const menu = await slash(page, query);
    await expect(menu.getByRole("option").first(), query).toHaveAccessibleName(new RegExp(`^${expected}`));
    await page.keyboard.press("Escape");
    for (let i = 0; i <= query.length; i++) await page.keyboard.press("Backspace");
  }
  await page.keyboard.type("/zzzz");
  await expect(page.getByRole("listbox", { name: "Insert block" })).toHaveCount(0);
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
  expect(html).toMatch(/<details open="" data-type="toggle"><summary>Show details<\/summary><p>Hidden body<\/p><\/details>/);
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

test("a collapsed toggle hides its body and the open state is stored", async ({ page }) => {
  await newLine(page);
  await slash(page, "toggle");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Summary line");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Secret body");
  await expect(page.getByText("Secret body")).toBeVisible();
  await page.getByRole("button", { name: "Collapse toggle" }).click();
  await expect(page.getByText("Secret body")).toBeHidden();
  expect(await editorHtml(page)).toMatch(/<details data-type="toggle"><summary>Summary line<\/summary><p>Secret body<\/p><\/details>/);
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
