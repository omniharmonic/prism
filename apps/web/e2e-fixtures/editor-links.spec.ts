import { test, expect, type Page } from "@playwright/test";

/**
 * NP-ED-18 — links in the editor, plain and live:
 *  (1) the link card (address + Open / Edit / Remove; Open / Copy where the page cannot be edited);
 *  (2) pasting one of OUR page links becomes a page mention chip.
 * Fixture: notion-media.html (plain DocumentRenderer; `?live` = two CollabEditors on one document).
 */
const enc = encodeURIComponent;
const html = (page: Page, i = 0) => page.evaluate((i) => (document.querySelectorAll(".tiptap")[i] as any).editor.getHTML() as string, i);
const tabs = (page: Page) => page.evaluate(() => ((window as any).prismMediaUI.getState().openTabs as Array<{ noteId: string; title: string }>).map((t) => `${t.noteId}:${t.title}`));
const card = (page: Page) => page.getByRole("group", { name: "Link", exact: true });
const CONTENT =
  '<p>Read <a href="https://example.test/docs">the docs</a> first.</p>' +
  '<p>Then <a href="/page/db1">the reading list</a> here.</p>' +
  '<p>A chip <span data-type="mention" data-kind="page" data-id="db1" data-mention-uid="u1">@page</span> and a wikilink [[Books/Braiding Sweetgrass]].</p>' +
  "<p>Closing line.</p>";
const open = async (page: Page, query = "") => {
  await page.goto(`/e2e-fixtures/notion-media.html?content=${enc(CONTENT)}${query}`);
  await expect(page.locator(".tiptap").first()).toBeVisible();
};
async function pasteText(page: Page, text: string, i = 0) {
  await page.evaluate(({ text, i }) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.querySelectorAll(".tiptap")[i]!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { text, i });
}
/** Put the caret at the end of the block whose text is `text` (through the editor: a click in a link line can land in the link). */
async function caretAtEnd(page: Page, text: string, i = 0) {
  await page.evaluate(({ text, i }) => {
    const editor = (document.querySelectorAll(".tiptap")[i] as any).editor;
    let at = -1;
    editor.state.doc.descendants((node: any, pos: number) => { if (at < 0 && node.isTextblock && node.textContent === text) at = pos + node.nodeSize - 1; return at < 0; });
    if (at < 0) throw new Error(`no block "${text}"`);
    editor.chain().focus().setTextSelection(at).run();
  }, { text, i });
  await expect.poll(() => page.evaluate((i) => { const e = (document.querySelectorAll(".tiptap")[i] as any).editor; return e.state.selection.empty ? e.state.selection.$from.parent.textContent : null; }, i)).toBe(text);
}

test("hovering a link shows its address with Open, Edit and Remove; chips and wikilinks get no card", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await context.route("https://example.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>docs</p>" }));
  await open(page);
  await caretAtEnd(page, "Closing line.");

  await page.getByRole("link", { name: "the docs" }).hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText("https://example.test/docs");
  await expect(card(page).getByRole("button")).toHaveText(["Open", "Edit", "Remove"]);
  // It never takes focus: typing carries on in the text, and the card gets out of the way.
  expect(await page.evaluate(() => document.activeElement?.classList.contains("tiptap"))).toBe(true);
  await page.keyboard.type("!");
  await expect(card(page)).toHaveCount(0);
  expect(await html(page)).toContain("Closing line.!");

  // A mention chip and a wikilink are not links to this card.
  await page.locator('[data-type="mention"]').hover();
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
  await page.locator(".wikilink").hover();
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);

  // Open: an outside link opens in a new tab that cannot reach this window.
  await page.getByRole("link", { name: "the docs" }).hover();
  const [popup] = await Promise.all([page.waitForEvent("popup"), card(page).getByRole("button", { name: "Open link" }).click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://example.test/docs");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
  await expect(card(page)).toHaveCount(0);

  // Open: a Prism page opens in the app, not in a browser tab.
  await page.getByRole("link", { name: "the reading list" }).hover();
  await expect(card(page).getByRole("button", { name: "Open page" })).toBeVisible();
  let popups = 0;
  page.on("popup", () => { popups++; });
  await card(page).getByRole("button", { name: "Open page" }).click();
  await expect.poll(() => tabs(page)).toContain("db1:Reading list");
  expect(popups).toBe(0);
  expect(page.url()).toContain("/e2e-fixtures/notion-media.html");

  // Edit: the inline link field opens on the whole link, with its address.
  await page.getByRole("link", { name: "the docs" }).hover();
  await card(page).getByRole("button", { name: "Edit link" }).click();
  const field = page.getByRole("textbox", { name: "Link address" });
  await expect(field).toHaveValue("https://example.test/docs");
  await field.fill("example.test/guide");
  await field.press("Enter");
  await expect.poll(() => html(page)).toContain('<a target="_blank" rel="noopener noreferrer nofollow" href="https://example.test/guide">the docs</a>');

  // Remove: the text stays, the link goes.
  await page.getByText("Closing line.!", { exact: true }).click();
  await page.getByRole("link", { name: "the docs" }).hover();
  await card(page).getByRole("button", { name: "Remove link" }).click();
  await expect.poll(() => html(page)).not.toContain("example.test/guide");
  expect(await html(page)).toContain("Read the docs first.");
});

test("keyboard: the caret in a link shows the card; ⌘K moves into it, Tab walks on, Esc returns to the text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  // A click in the link places the caret (it does not navigate) and the card follows.
  await page.getByRole("link", { name: "the docs" }).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-via", "caret");
  expect(page.url()).toContain("/e2e-fixtures/notion-media.html");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("tiptap"))).toBe(true);
  // Esc closes it without selecting the block.
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  expect(await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.empty)).toBe(true);
  // ⌘K with the caret in the link: focus moves into the card (the quick find does not open).
  await page.keyboard.press("ControlOrMeta+k");
  await expect(card(page).getByRole("button", { name: "Open link" })).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Search notes and commands" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(card(page).getByRole("button", { name: "Edit link" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(card(page).getByRole("button", { name: "Remove link" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("tiptap"))).toBe(true);
  // Leaving the link with the arrow keys leaves no card behind.
  await page.getByRole("link", { name: "the docs" }).click();
  await expect(card(page)).toBeVisible();
  await page.keyboard.press("End");
  await expect(card(page)).toHaveCount(0);
});

test("read-only page: the card offers Open and Copy only; a click opens the link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "&readonly");
  await expect(page.locator(".tiptap[contenteditable=false]")).toBeVisible();
  await page.getByRole("link", { name: "the docs" }).hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveText(["Open", "Copy"]);
  // Leaving the link takes the card away.
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
  // A click on a page link opens it in the app; this window does not navigate.
  await page.getByRole("link", { name: "the reading list" }).click();
  await expect.poll(() => tabs(page)).toContain("db1:Reading list");
  expect(page.url()).toContain("/e2e-fixtures/notion-media.html");
});

test("touch: a tap in an editable page places the caret and shows the card; in a read-only page it opens the link", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await open(page);
  await page.getByRole("link", { name: "the reading list" }).tap();
  await expect(card(page)).toBeVisible();
  expect(await tabs(page)).not.toContain("db1:Reading list");
  // Finger-sized actions that stay on screen.
  const box = (await card(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect((await card(page).getByRole("button", { name: "Open page" }).boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await card(page).getByRole("button", { name: "Open page" }).tap();
  await expect.poll(() => tabs(page)).toContain("db1:Reading list");

  await open(page, "&readonly");
  await page.evaluate(() => (window as any).prismMediaUI.setState({ openTabs: [], activeTabId: null }));
  await page.getByRole("link", { name: "the reading list" }).tap();
  await expect.poll(() => tabs(page)).toContain("db1:Reading list");
  await context.close();
});

test("reduced motion: the card does not animate", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await open(page);
  await page.getByRole("link", { name: "the docs" }).click();
  await expect(card(page)).toBeVisible();
  expect(await card(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await context.close();
});

test("only web, mail and in-app targets are ever opened; a page link is ours only on our own origin", async ({ page }) => {
  await open(page);
  const out = await page.evaluate(() => {
    const { linkTarget, pageIdFromUrl } = (window as any).prismLinks;
    const o = location.origin;
    return {
      js: linkTarget("javascript:alert(1)").kind,
      jsCase: linkTarget(" JaVaScRiPt:alert(1)").kind,
      data: linkTarget("data:text/html,<script>alert(1)</script>").kind,
      vbs: linkTarget("vbscript:msgbox(1)").kind,
      schemeless: linkTarget("//evil.example.test/x").kind,
      file: linkTarget("file:///etc/passwd").kind,
      // Review A1: anything a browser would resolve to ANOTHER origin, or that hides one, is never followed.
      backslash: linkTarget("/\\evil.example.test/login").kind,
      tab: linkTarget("/\t/evil.example.test").kind,
      backslashT: linkTarget("/\\t/evil").kind,
      twoBackslashes: linkTarget("\\\\evil").kind,
      newline: linkTarget("/a\nb").kind,
      del: linkTarget("/a\u007fb").kind,
      encoded: linkTarget("/%5Cevil").kind,
      dots: linkTarget("/../../x").kind,
      logout: linkTarget("/auth/logout").kind,
      anchor: linkTarget("#section").kind,
      credentials: linkTarget("https://user:pass@example.test/a").kind,
      web: linkTarget("https://example.test/a").kind,
      mail: linkTarget("mailto:ada@example.test").kind,
      inApp: linkTarget("/page/db1"),
      ours: pageIdFromUrl(`${o}/page/db1`),
      oursSlash: pageIdFromUrl(`${o}/page/db1/`),
      otherHost: pageIdFromUrl("https://prism.example.test/page/db1"),
      lookAlike: pageIdFromUrl(`${location.protocol}//${location.hostname}.evil.example.test${location.port ? `:${location.port}` : ""}/page/db1`),
      lookAlikePrefix: pageIdFromUrl(`${location.protocol}//evil-${location.host}/page/db1`),
      userinfo: pageIdFromUrl(`${o.replace("://", "://")}@evil.example.test/page/db1`),
      userinfo2: pageIdFromUrl(`${location.protocol}//evil.example.test@${location.host}/page/db1`),
      badId: pageIdFromUrl(`${o}/page/a%2Fb`),
      deeper: pageIdFromUrl(`${o}/page/db1/extra`),
      query: pageIdFromUrl(`${o}/page/db1?next=x`),
      otherPath: pageIdFromUrl(`${o}/pages/db1`),
    };
  });
  expect(out).toEqual({
    js: "blocked", jsCase: "blocked", data: "blocked", vbs: "blocked", schemeless: "blocked", file: "blocked",
    backslash: "blocked", tab: "blocked", backslashT: "blocked", twoBackslashes: "blocked", newline: "blocked", del: "blocked",
    encoded: "tab", dots: "tab", logout: "tab", anchor: "anchor", credentials: "blocked",
    web: "external", mail: "external", inApp: { kind: "page", id: "db1" },
    ours: "db1", oursSlash: "db1", otherHost: null, lookAlike: null, lookAlikePrefix: null, userinfo: null, userinfo2: null, badId: null, deeper: null, query: null, otherPath: null,
  });
});

test("pasting a Prism page link becomes a page mention; the menu offers the URL instead", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const origin = new URL(page.url()).origin;
  await caretAtEnd(page, "Closing line.");
  await pasteText(page, `${origin}/page/db1`);
  const chip = page.locator('.tiptap [data-type="mention"][data-kind="page"]');
  await expect(chip).toHaveCount(2); // the seeded chip + the pasted one
  await expect(chip.last()).toContainText("Reading list"); // resolved through the reader's own access
  const stored = await html(page);
  expect(stored.match(/data-kind="page" data-id="db1"/g)).toHaveLength(2);
  expect(stored).not.toContain(`${origin}/page/db1`);
  expect(stored).not.toContain("Reading list"); // the chip stores the id only
  const menu = page.getByRole("listbox", { name: "Paste as" });
  await expect(menu.getByRole("option")).toHaveText([/Page mention/, /URL/]);
  await expect(menu.getByRole("option", { name: /Page mention/ })).toHaveAttribute("aria-selected", "true");
  // "URL" puts the link back in place of the chip.
  await menu.getByRole("option", { name: /URL/ }).click();
  await expect(chip).toHaveCount(1);
  await expect.poll(() => html(page)).toContain(`href="${origin}/page/db1"`);

  // A page the reader cannot see is still a chip — one that reads "No access".
  await caretAtEnd(page, "Read the docs first.");
  await pasteText(page, `${origin}/page/secret-page`);
  await expect(page.getByRole("listbox", { name: "Paste as" })).toBeVisible();
  await expect(chip).toHaveCount(2);
  await expect(chip.first()).toContainText("No access");
  expect(await html(page)).toContain('data-kind="page" data-id="secret-page"');
  await page.keyboard.press("Escape");

  // Never for a look-alike host, another origin, or a path that is not exactly a page.
  const here = new URL(origin);
  const lookAlike = `${here.protocol}//${here.hostname}.evil.example.test${here.port ? `:${here.port}` : ""}/page/db1`;
  for (const url of [lookAlike, "https://prism.example.test/page/db1", `${origin}/page/db1/extra`]) {
    await caretAtEnd(page, "Then the reading list here.");
    const before = await page.locator('.tiptap [data-type="mention"]').count();
    await pasteText(page, url);
    await expect(page.getByRole("listbox", { name: "Paste as" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Paste as" }).getByRole("option", { name: /Page mention/ })).toHaveCount(0);
    expect(await page.locator('.tiptap [data-type="mention"]').count()).toBe(before);
    expect(await html(page)).toContain(`href="${url}"`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.undo());
  }
});

test("live document: the link card works, and a pasted page link is a mention chip on both clients", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await open(page, "&live");
  const a = page.getByRole("region", { name: "Client A" });
  const b = page.getByRole("region", { name: "Client B" });
  await expect(b.getByRole("link", { name: "the docs" })).toBeVisible();
  const origin = new URL(page.url()).origin;

  await caretAtEnd(page, "Closing line.", 0);
  await pasteText(page, `${origin}/page/db1`, 0);
  await expect(a.locator('[data-type="mention"][data-kind="page"]')).toHaveCount(2);
  await expect(b.locator('[data-type="mention"][data-kind="page"]')).toHaveCount(2);
  await expect(b.locator('[data-type="mention"][data-kind="page"]').last()).toContainText("Reading list");
  expect((await html(page, 1)).match(/data-kind="page" data-id="db1"/g)).toHaveLength(2);
  await expect(page.getByRole("listbox", { name: "Paste as" }).getByRole("option")).toHaveText([/Page mention/, /URL/]);
  await page.keyboard.press("Escape");
  expect(await html(page, 1)).not.toContain(`${origin}/page/db1`);

  // The card in the live editor: Remove reaches the other client.
  await a.getByRole("link", { name: "the docs" }).hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveText(["Open", "Edit", "Remove"]);
  await card(page).getByRole("button", { name: "Remove link" }).click();
  await expect(b.getByRole("link", { name: "the docs" })).toHaveCount(0);
  await expect(b.getByText("Read the docs first.")).toBeVisible();
  // A page link opens in the app from the live editor too.
  await a.getByRole("link", { name: "the reading list" }).hover();
  await card(page).getByRole("button", { name: "Open page" }).click();
  await expect.poll(() => tabs(page)).toContain("db1:Reading list");
});

/** Review A1: a stored link can never take THIS window somewhere else. */
test("a link never navigates the app window: look-alike paths are blocked, other in-app paths open in a new tab", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const content =
    '<p><a href="/&#92;evil.example.test/login">backslash</a> · <a href="/&#9;/evil.example.test">tabbed</a> · <a href="/auth/logout">logout</a> · <a href="/../../x">dots</a> · <a href="#top">anchor</a></p>';
  await page.goto(`/e2e-fixtures/notion-media.html?content=${enc(content)}&readonly`);
  await expect(page.locator(".tiptap[contenteditable=false]")).toBeVisible();
  const here = page.url();
  const navigations: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  const popups: string[] = [];
  context.on("page", (p) => { popups.push(p.url()); });
  await context.route("**/auth/logout", (r) => r.fulfill({ contentType: "text/html", body: "<p>signed out page</p>" }));
  await context.route("**/x", (r) => r.fulfill({ contentType: "text/html", body: "<p>x</p>" }));

  for (const name of ["backslash", "tabbed"]) {
    const link = page.getByRole("link", { name });
    if (await link.count()) {
      await link.hover();
      // If the editor kept the link at all, the card says it cannot be opened…
      await expect(card(page)).toContainText("This link can’t be opened");
      await expect(card(page).getByRole("button", { name: /Open/ })).toBeDisabled();
      // …and a click goes nowhere.
      await link.click();
      await page.mouse.move(5, 5);
      await expect(card(page)).toHaveCount(0);
    }
  }
  await page.waitForTimeout(300);
  expect(page.url()).toBe(here);
  expect(popups).toEqual([]);

  // Same-origin paths other than a page: a NEW tab that cannot reach this window — never this one.
  const [logout] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "logout" }).click()]);
  await logout.waitForLoadState();
  expect(new URL(logout.url()).pathname).toBe("/auth/logout");
  expect(await logout.evaluate(() => window.opener)).toBeNull();
  await logout.close();
  const [dots] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "dots" }).click()]);
  expect(new URL(dots.url()).origin).toBe(new URL(here).origin);
  await dots.close();
  // An anchor stays in the page.
  await page.getByRole("link", { name: "anchor" }).click();
  await page.waitForTimeout(200);
  expect(page.url().split("#")[0]).toBe(here.split("#")[0]);
  expect(navigations.filter((u) => u.split("#")[0] !== here.split("#")[0])).toEqual([]);
});

test("the inline link field refuses backslash and control-character paths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await page.getByText("Closing line.", { exact: true }).selectText();
  await page.locator(".document-selection-actions:visible").getByRole("button", { name: "Link", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Link address" });
  for (const bad of ["/\\evil.example.test/login", "\\\\evil", "/a\\b", "https://user:pass@example.test/a"]) {
    await field.fill(bad);
    await field.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Use a web, mail or page link." })).toBeVisible();
    expect(await html(page)).not.toContain("evil");
    expect(await html(page)).not.toContain("user:pass");
  }
  await field.fill("/page/db1");
  await field.press("Enter");
  await expect.poll(() => html(page)).toContain('href="/page/db1"');
});

/** Review A2: the Prism Client's host script handles every http(s) anchor click at the document. */
test("with a host that opens outside links itself, a link opens exactly once and a page link stays in the app", async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    (window as any).hostOpened = [] as string[];
    // What apps/client/src-tauri/src/host.js does: document capture, skip handled clicks, take http(s) anchors.
    document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !/^https?:/.test(a.href)) return;
      e.preventDefault();
      (window as any).hostOpened.push(a.href);
    }, true);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = new URL(baseURL!).origin;
  const content = `<p><a href="https://example.test/docs">outside</a> and <a href="${origin}/page/db1">our page</a></p>`;
  await page.goto(`/e2e-fixtures/notion-media.html?content=${enc(content)}&readonly`);
  await expect(page.locator(".tiptap[contenteditable=false]")).toBeVisible();
  let popups = 0;
  page.on("popup", () => { popups++; });
  await page.getByRole("link", { name: "outside" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).hostOpened as string[])).toEqual(["https://example.test/docs"]);
  await page.getByRole("link", { name: "our page" }).click();
  await expect.poll(() => tabs(page)).toContain("db1:Reading list");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).hostOpened as string[])).toEqual(["https://example.test/docs"]);
  expect(popups).toBe(0);
});

/** Review A3: the share route has no tabs — a page link opens the page's own address in a new tab. */
test("without a workspace shell a page link opens in a new tab", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await context.route("**/page/db1", (r) => r.fulfill({ contentType: "text/html", body: "<p>page</p>" }));
  await open(page, "&readonly&noshell");
  const [opened] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "the reading list" }).click()]);
  await opened.waitForLoadState();
  expect(new URL(opened.url()).pathname).toBe("/page/db1");
  expect(await opened.evaluate(() => window.opener)).toBeNull();
  expect(page.url()).toContain("/e2e-fixtures/notion-media.html");
});

/** Review A4: an edit while the card is still on its way must not bring it up on a stale range. */
test("typing while a hover card is pending cancels it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await caretAtEnd(page, "Closing line.");
  await page.keyboard.press("ControlOrMeta+Home");
  await page.getByRole("link", { name: "the docs" }).hover();
  await page.keyboard.type("X"); // before the card's delay has passed; every position after it shifts
  await page.waitForTimeout(600);
  await expect(card(page)).toHaveCount(0);
});

/** Review A5: someone who may only comment gets no Edit / Remove. */
test("comment-only live editor: the card offers Open and Copy, never Edit or Remove", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await open(page, "&live&commentonly");
  const a = page.getByRole("region", { name: "Client A" });
  await a.getByRole("link", { name: "the docs" }).hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveText(["Open", "Copy"]);
});

/** Review A6: keyboard focus on a link in a read-only page shows the card; moving on takes it away. */
test("read-only: the card that keyboard focus brings up goes when focus leaves the link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "&readonly");
  await page.getByRole("link", { name: "the docs" }).focus();
  await expect(card(page)).toBeVisible();
  await page.getByRole("link", { name: "the reading list" }).focus();
  await expect(card(page)).toContainText("/page/db1");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(card(page)).toHaveCount(0);
});
