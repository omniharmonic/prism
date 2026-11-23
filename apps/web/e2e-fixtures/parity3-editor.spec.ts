import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Parity pass 3 (slice G) — editor clauses with no assertion until now:
 *   NP-ED-08  numbered lists continue their numbering · the checked to-do style · callout colour
 *   NP-ED-10  table column resize
 *   NP-ED-16  a block TEXT colour · dark-mode values of the palette
 * (NP-ED-02 block menu → Comment is asserted in editor-toolbar.spec › "live editor: the toolbar
 * carries Comment…".)
 */
const fixture = (content?: string, extra = "") => `/e2e-fixtures/editor-blocks.html?${extra}${content === undefined ? "" : `content=${encodeURIComponent(content)}`}`;
const html = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
const saved = (page: Page) => page.evaluate(() => ((window as any).prismBlockWrites as Array<{ content?: string }>).at(-1)?.content ?? "");

async function open(page: Page, content?: string, extra = "") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixture(content, extra));
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
}
async function clickInto(page: Page, text: string) {
  await page.getByText(text, { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe(text);
}
async function blockMenu(page: Page, text: string): Promise<Locator> {
  await page.getByText(text, { exact: true }).hover();
  const gutter = page.locator(".block-gutter");
  await expect(gutter).toBeVisible();
  await gutter.getByRole("button", { name: /Drag to move/ }).click();
  const menu = page.getByRole("menu", { name: "Block actions" });
  await expect(menu).toBeVisible();
  return menu;
}
async function setBlockColor(page: Page, text: string, option: string) {
  const menu = await blockMenu(page, text);
  await menu.getByRole("menuitem", { name: "Color" }).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}
/** Put the caret right after `text` (End / Home are scroll keys in macOS Chromium, not caret keys). */
const caretAfter = (page: Page, text: string) => page.evaluate((t) => {
  const editor = (document.querySelector(".tiptap") as any).editor;
  let at = -1;
  editor.state.doc.descendants((node: any, pos: number) => { if (at < 0 && node.isText && node.text.includes(t)) at = pos + node.text.indexOf(t) + t.length; });
  if (at < 0) throw new Error(`no such text: ${t}`);
  editor.chain().focus().setTextSelection(at).run();
}, text);
/** Any CSS colour as [r, g, b] 0–255, resolved by the browser (color-mix() computes to color(srgb …)). */
const rgbOf = (page: Page, color: string) => page.evaluate((c) => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000";
  ctx.fillStyle = c;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!, a!];
}, color);
const css = (locator: Locator, property: string) => locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

/** NP-ED-08 · "numbered (continues numbering)". */
test("NP-ED-08: a numbered list continues its numbering", async ({ page }) => {
  await open(page, "<p>Intro</p>");
  await clickInto(page, "Intro"); // real focus, then the caret at the end of the text
  await caretAfter(page, "Intro");
  await page.keyboard.press("Enter");
  await page.keyboard.type("1. First step");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second step");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Third step");
  const list = page.locator(".tiptap ol");
  await expect(list).toHaveCount(1);
  await expect(list.locator("> li")).toHaveText(["First step", "Second step", "Third step"]);
  expect(await css(list, "list-style-type")).toBe("decimal");
  // The browser numbers them 1, 2, 3 (the marker's ordinal).
  const ordinals = () => list.locator("> li").evaluateAll((items) => items.map((li) => (li as HTMLLIElement).value || Array.prototype.indexOf.call(li.parentElement!.children, li) + ((li.parentElement as HTMLOListElement).start || 1)));
  expect(await ordinals()).toEqual([1, 2, 3]);
  // An item added in the middle renumbers what follows; it is still one list.
  await clickInto(page, "First step");
  await caretAfter(page, "First step");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Inserted step");
  await expect(list).toHaveCount(1);
  await expect(list.locator("> li")).toHaveText(["First step", "Inserted step", "Second step", "Third step"]);
  // A list started at another number continues from it, and the stored HTML keeps the start.
  await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.focus("end"));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // leave the list
  await page.keyboard.type("5. Fifth");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Sixth");
  const second = page.locator(".tiptap ol").nth(1);
  await expect(second.locator("> li")).toHaveText(["Fifth", "Sixth"]);
  expect(await second.evaluate((ol: HTMLOListElement) => ol.start)).toBe(5);
  expect(await html(page)).toMatch(/<ol start="5"><li><p>Fifth<\/p><\/li><li><p>Sixth<\/p><\/li><\/ol>/);
  await expect.poll(() => saved(page), { timeout: 8000 }).toContain('<ol start="5">');
});

/** NP-ED-08 · "to-do (checked style)". */
test("NP-ED-08: a checked to-do is struck through and muted; unchecked is not", async ({ page }) => {
  await open(page, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Ship it</p></li><li data-type="taskItem" data-checked="false"><p>Tell the team</p></li></ul><p>after</p>');
  const item = page.locator(".tiptap li[data-checked]").first();
  const other = page.locator(".tiptap li[data-checked]").nth(1);
  const body = item.locator("> div");
  const plain = await css(other.locator("> div"), "color");
  expect(await css(body, "text-decoration-line")).toBe("none");
  await item.locator("input[type=checkbox]").check();
  await expect(item).toHaveAttribute("data-checked", "true");
  expect(await css(body, "text-decoration-line")).toBe("line-through");
  const muted = await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--text-muted)"; document.querySelector(".tiptap")!.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
  expect(muted).not.toBe(plain);
  await expect.poll(() => css(body, "color")).toBe(muted); // (the colour eases in)
  expect(await css(body, "color")).toBe(await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--text-muted)"; document.querySelector(".tiptap")!.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }));
  // Not colour-only: the box itself is checked, and the neighbour is untouched.
  await expect(item.locator("input[type=checkbox]")).toBeChecked();
  expect(await css(other.locator("> div"), "text-decoration-line")).toBe("none");
  await expect.poll(() => saved(page), { timeout: 8000 }).toMatch(/data-checked="true"[^>]*>.*Ship it/);
  // Unchecking restores it.
  await item.locator("input[type=checkbox]").uncheck();
  expect(await css(body, "text-decoration-line")).toBe("none");
  await expect.poll(() => css(body, "color")).toBe(plain);
});

/** NP-ED-08 · "callout (icon + colour)". */
test("NP-ED-08: a callout shows its icon and takes a text colour from the block menu", async ({ page }) => {
  await open(page, '<p>Before</p><div data-type="callout" data-emoji="💡"><p>Mind the gap</p></div><p>After</p>');
  const callout = page.locator('.tiptap div[data-type="callout"]');
  await expect(callout).toHaveText("Mind the gap");
  // The icon is drawn from the stored emoji.
  expect(await callout.evaluate((el) => getComputedStyle(el, "::before").content)).toContain("💡");
  const plain = await css(callout.locator("p"), "color");
  await setBlockColor(page, "Mind the gap", "Red");
  await expect(callout).toHaveAttribute("data-block-color", "red");
  expect(await css(callout.locator("p"), "color")).not.toBe(plain);
  expect(await html(page)).toMatch(/<div data-block-color="red" data-emoji="💡" data-type="callout"><p>Mind the gap<\/p><\/div>/);
  await expect.poll(() => saved(page), { timeout: 8000 }).toContain('data-block-color="red"');
  // Reload from the stored HTML: icon and colour both survive.
  const stored = await saved(page);
  await open(page, stored);
  const again = page.locator('.tiptap div[data-type="callout"]');
  await expect(again).toHaveAttribute("data-block-color", "red");
  expect(await again.evaluate((el) => getComputedStyle(el, "::before").content)).toContain("💡");
});

/**
 * NP-ED-08 · callout colour, the BACKGROUND half.
 * Was a behaviour gap (PARITY-GAPS a.1 — seen failing 2026-10-03): the block menu stores
 * `data-block-color="blue_background"` on the callout, but the callout's own rule
 * (`.prose-editor div[data-type="callout"] { background: var(--glass-hover) }`, editor-blocks.css) is
 * more specific than `[data-block-color="…_background"]`, so the callout keeps its default fill.
 */
test("NP-ED-08: a callout background colour changes the callout's background", async ({ page }) => {
  await open(page, '<p>Before</p><div data-type="callout" data-emoji="💡"><p>Mind the gap</p></div><p>After</p>');
  const callout = page.locator('.tiptap div[data-type="callout"]');
  const plain = await css(callout, "background-color");
  await setBlockColor(page, "Mind the gap", "Blue background");
  await expect(callout).toHaveAttribute("data-block-color", "blue_background");
  expect(await css(callout, "background-color")).not.toBe(plain);
});

/** NP-ED-16 · "text and background colour per block … from the token palette". */
test("NP-ED-16: a block text colour comes from the token palette and is stored on the block", async ({ page }) => {
  await open(page);
  const block = page.locator(".tiptap p").filter({ hasText: "Bravo paragraph" });
  const plain = await css(block, "color");
  const menu = await blockMenu(page, "Bravo paragraph");
  await menu.getByRole("menuitem", { name: "Color" }).click();
  const colors = page.getByRole("menu", { name: "Color" });
  // Every choice is named (never colour alone): five text colours, five backgrounds, and Default.
  await expect(colors.getByRole("menuitemradio", { name: "Default", exact: true })).toHaveAttribute("aria-checked", "true");
  for (const name of ["Gray", "Blue", "Green", "Yellow", "Red"]) {
    await expect(colors.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
    await expect(colors.getByRole("menuitemradio", { name: `${name} background`, exact: true })).toBeVisible();
  }
  await colors.getByRole("menuitemradio", { name: "Green", exact: true }).click();
  await expect(block).toHaveAttribute("data-block-color", "green");
  const green = await css(block, "color");
  expect(green).not.toBe(plain);
  // It IS the palette token, not a hard-coded value.
  expect(green).toBe(await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--prism-color-green)"; document.querySelector(".tiptap")!.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }));
  // The text colour leaves the background alone; the menu now shows it as the current choice.
  expect(await css(block, "background-color")).toBe("rgba(0, 0, 0, 0)");
  await expect.poll(() => saved(page), { timeout: 8000 }).toContain('<p data-block-color="green">Bravo paragraph</p>');
  const reopened = await blockMenu(page, "Bravo paragraph");
  await reopened.getByRole("menuitem", { name: "Color" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Green", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Default", exact: true }).click();
  await expect(block).not.toHaveAttribute("data-block-color", /.+/);
  expect(await css(block, "color")).toBe(plain);
});

/** NP-ED-16 · "with dark-mode equivalents". */
test("NP-ED-16: every palette colour has its own dark-mode value", async ({ page }) => {
  const names = ["gray", "blue", "green", "yellow", "red"] as const;
  const blocks = names.map((n) => `<p data-block-color="${n}">${n} text</p><p data-block-color="${n}_background">${n} fill</p>`).join("") + "<p>plain text</p>";
  const read = async () => {
    const out: Record<string, string> = {};
    for (const n of names) {
      out[n] = await css(page.locator(`.tiptap p[data-block-color="${n}"]`), "color");
      out[`${n}_background`] = await css(page.locator(`.tiptap p[data-block-color="${n}_background"]`), "background-color");
    }
    out.plain = await css(page.locator(".tiptap p").filter({ hasText: "plain text" }), "color");
    out.canvas = await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--bg-base)"; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
    return out;
  };
  await open(page, blocks);
  const light = await read();
  await open(page, blocks, "dark&");
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  const dark = await read();
  expect(dark.canvas).not.toBe(light.canvas);
  expect(dark.plain).not.toBe(light.plain);
  for (const n of names) {
    // A different value in the dark theme …
    expect(dark[n], `${n} text`).not.toBe(light[n]);
    expect(dark[`${n}_background`], `${n} background`).not.toBe(light[`${n}_background`]);
    // … still a real fill, and (but for gray) still distinct from ordinary text.
    expect(dark[`${n}_background`], `${n} background`).not.toBe("rgba(0, 0, 0, 0)");
    if (n !== "gray") expect(dark[n], `${n} text`).not.toBe(dark.plain);
  }
  // The five text colours stay distinguishable from one another in both themes.
  expect(new Set(names.map((n) => light[n])).size).toBe(5);
  expect(new Set(names.map((n) => dark[n])).size).toBe(5);
  // Legible in both themes: WCAG contrast of each text colour on the page canvas.
  const luminance = ([r, g, b]: number[]) => {
    const [R, G, B] = [r!, g!, b!].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
  };
  const contrast = (a: number[], b: number[]) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const report: Record<string, number> = {};
  for (const [theme, values] of [["dark", dark], ["light", light]] as const) {
    const canvas = await rgbOf(page, values.canvas!);
    for (const n of names) report[`${theme} ${n}`] = Math.round(contrast(await rgbOf(page, values[n]!), canvas) * 100) / 100;
  }
  for (const [pair, ratio] of Object.entries(report)) expect(ratio, `${pair} text on the page canvas — all: ${JSON.stringify(report)}`).toBeGreaterThanOrEqual(4.5);
});

/** NP-ED-10 · "column resize". */
test("NP-ED-10: dragging a column border resizes the column and the width is saved", async ({ page }) => {
  await open(page, "<table><tbody><tr><th><p>Name</p></th><th><p>Owner</p></th><th><p>Due</p></th></tr><tr><td><p>Venue</p></td><td><p>Mira</p></td><td><p>Friday</p></td></tr></tbody></table><p>after</p>");
  const first = page.locator(".tiptap th").first();
  const second = page.locator(".tiptap th").nth(1);
  const before = (await first.boundingBox())!;
  const secondBefore = (await second.boundingBox())!;
  expect(await html(page)).not.toContain("colwidth");
  // Hover the border between the first two columns: the resize handle appears there.
  const edge = before.x + before.width - 1;
  const y = before.y + before.height / 2;
  await page.mouse.move(edge, y);
  await expect(page.locator(".tiptap .column-resize-handle").first()).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(edge + 40, y, { steps: 4 });
  await page.mouse.move(edge + 90, y, { steps: 4 });
  await page.mouse.up();
  // The first column is ~90 px wider (the columns to its right share what is left of the table).
  await expect.poll(async () => Math.round((await first.boundingBox())!.width - before.width)).toBeGreaterThanOrEqual(80);
  expect(Math.abs((await first.boundingBox())!.width - before.width - 90)).toBeLessThanOrEqual(12);
  expect((await second.boundingBox())!.x).toBeGreaterThan(secondBefore.x + 78);
  // Stored on every cell of that column, and nothing else changed.
  const now = await html(page);
  const widths = [...now.matchAll(/<t[hd] colspan="1" rowspan="1" colwidth="(\d+)"/g)].map((m) => Number(m[1]));
  expect(widths.length).toBeGreaterThanOrEqual(2);
  expect(new Set(widths.slice(0, 2)).size).toBe(1);
  expect(Math.abs(widths[0]! - (before.width + 90))).toBeLessThanOrEqual(12);
  for (const text of ["Name", "Owner", "Due", "Venue", "Mira", "Friday"]) expect(now).toContain(`<p>${text}</p>`);
  await expect.poll(() => saved(page), { timeout: 8000 }).toMatch(/colwidth="\d+"/);
  // Reopened from the stored HTML the column keeps its width.
  const stored = await saved(page);
  await open(page, stored);
  await expect.poll(async () => Math.round((await page.locator(".tiptap th").first().boundingBox())!.width)).toBeGreaterThanOrEqual(Math.round(before.width + 78));
  // One undo step in the session that made it (checked on a fresh drag).
  const cell = (await page.locator(".tiptap th").first().boundingBox())!;
  await page.mouse.move(cell.x + cell.width - 1, cell.y + cell.height / 2);
  await page.mouse.down();
  await page.mouse.move(cell.x + cell.width + 59, cell.y + cell.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await page.locator(".tiptap th").first().boundingBox())!.width - cell.width)).toBeGreaterThanOrEqual(50);
  await page.locator(".tiptap td").first().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => Math.abs(Math.round((await page.locator(".tiptap th").first().boundingBox())!.width - cell.width))).toBeLessThanOrEqual(4);
});

/** NP-ED-10: no resize handle where the document cannot be edited. */
test("NP-ED-10: a read-only table offers no column resize", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixture("<table><tbody><tr><th><p>Name</p></th><th><p>Owner</p></th></tr><tr><td><p>Venue</p></td><td><p>Mira</p></td></tr></tbody></table>", "readonly&"));
  await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "false");
  const first = (await page.locator(".tiptap th").first().boundingBox())!;
  await page.mouse.move(first.x + first.width - 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width + 80, first.y + first.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".tiptap .column-resize-handle")).toHaveCount(0);
  expect(Math.abs((await page.locator(".tiptap th").first().boundingBox())!.width - first.width)).toBeLessThanOrEqual(1);
});
