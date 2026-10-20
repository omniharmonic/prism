import { defineConfig, devices } from "@playwright/test";

/**
 * Notion-parity gate run (NOTION-PARITY-CHECKLIST.md §1.1 / §4 step 3): every
 * fixture spec on Chromium AND WebKit. Fixture-only, like the default config —
 * no live server, vault credentials or background jobs.
 *
 *   E2E_PORT=<free port> npx playwright test -c playwright.parity.config.ts \
 *     --project=webkit --workers=2
 *
 * PARITY_JSON=<file> additionally writes the machine-readable result the
 * evidence log (PARITY-EVIDENCE.md) is built from.
 */
const port = Number(process.env.E2E_PORT || 5188);
const json = process.env.PARITY_JSON;
export default defineConfig({
  testDir: "./e2e-fixtures",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  reporter: json ? [["line"], ["json", { outputFile: json }]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: "block",
    trace: "off",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort --mode fixture`,
    url: `http://127.0.0.1:${port}/e2e-fixtures/harness.html`,
    reuseExistingServer: false,
    env: { PRISM_SERVER: "http://127.0.0.1:1", VITE_GATEWAY_URL: "" },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
