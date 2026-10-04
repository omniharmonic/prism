/**
 * Acceptance screenshots (checklist §4 step 4) — NOT part of the default run.
 *
 * Without PRISM_SHOTS=1 this file defines no tests, so the suite's test count is unchanged.
 * With it, every shot in `acceptance-shots.ts` is captured in light and dark at 1440×900 and/or
 * 390×844 into `apps/web/acceptance-shots/<row-id>__<slug>__<theme>__<viewport>.png`.
 *
 *   PRISM_SHOTS=1 E2E_PORT=<port> npx playwright test -c playwright.config.ts \
 *     e2e-fixtures/acceptance-shots.spec.ts --workers=1 --reporter=line -g "2.5 Databases"
 *
 * Deterministic: fixed clock, reduced motion, animations and carets off, fonts awaited, no
 * request leaves 127.0.0.1. Then: `node --import tsx scripts/build-acceptance-gallery.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { SHOTS, type Shot, type Theme, type Viewport } from "./acceptance-shots";
import { connect, startRealServer, type RealServer } from "./real-server";

const ON = !!process.env.PRISM_SHOTS;
const SIZES: Record<Viewport, { width: number; height: number }> = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const THEMES: Theme[] = ["light", "dark"];
/** Monday 5 October 2026, 15:00 local: fixtures seed "today / yesterday / tomorrow" from the clock. */
const NOW = new Date(2026, 9, 5, 15, 0, 0);

let server: RealServer | undefined;

async function newContext(browser: Browser, baseURL: string, shot: Shot, vp: Viewport, theme: Theme): Promise<BrowserContext> {
  const touch = vp === "phone" && shot.touch !== false;
  const context = await browser.newContext({
    baseURL, viewport: SIZES[vp], deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: theme,
    serviceWorkers: "block", hasTouch: touch, isMobile: touch, locale: "en-US",
  });
  // No network: only the fixture server (and the real-server fixture, also loopback) is reachable.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.protocol === "data:" || url.protocol === "blob:" ? route.fallback() : route.abort();
  });
  const settings = { theme, ...(shot.settings ?? {}) };
  await context.addInitScript(({ settings, theme }) => {
    try {
      const stored = JSON.parse(localStorage.getItem("prism-settings") ?? "null") as { state?: Record<string, unknown>; version?: number } | null;
      localStorage.setItem("prism-settings", JSON.stringify({ state: { ...(stored?.state ?? {}), ...settings }, version: stored?.version ?? 0 }));
    } catch { /* storage unavailable: the class below still themes the page */ }
    const apply = () => { const root = document.documentElement; root.classList.toggle("light", theme === "light"); root.classList.toggle("dark", theme === "dark"); };
    apply();
    document.addEventListener("DOMContentLoaded", apply);
  }, { settings, theme });
  return context;
}

async function applyTheme(page: Page, theme: Theme) {
  await page.evaluate((theme) => { const root = document.documentElement; root.classList.toggle("light", theme === "light"); root.classList.toggle("dark", theme === "dark"); }, theme);
}

async function settle(page: Page) {
  await page.addStyleTag({ content: "*, *::before, *::after { caret-color: transparent !important; }" }).catch(() => {});
  await page.evaluate(async () => {
    await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  });
  await page.waitForTimeout(350);
}

/** NP-CO-11: two people on one live document, against the real-server fixture. */
async function presence(browser: Browser, baseURL: string, page: Page, context: BrowserContext, phone: boolean): Promise<() => Promise<void>> {
  server ??= await startRealServer(baseURL);
  await connect(page, context, server, "owner");
  await page.goto("/e2e-fixtures/collab-route.html?target=plan");
  await page.getByText(/Live · /).first().waitFor({ timeout: 30_000 });
  const other = await browser.newContext({ baseURL, viewport: SIZES.desktop });
  const eve = await other.newPage();
  await connect(eve, other, server, "eve");
  await eve.goto("/e2e-fixtures/collab-route.html?target=plan");
  await eve.getByText(/Live · /).first().waitFor({ timeout: 30_000 });
  await eve.getByText("Second paragraph here.").click();
  const group = page.locator('.document-page-header [data-slot="presence"]').getByRole("group", { name: /on this page/ });
  await group.first().waitFor({ timeout: 20_000 });
  if (phone) {
    await group.getByRole("button", { name: /person on this page/ }).click();
    await page.getByRole("list", { name: "On this page" }).waitFor();
  } else {
    await page.locator(".collaboration-carets__caret", { hasText: "Eve Editor" }).first().waitFor({ timeout: 20_000 });
  }
  return () => other.close();
}

if (ON) {
  test.describe.configure({ mode: "serial", timeout: 150_000 });
  test.afterAll(async () => { await server?.stop(); server = undefined; });

  for (const shot of SHOTS) for (const vp of shot.viewports) {
    test(`${shot.section} › ${shot.id} ${shot.slug} [${vp}]`, async ({ browser }, info) => {
      const baseURL = String(info.project.use.baseURL);
      const out = path.join(info.project.testDir, "..", "acceptance-shots");
      fs.mkdirSync(out, { recursive: true });
      const phone = vp === "phone";
      for (const theme of THEMES) {
        const context = await newContext(browser, baseURL, shot, vp, theme);
        let cleanup: (() => Promise<void>) | undefined;
        try {
          const page = await context.newPage();
          await page.clock.setFixedTime(NOW);
          const c = { phone, theme, context };
          if (shot.realServer) cleanup = await presence(browser, baseURL, page, context, phone);
          else {
            await page.goto(typeof shot.url === "function" ? shot.url(c) : shot.url);
            await applyTheme(page, theme);
            await shot.setup?.(page, c);
          }
          await applyTheme(page, theme);
          await settle(page);
          await page.screenshot({ path: path.join(out, `${shot.id}__${shot.slug}__${theme}__${vp}.png`), animations: "disabled", caret: "hide", scale: "css" });
        } finally {
          await cleanup?.().catch(() => {});
          await context.close();
        }
      }
    });
  }
}
