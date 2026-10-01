import { defineConfig, devices } from "@playwright/test";

/** Exercise the production native bundle; never use a real server or token. */
export default defineConfig({
  testDir: "./e2e-native",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5189", serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: {
    command: "vite preview --mode native --host 127.0.0.1 --port 5189 --strictPort",
    url: "http://127.0.0.1:5189",
    reuseExistingServer: false,
    env: { PRISM_SERVER: "http://127.0.0.1:1" },
  },
  projects: [
    { name: "native-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "native-webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
