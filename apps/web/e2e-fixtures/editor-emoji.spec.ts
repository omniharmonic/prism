import { type Page } from "@playwright/test";
import { test, expect, chromiumOnly } from "./browser-compat";

/**
 * NP-ED-27 — inline emoji: `:` + two characters opens a list (↑/↓, ↵/Tab insert the character, Esc
 * leaves the text), `:smile:` converts on the closing colon, `/emoji` opens the full picker.
 * Fixture: editor-select.html (plain; `?live` = two CollabEditors on one document).
 */
const enc = encodeURIComponent;
const menu = (page: Page) => page.getByRole("listbox", { name: "Emoji", exact: true });
const options = (page: Page) => menu(page).getByRole("option");
const text = (page: Page, i = 0) => page.evaluate((i) => { const e = (window as any).prismSelect.editor(i); return e.state.doc.child(e.state.doc.childCount - 1).textContent as string; }, i);
const html = (page: Page, i = 0) => page.evaluate((i) => (document.querySelectorAll(".tiptap")[i] as any).editor.getHTML() as string, i);

async function open(page: Page, query = "", content = "<p>Start</p>") {
  await page.goto(`/e2e-fixtures/editor-select.html?content=${enc(content)}${query}`);
  await expect(page.locator(".tiptap").first()).toBeVisible();
  await expect(page.locator(".tiptap").first()).toContainText(/\S/);
  if (query.includes("live")) await expect(page.locator(".tiptap").nth(1)).toContainText(/\S/);
  await page.locator(".tiptap").first().click();
  await page.evaluate(() => (window as any).prismSelect.editor(0).commands.focus("end"));
}
/** Empty the last paragraph and leave the caret in it. */
async function reset(page: Page) {
  await page.evaluate(() => {
    const e = (window as any).prismSelect.editor(0);
    const last = e.state.doc.childCount - 1;
    let pos = 0;
    for (let k = 0; k < last; k++) pos += e.state.doc.child(k).nodeSize;
    e.chain().focus().insertContentAt({ from: pos, to: pos + e.state.doc.child(last).nodeSize }, "<p>Start</p>").focus("end").run();
  });
}

for (const mode of ["plain", "live"]) {
  const q = mode === "live" ? "&live" : "";
  test.describe(`inline emoji — ${mode} editor`, () => {
    test("`:` + two letters opens a filtered list; ↑/↓ move, Enter / Tab / click insert the character as plain text", async ({ page }) => {
      await open(page, q);
      await page.keyboard.type(" :s");
      await expect(menu(page)).toHaveCount(0);
      await page.keyboard.type("m");
      await expect(menu(page)).toBeVisible();
      await expect(options(page).first()).toHaveAttribute("data-emoji", "😄");
      await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
      await expect(options(page).first()).toContainText(":smile:");
      // The listbox contract of the other editor menus.
      const body = page.locator(".tiptap").first();
      await expect(body).toHaveAttribute("aria-controls", (await menu(page).getAttribute("id"))!);
      await expect(body).toHaveAttribute("aria-activedescendant", (await options(page).first().getAttribute("id"))!);
      await page.keyboard.press("ArrowDown");
      await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.type("ile");
      await expect(options(page).first()).toHaveAttribute("data-emoji", "😄");
      await page.keyboard.press("Enter");
      await expect(menu(page)).toHaveCount(0);
      expect(await text(page)).toBe("Start 😄");
      await expect(body).not.toHaveAttribute("aria-controls", /.+/);
      expect(await html(page)).toContain("<p>Start 😄</p>"); // text, not a node
      if (mode === "live") await expect.poll(() => text(page, 1)).toBe("Start 😄");
      // Tab inserts too; so does a click.
      await page.keyboard.type(" :tad");
      await expect(options(page).first()).toHaveAttribute("data-emoji", "🎉");
      await page.keyboard.press("Tab");
      expect(await text(page)).toBe("Start 😄 🎉");
      await page.keyboard.type(" :fir");
      await options(page).filter({ hasText: ":fire:" }).click();
      expect(await text(page)).toBe("Start 😄 🎉 🔥");
      // Still typing where the emoji went.
      await page.keyboard.type("!");
      expect(await text(page)).toBe("Start 😄 🎉 🔥!");
    });

    test("`:smile:` typed in full converts on the closing colon; an unknown name stays as typed", async ({ page }) => {
      await open(page, q);
      await page.keyboard.type(" :smile:");
      expect(await text(page)).toBe("Start 😄");
      await expect(menu(page)).toHaveCount(0);
      await page.keyboard.type(" :+1: :zzqq: done");
      expect(await text(page)).toBe("Start 😄 👍 :zzqq: done");
      if (mode === "live") await expect.poll(() => text(page, 1)).toBe("Start 😄 👍 :zzqq: done");
    });

    test("Esc closes the list and leaves the typed text; it stays closed for that word", async ({ page }) => {
      await open(page, q);
      await page.keyboard.type(" :smi");
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu(page)).toHaveCount(0);
      expect(await text(page)).toBe("Start :smi");
      // Escape was the menu's: nothing got selected as a block.
      expect(await page.evaluate(() => (window as any).prismSelect.blocks(0))).toEqual([]);
      await page.keyboard.type("l");
      await page.waitForTimeout(150);
      await expect(menu(page)).toHaveCount(0);
      expect(await text(page)).toBe("Start :smil");
      // A new word opens it again.
      await page.keyboard.type(" :roc");
      await expect(menu(page)).toBeVisible();
    });

    test("never opens in code, a time, a URL or inside a word — and converts nothing there", async ({ page }) => {
      await open(page, q);
      for (const typed of ["10:30", "at 9:15pm", "http://example.com", "see https://ex.test/a:bc", "a:bc", "key:value", " :30", " :3d"]) {
        await reset(page);
        await page.keyboard.type(typed);
        await page.waitForTimeout(120);
        await expect(menu(page), `no list for "${typed}"`).toHaveCount(0);
      }
      await reset(page);
      await page.keyboard.type(" 10:30: and a:smile: and http://smile:");
      expect(await text(page)).toBe("Start 10:30: and a:smile: and http://smile:");
      // Inline code.
      await reset(page);
      await page.keyboard.type(" ");
      await page.evaluate(() => (window as any).prismSelect.editor(0).chain().focus().toggleCode().run());
      await page.keyboard.type(":smi");
      await page.waitForTimeout(120);
      await expect(menu(page)).toHaveCount(0);
      await page.keyboard.type("le:");
      expect(await text(page)).toBe("Start :smile:");
      // A code block.
      await reset(page);
      await page.evaluate(() => (window as any).prismSelect.editor(0).chain().focus().toggleCodeBlock().run());
      await page.keyboard.type(" :smile: :ta");
      await page.waitForTimeout(120);
      await expect(menu(page)).toHaveCount(0);
      // (The code block is followed by an empty paragraph, so read the whole page.)
      expect(await page.evaluate(() => (window as any).prismSelect.editor(0).state.doc.textContent as string)).toBe("Start :smile: :ta");
    });
  });
}

test.describe("inline emoji — data, memory, picker, phone", () => {
  test("the full emoji set is a lazy chunk fetched on the first `:`; before it arrives (or offline) the built-in set answers", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (r) => { if (r.url().includes("emojis-en")) requested.push(r.url()); });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(/emojis-en/, async (route) => { await held; await route.continue(); });
    await open(page);
    await page.keyboard.type(" plain words, no colon trigger");
    await page.waitForTimeout(300);
    expect(requested).toEqual([]);
    await page.keyboard.type(" :sm");
    // Held back: the built-in set already lists it.
    await expect(options(page).first()).toHaveAttribute("data-emoji", "😄");
    await expect.poll(() => requested.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).prismSelect.emojiSetIsFull())).toBe(false);
    await page.keyboard.press("Escape");
    await page.keyboard.type(" :unic");
    await page.waitForTimeout(150);
    await expect(menu(page)).toHaveCount(0); // not in the built-in set
    release();
    await expect.poll(() => page.evaluate(() => (window as any).prismSelect.emojiSetIsFull())).toBe(true);
    await expect(options(page).first()).toHaveAttribute("data-emoji", "🦄");
    await page.keyboard.press("Enter");
    expect(await text(page)).toContain("🦄");
    // A full-set shortcode converts once the set is there.
    await page.keyboard.type(" :waving_hand:");
    expect(await text(page)).toContain("👋");
  });

  test("a failed download (offline) leaves the built-in set working", async ({ page }) => {
    await page.route(/emojis-en/, (route) => route.abort());
    await open(page);
    await page.keyboard.type(" :rock");
    await expect(options(page).first()).toHaveAttribute("data-emoji", "🚀");
    await page.keyboard.press("Enter");
    expect(await text(page)).toBe("Start 🚀");
    await page.keyboard.type(" :tada:");
    expect(await text(page)).toBe("Start 🚀 🎉");
  });

  test("an emoji used before comes first; the last skin tone is applied", async ({ page }) => {
    await open(page);
    await page.keyboard.type(" :ro");
    await expect(options(page).first()).toHaveAttribute("data-emoji", "🤣"); // rofl before rocket
    await page.keyboard.type("cket");
    await page.keyboard.press("Enter");
    expect(await text(page)).toBe("Start 🚀");
    await page.keyboard.type(" :ro");
    await expect(options(page).first()).toHaveAttribute("data-emoji", "🚀");
    await page.keyboard.press("Escape");
    // Remembered on this device across a reload.
    await page.evaluate(() => localStorage.setItem("prism:emoji:tone", "1f3fd"));
    await open(page);
    await page.keyboard.type(" :ro");
    await expect(options(page).first()).toHaveAttribute("data-emoji", "🚀");
    await page.keyboard.press("Escape");
    await reset(page);
    await page.keyboard.type(" :+1: :wav");
    await expect(options(page).first().locator(".prism-emoji-glyph")).toHaveText("👋🏽");
    await page.keyboard.press("Enter");
    expect(await text(page)).toBe("Start 👍🏽 👋🏽");
  });

  test("`/emoji` opens the full picker at the caret; a pick is inserted and its skin tone remembered", async ({ page }) => {
    await open(page);
    await page.keyboard.type(" /emoji");
    await expect(page.getByRole("listbox", { name: "Insert block" }).getByRole("option", { name: /Emoji/ })).toBeVisible();
    await page.keyboard.press("Enter");
    const picker = page.getByRole("dialog", { name: "Emoji picker" });
    await expect(picker).toBeVisible();
    await picker.getByPlaceholder("Search emoji").fill("rocket");
    await picker.locator('button[data-unified="1f680"]').first().click();
    await expect(picker).toHaveCount(0);
    expect(await text(page)).toBe("Start 🚀");
    await page.keyboard.type("!");
    expect(await text(page)).toBe("Start 🚀!");
    // Esc closes it without inserting.
    await page.keyboard.type(" /emoji");
    await page.keyboard.press("Enter");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    expect(await text(page)).toBe("Start 🚀! ");
  });

  test("IME: the list never opens mid-composition; committed text opens it", async ({ page, browserName }) => {
    chromiumOnly(browserName, "the composition is synthesised with CDP Input.imeSetComposition");
    await open(page);
    await page.keyboard.type(" ");
    const cdp = await page.context().newCDPSession(page);
    for (const composing of [":sm", ":smile", ":smile:", "：sm"]) {
      await cdp.send("Input.imeSetComposition", { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
      expect(await page.evaluate(() => (window as any).prismSelect.editor(0).view.composing)).toBe(true);
      await page.waitForTimeout(200);
      await expect(menu(page), `no list while composing "${composing}"`).toHaveCount(0);
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    }
    expect(await text(page)).toBe("Start ");
    await cdp.send("Input.imeSetComposition", { text: ":ro", selectionStart: 3, selectionEnd: 3 });
    await expect(menu(page)).toHaveCount(0);
    await cdp.send("Input.insertText", { text: ":ro" });
    await expect(menu(page)).toBeVisible();
    expect(await text(page)).toBe("Start :ro");
  });

  test("phone: the list stays above the keyboard toolbar", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const content = Array.from({ length: 16 }, (_, i) => `<p>Line ${i + 1} of a longer page.</p>`).join("");
    await page.goto(`/e2e-fixtures/editor-select.html?content=${enc(content)}`);
    const body = page.locator(".tiptap").first();
    await expect(body).toContainText("Line 16");
    await body.tap();
    await page.evaluate(() => (window as any).prismSelect.editor(0).commands.focus("end"));
    const toolbar = page.locator(".keyboard-toolbar");
    await expect(toolbar).toBeVisible();
    await page.keyboard.type(" :sm");
    await expect(menu(page)).toBeVisible();
    const m = (await menu(page).boundingBox())!;
    const t = (await toolbar.boundingBox())!;
    expect(m.y + m.height).toBeLessThanOrEqual(t.y + 0.5);
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(390);
    await options(page).first().tap();
    expect(await text(page)).toBe("Line 16 of a longer page. 😄");
    await context.close();
  });
});

test.describe("inline emoji — review round", () => {
  test("S5: a picker that fails to download closes with a notice, leaves the `:` list working, and can be opened again", async ({ page, browserName }) => {
    await page.route(/deps\/emoji-picker-react\.js/, (route) => route.abort());
    await open(page);
    await page.keyboard.type(" /emoji");
    await page.keyboard.press("Enter");
    await expect(page.locator(".block-notice")).toContainText("emoji picker");
    await expect(page.getByRole("dialog", { name: "Emoji picker" })).toHaveCount(0);
    // The list is alive.
    await page.keyboard.type(":sm");
    await expect(options(page).first()).toHaveAttribute("data-emoji", "😄");
    await page.keyboard.press("Enter");
    expect(await text(page)).toBe("Start 😄");
    // Back online: the next open asks for the picker again.
    await page.unroute(/deps\/emoji-picker-react\.js/);
    await page.keyboard.type(" /emoji");
    await page.keyboard.press("Enter");
    const picker = page.getByRole("dialog", { name: "Emoji picker" });
    await expect(picker).toBeVisible();
    // (WebKit remembers a failed module download for the page's lifetime; there the notice shows again.)
    if (browserName === "chromium") await expect(picker.getByPlaceholder("Search emoji")).toBeVisible();
  });

  test("S6: a collaborator's insert before the trigger between the list opening and Enter — the emoji still replaces exactly `:sm`", async ({ page }) => {
    await open(page, "&live");
    await page.keyboard.type(" :sm");
    await expect(options(page).first()).toHaveAttribute("data-emoji", "😄");
    await page.evaluate(() => {
      const w = window as any;
      w.prismSelect.editor(1).commands.insertContentAt(1, "Hey ");
      // Same task: nothing has re-rendered since the peer's insert.
      document.querySelectorAll(".tiptap")[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    });
    await expect.poll(() => text(page, 1)).toBe("Hey Start 😄");
    expect(await text(page, 0)).toBe("Hey Start 😄");
    await expect(menu(page)).toHaveCount(0);
  });

  for (const mode of ["plain", "live"]) {
    test(`S7: ⌘Z after \`:smile:\` gives the typed text back; a second ⌘Z removes it (${mode})`, async ({ page }) => {
      await open(page, mode === "live" ? "&live" : "");
      await page.keyboard.type(" :smile:");
      expect(await text(page)).toBe("Start 😄");
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => text(page)).toBe("Start :smile:");
      if (mode === "live") await expect.poll(() => text(page, 1)).toBe("Start :smile:");
      await expect(menu(page)).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await text(page)).includes(":smile:")).toBe(false);
      expect(await text(page)).not.toContain("😄");
      if (mode === "live") await expect.poll(async () => (await text(page, 1)).includes(":smile")).toBe(false);
    });
  }

  test("S7: only a built-in shortcode converts on its own; a full-set name converts while its list is open", async ({ page }) => {
    await open(page);
    await page.keyboard.type(" :uni");
    await expect.poll(() => page.evaluate(() => (window as any).prismSelect.emojiSetIsFull())).toBe(true);
    await expect(options(page).first()).toBeVisible();
    await page.keyboard.press("Escape"); // list dismissed for this word
    await page.keyboard.type("corn: and");
    expect(await text(page)).toBe("Start :unicorn: and");
    // The list open for exactly that name: the closing colon converts.
    await page.keyboard.type(" :unicorn");
    await expect(options(page).first()).toHaveAttribute("data-emoji", "🦄");
    await page.keyboard.type(":");
    expect(await text(page)).toBe("Start :unicorn: and 🦄");
    // A built-in converts even with the list dismissed.
    await page.keyboard.type(" :ta");
    await page.keyboard.press("Escape");
    await page.keyboard.type("da:");
    expect(await text(page)).toBe("Start :unicorn: and 🦄 🎉");
  });

  test("the list opens on typing only — not on putting the caret after existing text, not inside `[[`, not beside another popup", async ({ page }) => {
    await open(page, "", "<p>Start :sm</p>");
    await page.waitForTimeout(250);
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.type("i");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    // Inside an unclosed [[ a colon is part of the page name: no list, no conversion.
    await reset(page);
    await page.keyboard.type(" [[Plan :smi");
    await page.waitForTimeout(150);
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.type("le:");
    expect(await text(page)).toBe("Start [[Plan :smile:");
    await page.keyboard.press("Escape");
    // Beside the @ menu.
    await reset(page);
    await page.keyboard.type(" @rem");
    await expect(page.getByRole("listbox", { name: "Mention a person, page or date" })).toBeVisible();
    await page.keyboard.type(" :sm");
    await page.waitForTimeout(150);
    if (await page.getByRole("listbox", { name: "Mention a person, page or date" }).isVisible()) await expect(menu(page)).toHaveCount(0);
  });

  test("Esc and Enter typed right behind the trigger are the list's, before anything has rendered", async ({ page }) => {
    await open(page);
    const out = await page.evaluate(() => {
      const w = window as any;
      const editor = w.prismSelect.editor(0);
      const dom = document.querySelector(".tiptap")!;
      const key = (k: string) => dom.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true }));
      editor.commands.insertContent(" :sm");
      key("Escape");
      const afterEsc = { blocks: w.prismSelect.blocks(0), text: editor.state.doc.textContent };
      editor.commands.insertContent(" :tad");
      key("Enter");
      return { afterEsc, text: editor.state.doc.textContent, count: editor.state.doc.childCount };
    });
    expect(out.afterEsc).toEqual({ blocks: [], text: "Start :sm" });
    expect(out).toMatchObject({ text: "Start :sm 🎉", count: 1 });
    await expect(menu(page)).toHaveCount(0);
  });

  test("comment-only: no list and no conversion (nothing may be typed there)", async ({ page }) => {
    await open(page, "&live&commentonly");
    await page.keyboard.type(" :smile:");
    await page.waitForTimeout(150);
    await expect(menu(page)).toHaveCount(0);
    expect(await text(page, 1)).toBe("Start");
  });
});
