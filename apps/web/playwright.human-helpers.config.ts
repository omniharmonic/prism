import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e-fixtures",
  testMatch:
    process.env.PRISM_TEST_NATIVE === "1"
      ? "**/human-command-native.spec.ts"
      : "**/human-command-helpers.spec.ts",
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:5193", serviceWorkers: "block" },
  webServer: {
    command:
      "npm run dev -- --host 127.0.0.1 --port 5193 --strictPort --mode fixture",
    url: "http://127.0.0.1:5193/e2e-fixtures/human-command-helpers.html",
    reuseExistingServer: false,
    env: {
      PRISM_SERVER: "http://127.0.0.1:1",
      VITE_GATEWAY_URL: "",
      VITE_PRISM_NATIVE: process.env.PRISM_TEST_NATIVE ?? "",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
