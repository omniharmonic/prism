import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./browser-compat";
import { focusIndicator } from "./a11y-measure";
import { SURFACES, openSurface, type Viewport } from "./a11y-surfaces";

/**
 * Parity pass 4 — accessibility clauses that were on main without an assertion:
 *   NP-AX-02  history by keyboard (the journeys in notion-a11y-keyboard only open and close the viewer)
 *   NP-AX-04  the named "contrast tokens AA" test (token pairs, both themes)
 *   NP-AX-06  the LOWER bound of "120–180 ms" (notion-a11y asserts only ≤ 180)
 */

// ── NP-AX-02 ────────────────────────────────────────────────────────────────────────────────
async function tabTo(page: Page, target: Locator, where: string, max = 80) {
  for (let i = 0; i < max; i++) {
    if (await target.first().evaluate((el) => el === document.activeElement).catch(() => false)) {
      const f = await focusIndicator(page);
      expect(f.visible, `${where}: focus indicator (${f.what} — ${f.detail})`).toBe(true);
      return;
    }
    await page.keyboard.press("Tab");
  }
  const at = await focusIndicator(page);
  throw new Error(`${where}: not reachable with Tab in ${max} presses (focus ended on ${at.what})`);
}

test("NP-AX-02: history by keyboard only — open a version, switch the view, start and cancel a restore, Esc returns focus", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-history.html");
  const row = page.locator(".prism-context-history button.prism-context-history-row").first();
  await expect(row).toBeVisible();
  await tabTo(page, row, "history row", 250);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // The view switch is reachable and works from the keyboard.
  const full = dialog.getByRole("button", { name: "Full text", exact: true });
  await tabTo(page, full, "Full text");
  await page.keyboard.press("Enter");
  await expect(full).toHaveAttribute("aria-pressed", "true");

  // Restore is two steps, both from the keyboard; Cancel leaves the page as it was.
  const restore = dialog.getByRole("button", { name: "Restore this version" });
  await tabTo(page, restore, "Restore this version");
  await page.keyboard.press("Enter");
  const confirm = dialog.getByRole("button", { name: "Confirm restore" });
  await expect(confirm).toBeVisible();
  // Focus is still inside the dialog (no drop to <body>), and Cancel is reachable.
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await tabTo(page, dialog.getByRole("button", { name: "Cancel", exact: true }), "Cancel");
  await page.keyboard.press("Enter");
  await expect(restore).toBeVisible();
  await expect(confirm).toHaveCount(0);

  // No trap: Tab keeps cycling inside the modal; Esc closes it and focus is back on the row.
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
});

// ── NP-AX-04 ────────────────────────────────────────────────────────────────────────────────
type Pair = { fg: string; bg: string; over?: string; min: number };
const SURFACE_TOKENS = ["--bg-surface", "--bg-elevated", "--bg-sidebar"];
const FILL_TOKENS = ["--glass-hover", "--glass-active", "--surface-hover", "--surface-selected"];
const PAIRS: Pair[] = [
  // Reading text on every surface and on the hover / selected fills (fills composited over the page).
  ...["--text-primary", "--text-secondary", "--text-muted"].flatMap((fg) => [
    ...SURFACE_TOKENS.map((bg) => ({ fg, bg, min: 4.5 })),
    ...FILL_TOKENS.map((bg) => ({ fg, bg, over: "--bg-surface", min: 4.5 })),
  ]),
  // Accent and status colours used AS TEXT on the page surfaces.
  ...["--text-accent", "--color-accent", "--color-danger", "--color-success", "--color-warning"].flatMap((fg) => SURFACE_TOKENS.map((bg) => ({ fg, bg, min: 4.5 }))),
  // Filled buttons.
  { fg: "--action-fg", bg: "--action-bg", min: 4.5 },
  { fg: "#ffffff", bg: "--danger-bg", min: 4.5 },
];

const measure = (page: Page, pairs: Pair[]) => page.evaluate((pairs) => {
  const probe = document.createElement("div");
  // The app fades colours (0.3 s on every element): without this the probe would report a colour
  // half-way from the previous one.
  probe.style.transition = "none";
  document.body.appendChild(probe);
  const rgba = (value: string): [number, number, number, number] => {
    probe.style.color = "";
    probe.style.color = value.startsWith("--") ? `var(${value})` : value;
    const m = getComputedStyle(probe).color.match(/[\d.]+/g)!.map(Number);
    return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
  };
  const over = (top: number[], under: number[]) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)); };
  const lum = (c: number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const out = pairs.map((p) => {
    const base = p.over ? rgba(p.over) : [255, 255, 255, 1];
    const bg = over(rgba(p.bg), base);
    const fg = over(rgba(p.fg), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { ...p, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 };
  });
  probe.remove();
  return out;
}, pairs);

for (const theme of ["light", "dark"] as const) {
  test(`NP-AX-04: contrast tokens AA — ${theme}`, async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    await expect(page.locator(".tiptap[contenteditable=true]").first()).toBeVisible();
    await page.evaluate((t) => { const c = document.documentElement.classList; c.toggle("light", t === "light"); c.toggle("dark", t === "dark"); }, theme);
    const rows = await measure(page, PAIRS);
    test.info().annotations.push({ type: "contrast", description: rows.map((r) => `${r.fg} on ${r.bg}: ${r.ratio}`).join("; ") });
    const failing = rows.filter((r) => r.ratio < r.min).map((r) => `${r.fg} on ${r.bg}${r.over ? ` (over ${r.over})` : ""}: ${r.ratio} < ${r.min}`);
    expect(failing, `token pairs under WCAG AA in ${theme}`).toEqual([]);
  });
}

/** NP-AX-04 "colour is never the only signal": a suggestion is struck / underlined, not only tinted. */
test("NP-AX-04: suggestion marks carry a strike and an underline, not colour alone", async ({ page }) => {
  await page.goto("/e2e-fixtures/suggestion-review.html");
  const doc = page.locator(".ProseMirror").first();
  await expect(doc).toBeVisible();
  const lines = (selector: string) => doc.locator(selector).evaluateAll((els) => els.map((el) => getComputedStyle(el).textDecorationLine));
  const del = await lines('span[data-suggestion="delete"]');
  const ins = await lines('span[data-suggestion="insert"]');
  expect(del.length, "a suggested deletion is in the fixture").toBeGreaterThan(0);
  expect(ins.length, "a suggested insertion is in the fixture").toBeGreaterThan(0);
  for (const d of del) expect(d).toContain("line-through");
  for (const i of ins) expect(i).toContain("underline");
});

// ── NP-AX-06 ────────────────────────────────────────────────────────────────────────────────
const entrance = (page: Page, root: string) => page.evaluate((root) => {
  const toMs = (v: string) => Math.max(0, ...v.split(",").map((x) => (x.trim().endsWith("ms") ? parseFloat(x) : parseFloat(x) * 1000)).filter((n) => !Number.isNaN(n)));
  const roots = Array.from(document.querySelectorAll<HTMLElement>(root)).filter((el) => el.getClientRects().length);
  let ms = 0;
  for (const r of roots) for (const el of [r, ...Array.from(r.children), ...Array.from(r.children).flatMap((c) => Array.from(c.children))] as HTMLElement[]) {
    const st = getComputedStyle(el);
    if (st.animationName !== "none" && st.animationIterationCount !== "infinite") ms = Math.max(ms, toMs(st.animationDuration));
    const props = st.transitionProperty.split(",").map((p) => p.trim());
    const times = st.transitionDuration.split(",").map((t) => toMs(t));
    props.forEach((p, i) => { if (/^(all|opacity|transform|translate|scale)$/.test(p)) ms = Math.max(ms, times[i % times.length] ?? 0); });
  }
  return { found: roots.length, ms };
}, root);

/** The phone sheets (the "More" sheet and the page-actions sheet, both `BottomSheet`) were a gap until w13: 0 ms. */
const RANGE: Array<{ kind: string; id: string; vp: Viewport; root: string }> = [
  { kind: "menu", id: "page-actions-menu", vp: "desktop", root: ".page-menu" },
  { kind: "peek", id: "db-row-peek-side", vp: "desktop", root: ".db-peek" },
  { kind: "sheet", id: "page-actions-menu", vp: "phone", root: "dialog[open], .sheet-panel" },
  { kind: "sheet", id: "phone-more-sheet", vp: "phone", root: "dialog.prism-mobile-sheet" },
];
for (const m of RANGE) {
  test(`NP-AX-06: a ${m.kind} enters in 120–180 ms (${m.id} · ${m.vp})`, async ({ page }) => {
    const s = SURFACES.find((x) => x.id === m.id)!;
    await openSurface(page, s, m.vp, "light");
    const e = await entrance(page, m.root);
    test.info().annotations.push({ type: "entrance-ms", description: String(e.ms) });
    expect(e.found, `${m.root} is on screen`).toBeGreaterThan(0);
    expect(e.ms, "an entrance exists and is at least 120 ms").toBeGreaterThanOrEqual(120);
    expect(e.ms, "and at most 180 ms").toBeLessThanOrEqual(180);
  });
}
