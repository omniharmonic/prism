import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e-fixtures",
  testMatch: ["inbox.spec.ts", "inbox-people.spec.ts"],
  fullyParallel: true,
  workers: 2,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5193",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run dev -- --host 127.0.0.1 --port 5193 --strictPort --mode fixture",
    url: "http://127.0.0.1:5193/e2e-fixtures/inbox.html",
    reuseExistingServer: false,
    env: { PRISM_SERVER: "http://127.0.0.1:1", VITE_GATEWAY_URL: "" },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
