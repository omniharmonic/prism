/**
 * No blocking browser dialog anywhere in shipped UI (owner report from the iPhone app, 2026-10-09:
 * "Embeds and image uploads don't seem to work at all because no dialogue window opens").
 *
 * The Prism Client's web view (Tauri / wry, macOS and iOS) implements no JavaScript-dialog delegate,
 * so `window.prompt()` answers null, `confirm()` answers false and `alert()` shows nothing. Every test
 * here stubs all three to THROW (`forbidBrowserDialogs`) — stricter than the app — so any remaining
 * call fails. Covered: the editor's address field (plain and live editor, desktop and phone with the
 * keyboard up), the file chooser opening from the tap itself, and the in-app confirmation.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";
import { KEYBOARD, PHONE, expectInVisibleArea, openKeyboard, selectWord } from "./editing-chrome-helpers";
import { addressField, answerConfirm, enterAddress, forbidBrowserDialogs } from "./in-app-dialog-helpers";

const media = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "media", name);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const DESKTOP = { width: 1440, height: 900 };
const YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

type Ed = { getHTML(): string; getJSON(): { content: Array<{ type: string }> }; state: any; chain(): any; isFocused: boolean };
const ed = <T>(page: Page, fn: (e: Ed) => T) => page.evaluate(`(${fn.toString()})(document.querySelector(".tiptap").editor)`) as Promise<T>;
const blocks = (page: Page) => ed(page, (e) => e.getJSON().content.map((n) => n.type));
const html = (page: Page) => ed(page, (e) => e.getHTML());
const editor = (page: Page) => page.locator(".tiptap").first();
/** The editor's selection once the editor holds the focus again (TipTap returns it on the next frame). */
async function caret(page: Page, expectFocus = true) {
  if (expectFocus) await expect(editor(page)).toBeFocused();
  return ed(page, (e) => ({ from: e.state.selection.from as number, to: e.state.selection.to as number, focused: e.isFocused }));
}
/** Nothing outside the fixture is contacted (embed frames, link previews). */
const offline = (context: BrowserContext) => context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());

/** An empty paragraph right after the paragraph reading `text`, holding the caret. */
async function emptyLineAfter(page: Page, text: string, touch = false) {
  const target = page.getByText(text, { exact: true });
  if (touch) await target.tap(); else await target.click();
  await page.evaluate((t) => {
    const e = (document.querySelector(".tiptap") as any).editor;
    let end = 0;
    e.state.doc.descendants((node: any, pos: number) => { if (node.isTextblock && node.textContent === t) end = pos + node.nodeSize; });
    e.chain().focus().insertContentAt(end, { type: "paragraph" }).setTextSelection(end + 1).run();
  }, text);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => ed(page, (e) => e.state.selection.$from.parent.content.size)).toBe(0);
}
async function slash(page: Page, query: string, option: RegExp, touch = false) {
  await page.keyboard.type(`/${query}`);
  const item = page.getByRole("option", { name: option });
  await expect(item).toBeVisible();
  if (touch) await item.tap(); else await item.click();
}
async function phone(browser: Browser, width = 390) {
  const context = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } });
  await offline(context);
  const page = await context.newPage();
  const calls = await forbidBrowserDialogs(page);
  return { context, page, calls };
}
/** The keyboard as the iOS app shows it: the visible area is panned all the way down. */
const keyboardUp = (page: Page) => openKeyboard(page, { offsetTop: 844 - KEYBOARD });

test.describe("plain editor", () => {
  const URL = "/e2e-fixtures/editor-blocks.html";
  let calls: () => Promise<string[]>;
  test.beforeEach(async ({ page, context }) => {
    await offline(context);
    calls = await forbidBrowserDialogs(page);
    await page.setViewportSize(DESKTOP);
  });
  test.afterEach(async () => { expect(await calls(), "browser dialogs called").toEqual([]); });
  const open = async (page: Page, query = "") => { await page.goto(URL + query); await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible(); };

  test("Embed: the field takes the caret, Enter inserts the embed where the caret was", async ({ page }) => {
    await open(page);
    await emptyLineAfter(page, "Bravo paragraph");
    await slash(page, "embed", /^Embed/);
    const { dialog, field } = await addressField(page, "Link to embed");
    await expect(dialog).not.toHaveClass(/prism-docked-composer/); // desktop: a popover by the caret
    expect(await html(page)).not.toContain("/embed"); // the typed command is gone, as before
    await field.fill(YOUTUBE);
    await field.press("Enter");
    await expect(dialog).toHaveCount(0);
    expect(await blocks(page)).toEqual(["heading", "paragraph", "embed", "bulletList", "blockquote", "paragraph"]);
    await expect(editor(page).locator('.prism-embed iframe[src*="youtube"]')).toHaveCount(1);
  });

  test("Embed with an address no provider recognises becomes a bookmark, exactly as before; a bare domain gets https://", async ({ page }) => {
    await open(page);
    await emptyLineAfter(page, "Bravo paragraph");
    await slash(page, "embed", /^Embed/);
    await enterAddress(page, "Link to embed", "atlas.example.test/watersheds");
    expect(await blocks(page)).toEqual(["heading", "paragraph", "bookmark", "bulletList", "blockquote", "paragraph"]);
    expect(await html(page)).toContain('data-url="https://atlas.example.test/watersheds"');
  });

  test("Web bookmark and Image from URL insert their block at the caret", async ({ page }) => {
    await open(page);
    await emptyLineAfter(page, "Bravo paragraph");
    await slash(page, "bookmark", /^Web bookmark/);
    await enterAddress(page, "Link for the bookmark", "https://atlas.example.test/watersheds");
    expect(await blocks(page)).toEqual(["heading", "paragraph", "bookmark", "bulletList", "blockquote", "paragraph"]);
    await emptyLineAfter(page, "Foxtrot closing");
    await slash(page, "image", /^Image /);
    await enterAddress(page, "Image address", "https://images.example.test/chart.png");
    expect((await blocks(page)).slice(-3)).toEqual(["paragraph", "image", "paragraph"]); // after "Foxtrot closing"; the editor keeps a line to type on
    expect(await html(page)).toContain('src="https://images.example.test/chart.png"');
  });

  test("Esc inserts nothing and puts the caret back where it was", async ({ page }) => {
    await open(page);
    await emptyLineAfter(page, "Bravo paragraph");
    const before = { html: await html(page), caret: await caret(page) };
    for (const [query, option, name] of [["embed", /^Embed/, "Link to embed"], ["bookmark", /^Web bookmark/, "Link for the bookmark"], ["image", /^Image /, "Image address"]] as const) {
      await slash(page, query, option);
      const { dialog, field } = await addressField(page, name);
      await field.fill(YOUTUBE);
      await field.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await html(page), `${name}: nothing inserted, the command text removed`).toBe(before.html);
      expect(await caret(page), `${name}: the caret is back`).toEqual({ ...before.caret, focused: true });
    }
    // Cancel is the same answer as Esc; typing goes on at the caret.
    await slash(page, "embed", /^Embed/);
    await (await addressField(page, "Link to embed")).dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await html(page)).toBe(before.html);
    await page.keyboard.type("still here");
    expect(await html(page)).toContain("<p>Bravo paragraph</p><p>still here</p>");
  });

  test("the place follows edits made while the field is open (a collaborator typing above)", async ({ page }) => {
    await open(page);
    await emptyLineAfter(page, "Bravo paragraph");
    await slash(page, "embed", /^Embed/);
    const { field } = await addressField(page, "Link to embed");
    await ed(page, (e) => { e.chain().insertContentAt(0, [{ type: "paragraph", content: [{ type: "text", text: "Written above meanwhile" }] }, { type: "paragraph", content: [{ type: "text", text: "and one more" }] }]).run(); });
    await expect(field).toBeFocused();
    await field.fill(YOUTUBE);
    await field.press("Enter");
    expect(await blocks(page)).toEqual(["paragraph", "paragraph", "heading", "paragraph", "embed", "bulletList", "blockquote", "paragraph"]);
  });

  test("an address that is not allowed is refused in plain words and nothing is inserted", async ({ page }) => {
    await open(page);
    await emptyLineAfter(page, "Bravo paragraph");
    const before = await html(page);
    await slash(page, "image", /^Image /);
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAAA", "//evil.example/x.png", "not an address"]) {
      const dialog = await enterAddress(page, "Image address", bad);
      await expect(dialog.getByRole("alert")).toHaveText("Enter the image’s web address (https://…).");
      await expect(dialog.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
      expect(await html(page)).toBe(before);
    }
    await page.keyboard.press("Escape");
    await expect(editor(page)).toBeFocused();
    await slash(page, "embed", /^Embed/);
    for (const bad of ["javascript:alert(1)", "ftp://files.example/x", "just words"]) {
      const dialog = await enterAddress(page, "Link to embed", bad);
      await expect(dialog.getByRole("alert")).toHaveText("Enter a web address (https://…).");
      expect(await html(page)).toBe(before);
    }
    // Typing again clears the message; a press outside cancels.
    const { dialog, field } = await addressField(page, "Link to embed");
    await field.fill("y");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.getByText("Alpha", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await html(page)).toBe(before);
  });

  test("the bar's Link and Image use the same field: link the selection, edit it, remove it", async ({ page }) => {
    await open(page);
    await page.locator(".document-formatting-bar").getByRole("button", { name: "Formatting", exact: true }).click();
    const group = page.getByRole("group", { name: "Text formatting" });
    await selectWord(page, "Bravo");
    await group.getByRole("button", { name: "Link", exact: true }).click();
    await enterAddress(page, "Link address", "example.com/plan");
    expect(await html(page)).toMatch(/<a [^>]*href="https:\/\/example\.com\/plan"[^>]*>Bravo<\/a> paragraph/);
    // Refused: the same rule as the inline link field.
    await selectWord(page, "Foxtrot");
    await group.getByRole("button", { name: "Link", exact: true }).click();
    const refused = await enterAddress(page, "Link address", "javascript:alert(1)");
    await expect(refused.getByRole("alert")).toHaveText("Use a web, mail or page link.");
    await page.keyboard.press("Escape");
    expect(await html(page)).toContain("<p>Foxtrot closing</p>");
    expect(await caret(page)).toMatchObject({ focused: true });
    expect(await ed(page, (e) => e.state.doc.textBetween(e.state.selection.from, e.state.selection.to))).toBe("Foxtrot"); // the selection is restored
    // On an existing link the field starts with its address and offers Remove.
    await selectWord(page, "Bravo");
    await group.getByRole("button", { name: "Link", exact: true }).click();
    const { dialog, field } = await addressField(page, "Link address");
    await expect(field).toHaveValue("https://example.com/plan");
    await dialog.getByRole("button", { name: "Remove link" }).click();
    expect(await html(page)).toContain("<p>Bravo paragraph</p>");
    // Image.
    await page.getByText("Foxtrot closing", { exact: true }).click();
    await group.getByRole("button", { name: "Image", exact: true }).click();
    await enterAddress(page, "Image address", "https://images.example.test/bar.png");
    expect(await html(page)).toContain('src="https://images.example.test/bar.png"');
  });

  test("the file chooser opens from the key press itself, and a chosen image or file is uploaded and inserted", async ({ page }) => {
    await open(page, "?upload");
    await emptyLineAfter(page, "Bravo paragraph");
    const chooser = page.waitForEvent("filechooser");
    await slash(page, "image", /^Image Upload or embed/);
    const picked = await chooser;
    // The transient input is laid out (WebKit opens nothing for a detached or display:none input on some builds).
    expect(await page.locator("input[data-prism-file-picker]").evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
    expect(await page.locator("input[data-prism-file-picker]").getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp,image/avif");
    await picked.setFiles({ name: "picked.png", mimeType: "image/png", buffer: PNG });
    await expect(editor(page).locator("img")).toHaveCount(1);
    await expect(page.locator("input[data-prism-file-picker]")).toHaveCount(0);
    expect((await blocks(page)).slice(0, 3)).toEqual(["heading", "paragraph", "image"]);
    for (const [query, option, accept] of [["file", /^File Upload any file/, null], ["pdf", /^PDF/, "application/pdf,.pdf"], ["audio", /^Audio/, "audio/*"], ["video", /^Video Upload a video/, "video/*"]] as const) {
      await emptyLineAfter(page, "Foxtrot closing");
      const next = page.waitForEvent("filechooser");
      await slash(page, query, option);
      await next;
      expect(await page.locator("input[data-prism-file-picker]").getAttribute("accept"), query).toBe(accept);
      await page.locator("input[data-prism-file-picker]").evaluate((el) => el.dispatchEvent(new Event("cancel"))); // a dismissed chooser leaves nothing behind
      await expect(page.locator("input[data-prism-file-picker]")).toHaveCount(0);
    }
  });
});

test.describe("plain editor · phone, keyboard up", () => {
  test("Embed: the field docks on the keyboard, 16 px type and 44 px targets; Enter inserts at the caret, Esc restores it", async ({ browser }) => {
    const { context, page, calls } = await phone(browser);
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    await emptyLineAfter(page, "Bravo paragraph", true);
    await keyboardUp(page);
    const before = { html: await html(page), caret: await caret(page) };
    await slash(page, "embed", /^Embed/, true);
    const { dialog, field } = await addressField(page, "Link to embed");
    await expect(dialog).toHaveClass(/prism-docked-composer/);
    await expectInVisibleArea(page, ".prism-editor-prompt", "the address field");
    expect(parseFloat(await field.evaluate((el) => getComputedStyle(el).fontSize)), "no iOS zoom-on-focus").toBeGreaterThanOrEqual(16);
    for (const b of await dialog.getByRole("button").all()) { const box = (await b.boundingBox())!; expect(Math.min(box.width, box.height), await b.innerText()).toBeGreaterThanOrEqual(44); }
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // The keyboard toolbar belongs to the document: it is gone while the field has the caret.
    await expect(page.getByRole("toolbar", { name: "Editing toolbar" })).toHaveCount(0);
    await field.press("Escape");
    expect(await html(page)).toBe(before.html);
    expect(await caret(page)).toEqual({ ...before.caret, focused: true });
    await slash(page, "embed", /^Embed/, true);
    await (await addressField(page, "Link to embed")).field.fill(YOUTUBE);
    await page.getByRole("dialog", { name: "Link to embed" }).getByRole("button", { name: "Embed", exact: true }).tap();
    expect(await blocks(page)).toEqual(["heading", "paragraph", "embed", "bulletList", "blockquote", "paragraph"]);
    await slashImageByUrl(page);
    expect(await calls()).toEqual([]);
    await context.close();
  });
  async function slashImageByUrl(page: Page) {
    await emptyLineAfter(page, "Foxtrot closing", true);
    await slash(page, "bookmark", /^Web bookmark/, true);
    await enterAddress(page, "Link for the bookmark", "https://atlas.example.test/watersheds");
    await expect(page.locator(".tiptap .prism-bookmark")).toHaveCount(1);
  }

  test("the [[ list opens in the visible area, not behind the keyboard", async ({ browser }) => {
    const { context, page } = await phone(browser);
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    await emptyLineAfter(page, "Foxtrot closing", true);
    await keyboardUp(page);
    await page.keyboard.type("[[");
    await expect(page.getByRole("listbox", { name: "Link to a document" })).toBeVisible();
    await expectInVisibleArea(page, '[role="listbox"][aria-label="Link to a document"]', "the [[ list");
    await context.close();
  });

  test("a tap on Image / File opens the chooser from that tap; the picked image is uploaded and shown", async ({ browser }) => {
    const { context, page, calls } = await phone(browser);
    await page.goto("/e2e-fixtures/editor-blocks.html?upload");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    await emptyLineAfter(page, "Bravo paragraph", true);
    await keyboardUp(page);
    const chooser = page.waitForEvent("filechooser");
    await slash(page, "image", /^Image Upload or embed/, true);
    await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
    await expect(editor(page).locator("img")).toHaveCount(1);
    expect((await blocks(page)).slice(0, 3)).toEqual(["heading", "paragraph", "image"]);
    // The toolbar's Image button is a tap too.
    await page.getByText("Foxtrot closing", { exact: true }).tap();
    const again = page.waitForEvent("filechooser");
    await page.getByRole("toolbar", { name: "Editing toolbar" }).getByRole("button", { name: "Image", exact: true }).tap();
    await (await again).setFiles({ name: "second.png", mimeType: "image/png", buffer: PNG });
    await expect(editor(page).locator("img")).toHaveCount(2);
    await emptyLineAfter(page, "Foxtrot closing", true);
    const file = page.waitForEvent("filechooser");
    await slash(page, "file", /^File Upload any file/, true);
    await (await file).setFiles(media("brief.pdf"));
    await expect(editor(page).locator('.prism-attachment[data-kind="pdf"]')).toHaveCount(1);
    expect(await calls()).toEqual([]);
    await context.close();
  });
});

test.describe("live editor", () => {
  test.describe.configure({ mode: "serial" });
  let server: RealServer;
  test.beforeAll(async ({}, info) => { server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188")); });
  test.afterAll(async () => server?.stop());
  test.setTimeout(90_000);
  let seq = 0;
  async function openLive(page: Page, context: BrowserContext, who: "owner" | "sam" = "owner") {
    const id = `dialogs-${process.pid}-${++seq}`;
    expect(await server.add({ id, path: `vault/Shared/Dialogs ${id}`, content: "<h2>Heading</h2><p>Start here</p><p>Closing line</p>", tags: ["team"] })).toBe(true);
    await offline(context);
    await connect(page, context, server, who);
    await page.addInitScript(() => {
      const send = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (!(init?.body instanceof FormData)) return send(input, init);
        const encoded = new Response(init.body);
        const headers = new Headers(init.headers);
        headers.set("Content-Type", encoded.headers.get("Content-Type")!);
        return send(input, { ...init, headers, body: await encoded.arrayBuffer() });
      };
    });
    await page.goto(`/e2e-fixtures/collab-route.html?page=${id}`);
    await expect(page.getByText(/Live/).first()).toBeVisible();
    await expect(editor(page)).toContainText("Start here");
    return id;
  }

  test("desktop: Embed lands at the caret; Esc restores it; the bar's Link uses the field", async ({ page, context }) => {
    const calls = await forbidBrowserDialogs(page);
    await page.setViewportSize(DESKTOP);
    const id = await openLive(page, context);
    await emptyLineAfter(page, "Start here");
    const before = { html: await html(page), caret: await caret(page) };
    await slash(page, "embed", /^Embed/);
    await (await addressField(page, "Link to embed")).field.press("Escape");
    expect(await html(page)).toBe(before.html);
    expect(await caret(page)).toEqual({ ...before.caret, focused: true });
    await slash(page, "embed", /^Embed/);
    await enterAddress(page, "Link to embed", YOUTUBE);
    expect(await blocks(page)).toEqual(["heading", "paragraph", "embed", "paragraph"]);
    await page.locator(".document-formatting-bar").getByRole("button", { name: "Formatting", exact: true }).click();
    await selectWord(page, "Closing");
    await page.getByRole("group", { name: "Text formatting" }).getByRole("button", { name: "Link", exact: true }).click();
    await enterAddress(page, "Link address", "https://example.com/live");
    expect(await html(page)).toMatch(/<a [^>]*href="https:\/\/example\.com\/live"[^>]*>Closing<\/a> line/);
    await expect.poll(async () => (await server.note(id))?.content ?? "", { timeout: 20_000 }).toContain('data-type="embed"');
    expect(await calls()).toEqual([]);
  });

  test("phone, keyboard up: Web bookmark through the docked field; Image opens the chooser from the tap and the upload is shown", async ({ browser }) => {
    const { context, page, calls } = await phone(browser);
    await openLive(page, context);
    await emptyLineAfter(page, "Start here", true);
    await keyboardUp(page);
    await slash(page, "bookmark", /^Web bookmark/, true);
    const { dialog } = await addressField(page, "Link for the bookmark");
    await expect(dialog).toHaveClass(/prism-docked-composer/);
    await expectInVisibleArea(page, ".prism-editor-prompt", "the address field");
    await enterAddress(page, "Link for the bookmark", "https://atlas.example.test/watersheds");
    expect(await blocks(page)).toEqual(["heading", "paragraph", "bookmark", "paragraph"]);
    await emptyLineAfter(page, "Closing line", true);
    const chooser = page.waitForEvent("filechooser");
    await slash(page, "image", /^Image Upload or embed/, true);
    await (await chooser).setFiles(media("cover.png"));
    await expect(editor(page).locator('img[src^="/api/attachments/"]')).toHaveCount(1);
    expect(await calls()).toEqual([]);
    await context.close();
  });

  test("someone who can only suggest cannot insert blocks, so no field (and no browser dialog) is ever offered", async ({ page, context }) => {
    const calls = await forbidBrowserDialogs(page);
    await page.setViewportSize(DESKTOP);
    await offline(context);
    await connect(page, context, server, "sam");
    await page.goto("/e2e-fixtures/collab-route.html?target=plan");
    await expect(page.getByText(/Suggesting/).first()).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await editor(page).locator("p").first().click();
    await page.keyboard.type("/embed");
    await expect(page.getByRole("option", { name: /^Embed/ })).toHaveCount(0);
    await expect(page.locator(".prism-editor-prompt")).toHaveCount(0);
    // The bar offers no Link / Image to a person who cannot edit.
    await expect(page.getByRole("group", { name: "Text formatting" })).toHaveCount(0);
    expect(await calls()).toEqual([]);
  });
});

test.describe("in-app confirmation", () => {
  const URL = "/e2e-fixtures/in-app-dialogs.html";
  const answers = (page: Page) => page.evaluate(() => (window as any).prismDialogs.answers as unknown[]);
  const writes = (page: Page) => page.evaluate(() => (window as any).prismDialogs.calls as string[]);
  let calls: () => Promise<string[]>;
  test.beforeEach(async ({ page }) => { calls = await forbidBrowserDialogs(page); await page.setViewportSize(DESKTOP); await page.goto(URL); });
  test.afterEach(async () => { expect(await calls(), "browser dialogs called").toEqual([]); });

  test("a destructive question: Cancel has the focus, Esc and Cancel answer no, the button answers yes, focus returns", async ({ page }) => {
    const ask = page.getByRole("button", { name: "Ask", exact: true });
    // From the keyboard (Safari does not focus a button on a click): the focus must come back to it.
    await ask.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: "Delete this event?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("This cannot be undone.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(ask).toBeFocused();
    await ask.click();
    await answerConfirm(page, "Cancel");
    await ask.click();
    await answerConfirm(page, "Delete");
    expect(await answers(page)).toEqual([false, false, true]);
  });

  test("a plain question starts on its yes button; a message has one button; two questions wait their turn", async ({ page }) => {
    await page.getByRole("button", { name: "Ask plain" }).click();
    await expect(page.getByRole("alertdialog").getByRole("button", { name: "Add links" })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Tell", exact: true }).click();
    const message = page.getByRole("alertdialog", { name: "Wikilinks" });
    await expect(message).toContainText("Resolved 3 of 4 wikilinks.");
    await expect(message.getByRole("button")).toHaveCount(1);
    await answerConfirm(page, "OK");
    await page.getByRole("button", { name: "Ask twice" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(1);
    await expect(page.getByRole("alertdialog", { name: "First?" })).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("alertdialog", { name: "Second?" })).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(await answers(page)).toEqual([true, "told", "first:true", "second:false"]);
  });

  test("inside Settings (a modal dialog): signing a device out and revoking an agent token ask first, on top, and both answers hold", async ({ page }) => {
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByText("Avery’s iPhone")).toBeVisible();
    const revokeDevice = settings.getByRole("button", { name: "Revoke" }).first();
    await revokeDevice.click();
    const question = page.getByRole("alertdialog", { name: "Sign out \"Avery’s iPhone\"?" });
    await expect(question).toBeVisible();
    // It is the top layer: the point in the middle of its Cancel button belongs to it, not to Settings.
    const cancel = question.getByRole("button", { name: "Cancel" });
    const box = (await cancel.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[role=alertdialog]"), { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(true);
    await cancel.click();
    expect(await writes(page)).toEqual([]);
    await expect(settings.getByText("Avery’s iPhone")).toBeVisible();
    await revokeDevice.click();
    await answerConfirm(page, "Sign out");
    await expect(settings.getByText("Avery’s iPhone")).toHaveCount(0);
    expect(await writes(page)).toEqual(["revokeDevice:dev-1"]);
    // The agent token.
    const token = settings.getByRole("button", { name: "Revoke" }).last();
    await expect(settings.getByText("Research agent")).toBeVisible();
    await token.click();
    await answerConfirm(page, "Cancel", "Any agent using it loses access immediately.");
    await expect(settings.getByText("Research agent")).toBeVisible();
    await token.click();
    await answerConfirm(page, "Revoke", "Revoke \"Research agent\"?");
    await expect(settings.getByText("Research agent")).toHaveCount(0);
    expect(await writes(page)).toEqual(["revokeDevice:dev-1", "revokeAgentToken:tok-1"]);
  });

  test("phone: the confirmation fits the screen and its buttons are 44 px targets", async ({ browser }) => {
    const { context, page, calls: phoneCalls } = await phone(browser);
    await page.goto(URL);
    await page.getByRole("button", { name: "Ask", exact: true }).tap();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    for (const b of await dialog.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await dialog.getByRole("button", { name: "Delete" }).tap();
    expect(await answers(page)).toEqual([true]);
    expect(await phoneCalls()).toEqual([]);
    await context.close();
  });
});

test("guard: check-no-browser-dialogs passes on the tree and catches a new call", async ({}, info) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-no-browser-dialogs.mjs");
  const clean = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(clean.status, clean.stderr).toBe(0);
  const dir = info.outputPath("dialogs-guard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "bad.tsx"), 'export const a = () => { if (window.confirm("x")) alert("y"); const p = globalThis["prompt"]; return prompt("z") ?? p; };\n');
  writeFileSync(path.join(dir, "fine.ts"), '// alert(1) in a comment\nexport const s = "javascript:alert(1)";\nasync function confirm(x: number) { return x; }\nexport const ok = () => confirm(1);\nexport const store = { confirm() {} }; store.confirm();\n');
  const dirty = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  expect(dirty.status).toBe(1);
  expect(dirty.stderr).toContain("bad.tsx:1");
  for (const what of ["window.confirm", "alert(…)", "globalThis.prompt", "prompt(…)"]) expect(dirty.stderr).toContain(what);
  expect(dirty.stderr).not.toContain("fine.ts");
});
