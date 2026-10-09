import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { SURFACES, openSurface, type Theme } from "./a11y-surfaces";
import { borderContrast, controlBoundaryContrast, focusIndicatorContrast, type NonTextFinding } from "./a11y-measure";

/**
 * NP-AX-04 non-text contrast (WCAG 1.4.11, ≥ 3 : 1) — every primary surface at 1440×900, light and dark.
 *
 *  1. FOCUS INDICATORS — Tab through the surface; at every stop the outline / hard ring is measured against
 *     what it is drawn on. This is a gate: none may be below 3 : 1. One kind is recorded instead of gated:
 *     a TEXT-ENTRY field whose ring is a soft glow (the two composers) — its caret shows focus, and its
 *     focused BORDER is asserted at ≥ 3 : 1 in the last tests of this file.
 *  2. CONTROL BOUNDARIES — every visible text field, select, textarea and custom checkbox / switch / radio: the
 *     best of its border and its fill against what is behind it (also the box a wrapper draws around a seamless
 *     field, a checkbox's drawn box, a segmented group's box). A GATE since decision c.17: none below 3 : 1, none
 *     left unjudged. Fields draw their box with the shared hairline, which `tokens.css` re-points to
 *     `--control-border` on the control itself ("FORM CONTROL BOUNDARIES"); a control over a blur or a gradient,
 *     where no ratio can be computed, passes only with a visible border in exactly that token.
 *
 * Text contrast is the axe sweep's (`notion-a11y-axe.spec.ts`) and the token-pair test's. Not measured:
 * anything drawn over a gradient, an image or a blur; icons; text over cover images.
 */
const REPORT = process.env.A11Y_REPORT;
const only = (process.env.A11Y_ONLY ?? "").split(",").filter(Boolean);
const MAX_STOPS = 40;

for (const theme of ["light", "dark"] as Theme[]) {
  test.describe(`non-text contrast · ${theme}`, () => {
    for (const s of SURFACES) {
      if (s.only === "phone") continue;
      if (only.length && !only.includes(s.id)) continue;
      test(`${s.id} · ${theme}`, async ({ page }) => {
        await openSurface(page, s, "desktop", theme);
        // 2. boundaries first (before focus moves anything)
        const boundaries = await controlBoundaryContrast(page);
        // 1. focus rings
        const rings: Array<NonTextFinding & { how: string }> = [];
        /** Text-entry fields whose ring is below 3 : 1 (caret + border show focus). */
        const softFields: Array<NonTextFinding & { how: string }> = [];
        const unmeasured: string[] = [];
        const seen = new Set<string>();
        let measured = 0;
        for (let i = 0; i < MAX_STOPS; i++) {
          await page.keyboard.press("Tab");
          const f = await focusIndicatorContrast(page);
          if (f.what === "body") continue;
          if (seen.has(f.what)) { if (seen.size > 2 && i > seen.size + 3) break; continue; }
          seen.add(f.what);
          if (f.ratio === null) { unmeasured.push(`${f.what} — ${f.how}`); continue; }
          measured++;
          if (f.ratio < 3) (f.caret ? softFields : rings).push({ what: f.what, ratio: f.ratio, colors: f.colors, how: f.how });
        }
        if (REPORT) {
          mkdirSync(REPORT, { recursive: true });
          writeFileSync(`${REPORT}/contrast_${s.id}_${theme}.json`, JSON.stringify({ focus: { low: rings, softFields, measured, unmeasured }, boundaries }, null, 1));
        }
        test.info().annotations.push({ type: "non-text-contrast", description: `focus: ${measured} measured, ${rings.length} low, ${softFields.length} soft-ring text fields, ${unmeasured.length} not judged · boundaries: ${boundaries.ok} ok, ${boundaries.low.length} low, ${boundaries.unmeasured.length} not judged` });
        expect(rings, "focus indicators below 3 : 1").toEqual([]);
        expect(boundaries.low, "form control boundaries below 3 : 1 (tokens.css --control-border)").toEqual([]);
        expect(boundaries.unmeasured, "form controls whose boundary could not be judged").toEqual([]);
      });
    }
  });
}

// The two composers show focus with their BORDER (a soft glow around it is decoration): it must reach 3 : 1.
for (const theme of ["light", "dark"] as Theme[]) {
  for (const [id, field, box] of [["message-thread", "Message", ".prism-compose-surface"], ["agent-chat-empty", "Message the agent", ".prism-agent-compose-surface"]] as const) {
    test(`${id} · ${theme}: the focused composer's border is at least 3 : 1`, async ({ page }) => {
      await openSurface(page, SURFACES.find((s) => s.id === id)!, "desktop", theme);
      // Some surfaces open with the composer focused: measure "at rest" with focus taken away.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(300);
      const rest = await borderContrast(page, box);
      await page.getByRole("textbox", { name: field, exact: true }).focus();
      await page.waitForTimeout(300); // the border colour transitions
      const focused = await borderContrast(page, box);
      expect(focused.ratio, `focused border ${focused.colors} (at rest ${rest.colors})`).not.toBeNull();
      expect(focused.ratio!, `focused border ${focused.colors}`).toBeGreaterThanOrEqual(3);
      expect(focused.ratio!).toBeGreaterThan(rest.ratio ?? 0);
    });
  }
}
