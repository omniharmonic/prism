import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { SURFACES, openSurface } from "./a11y-surfaces";
import { touchTargets } from "./a11y-measure";

/**
 * NP-AX-07 "touch targets ≥44px": every primary surface on a phone (390×844, touch, coarse pointer).
 * A control passes when its box is ≥ 44×44, or its effective hit area is (hit-slop), or it is ≥ 24×24
 * with no other control inside the 44×44 square centred on it (WCAG 2.5.8 spacing). See `a11y-measure.ts`.
 * Not measured: third-party widgets (Excalidraw, emoji picker, map), inline links in running text.
 */
test.use({ hasTouch: true, isMobile: true });
const REPORT = process.env.A11Y_REPORT;
/** Buttons the fixture pages add around the product UI (unstyled, class-less). */
const SCAFFOLD = ["Toggle panel", "Alex", "Morgan", "Switch workspace", "Switch to view-only", "Open search", "Query", "Prepend history", "Receive message", "Room A", "Room B", "Alex account", "Morgan account"];
/**
 * Known and NOT fixed: the database month grid. Seven day columns in 390 px are 51 px wide; a 44 px
 * "+" and 44 px page chips cannot fit a day cell. Every page is also reachable from the list/table
 * views and "New" (44 px) creates a page. Reported in A11Y-RESULTS.md as open.
 */
const KNOWN = [/^button\.db-cal-add/, /^button\.db-cal-item/];
const only = (process.env.A11Y_ONLY ?? "").split(",").filter(Boolean);

test.describe("touch targets ≥44px", () => {
  for (const s of SURFACES) {
    if (s.only === "desktop") continue;
    if (only.length && !only.includes(s.id)) continue;
    test(`${s.id} · phone`, async ({ page }) => {
      await openSurface(page, s, "phone", "light");
      const offenders = await touchTargets(page, SCAFFOLD);
      if (REPORT) { mkdirSync(REPORT, { recursive: true }); writeFileSync(`${REPORT}/touch_${s.id}.json`, JSON.stringify(offenders, null, 1)); }
      const known = offenders.filter((o) => KNOWN.some((k) => k.test(o.what)));
      const bad = offenders.filter((o) => !known.includes(o));
      if (known.length) test.info().annotations.push({ type: "known-small-targets", description: `${known.length} (month grid)` });
      expect(bad, "controls smaller than a touch target").toEqual([]);
    });
  }
});
