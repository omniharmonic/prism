import { defineConfig, devices } from "@playwright/test";

/** Fixture-only default. No live server, vault credentials or background jobs. */
export default defineConfig({
  testDir: "./e2e-fixtures",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5188",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5188 --strictPort --mode fixture",
    url: "http://127.0.0.1:5188/e2e-fixtures/harness.html",
    reuseExistingServer: false,
    env: { PRISM_SERVER: "http://127.0.0.1:1", VITE_GATEWAY_URL: "" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
