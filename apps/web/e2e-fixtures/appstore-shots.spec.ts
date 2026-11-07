import { test } from "@playwright/test";
const ON = !!process.env.APPSTORE_SHOTS;
const OUT = process.env.APPSTORE_OUT!;
const NOW = new Date(2026, 9, 5, 15, 0, 0);
const DEV = {
  iphone: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  ipad: { viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: false, hasTouch: true },
} as const;
const CANDS: Array<[string, string]> = (process.env.APPSTORE_URLS ?? "").split("|").filter(Boolean).map((s) => s.split("=>") as [string, string]);
if (ON) for (const d of (process.env.APPSTORE_DEV ?? "iphone").split(",") as Array<keyof typeof DEV>) for (const [name, url] of CANDS) {
  test(`${d} ${name}`, async ({ browser }, info) => {
    const ctx = await browser.newContext({ baseURL: String(info.project.use.baseURL), ...DEV[d], reducedMotion: "reduce", colorScheme: "light", serviceWorkers: "block", locale: "en-US" });
    await ctx.route("**/*", (r) => { const u = new URL(r.request().url()); return ["127.0.0.1", "localhost"].includes(u.hostname) || u.protocol === "data:" || u.protocol === "blob:" ? r.fallback() : r.abort(); });
    await ctx.addInitScript(() => { try { localStorage.setItem("prism-settings", JSON.stringify({ state: { theme: "light" }, version: 0 })); } catch {} document.documentElement.classList.add("light"); });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(NOW);
    await page.goto(url);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${d}-${name}.png`, animations: "disabled", caret: "hide" });
    await ctx.close();
  });
}
