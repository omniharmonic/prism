import { test, expect, type Page, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AGENT_COLOR, CARET_COLORS, colorFor } from "../../../packages/core/src/lib/collab/colors";

/**
 * Slice K.
 *  NP-ED-08 / NP-ED-16 — a callout's BACKGROUND colour is drawn (it was stored but outranked by the
 *  callout's own fill): plain editor, live editor, published page and print, light and dark, with
 *  the text at ≥ 4.5 : 1 on every tint.
 *  NP-CO-10 — an agent's marks never share a person's caret colour: a reserved colour that is not
 *  in the human palette, drawn dashed, beside the "(agent)" author label.
 */
const COLOURS = ["gray", "blue", "green", "yellow", "red"] as const;
const callouts = `<div data-type="callout" data-emoji="💡"><p>Default callout text</p></div>` + COLOURS.map((c) => `<div data-type="callout" data-emoji="💡" data-block-color="${c}_background"><p>${c} callout text</p></div>`).join("");
const q = (html: string, extra = "") => `?${extra}content=${encodeURIComponent(html)}`;

/** Resolve a CSS colour to [r,g,b,a] (color-mix() and color(srgb …) included), in the page. */
const RESOLVE = `(c) => { const k = document.createElement("canvas"); k.width = k.height = 1; const x = k.getContext("2d", { willReadFrequently: true }); x.clearRect(0, 0, 1, 1); x.fillStyle = "#000"; x.fillStyle = c; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; }`;
/** The contrast of an element's text against everything painted behind it (semi-transparent fills composited down to the page). */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node, resolveSource) => {
    const resolve = new Function(`return (${resolveSource})`)() as (c: string) => [number, number, number, number];
    const layers: Array<[number, number, number, number]> = [];
    for (let at: Element | null = node; at; at = at.parentElement) layers.push(resolve(getComputedStyle(at).backgroundColor));
    let bg: [number, number, number] = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const [fr, fg, fb, fa] = resolve(getComputedStyle(node).color);
    const fgc: [number, number, number] = [fr * fa + bg[0] * (1 - fa), fg * fa + bg[1] * (1 - fa), fb * fa + bg[2] * (1 - fa)];
    const lum = ([r, g, b]: [number, number, number]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const [hi, lo] = [lum(fgc), lum(bg)].sort((a, b) => b - a) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  }, RESOLVE);
}
const fill = (el: Locator) => el.evaluate((node, resolveSource) => (new Function(`return (${resolveSource})`)() as (c: string) => number[])(getComputedStyle(node).backgroundColor).join(","), RESOLVE);

async function expectCalloutColours(_page: Page, scope: Locator) {
  const plain = scope.locator('div[data-type="callout"]:not([data-block-color])');
  await expect(plain).toBeVisible();
  const base = await fill(plain);
  const seen = new Set([base]);
  for (const c of COLOURS) {
    const callout = scope.locator(`div[data-type="callout"][data-block-color="${c}_background"]`);
    await expect(callout).toBeVisible();
    const colour = await fill(callout);
    expect(colour, `${c} background is drawn`).not.toBe(base);
    expect(seen.has(colour), `${c} differs from the other tints`).toBe(false);
    seen.add(colour);
    // The callout keeps its own box (padding for the icon), and its text stays readable.
    expect(await callout.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThan(30);
    expect(await contrast(callout.locator("p")), `${c} callout text contrast`).toBeGreaterThanOrEqual(4.5);
  }
  expect(await contrast(plain.locator("p"))).toBeGreaterThanOrEqual(4.5);
}
async function expectNoContrastViolation(page: Page, selector: string) {
  const result = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze();
  expect(result.violations.flatMap((v) => v.nodes.map((n) => n.html))).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`NP-ED-08: every callout background colour is drawn — plain editor, ${theme}`, async ({ page }) => {
    await page.goto(`/e2e-fixtures/editor-blocks.html${q(callouts, theme === "dark" ? "dark&" : "")}`);
    const editor = page.locator(".tiptap");
    await expectCalloutColours(page, editor);
    await expectNoContrastViolation(page, '.tiptap div[data-type="callout"]');
  });

  test(`NP-ED-08: every callout background colour is drawn — live editor, ${theme}`, async ({ page }) => {
    await page.goto(`/e2e-fixtures/parity4-suggest.html${q(callouts, theme === "dark" ? "dark&" : "")}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("Default callout text");
    await expectCalloutColours(page, editor);
    await expectNoContrastViolation(page, '.ProseMirror div[data-type="callout"]');
  });
}

test("NP-ED-08: a published page draws the callout background colours", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/e2e-fixtures/publication.html?html=${encodeURIComponent(callouts)}`);
  const article = page.locator("article.prose-editor");
  await expect(article).toContainText("Default callout text");
  await expectCalloutColours(page, article);
  // Nothing was styled inline to get there.
  expect(await article.locator('div[data-type="callout"][style]').count()).toBe(0);
});

test("NP-ED-08: print keeps the callout background colours, dark text on a light tint in both themes", async ({ page }) => {
  for (const extra of ["", "dark&"]) {
    await page.goto(`/e2e-fixtures/editor-blocks.html${q(callouts, extra)}`);
    await expect(page.locator(".tiptap")).toContainText("Default callout text");
    await page.emulateMedia({ media: "print" });
    await expectCalloutColours(page, page.locator(".tiptap"));
    await page.emulateMedia({ media: "screen" });
  }
});

// ── NP-CO-10 ───────────────────────────────────────────────────────────────
test("NP-CO-10: the agent colour is reserved — no person can be given it", () => {
  expect(CARET_COLORS).not.toContain(AGENT_COLOR);
  expect(new Set(CARET_COLORS).size).toBe(CARET_COLORS.length);
  for (let i = 0; i < 5000; i++) {
    const colour = colorFor(`person-${i}@example.test`);
    expect(CARET_COLORS).toContain(colour);
    expect(colour).not.toBe(AGENT_COLOR);
  }
});

const mark = (kind: "insert" | "delete", user: string, colour: string, text: string, id: string) =>
  `<span data-suggestion="${kind}" data-suggestion-id="${id}" data-user="${user}" data-color="${colour}">${text}</span>`;
const page1 =
  `<p>Human: ${mark("insert", "Eve", CARET_COLORS[1]!, "human words", "h1")}.</p>` +
  `<p>Agent: ${mark("delete", "Olive Owner (agent)", AGENT_COLOR, "old agent words", "a1")}${mark("insert", "Olive Owner (agent)", AGENT_COLOR, "new agent words", "a1")}.</p>` +
  // Written before the reserved colour existed: the account's caret colour on an agent's mark.
  `<p>Earlier agent: ${mark("insert", "Olive Owner (agent)", CARET_COLORS[1]!, "legacy agent words", "a0")}.</p>`;

for (const theme of ["light", "dark"] as const) {
  test(`NP-CO-10: an agent's marks are dashed, in a colour no caret has — ${theme}`, async ({ page }) => {
    await page.goto(`/e2e-fixtures/parity4-suggest.html${q(page1, theme === "dark" ? "dark&" : "")}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("new agent words");
    const line = (el: Locator) => el.evaluate((node, resolveSource) => {
      const s = getComputedStyle(node);
      return { style: s.textDecorationStyle, colour: (new Function(`return (${resolveSource})`)() as (c: string) => number[])(s.textDecorationColor).slice(0, 3).join(",") };
    }, RESOLVE);
    const carets = await page.evaluate(([list, resolveSource]) => (list as string[]).map((c) => (new Function(`return (${resolveSource})`)() as (c: string) => number[])(c).slice(0, 3).join(",")), [CARET_COLORS, RESOLVE] as const);
    const human = await line(editor.locator('[data-suggestion="insert"]', { hasText: "human words" }));
    expect(human.style).toBe("solid");
    const agentLines = [];
    for (const text of ["old agent words", "new agent words", "legacy agent words"]) {
      const el = editor.locator("[data-suggestion]", { hasText: text });
      const agent = await line(el);
      // The non-colour cue, and a colour that is no person's.
      expect(agent.style, text).toBe("dashed");
      expect(carets, text).not.toContain(agent.colour);
      expect(agent.colour, text).not.toBe(human.colour);
      await expect(el).toHaveAttribute("data-user", /\(agent\)$/);
      agentLines.push(agent.colour);
    }
    // Consistent: one agent colour, whatever the stored mark carried.
    expect(new Set(agentLines).size).toBe(1);
    // The words themselves keep reading contrast.
    await expectNoContrastViolation(page, ".ProseMirror [data-suggestion]");
    // The review queue names the agent as such.
    const review = page.locator("details.prism-suggestion-review");
    await review.locator("summary").click();
    await review.getByRole("button", { name: "Next suggested change" }).click();
    await expect(review.getByText("Olive Owner (agent)")).toBeVisible();
    await expect(review.getByText("Agent suggestion")).toBeVisible();
  });
}
