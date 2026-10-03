import { test, expect, type Page } from "@playwright/test";

/** Wave 2B editor depth: code blocks (ED-11), images (ED-12), TOC (ED-19), find & replace (ED-23). */
const SHOTS = process.env.PRISM_EDITOR_SHOTS;
const html = (page: Page, i = 0) => page.evaluate((i) => (document.querySelectorAll(".tiptap")[i] as any).editor.getHTML() as string, i);
const open = (page: Page, query = "") => page.goto(`/e2e-fixtures/notion-media.html${query}`);
const enc = encodeURIComponent;

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
  await page.getByText("end", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
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
  await page.keyboard.press("ControlOrMeta+Shift+h");
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
  await page.keyboard.press("ControlOrMeta+Shift+h");
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
