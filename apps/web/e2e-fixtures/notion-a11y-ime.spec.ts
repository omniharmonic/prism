import { test, expect, type CDPSession, type Locator, type Page } from "@playwright/test";

/**
 * NP-AX-08 — IME composition (Japanese/Chinese input, dictation).
 *
 * Composition is synthesised with Chromium's `Input.imeSetComposition` (real compositionstart /
 * compositionupdate / compositionend and `beforeinput` events; `view.composing` is true). The Enter that
 * COMMITS a composition is dispatched as a keydown with `isComposing: true` (Chromium, Firefox) and as
 * the Safari shape (`isComposing: false`, `keyCode: 229`, after compositionend): with CDP there is no
 * input method to swallow a real Enter, so a real key press would not be representative.
 * Not covered here: a real IME's candidate window, iOS dictation, autocorrect — device checks.
 */
const editor = (page: Page) => page.locator(".tiptap[contenteditable=true]").first();
const pm = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const editor = document.querySelector(".tiptap").editor; return (${fn})(editor); })()`) as Promise<T>;
const compose = (cdp: CDPSession, text: string) => cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
const cancel = (cdp: CDPSession) => cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
const commit = (cdp: CDPSession, text: string) => cdp.send("Input.insertText", { text });
/** The committing Enter, both browser shapes. Returns whether a handler acted on it (preventDefault). */
async function imeEnter(target: Locator, extra: Record<string, unknown> = {}) {
  return target.evaluate((el, extra) => {
    const fire = (init: KeyboardEventInit & { keyCode?: number }) => { const e = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init, ...extra }); Object.defineProperty(e, "keyCode", { get: () => init.keyCode ?? 13 }); el.dispatchEvent(e); return e.defaultPrevented; };
    return [fire({ isComposing: true, keyCode: 229 }), fire({ isComposing: false, keyCode: 229 })];
  }, extra);
}
async function newParagraph(page: Page) {
  await expect(editor(page)).toBeVisible();
  await editor(page).click();
  await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.focus("end"));
  await page.keyboard.press("Enter");
}
const menus = (page: Page) => page.locator('[role="listbox"][aria-label="Insert block"], [role="listbox"][aria-label="Mention a person, page or date"], .wikilink-dropdown, [aria-label="Link to a page"]');

test.describe("IME composition", () => {
  test("slash, @ and [[ menus stay closed mid-composition; nothing is inserted twice", async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-mentions.html");
    const body = page.locator(".ProseMirror").first();
    await expect(body).toBeVisible();
    await body.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    const cdp = await page.context().newCDPSession(page);
    const blocks = () => page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.doc.childCount);
    const before = await blocks();
    for (const trigger of ["/", "@", "[[", "/に", "@に", "[[に", "／", "＠"]) {
      await compose(cdp, trigger);
      expect(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.view.composing), `composing "${trigger}"`).toBe(true);
      await page.waitForTimeout(250);
      await expect(menus(page), `no menu while composing "${trigger}"`).toHaveCount(0);
      // The candidate-list keys are the input method's: they do not drive anything in the app.
      for (const key of ["ArrowDown", "ArrowUp", "Tab", "Escape"]) await body.evaluate((el, key) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing: true })), key);
      await expect(menus(page)).toHaveCount(0);
      expect(await page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.view.composing)).toBe(true);
      await cancel(cdp);
    }
    expect(await blocks()).toBe(before);
    // Compose, commit: the committed text is there exactly once.
    await compose(cdp, "にほんご");
    await compose(cdp, "日本語");
    await commit(cdp, "日本語");
    await expect.poll(() => page.evaluate(() => (document.querySelector(".ProseMirror") as any).editor.state.doc.lastChild.textContent)).toBe("日本語");
    expect(await body.evaluate((el) => el.textContent!.split("日本語").length - 1)).toBe(1);
    // A typed trigger still works afterwards (the guard is about composition only).
    await page.keyboard.type(" /");
    await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("Markdown input rules do not fire mid-composition", async ({ page }) => {
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await newParagraph(page);
    const cdp = await page.context().newCDPSession(page);
    const last = () => pm<string>(page, "(e) => e.state.doc.lastChild.type.name");
    for (const text of ["# ", "- ", "1. ", "> ", "[] ", "```", "---", ">> "]) {
      await compose(cdp, text);
      await page.waitForTimeout(120);
      expect(await pm<boolean>(page, "(e) => e.view.composing"), `composing "${text}"`).toBe(true);
      expect(await last(), `"${text}" did not convert the block while composing`).toBe("paragraph");
      await cancel(cdp);
      expect(await last()).toBe("paragraph");
      expect(await pm<string>(page, "(e) => e.state.doc.lastChild.textContent")).toBe("");
    }
    // Inline marks: composing **x** leaves the asterisks alone until the composition ends.
    await compose(cdp, "**太字**");
    await page.waitForTimeout(120);
    expect(await pm<string>(page, "(e) => e.state.doc.lastChild.textContent")).toBe("**太字**");
    await cancel(cdp);
  });

  test("the Enter that commits a composition does not create a block, pick a menu row or leave the title", async ({ page }) => {
    await page.goto("/e2e-fixtures/editor-blocks.html");
    await newParagraph(page);
    await page.keyboard.type("にほん");
    const count = await pm<number>(page, "(e) => e.state.doc.childCount");
    expect(await imeEnter(editor(page))).toEqual([false, false]);
    expect(await pm<number>(page, "(e) => e.state.doc.childCount")).toBe(count);
    // An open slash menu: the composing Enter does not choose its first row.
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const slash = page.getByRole("listbox", { name: "Insert block" });
    await expect(slash).toBeVisible();
    const html = await pm<string>(page, "(e) => e.getHTML()");
    expect(await imeEnter(editor(page))).toEqual([false, false]);
    await expect(slash).toBeVisible();
    expect(await pm<string>(page, "(e) => e.getHTML()")).toBe(html);
    await page.keyboard.press("Escape");
  });

  test("the committing Enter does not rename, search-open, send a reply or post a comment", async ({ page }) => {
    // Title field: still editing, nothing committed.
    await page.goto("/e2e-fixtures/notion-shell.html");
    await expect(editor(page)).toBeVisible();
    await page.getByRole("button", { name: /^Rename / }).first().click();
    const title = page.getByRole("textbox", { name: "Document title" });
    await title.fill("会議メモ");
    await imeEnter(title);
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("会議メモ");
    expect(await page.evaluate(() => ((window as any).prismShell?.writes?.length ?? 0))).toBe(await page.evaluate(() => ((window as any).prismShell?.writes?.length ?? 0)));
    await title.press("Escape");
    // ⌘K: the selected row is not opened.
    await page.keyboard.press("ControlOrMeta+k");
    const combo = page.getByRole("combobox", { name: "Search notes and commands" });
    await combo.fill("workshop");
    await expect(page.getByRole("group", { name: "Notes" }).getByRole("option").first()).toBeVisible();
    await imeEnter(combo);
    await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Comment thread reply (plain Enter sends) and the page-comment composer.
    await page.goto("/e2e-fixtures/notion-comments.html");
    const mine = page.getByRole("main", { name: "Your view" }).getByRole("region", { name: "Page discussion" });
    await mine.getByRole("button", { name: "Add comment" }).click();
    const composer = mine.getByRole("textbox", { name: "Comment on this page" });
    await composer.fill("下書き");
    await imeEnter(composer);
    await imeEnter(composer, { metaKey: true, ctrlKey: true });
    await expect(mine.locator("[data-comment-id]")).toHaveCount(0);
    await expect(composer).toHaveValue("下書き");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(mine.locator("[data-comment-id]")).toHaveCount(1);
    const reply = mine.getByRole("textbox", { name: /Reply/ }).first();
    await reply.fill("返信");
    const replies = await mine.locator("[data-comment-id]").first().innerText();
    await imeEnter(reply);
    await expect(reply).toHaveValue("返信");
    expect(await mine.locator("[data-comment-id]").first().innerText()).toBe(replies);
    // A real Enter still sends.
    await reply.press("Enter");
    await expect(mine.locator("[data-comment-id]").first()).toContainText("返信");
  });

  test("autosave and a remote update do not interrupt a composition", async ({ page }) => {
    await page.goto("/e2e-fixtures/workspace.html?session&events");
    await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
    const body = page.locator(".tiptap");
    await expect(body).toContainText("Useful observations from our last conversation.");
    await body.click();
    await page.keyboard.press("ControlOrMeta+End");
    const cdp = await page.context().newCDPSession(page);
    await compose(cdp, "にほんご");
    const composing = () => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.view.composing);
    expect(await composing()).toBe(true);
    // Another device saves the page while the composition is open.
    await page.evaluate(() => {
      const note = ((window as any).prismFixtureNotes as any[]).find((n) => n.id === "field-notes");
      note.content = "<h1>Field notes</h1><p>Edited on the other device.</p>";
      note.updatedAt = "2026-10-01T12:05:00.000Z";
      (window as any).prismFixtureInvalidate("field-notes");
    });
    // Past the 500 ms event batch, the re-read and the autosave debounce.
    await page.waitForTimeout(2500);
    expect(await composing(), "still composing").toBe(true);
    await expect(body).toContainText("Useful observations from our last conversation.");
    await expect(body).not.toContainText("Edited on the other device.");
    await expect(body).toContainText("にほんご");
    // Updating the candidate and committing still works: the text lands once, where it was typed.
    await compose(cdp, "日本語");
    await commit(cdp, "日本語");
    await expect.poll(composing).toBe(false);
    await expect(body).toContainText("Useful observations from our last conversation.日本語");
    expect(await body.evaluate((el) => el.textContent!.split("日本語").length - 1)).toBe(1);
    expect(await body.evaluate((el) => el.textContent!.includes("にほんご"))).toBe(false);
  });
});
