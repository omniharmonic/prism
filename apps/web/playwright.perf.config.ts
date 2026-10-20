import { defineConfig, devices } from "@playwright/test";

/**
 * Performance budgets (NOTION-PARITY-CHECKLIST §2.14, NP-PF-01…09 + NP-SB-13).
 * NOT part of the fixture suite: its own testDir, one worker, no retries.
 * It measures a PRODUCTION build (`npx vite build` → apps/web/dist) served by the real
 * Prism Server over a synthetic 15k-note fake vault (apps/server/test/fixtures/perf-server.ts).
 *
 *   cd apps/web && npx vite build
 *   PERF_PORT=5363 npx playwright test -c playwright.perf.config.ts            # all rows
 *   PERF_PORT=5363 npx playwright test -c playwright.perf.config.ts -g PF-04   # one row
 *
 * PERF_RUNS (5) samples per number — the checklist's method is `PERF_RUNS=20`: with 20 or more samples
 * every budget row is judged on p50 AND p95 (reported in the results file and the log); fewer samples
 * give the quick best / median verdict, marked "not the row's method". PERF_OUT (test-results/perf/results.json);
 * PERF_IDLE_S (120) idle window for PF-09; PERF_SOAK_OPENS (50) for PF-07.
 */
export default defineConfig({
  testDir: "./perf",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 15 * 60_000,
  reporter: "line",
  use: { serviceWorkers: "block", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
