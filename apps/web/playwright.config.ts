import { defineConfig, devices } from "@playwright/test";

/** Fixture-only default. No live server, vault credentials or background jobs. */
// E2E_PORT lets parallel worktrees run their own fixture server without colliding.
const port = Number(process.env.E2E_PORT || 5188);
// WebKit is OPT-IN: the default run (no --project, no E2E_WEBKIT) is Chromium only, as before.
// `--project=webkit` (or E2E_WEBKIT=1) adds the project; the flag is copied to the environment
// so worker processes, which do not see the CLI arguments, load the same project list.
if (process.argv.some((a, i, all) => a === "--project=webkit" || (a === "--project" && all[i + 1] === "webkit"))) process.env.E2E_WEBKIT = "1";
const webkit = process.env.E2E_WEBKIT === "1";
export default defineConfig({
  testDir: "./e2e-fixtures",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort --mode fixture`,
    url: `http://127.0.0.1:${port}/e2e-fixtures/harness.html`,
    reuseExistingServer: false,
    env: { PRISM_SERVER: "http://127.0.0.1:1", VITE_GATEWAY_URL: "" },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(webkit ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
});
