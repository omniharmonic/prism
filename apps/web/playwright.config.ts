import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config for the web PWA's browser-only paths (publishing +
 * onboarding viewer-skip). These run against a LIVE Prism Server (pm2
 * `prism-server`) that serves the built `apps/web/dist` and fronts a live
 * Parachute vault — so every spec here is tagged `@live` (see the specs).
 *
 * baseURL is the LOCAL server origin (http://localhost:8787), NOT the public
 * APP_ORIGIN. Override with E2E_BASE_URL if the server runs elsewhere.
 *
 * Cache safety: the app registers a PWA service worker whose `navigateFallback`
 * shadows routes and whose precache can serve STALE JS across runs. We set
 * `serviceWorkers: "block"` so Playwright never lets the SW register — every
 * test gets the freshly-served build, never a cached one. Each test also gets a
 * fresh browser context (Playwright default), so storage never leaks between
 * tests.
 */
export default defineConfig({
  testDir: "./e2e",
  // Publishing is one-publication-per-tag; serialize so specs sharing the throwaway
  // `_e2e*` tags can never race each other on publish/unpublish.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:8787",
    serviceWorkers: "block",
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
