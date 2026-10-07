import { test, expect, type Page } from "@playwright/test";
import { SURFACES, openSurface, type Viewport } from "./a11y-surfaces";

/** Wave 2E · NP-AX-06: 120–180 ms surfaces; none under reduced motion (OS or in-app). */
const ms = (value: string) => Math.max(...value.split(",").map((v) => (v.trim().endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000)));
async function paletteDuration(page: Page): Promise<number> {
  await page.keyboard.press("ControlOrMeta+k");
  const sheet = page.locator(".prism-search-sheet");
  await expect(sheet).toBeVisible();
  const value = await sheet.evaluate((node) => getComputedStyle(node).animationDuration);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  return ms(value);
}

test("reduced motion disables transitions", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const normal = await paletteDuration(page);
  expect(normal).toBeGreaterThanOrEqual(120);
  expect(normal).toBeLessThanOrEqual(180);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await paletteDuration(page)).toBeLessThanOrEqual(1);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await paletteDuration(page)).toBeGreaterThanOrEqual(120);
  // The in-app setting does the same, persists on this device and survives reload.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
  await page.keyboard.press("Escape");
  expect(await paletteDuration(page)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);
});

/**
 * NP-AX-06, Pass 2: menus, sheets, peeks, dialogs and toasts — measured, not only the search sheet.
 * For every surface: the popup's entrance (animation or transition on its root and first two levels)
 * lasts at most 180 ms, and both the OS preference and the in-app setting bring it — and every
 * animation running anywhere on the page — down to nothing (≤ 1 ms).
 */

const MOTION: Array<{ id: string; vp: Viewport; root: string }> = [
  { id: "page-actions-menu", vp: "desktop", root: ".page-menu" },
  { id: "tree-row-menu", vp: "desktop", root: ".page-menu" },
  { id: "block-menu", vp: "desktop", root: '[role="menu"][aria-label="Block actions"]' },
  { id: "slash-menu", vp: "desktop", root: '[role="listbox"][aria-label="Insert block"]' },
  { id: "selection-toolbar", vp: "desktop", root: ".document-selection-actions, .cd-bubble" },
  { id: "db-filter", vp: "desktop", root: ".db-popover" },
  { id: "db-row-peek-side", vp: "desktop", root: ".db-peek" },
  { id: "db-row-peek-center", vp: "desktop", root: ".db-peek" },
  { id: "share-people", vp: "desktop", root: "dialog[open]" },
  { id: "sidebar-peek", vp: "desktop", root: ".sidebar-peek" },
  { id: "command-bar", vp: "desktop", root: ".prism-search-sheet" },
  { id: "trash-and-toast", vp: "desktop", root: '[role="dialog"][aria-label="Trash"], .page-toast' },
  { id: "shortcut-sheet", vp: "desktop", root: '[role="dialog"][aria-label="Keyboard shortcuts"]' },
  { id: "account-menu", vp: "desktop", root: '[role="menu"][aria-label="Account"]' },
  { id: "phone-more-sheet", vp: "phone", root: "dialog.prism-mobile-sheet" },
  { id: "tree", vp: "phone", root: ".workspace-mobile-drawer" },
  { id: "page-actions-menu", vp: "phone", root: "dialog[open], .sheet-panel" },
  { id: "db-filter", vp: "phone", root: ".db-popover, dialog[open], .sheet-panel" },
  // Every other phone layer (w13): full-screen search, the agent drawer, dialogs laid out as sheets.
  { id: "command-bar", vp: "phone", root: ".prism-search-sheet" },
  { id: "agent-companion-phone", vp: "phone", root: ".workspace-mobile-drawer" },
  { id: "new-page-chooser", vp: "phone", root: "dialog[open]" },
  { id: "new-page-chooser", vp: "desktop", root: "dialog[open]" },
  { id: "share-people", vp: "phone", root: "dialog[open]" },
  { id: "tree-row-menu", vp: "phone", root: "dialog[open], .page-menu" },
  { id: "shortcut-sheet", vp: "phone", root: '[role="dialog"][aria-label="Keyboard shortcuts"]' },
  { id: "settings-appearance", vp: "phone", root: 'dialog[aria-label="Settings"]' },
  { id: "settings-appearance", vp: "desktop", root: 'dialog[aria-label="Settings"]' },
  { id: "import-dialog", vp: "phone", root: 'dialog[open], [role="dialog"]' },
];
const durations = (page: Page, root: string) => page.evaluate((root) => {
  const toMs = (v: string) => Math.max(0, ...v.split(",").map((x) => (x.trim().endsWith("ms") ? parseFloat(x) : parseFloat(x) * 1000)).filter((n) => !Number.isNaN(n)));
  const roots = Array.from(document.querySelectorAll<HTMLElement>(root)).filter((el) => el.getClientRects().length);
  let entrance = 0;
  for (const r of roots) for (const el of [r, ...Array.from(r.children), ...Array.from(r.children).flatMap((c) => Array.from(c.children))] as HTMLElement[]) {
    const st = getComputedStyle(el);
    if (st.animationName !== "none" && st.animationIterationCount !== "infinite") entrance = Math.max(entrance, toMs(st.animationDuration));
    // A transition on opacity/transform/visibility is how a popup enters or leaves; colour fades are not motion.
    const props = st.transitionProperty.split(",").map((p) => p.trim());
    const times = st.transitionDuration.split(",").map((t) => toMs(t));
    props.forEach((p, i) => { if (/^(all|opacity|transform|translate|scale|top|left|right|bottom|height|width|max-height|visibility)$/.test(p)) entrance = Math.max(entrance, times[i % times.length] ?? 0); });
  }
  // Anything still animating anywhere (spinners included).
  const running = document.getAnimations().filter((a) => a.playState === "running").map((a) => Number((a.effect?.getComputedTiming().duration as number) ?? 0)).filter((d) => d > 1);
  return { found: roots.length, entrance, running: running.length ? Math.max(...running) : 0 };
}, root);

test.describe("reduced motion disables transitions: menus, sheets, peeks", () => {
  for (const m of MOTION) test(`${m.id} · ${m.vp}`, async ({ page }) => {
    const s = SURFACES.find((x) => x.id === m.id)!;
    await openSurface(page, s, m.vp, "light");
    const normal = await durations(page, m.root);
    expect(normal.found, `${m.root} is on screen`).toBeGreaterThan(0);
    expect(normal.entrance, "entrance at most 180 ms").toBeLessThanOrEqual(180);
    // …and it exists: a popup that appears at once (0 ms) is as much a miss as a slow one.
    expect(normal.entrance, "an entrance of at least 100 ms").toBeGreaterThanOrEqual(100);
    test.info().annotations.push({ type: "entrance-ms", description: String(normal.entrance) });
    // In-app setting.
    // Toggling the setting can itself restart an entrance; let stragglers finish (a spinner would not).
    await page.evaluate(() => document.documentElement.classList.add("reduce-motion"));
    await page.waitForTimeout(450);
    const inApp = await durations(page, m.root);
    expect(inApp.entrance, "in-app Reduce motion").toBeLessThanOrEqual(1);
    expect(inApp.running, "in-app Reduce motion: nothing keeps animating").toBeLessThanOrEqual(1);
    await page.evaluate(() => document.documentElement.classList.remove("reduce-motion"));
    // OS preference.
    await page.waitForTimeout(450);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(450);
    const os = await durations(page, m.root);
    expect(os.entrance, "prefers-reduced-motion").toBeLessThanOrEqual(1);
    expect(os.running, "prefers-reduced-motion: nothing keeps animating").toBeLessThanOrEqual(1);
  });
});
