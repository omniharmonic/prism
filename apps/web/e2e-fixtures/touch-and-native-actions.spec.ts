/**
 * The rest of the "does nothing on a phone / in the app" family (PR #48, second pass):
 *
 *  - saving a file: the Prism Client's web view cancels downloads, so its shell saves an attachment
 *    itself (`__PRISM_SHELL__.saveAttachment(id, name)`) and page-built text through `exportNote`;
 *    a browser still gets a download;
 *  - a bookmark card has an explicit Open control (touch: always there, 44 px); a tap that only
 *    places the selection reaches no host and opens nothing;
 *  - a page the reader cannot edit: image actions are on the image on a touch screen, and a long
 *    press on a link brings its card (Open / Copy);
 *  - the table controls on a phone: 44 px, one row of whole buttons, a chevron while there is more;
 *  - `@` / the database dialog with the keyboard up.
 *
 * Browser dialogs are stubbed to throw throughout (`forbidBrowserDialogs`).
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { connectLink, startRealServer, type RealServer } from "./real-server";
import { KEYBOARD, PHONE, expectInVisibleArea, openKeyboard } from "./editing-chrome-helpers";
import { forbidBrowserDialogs } from "./in-app-dialog-helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ATT = "a_AbCdEfGhIjKlMnOpQrStUv";
const DESKTOP = { width: 1440, height: 900 };
const enc = encodeURIComponent;
const BLOCKS = "/e2e-fixtures/editor-blocks.html";
const MEDIA = `<p>Start</p><img src="/api/attachments/${ATT}" alt="River at dawn"><div data-type="attachment" data-kind="pdf" data-src="/api/attachments/a_pdf1" data-name="Site plan.pdf" data-size="2048" data-mime="application/pdf"></div><div data-type="attachment" data-kind="file" data-src="https://files.example.test/notes.txt" data-name="notes.txt" data-mime="text/plain"></div><img src="https://images.example.test/outside.png" alt="Outside"><p>End</p>`;
const BOOKMARK = `<p>Start</p><div data-type="bookmark" data-url="https://atlas.example.test/watersheds" data-title="Watershed atlas"></div><p>End</p>`;
const LINKS = `<p>Read the <a href="https://atlas.example.test/guide">field guide</a> first.</p><img src="/api/attachments/${ATT}" alt="River at dawn"><p>End</p>`;
const TABLE = "<p>Start</p><table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>one</p></td><td><p>two</p></td></tr></tbody></table><p>End</p>";

const editor = (page: Page) => page.locator(".tiptap").first();
const serveAttachments = (context: BrowserContext) => context.route("**/api/attachments/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
const offline = (context: BrowserContext) => context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());
async function prepare(page: Page, context: BrowserContext) {
  await offline(context);
  await serveAttachments(context);
  return forbidBrowserDialogs(page);
}
async function phone(browser: Browser, width = 390) {
  const context = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } });
  const page = await context.newPage();
  const calls = await prepare(page, context);
  return { context, page, calls };
}
const open = async (page: Page, query: string) => { await page.goto(BLOCKS + query); await expect(editor(page)).toBeVisible(); };
/** The Prism Client's shell, as the page sees it: records every call; `answer` decides the outcome. */
const fakeShell = (page: Page, answer: "saved" | "cancelled" | "fails" = "saved") => page.addInitScript((answer) => {
  const calls: unknown[][] = [];
  const reply = (name: string) => (answer === "fails" ? Promise.reject("The server couldn’t send the file (HTTP 502).") : Promise.resolve(answer === "saved" ? name : null));
  Object.assign(window, {
    prismShellCalls: calls,
    __PRISM_SHELL__: Object.freeze({
      saveAttachment: (id: string, name: string) => { calls.push(["saveAttachment", id, name]); return reply(name); },
      exportNote: (content: string, name: string, format: string) => { calls.push(["exportNote", content.length, name, format]); return reply(name); },
    }),
  });
  // The shell's host script answers window.open for outside links (one native confirmation).
  const opened: string[] = [];
  Object.assign(window, { prismOpened: opened });
  window.open = (url?: string | URL) => { opened.push(String(url)); return null; };
  // …and a blob: download must never be attempted there (the web view cancels it).
  const make = URL.createObjectURL.bind(URL);
  Object.assign(window, { prismBlobs: 0 });
  URL.createObjectURL = (o: Blob | MediaSource) => { (window as unknown as { prismBlobs: number }).prismBlobs++; return make(o); };
}, answer);
const shellCalls = (page: Page) => page.evaluate(() => (window as unknown as { prismShellCalls: unknown[][] }).prismShellCalls);
/** A host that opens outside links itself, like the Prism Client's `host.js`: counts what reaches it. */
const fakeHostLinks = (page: Page) => page.addInitScript(() => {
  const seen: string[] = [];
  Object.assign(window, { prismHostOpened: seen });
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !/^https?:/.test(a.href) || new URL(a.href).origin === location.origin) return;
    e.preventDefault();
    seen.push(a.href);
  }, true);
});
const hostOpened = (page: Page) => page.evaluate(() => (window as unknown as { prismHostOpened: string[] }).prismHostOpened);
/** A long press with a finger: pointer events held past the threshold, then the tap's click. */
async function longPress(page: Page, selector: string, ms = 600) {
  const box = (await page.locator(selector).first().boundingBox())!;
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  const fire = (type: string) => page.locator(selector).first().evaluate((el, { type, at }) => { el.dispatchEvent(new PointerEvent(type, { ...at, pointerType: "touch", pointerId: 7, bubbles: true, cancelable: true, isPrimary: true })); }, { type, at });
  await fire("pointerdown");
  await page.waitForTimeout(ms);
  await fire("pointerup");
  await page.locator(selector).first().evaluate((el, at) => { el.dispatchEvent(new MouseEvent("click", { ...at, bubbles: true, cancelable: true, button: 0 })); }, at);
}

test.describe("saving a file", () => {
  test("browser: Download image and Download file are still downloads", async ({ page, context }) => {
    const calls = await prepare(page, context);
    await page.setViewportSize(DESKTOP);
    await open(page, "?content=" + enc(MEDIA));
    const image = page.locator("figure.prism-image").first();
    await image.locator("img").click();
    const first = page.waitForEvent("download");
    await image.getByRole("button", { name: "Download image" }).click();
    expect((await first).suggestedFilename()).toBe("River at dawn.png");
    const second = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Site plan.pdf" }).click();
    expect((await second).suggestedFilename()).toBe("Site plan.pdf");
    expect(await calls()).toEqual([]);
  });

  test("the app: the shell saves the attachment by its id — no blob download, no URL from the page; an outside file or image opens through the host", async ({ page, context }) => {
    const calls = await prepare(page, context);
    await fakeShell(page);
    await page.setViewportSize(DESKTOP);
    await open(page, "?content=" + enc(MEDIA));
    const image = page.locator("figure.prism-image").first();
    await image.locator("img").click();
    await image.getByRole("button", { name: "Download image" }).click();
    await expect.poll(() => shellCalls(page)).toEqual([["saveAttachment", ATT, "River at dawn"]]);
    await page.getByRole("button", { name: "Download Site plan.pdf" }).click();
    await expect.poll(() => shellCalls(page)).toEqual([["saveAttachment", ATT, "River at dawn"], ["saveAttachment", "a_pdf1", "Site plan.pdf"]]);
    expect(await page.evaluate(() => (window as unknown as { prismBlobs: number }).prismBlobs), "no blob: download in the app").toBe(0);
    // Not ours: never fetched with our credentials, never sent to the shell's save — opened by the host (its confirmation).
    await page.getByRole("button", { name: "Download notes.txt" }).click();
    const outside = page.locator("figure.prism-image").nth(1);
    await outside.locator("img").click({ force: true });
    await outside.getByRole("button", { name: "Download image" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { prismOpened: string[] }).prismOpened)).toEqual(["https://files.example.test/notes.txt", "https://images.example.test/outside.png"]);
    expect((await shellCalls(page)).length).toBe(2);
    expect(await calls()).toEqual([]);
  });

  test("the app: a closed save panel is not an error; a failed save says so", async ({ page, context }) => {
    await prepare(page, context);
    await fakeShell(page, "cancelled");
    await page.setViewportSize(DESKTOP);
    await open(page, "?content=" + enc(MEDIA));
    await page.getByRole("button", { name: "Download Site plan.pdf" }).click();
    await expect.poll(() => shellCalls(page)).toHaveLength(1);
    await expect(page.locator(".prism-attachment-status").first()).toHaveText("");
    await expect(page.getByRole("alert")).toHaveCount(0);

    const failing = await context.newPage();
    await forbidBrowserDialogs(failing);
    await fakeShell(failing, "fails");
    await failing.setViewportSize(DESKTOP);
    await open(failing, "?content=" + enc(MEDIA));
    await failing.getByRole("button", { name: "Download Site plan.pdf" }).click();
    await expect(failing.locator(".prism-attachment-status").first()).toHaveText("Couldn't download this file.");
    const image = failing.locator("figure.prism-image").first();
    await image.locator("img").click();
    await image.getByRole("button", { name: "Download image" }).click();
    await expect(failing.getByRole("alert").filter({ hasText: "Couldn't save this image." })).toBeVisible();
  });
});

test.describe("bookmark card", () => {
  test("phone, editable page: a tap places the selection and reaches no host; the Open control (44 px, named) opens the link exactly once", async ({ browser }) => {
    const { context, page, calls } = await phone(browser);
    await fakeHostLinks(page);
    await open(page, "?content=" + enc(BOOKMARK));
    const card = page.locator(".prism-bookmark");
    await expect(card).toBeVisible();
    await expect(card.locator("a")).toHaveCount(0); // not an anchor: nothing for a host script to take
    await card.locator(".prism-bookmark-title").tap();
    await expect(page.locator(".prism-bookmark-block")).toHaveClass(/is-selected/);
    expect(await hostOpened(page), "a tap that lands the selection opens nothing").toEqual([]);
    const openBtn = card.getByRole("button", { name: "Open atlas.example.test in a new tab" });
    await expect(openBtn).toBeVisible();
    const box = (await openBtn.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    expect(await openBtn.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await openBtn.tap();
    await expect.poll(() => hostOpened(page)).toEqual(["https://atlas.example.test/watersheds"]);
    await page.waitForTimeout(150);
    expect(await hostOpened(page), "exactly once").toHaveLength(1);
    expect(await calls()).toEqual([]);
    await context.close();
  });

  test("a page that cannot be edited: the card itself opens the link; in a browser that is a new tab", async ({ page, context }) => {
    await prepare(page, context);
    // The tab a link opens is answered here (nothing outside the fixture is contacted).
    await context.route("https://atlas.example.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>opened</title>" }));
    await page.setViewportSize(DESKTOP);
    await open(page, "?readonly&content=" + enc(BOOKMARK));
    const popup = context.waitForEvent("page");
    await page.locator(".prism-bookmark-title").click();
    const tab = await popup;
    await tab.waitForURL(/atlas\.example\.test\/watersheds/);
    expect(await tab.evaluate(() => window.opener), "the new tab gets no handle on this window").toBeNull();
    expect(page.url()).toContain("editor-blocks.html"); // this window never navigates
    // Keyboard: the Open control is a real button.
    const again = context.waitForEvent("page");
    await page.getByRole("button", { name: "Open atlas.example.test in a new tab" }).focus();
    await page.keyboard.press("Enter");
    await again;
  });

  test("desktop, editable: ⌘-click opens, a plain click selects, the Open control appears on hover", async ({ page, context }) => {
    await prepare(page, context);
    await fakeHostLinks(page);
    await page.setViewportSize(DESKTOP);
    await open(page, "?content=" + enc(BOOKMARK));
    await page.locator(".prism-bookmark-title").click();
    await expect(page.locator(".prism-bookmark-block")).toHaveClass(/is-selected/);
    expect(await hostOpened(page)).toEqual([]);
    await page.locator(".prism-bookmark-title").click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(() => hostOpened(page)).toHaveLength(1);
    await page.locator(".prism-bookmark").hover();
    await expect(page.getByRole("button", { name: "Open atlas.example.test in a new tab" })).toHaveCSS("opacity", "1");
  });
});

test.describe("a page the reader cannot edit, on a phone", () => {
  let server: RealServer;
  test.beforeAll(async ({}, info) => { server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188")); });
  test.afterAll(async () => server?.stop());

  async function checkReaderActions(page: Page) {
    const image = page.locator("figure.prism-image").first();
    await expect(image.locator("img")).toBeVisible();
    await expect(image).not.toHaveAttribute("data-editable", "");
    const bar = image.getByRole("toolbar", { name: "Image options" });
    // No hover on a touch screen: the reader's actions are simply there, finger-sized.
    await expect(bar).toHaveCSS("opacity", "1");
    for (const name of ["View full screen", "Download image", "Copy image"]) {
      const b = bar.getByRole("button", { name, exact: true });
      await expect(b).toBeVisible();
      const box = (await b.boundingBox())!;
      expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["Align left", "Caption", "Replace image"]) await expect(bar.getByRole("button", { name, exact: true })).toBeHidden();
    await bar.getByRole("button", { name: "Download image" }).tap();
    await expect.poll(() => shellCalls(page)).toEqual([["saveAttachment", ATT, "River at dawn"]]);
    // A link: a tap follows it (unchanged); a long press brings its card with Copy.
    await longPress(page, ".tiptap a[href]");
    const card = page.getByRole("group", { name: "Link" });
    await expect(card).toBeVisible();
    expect(await hostOpened(page), "the long press did not also open the link").toEqual([]);
    const copy = card.getByRole("button", { name: "Copy link" });
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await copy.tap();
    await expect(copy).toContainText("Copied");
    expect(await page.evaluate(() => (window as unknown as { prismCopied: string[] }).prismCopied)).toEqual(["https://atlas.example.test/guide"]);
    // A tap elsewhere puts the card away; a plain tap on the link opens it once.
    await page.touchscreen.tap(195, 780); // empty page below the content
    await expect(card).toHaveCount(0);
    await page.locator(".tiptap a[href]").tap();
    await expect.poll(() => hostOpened(page)).toEqual(["https://atlas.example.test/guide"]);
  }
  const fakeClipboard = (page: Page) => page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { prismCopied: copied });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); }, write: async () => { throw new Error("no image clipboard in this test"); } } });
  });

  test("read-only: image actions are on the image; a long press on a link brings Open / Copy", async ({ browser }) => {
    const { context, page, calls } = await phone(browser);
    await fakeShell(page);
    await fakeHostLinks(page);
    await fakeClipboard(page);
    await open(page, "?readonly&content=" + enc(LINKS));
    await checkReaderActions(page);
    expect(await calls()).toEqual([]);
    await context.close();
  });

  test("suggest-only (live page): the same", async ({ browser }) => {
    test.setTimeout(90_000);
    const { context, page, calls } = await phone(browser);
    const id = `reader-${process.pid}`;
    expect(await server.add({ id, path: `vault/Shared/Reader ${id}`, content: LINKS, tags: ["team"] })).toBe(true);
    const token = await server.link({ resourceType: "note", resource: id, level: "suggest" });
    await fakeShell(page);
    await fakeHostLinks(page);
    await fakeClipboard(page);
    await connectLink(page, server);
    // The fixture server holds no bytes for this id: the image is answered here (registered last = asked first).
    await page.route("**/api/attachments/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.goto(`/e2e-fixtures/collab-route.html?target=${id}&token=${encodeURIComponent(token)}`);
    await expect(editor(page)).toContainText("field guide");
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await checkReaderActions(page);
    expect(await calls()).toEqual([]);
    await context.close();
  });
});

test.describe("table controls on a phone", () => {
  for (const width of [390, 320] as const) test(`${width}: 44 px targets, a row of whole buttons, a chevron while there is more, every action reachable`, async ({ browser }) => {
    const { context, page, calls } = await phone(browser, width);
    await open(page, "?content=" + enc(TABLE));
    await page.getByText("one", { exact: true }).tap();
    const bar = page.getByRole("toolbar", { name: "Table" });
    await expect(bar).toBeVisible();
    const box = (await bar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "nothing past the screen edge").toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const row = bar.locator(".table-controls-row");
    const measure = () => row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, scrollLeft: el.scrollLeft, more: el.scrollWidth - el.clientWidth - el.scrollLeft > 4, buttons: Array.from(el.querySelectorAll("button")).map((b) => { const x = b.getBoundingClientRect(); return { name: b.getAttribute("aria-label")!, left: x.left, right: x.right, width: x.width, height: x.height }; }) };
    });
    const whole = (m: Awaited<ReturnType<typeof measure>>) => {
      // No button is cut by either edge of the row: it is entirely in, or entirely out.
      for (const b of m.buttons) {
        const inside = b.left >= m.left - 0.5 && b.right <= m.right + 0.5;
        const outside = b.right <= m.left + 0.5 || b.left >= m.right - 0.5;
        expect(inside || outside, `${b.name} is cut by the row's edge`).toBe(true);
      }
    };
    let m = await measure();
    expect(m.buttons).toHaveLength(10);
    for (const b of m.buttons) { expect(b.width, b.name).toBeGreaterThanOrEqual(44); expect(b.height, b.name).toBeGreaterThanOrEqual(44); }
    whole(m);
    expect(m.more, "ten 44 px buttons do not fit: there is more").toBe(true);
    await expect(bar).toHaveAttribute("data-more", /.*/);
    await expect(bar.locator(".table-controls-more")).toBeVisible(); // the cue, beside the row
    // Scrolled to the end: the cue goes, the last action is whole and works.
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(bar).not.toHaveAttribute("data-more", /.*/);
    m = await measure();
    whole(m);
    const last = m.buttons.at(-1)!;
    expect(last.name).toBe("Delete table");
    expect(last.right).toBeLessThanOrEqual(m.right + 0.5);
    await bar.getByRole("button", { name: "Add column right" }).tap();
    await expect(page.locator(".tiptap table tr").first().locator("th, td")).toHaveCount(3);
    // Keyboard up (the visible area panned, as in the app): the bar is in the visible area.
    await page.getByText("two", { exact: true }).tap();
    await openKeyboard(page, { offsetTop: 844 - KEYBOARD });
    await expect(bar).toBeVisible();
    await expectInVisibleArea(page, ".table-controls", "the table controls");
    await bar.locator(".table-controls-row").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await bar.getByRole("button", { name: "Delete table" }).tap();
    await expect(page.locator(".tiptap table")).toHaveCount(0);
    expect(await calls()).toEqual([]);
    await context.close();
  });

  test("desktop: unchanged — one compact bar, no chevron", async ({ page, context }) => {
    await prepare(page, context);
    await page.setViewportSize(DESKTOP);
    await open(page, "?content=" + enc(TABLE));
    await page.getByText("one", { exact: true }).click();
    const bar = page.getByRole("toolbar", { name: "Table" });
    await expect(bar).toBeVisible();
    await expect(bar.locator(".table-controls-more")).toBeHidden();
    expect((await bar.getByRole("button", { name: "Add row below" }).boundingBox())!.width).toBe(30);
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(40);
  });
});

test.describe("phone, keyboard up", () => {
  const keyboardUp = (page: Page) => openKeyboard(page, { offsetTop: 844 - KEYBOARD });

  test("the @ menu opens in the visible area, not behind the keyboard", async ({ browser }) => {
    const { context, page } = await phone(browser);
    await page.goto("/e2e-fixtures/notion-mentions.html");
    await expect(editor(page)).toBeVisible();
    await editor(page).locator("p").last().tap();
    await page.evaluate(() => { const e = (document.querySelector(".tiptap") as unknown as { editor: any }).editor; e.chain().focus("end").insertContentAt(e.state.doc.content.size, { type: "paragraph" }).focus("end").run(); });
    // A long page: the caret is low on the screen, where the old placement (the layout viewport) put the menu under the keys.
    await page.evaluate(() => { const e = (document.querySelector(".tiptap") as unknown as { editor: any }).editor; for (let i = 0; i < 12; i++) e.commands.insertContentAt(e.state.doc.content.size, { type: "paragraph" }); e.commands.focus("end"); });
    await keyboardUp(page);
    await page.keyboard.type("@");
    await expect(page.locator(".prism-mention-menu")).toBeVisible();
    await expectInVisibleArea(page, ".prism-mention-menu", "the @ menu");
    await context.close();
  });

  test("the database dialog fits the visible area; Cancel returns the caret to the page", async ({ browser }) => {
    const { context, page, calls } = await phone(browser);
    await page.goto("/e2e-fixtures/notion-media.html?content=" + enc("<p>Plan</p><p></p>"));
    await expect(page.locator(".tiptap[contenteditable=true]").first()).toBeVisible();
    await editor(page).locator("p").first().tap();
    await page.evaluate(() => { const e = (document.querySelector(".tiptap") as unknown as { editor: any }).editor; e.chain().focus("end").insertContentAt(e.state.doc.content.size, { type: "paragraph" }).focus("end").run(); });
    await keyboardUp(page);
    await page.keyboard.type("/linked");
    await page.getByRole("option", { name: /^Linked view of database/ }).tap();
    const dialog = page.getByRole("dialog", { name: "Link a database" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Search databases" })).toBeFocused();
    await expectInVisibleArea(page, ".prism-db-insert", "the database dialog");
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectInVisibleArea(page, ".prism-db-insert-actions button", "Cancel");
    await cancel.tap();
    await expect(dialog).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("still here");
    await expect(editor(page)).toContainText("still here");
    expect(await calls()).toEqual([]);
    await context.close();
  });
});
