import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { SURFACES, openSurface, type Theme, type Viewport } from "./a11y-surfaces";

/**
 * NP-AX-03 "axe: no serious violations" + NP-AX-01 dark sweep: every primary surface, light AND dark,
 * 1440×900 AND 390×844. Zero serious/critical axe violations; in dark, no white panel.
 *
 * Not checked here, with reasons:
 *  - `document-title` / `html-has-lang`: fixture pages are scaffolds; the real `index.html` is asserted below.
 *  - `.excalidraw` and `.EmojiPickerReact`: third-party widgets we do not author (their own chrome).
 *  - ALLOWED below: one rule on one element each, with the reason. Nothing is disabled globally.
 */
const ALLOWED: Array<{ rule: string; element: RegExp; why: string }> = [
  // The slash and @ lists are driven from the editor with aria-activedescendant: focus never enters the
  // list, the active option is scrolled into view, and ↑/↓ reach every option. axe cannot see that and
  // asks for a tab stop inside the list, which would pull focus out of the text being typed.
  { rule: "scrollable-region-focusable", element: /^<div[^>]*role="listbox"[^>]*aria-label="(Insert block|Mention a person, page or date)"/, why: "activedescendant listbox" },
];
const REPORT = process.env.A11Y_REPORT;
const only = (process.env.A11Y_ONLY ?? "").split(",").filter(Boolean);

test("the app document has a language and a title", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(html).toMatch(/<html[^>]*\slang="en"/);
  expect(html).toMatch(/<title>[^<]+<\/title>/);
});

test.describe("axe: no serious violations", () => {
  for (const s of SURFACES) for (const vp of ["desktop", "phone"] as Viewport[]) for (const theme of ["light", "dark"] as Theme[]) {
    if (s.only && s.only !== vp) continue;
    if (only.length && !only.includes(s.id)) continue;
    test(`${s.id} · ${vp} · ${theme}`, async ({ page }) => {
      await openSurface(page, s, vp, theme);
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const result = await new AxeBuilder({ page }).disableRules(["document-title", "html-has-lang"]).exclude(".excalidraw").exclude(".EmojiPickerReact").analyze();
      const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ rule: v.id, nodes: v.nodes
          .filter((n) => !ALLOWED.some((a) => a.rule === v.id && a.element.test(n.html)))
          .map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 180), why: [...n.any, ...n.all, ...n.none].map((c) => c.message).join("; ").slice(0, 260) })) }))
        .filter((v) => v.nodes.length);
      // NP-AX-01: in dark, nothing larger than a chip paints a light background ("no white panels").
      const white = theme === "dark" ? await page.evaluate(() => {
        const out: string[] = [];
        const lum = (r: number, g: number, b: number) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          // `.page-toast` is an inverted snackbar by design (light pill on dark, dark pill on light; its text is AA on it).
          if (el.closest(".excalidraw, .EmojiPickerReact, .page-toast, img, video, canvas, svg, [data-a11y-light-ok]")) continue;
          const r = el.getBoundingClientRect();
          if (r.width * r.height < 12_000 || r.width < 60 || r.height < 28) continue;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) < 0.2) continue;
          const m = st.backgroundColor.match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/);
          if (!m || Number(m[4] ?? 1) < 0.6) continue;
          if (lum(+m[1], +m[2], +m[3]) > 0.6) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} ${st.backgroundColor} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out.slice(0, 12);
      }) : [];
      if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(`${REPORT}/${s.id}_${vp}_${theme}.json`, JSON.stringify({ bad, white }, null, 1)); }
      expect.soft(white, "light panels in dark mode").toEqual([]);
      expect(bad, "serious/critical axe violations").toEqual([]);
    });
  }
});
