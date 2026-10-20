/**
 * "Open in the app" on a page link opened in a phone's browser (decision D-H, docs/client-app.md
 * § Links). Self-hosted servers cannot have universal links in the published app, so the PWA
 * offers ONE tap that launches `prism://source/<id>?server=<origin>&vault=<vault>` — the shell's
 * contextual route, opened only when the app is paired with this same server and vault.
 *
 * The fixture page is served AT the path under test (`/page/<id>` …), so the module reads a real
 * `location`. What a browser cannot show: Safari's "Open in “Prism”?" sheet and the OS handing
 * the URL to the app (device check); the shell's parse of the same URL is `cargo test`
 * (`links::tests::open_in_app_banner_link`).
 */
import { test, expect, devices, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openInAppPageId, openInAppHref, isAppleMobileBrowser, dismissedRecently, OPEN_IN_APP_QUIET_MS } from "../src/share/openInApp";

const IPHONE = devices["iPhone 13"];

test.use({ viewport: IPHONE.viewport, userAgent: IPHONE.userAgent, hasTouch: true });

/** Serve the fixture at `path` (any URL on the dev server) and record prism:// launches instead of following them. */
async function open(page: Page, url: string, init: { vault?: string | null; capability?: boolean; host?: boolean } = {}) {
  // The fixture page as the dev server serves it (with Vite's module preamble), at `url`.
  await page.route((u) => u.pathname === new URL(url, "http://x").pathname && !u.pathname.startsWith("/e2e-fixtures/"), async (route) => {
    const res = await route.fetch({ url: new URL("/e2e-fixtures/open-in-app.html", route.request().url()).href });
    await route.fulfill({ status: 200, contentType: "text/html", body: await res.text() });
  });
  await page.addInitScript((init) => {
    (window as any).openInAppFixture = { vault: init.vault ?? null, capability: !!init.capability };
    if (init.host) (window as any).__PRISM_HOST__ = { apiOrigin: location.origin };
    (window as any).launched = [];
    // Last in the click path: record what the tap would launch and stop the navigation
    // (a test browser has no app for the prism scheme).
    window.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (a && a.getAttribute("href")?.startsWith("prism:")) {
        (window as any).launched.push(a.getAttribute("href"));
        e.preventDefault();
      }
    });
  }, init);
  await page.goto(url);
  await expect(page.locator("html[data-fixture-ready='1']")).toBeAttached();
}

const banner = (page: Page) => page.getByRole("region", { name: "Open in the Prism app" });

test.describe("pure rules", () => {
  test("which URLs may offer the app", () => {
    expect(openInAppPageId({ pathname: "/page/abc_1-2", search: "" })).toBe("abc_1-2");
    expect(openInAppPageId({ pathname: "/collab/abc", search: "" })).toBe("abc");
    expect(openInAppPageId({ pathname: "/page/abc/", search: "" })).toBe("abc");
    for (const [pathname, search] of [
      ["/page/abc", "?t=cap"], ["/page/abc", "?vault=primary"], ["/collab/abc", "?t=x"], ["/page/a/b", ""], ["/page/", ""],
      ["/page/a%2Fb", ""], ["/page/a.b", ""], ["/p/site", ""], ["/inbox", ""], ["/auth/device/authorize", ""], ["/accept-invite", ""],
      ["/page/" + "a".repeat(129), ""],
    ]) expect(openInAppPageId({ pathname, search }), `${pathname}${search}`).toBeNull();
  });

  test("the app link names this server and a plain vault, nothing else", () => {
    expect(openInAppHref("abc", "https://prism.example.com", "team")).toBe("prism://source/abc?server=https%3A%2F%2Fprism.example.com&vault=team");
    expect(openInAppHref("abc", "https://prism.example.com/x?y=1", null)).toBe("prism://source/abc?server=https%3A%2F%2Fprism.example.com&vault=primary");
    expect(openInAppHref("abc", "https://prism.example.com", "a/b")).toContain("vault=primary");
    expect(openInAppHref("abc", "https://user:pw@prism.example.com", "x")).toBeNull();
    expect(openInAppHref("abc", "javascript:alert(1)", "x")).toBeNull();
    expect(openInAppHref("a b", "https://prism.example.com", "x")).toBeNull();
  });

  test("Apple phone and tablet browsers only, never an installed web app", () => {
    expect(isAppleMobileBrowser({ userAgent: devices["iPhone 13"].userAgent })).toBe(true);
    expect(isAppleMobileBrowser({ userAgent: devices["iPad Mini"].userAgent })).toBe(true);
    expect(isAppleMobileBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobileBrowser({ userAgent: devices["Desktop Safari"].userAgent, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isAppleMobileBrowser({ userAgent: devices["Pixel 7"].userAgent })).toBe(false);
    expect(isAppleMobileBrowser({ userAgent: devices["iPhone 13"].userAgent, standalone: true })).toBe(false);
  });

  test("Not now is remembered for a while, then expires", () => {
    const now = 1_000_000_000_000;
    expect(dismissedRecently(String(now - 1), now)).toBe(true);
    expect(dismissedRecently(String(now - OPEN_IN_APP_QUIET_MS), now)).toBe(false);
    expect(dismissedRecently(String(now + 60_000), now)).toBe(false); // a time from the future is not trusted
    expect(dismissedRecently("junk", now)).toBe(false);
    expect(dismissedRecently(null, now)).toBe(false);
  });
});

test("a page link on an iPhone offers the app; one tap launches the contextual prism:// link", async ({ page }) => {
  await open(page, "/page/note_1");
  const b = banner(page);
  await expect(b).toBeVisible();
  const link = b.getByRole("link", { name: "Open in app" });
  const origin = new URL(page.url()).origin;
  await expect(link).toHaveAttribute("href", `prism://source/note_1?${new URLSearchParams({ server: origin, vault: "primary" })}`);
  // Nothing happened on its own: same page, focus untouched.
  expect(new URL(page.url()).pathname).toBe("/page/note_1");
  expect(await page.evaluate(() => (window as any).launched.length)).toBe(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  // The vault is known by the time of the tap (signed in meanwhile): the link carries it.
  await page.evaluate(() => { (window as any).openInAppFixture.vault = "team_vault"; });
  await link.tap();
  expect(await page.evaluate(() => (window as any).launched)).toEqual([`prism://source/note_1?${new URLSearchParams({ server: origin, vault: "team_vault" })}`]);
  await expect(b).toHaveCount(0);
});

test("fits a 320 px phone with 44 px targets, above the home indicator", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page, "/collab/note_1");
  const b = banner(page);
  await expect(b).toBeVisible();
  const box = (await b.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(320 - 16 + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  for (const control of [b.getByRole("link", { name: "Open in app" }), b.getByRole("button", { name: "Not now" })]) {
    const r = (await control.boundingBox())!;
    expect(r.height).toBeGreaterThanOrEqual(44);
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

for (const theme of ["light", "dark"] as const) {
  test(`axe: no serious violations · ${theme}`, async ({ page }) => {
    await open(page, "/page/note_1");
    // Switch the theme with transitions off, so axe reads the settled colours.
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
    await page.evaluate((t) => { document.documentElement.classList.remove("light", "dark"); document.documentElement.classList.add(t); }, theme);
    await expect(banner(page)).toBeVisible();
    const result = await new AxeBuilder({ page }).include(".prism-open-in-app").analyze();
    expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.failureSummary).join(" | ")}`)).toEqual([]);
  });
}

test("Not now hides it on this device", async ({ page }) => {
  await open(page, "/page/note_1");
  await banner(page).getByRole("button", { name: "Not now" }).tap();
  await expect(banner(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator("html[data-fixture-ready='1']")).toBeAttached();
  await expect(banner(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).launched.length)).toBe(0);
});

for (const [name, url, init] of [
  ["a capability link (?t=)", "/collab/note_1?t=capability-token", {}],
  ["a capability kept for this tab", "/page/note_1", { capability: true }],
  ["any query (the app's own 'open in browser' answer)", "/page/note_1?vault=primary", {}],
  ["a published site", "/p/site", {}],
  ["the device sign-in page", "/auth/device/authorize", {}],
  ["an invite", "/accept-invite", {}],
  ["a deeper path", "/page/note_1/more", {}],
  ["inside the Prism Client", "/page/note_1", { host: true }],
] as const) {
  test(`never for ${name}`, async ({ page }) => {
    await open(page, url, init);
    expect(await page.evaluate(() => (window as any).openInAppFixture.mounted)).toBe(false);
    await expect(banner(page)).toHaveCount(0);
  });
}

test.describe("not an Apple phone", () => {
  test.use({ viewport: devices["Pixel 7"].viewport, userAgent: devices["Pixel 7"].userAgent });
  test("an Android browser gets no banner (the app is Apple-only)", async ({ page }) => {
    await open(page, "/page/note_1");
    await expect(banner(page)).toHaveCount(0);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 }, userAgent: devices["Desktop Safari"].userAgent, hasTouch: false });
  test("a desktop browser gets no banner", async ({ page }) => {
    await open(page, "/page/note_1");
    await expect(banner(page)).toHaveCount(0);
  });
});
