/**
 * The page / editor chrome (owner's first iPhone run: "weird stacking … cluttered").
 *
 * A phone page has ONE chrome row above its body — connection state, Outline, the mode, Comments,
 * backlinks — instead of four stacked strips; ONE comments entry point; review controls only while
 * there is something to review. On a touch device Prism shows ONE formatting surface: the keyboard
 * toolbar, which also carries the selection's actions (the system's selection callout sits where
 * the bubble used to float). Nothing may cover the caret or the selected text. Desktop is unchanged
 * apart from alignment.
 *
 * Both editors: the plain one (`DocumentRenderer`, notion-shell fixture) and the live one
 * (`CollabDoc` → `CollabEditor`, against the REAL server: owner = edit, sam = suggest-only, gina = view).
 * What a headless browser cannot show — the real keyboard and the system callout — is a device check;
 * the keyboard here is the visual viewport shrinking, as in notion-mobile.spec.ts.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";
import { PHONE, expectOneRow, formattingSurfaces, measureChrome, openKeyboard, selectWord } from "./editing-chrome-helpers";

const WIDTHS = [390, 320] as const;
const DESKTOP = { width: 1440, height: 900 };
const tiptap = (page: Page) => page.locator(".tiptap").first();
async function phone(browser: Browser, width: number) {
  const context = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } });
  return { context, page: await context.newPage() };
}
/** Buttons that start or open comments (never the ones inside an open comments drawer or a thread). */
const commentEntries = (page: Page) => page.getByRole("button", { name: /^(Comments?( \(\d+ open\))?|Add comment|Add a page comment)$/ });

test.describe("plain page", () => {
  const URL = "/e2e-fixtures/notion-shell.html";
  const ready = async (page: Page) => { await page.goto(URL); await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible(); await expect(page.getByRole("button", { name: "2 backlinks" })).toBeVisible(); };

  for (const width of WIDTHS) test(`phone ${width}: one row (Outline, backlinks); the keyboard toolbar is the one formatting surface`, async ({ browser }) => {
    const { context, page } = await phone(browser, width);
    await ready(page);
    await expectOneRow(page, ["Outline", "2 backlinks"]);
    // The backlinks count is an item of the row, not a strip of its own under the title.
    await expect(page.locator(".backlinks:not([data-inline])")).toHaveCount(0);
    // Touch: no second formatting surface to open above the body.
    await expect(page.getByRole("button", { name: "Formatting", exact: true })).toHaveCount(0);
    await expect(formattingSurfaces(page)).toHaveCount(0);

    // Reachable: the outline and the list of linking pages, one tap each, inside the screen.
    await page.getByRole("button", { name: "Outline", exact: true }).tap();
    const outline = page.getByRole("navigation", { name: "Document outline" });
    await expect(outline.getByRole("button", { name: "Purpose" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "2 backlinks" }).tap();
    const list = page.getByRole("region", { name: "Pages that link here" });
    await expect(list.getByRole("button")).toHaveCount(2);
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");

    // Typing: the toolbar rides on the keyboard, alone.
    await page.locator(".tiptap p").first().tap();
    const toolbar = page.getByRole("toolbar", { name: "Editing toolbar" });
    await expect(toolbar).toBeVisible();
    await openKeyboard(page);
    await expect(toolbar).toHaveAttribute("data-keyboard-inset", String(844 - 480));
    await expect(formattingSurfaces(page)).toHaveCount(1);
    for (const name of ["Insert block", "Turn into", "Bold", "Italic", "Underline", "Strikethrough", "Code", "Link", "To-do", "Indent", "Outdent", "Mention", "Image", "Undo", "Redo", "Dismiss keyboard"]) {
      await expect(toolbar.getByRole("button", { name, exact: true })).toHaveCount(1);
    }
    let m = await measureChrome(page);
    expect(m.overlaps).toEqual([]);
    expect(m.covered, "chrome over the caret").toEqual([]);

    // Selecting: still ONE surface. The selection's actions are in the toolbar; nothing floats over the text.
    await selectWord(page, "workshop");
    await expect(toolbar).toHaveAttribute("data-selection", "true");
    await expect(formattingSurfaces(page)).toHaveCount(1);
    await expect(page.locator(".document-selection-actions")).toHaveCount(0);
    for (const name of [/^Turn into/, "Bold selection", "Italic selection", "Underline selection", "Strikethrough selection", "Code selection", "Link", "Text color and highlight", "Mention a person, page or date", "To-do", "Indent", "Outdent", "Undo", "Redo", "Dismiss keyboard"]) {
      await expect(toolbar.getByRole("button", { name, exact: typeof name === "string" })).toHaveCount(1);
    }
    for (const size of await toolbar.getByRole("button").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); }))) expect(size).toBeGreaterThanOrEqual(44);
    m = await measureChrome(page);
    expect(m.selection, "the selection was measured").not.toBeNull();
    expect(m.overlaps).toEqual([]);
    expect(m.covered, "chrome over the selected text").toEqual([]);
    expect(m.selection!.bottom).toBeLessThanOrEqual((await toolbar.boundingBox())!.y + 1);

    // The actions act on the selection and keep it; a menu opens upward, on screen, clear of the keyboard.
    await toolbar.getByRole("button", { name: "Bold selection" }).tap();
    await expect(tiptap(page).locator("strong")).toHaveText("workshop");
    await toolbar.getByRole("button", { name: "Text color and highlight" }).tap();
    const menu = page.getByRole("menu", { name: "Color" });
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual((await toolbar.boundingBox())!.y + 1);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    await menu.getByRole("menuitemradio", { name: "Yellow highlight" }).tap();
    await expect(tiptap(page).locator("mark")).toHaveText("workshop");
    // A link from the selection: the field is in the same row and the row survives the focus change.
    await selectWord(page, "workshop");
    await toolbar.getByRole("button", { name: "Link", exact: true }).tap();
    await toolbar.getByLabel("Link address").fill("example.test/plan");
    await toolbar.getByRole("button", { name: "Apply" }).tap();
    await expect(tiptap(page).locator('a[href="https://example.test/plan"]')).toHaveText("workshop");
    await expect(formattingSurfaces(page)).toHaveCount(1);
    await context.close();
  });

  test("a page that cannot be edited: Outline only, and no empty toolbar on a selection", async ({ browser }) => {
    const { context, page } = await phone(browser, 390);
    await page.goto("/e2e-fixtures/editor-blocks.html?readonly");
    await expect(tiptap(page)).toContainText("Bravo paragraph");
    await expect(page.getByRole("button", { name: "Outline", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Formatting", exact: true })).toHaveCount(0);
    await selectWord(page, "Bravo");
    await page.waitForTimeout(300);
    await expect(formattingSurfaces(page)).toHaveCount(0);
    await context.close();
  });

  test("desktop: unchanged — the pill under the title, Formatting in the bar, the bubble on a selection", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await ready(page);
    await expect(page.locator(".document-writing-measure .backlinks:not([data-inline]) .backlinks-pill")).toHaveText(/2 backlinks/);
    await expect(page.locator(".document-formatting-bar .backlinks")).toHaveCount(0);
    const bar = page.locator(".document-formatting-bar");
    await expect(bar).not.toHaveAttribute("data-chrome", "row");
    await expect(bar.getByRole("button", { name: "Outline", exact: true })).toHaveText(/Outline/);
    const formatting = bar.getByRole("button", { name: "Formatting", exact: true });
    expect((await formatting.boundingBox())!.width).toBeGreaterThan(80); // icon AND label
    await formatting.click();
    await expect(page.getByRole("group", { name: "Text formatting" }).getByRole("button", { name: "Heading 2" })).toBeVisible();
    await formatting.click();
    await page.locator(".tiptap p").first().click();
    await expect(page.getByRole("toolbar", { name: "Editing toolbar" })).toHaveCount(0);
    await selectWord(page, "workshop");
    const bubble = page.locator(".document-selection-actions");
    await expect(bubble).toBeVisible();
    await expect(bubble.getByRole("button", { name: "Bold selection" })).toBeVisible();
    await expect(page.locator(".keyboard-toolbar")).toHaveCount(0);
  });
});

test.describe("live page", () => {
  test.describe.configure({ mode: "serial" });
  let server: RealServer;
  test.beforeAll(async ({}, info) => { server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188")); });
  test.afterAll(async () => server?.stop());
  async function open(page: Page, who: "sam" | "owner" | "gina") {
    await connect(page, page.context(), server, who);
    await page.goto("/e2e-fixtures/collab-route.html?target=plan");
    await expect(tiptap(page)).toContainText("Alpha");
    await expect(page.getByText(/Live/).first()).toBeVisible();
  }
  /** What a phone page used to stack between the title and the body. */
  async function noStrips(page: Page) {
    await expect(page.locator(".document-page-status")).toHaveCount(0);
    await expect(page.locator(".page-discussion")).toHaveCount(0);
    await expect(page.locator(".backlinks:not([data-inline])")).toHaveCount(0);
  }

  for (const width of WIDTHS) test(`editor · phone ${width}: one row, one comments entry, no review controls with nothing to review`, async ({ browser }) => {
    const { context, page } = await phone(browser, width);
    await open(page, "owner");
    await expectOneRow(page, ["Live", "Outline", "Editing", /^Comments/]);
    await noStrips(page);
    await expect(commentEntries(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^(Accept|Reject) all suggestions$/ }).filter({ visible: true })).toHaveCount(0);
    await expect(page.locator(".prism-suggestion-review")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Formatting", exact: true })).toHaveCount(0);

    // The mode is one tap; the state next to it stays "Live".
    await page.getByRole("button", { name: "Editing", exact: true }).tap();
    await expectOneRow(page, ["Live", "Outline", "Suggesting", /^Comments/]);
    await page.getByRole("button", { name: "Suggesting", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Editing", exact: true })).toBeVisible();

    // Comments: the row's button opens the drawer; a page comment starts there (two taps).
    await commentEntries(page).tap();
    const add = page.getByRole("button", { name: "Add comment" });
    await expect(add).toBeVisible();
    await add.tap();
    await expect(page.getByLabel("Comment on this page")).toBeFocused();
    await page.getByRole("button", { name: "Close comments" }).tap();
    await context.close();
  });

  test("editor · keyboard and selection: one formatting surface, the selection is never covered, Comment is in the toolbar", async ({ browser }) => {
    const { context, page } = await phone(browser, 390);
    await open(page, "owner");
    await page.locator(".tiptap p").nth(1).tap();
    const toolbar = page.getByRole("toolbar", { name: "Editing toolbar" });
    await expect(toolbar).toBeVisible();
    await openKeyboard(page);
    await expect(formattingSurfaces(page)).toHaveCount(1);
    await selectWord(page, "Second");
    await expect(toolbar).toHaveAttribute("data-selection", "true");
    await expect(formattingSurfaces(page)).toHaveCount(1);
    await expect(page.locator(".cd-bubble")).toHaveCount(0);
    for (const name of ["Bold selection", "Code selection", "Link", "Text color and highlight", "Comment on selection", "Dismiss keyboard"]) {
      await expect(toolbar.getByRole("button", { name, exact: true })).toHaveCount(1);
    }
    const m = await measureChrome(page);
    expect(m.overlaps).toEqual([]);
    expect(m.covered, "chrome over the selected text").toEqual([]);
    expect(m.selection!.bottom).toBeLessThanOrEqual((await toolbar.boundingBox())!.y + 1);
    await toolbar.getByRole("button", { name: "Comment on selection" }).tap();
    await page.getByPlaceholder(/Add a comment/).fill("Is this still true?");
    await page.getByRole("button", { name: "Comment", exact: true }).tap();
    await expect(tiptap(page).locator("span[data-comment-id]")).toHaveText("Second");
    // The row counts it; the thread is in the one drawer.
    await expect(page.getByRole("button", { name: "Comments (1 open)" })).toBeVisible();

    // Suggesting: the toolbar offers no untracked edits — it exists only for a selection.
    await page.getByRole("button", { name: "Editing", exact: true }).tap();
    await page.locator(".tiptap p").first().tap();
    await expect(page.locator(".keyboard-toolbar")).toHaveCount(0);
    await selectWord(page, "Alpha");
    const actions = page.getByRole("toolbar", { name: "Selection actions" });
    await expect(actions.getByRole("button", { name: "Bold selection" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Link", exact: true })).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Insert block" })).toHaveCount(0);
    await expect(formattingSurfaces(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Suggesting", exact: true }).tap();
    await context.close();
  });

  for (const width of WIDTHS) test(`suggest-only · phone ${width}: one row; Suggest edit and Comment dock at the bottom on a selection`, async ({ browser }) => {
    const { context, page } = await phone(browser, width);
    await open(page, "sam");
    await expect(tiptap(page)).toHaveAttribute("contenteditable", "false");
    await expectOneRow(page, ["Live · Suggesting", "Outline", /^Comments/]);
    await noStrips(page);
    await expect(commentEntries(page)).toHaveCount(1);
    await tiptap(page).tap();
    await expect(page.locator(".keyboard-toolbar")).toHaveCount(0); // nothing until text is selected
    await selectWord(page, "gamma");
    const actions = page.getByRole("toolbar", { name: "Selection actions" });
    await expect(actions).toBeVisible();
    await expect(page.locator(".cd-bubble")).toHaveCount(0);
    await expect(formattingSurfaces(page)).toHaveCount(1);
    await expect(actions.getByRole("button", { name: "Bold selection" })).toHaveCount(0);
    for (const name of ["Suggest an edit to the selection", "Comment on selection"]) {
      const box = (await actions.getByRole("button", { name }).boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    const m = await measureChrome(page);
    expect(m.overlaps).toEqual([]); // the bubble used to sit on the "You can suggest changes" note
    expect(m.covered, "chrome over the selected text").toEqual([]);
    await actions.getByRole("button", { name: "Suggest an edit to the selection" }).tap();
    await expect(page.getByRole("dialog", { name: "Suggest an edit" }).locator("blockquote")).toHaveText("gamma");
    await context.close();
  });

  test("read-only · phone: one row; a selection offers nothing, so nothing appears", async ({ browser }) => {
    const { context, page } = await phone(browser, 390);
    await open(page, "gina");
    await expectOneRow(page, ["Live · View only", "Outline", /^Comments/]);
    await noStrips(page);
    await expect(commentEntries(page)).toHaveCount(1);
    await selectWord(page, "gamma");
    await page.waitForTimeout(300);
    await expect(formattingSurfaces(page)).toHaveCount(0);
    await context.close();
  });

  test("desktop: unchanged — status and Comments in the header, the page discussion, bulk review in the bar, the bubble; the bar now shares the text column", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await open(page, "owner");
    const status = page.locator(".document-page-status");
    await expect(status).toContainText("Live · Editing");
    await expect(status.getByRole("button", { name: "Comments" })).toHaveText("Comments");
    await expect(page.getByRole("region", { name: "Page discussion" })).toBeVisible();
    const bar = page.locator(".document-formatting-bar");
    await expect(bar).not.toHaveAttribute("data-chrome", "row");
    await expect(bar.locator(".document-chrome-status, .document-chrome-trailing")).toHaveCount(0);
    for (const name of ["Outline", "Formatting", "Editing", "Accept all suggestions", "Reject all suggestions"]) await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Accept all suggestions" })).toHaveText(/Accept all/);
    // Alignment: the row starts and ends on the text column (it used to start 140 px left of the title).
    const edges = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { icon: r(".document-outline-toggle svg").left, review: r(".document-review-controls").right, title: r(".document-page-header").left, text: r(".tiptap").left, textRight: r(".tiptap").right };
    });
    expect(Math.abs(edges.icon - edges.text)).toBeLessThanOrEqual(1);
    expect(Math.abs(edges.icon - edges.title)).toBeLessThanOrEqual(1);
    expect(Math.abs(edges.review - edges.textRight)).toBeLessThanOrEqual(1);
    await page.locator(".tiptap p").first().click();
    await selectWord(page, "gamma");
    const bubble = page.locator(".cd-bubble");
    await expect(bubble).toBeVisible();
    await expect(bubble.getByRole("button", { name: "Comment on selection" })).toBeVisible();
    await expect(page.locator(".keyboard-toolbar")).toHaveCount(0);
  });

  // Last: it changes the page for good.
  test("pending suggestions · phone: the review strip appears with them, bulk review is inside it, and both go when done", async ({ browser }) => {
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const sam = await desk.newPage();
    await open(sam, "sam");
    await selectWord(sam, "beta");
    await sam.getByRole("button", { name: "Suggest an edit to the selection" }).click();
    const composer = sam.getByRole("dialog", { name: "Suggest an edit" });
    await composer.getByLabel("Replacement text").fill("delta");
    await composer.getByRole("button", { name: "Suggest", exact: true }).click();
    await expect(sam.locator('[data-suggestion="insert"]')).toHaveText("delta");
    await desk.close();

    for (const width of WIDTHS) {
      const { context, page } = await phone(browser, width);
      await open(page, "owner");
      await expect(page.locator('[data-suggestion="insert"]')).toHaveText("delta");
      await expectOneRow(page, ["Live", "Outline", "Editing", /^Comments/]);
      const strip = page.locator(".prism-suggestion-review");
      await expect(strip.locator("summary")).toHaveText("1 suggested change");
      // Two taps: open the strip, then Accept all / Reject all (44 px, side by side).
      await expect(page.getByRole("button", { name: "Accept all suggestions" }).filter({ visible: true })).toHaveCount(0);
      await strip.locator("summary").tap();
      const bulk = strip.getByRole("group", { name: "All suggested changes" });
      for (const name of ["Accept all suggestions", "Reject all suggestions"]) {
        const box = (await bulk.getByRole("button", { name }).boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect((await measureChrome(page)).overlaps).toEqual([]);
      if (width === WIDTHS[WIDTHS.length - 1]) {
        await bulk.getByRole("button", { name: "Accept all suggestions" }).tap();
        await expect(page.locator("[data-suggestion]")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getText() as string)).toContain("Alpha delta gamma");
        await expect(strip).toHaveCount(0);
        await expect(page.getByRole("status").filter({ hasText: "Accepted 1 suggested change." })).toBeVisible();
      }
      await context.close();
    }
  });
});
