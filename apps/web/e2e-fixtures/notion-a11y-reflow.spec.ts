import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { SURFACES, openSurface, type Viewport } from "./a11y-surfaces";
import { reflow, textSpacingClips } from "./a11y-measure";

/**
 * NP-AX-05 "200% zoom no overflow". Browser zoom at 200 % halves the CSS viewport, so:
 *  - a 1440×900 window at 200 %  = 720×450 CSS px  (desktop surfaces, opened at 1440 then "zoomed");
 *  - WCAG 1.4.10 reflow          = 320 CSS px wide (phone surfaces, opened at 390 then narrowed).
 * Asserted: no horizontal page scroll (document, main, dialogs, panels), no control pushed off the side,
 * no control sitting under another control. Tables, boards and code may scroll inside their own scroller.
 * Then the WCAG 1.4.12 text-spacing override must not cut text off.
 * This is a viewport emulation, not a real browser zoom or iOS Dynamic Type (a device check).
 */
const REPORT = process.env.A11Y_REPORT;
const only = (process.env.A11Y_ONLY ?? "").split(",").filter(Boolean);
const ZOOMED: Record<Viewport, { width: number; height: number }> = { desktop: { width: 720, height: 450 }, phone: { width: 320, height: 568 } };

test.describe("200% zoom no overflow", () => {
  for (const s of SURFACES) for (const vp of ["desktop", "phone"] as Viewport[]) {
    if (s.only && s.only !== vp) continue;
    if (only.length && !only.includes(s.id)) continue;
    test(`${s.id} · ${vp}`, async ({ page }) => {
      await openSurface(page, s, vp, "light");
      await page.setViewportSize(ZOOMED[vp]);
      await page.waitForTimeout(350);
      const r = await reflow(page);
      const clips = await textSpacingClips(page);
      const after = await reflow(page);
      const report = { ...r, textSpacing: clips, pageScrollWithSpacing: after.pageScroll };
      if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(`${REPORT}/reflow_${s.id}_${vp}.json`, JSON.stringify(report, null, 1)); }
      expect(report).toEqual({ pageScroll: [], offscreen: [], overlap: [], textSpacing: [], pageScrollWithSpacing: [] });
    });
  }
});

/** The measures are not vacuous: a page that overflows, hides a control and clips spaced text is reported. */
test("the reflow measures catch overflow, off-screen controls and clipped text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.setContent(`<main style="width:500px"><button style="margin-left:300px;width:80px">Far</button>
    <div style="height:38px;overflow:hidden;font-family:sans-serif;font-size:14px;line-height:18px;width:210px"><span>Two words here and quite a few more words to wrap around</span></div></main>`);
  const r = await reflow(page);
  expect(r.pageScroll.length).toBeGreaterThan(0);
  expect(r.offscreen.join()).toContain("Far");
  expect((await textSpacingClips(page)).join()).toContain("Two words here");
});
