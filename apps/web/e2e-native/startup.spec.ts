import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const hostSource = readFileSync(new URL("../../client/src-tauri/src/host.js", import.meta.url), "utf8")
  .replace("__PRISM_ORIGIN__", JSON.stringify("https://fixture.example.test"))
  .replace("__PRISM_PLATFORM__", JSON.stringify("macos")); // host.rs replaces both placeholders

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:5189/") ? route.continue() : route.abort());
  // Run the real injected shell script with an isolated IPC adapter. This is
  // a bundle/host regression, not a claim that the installed macOS app passed.
  await page.addInitScript({ content: `
    window.prismNativeCommands = [];
    window.__TAURI_INTERNALS__ = { invoke: async function(command) {
      window.prismNativeCommands.push(command);
      if (command === "get_token") {
        if (new URLSearchParams(location.search).has("pending-credentials")) {
          return new Promise(function(resolve) { window.prismResolveCredential = resolve; });
        }
        return null;
      }
      if (command === "sign_in") throw new Error("Fixture sign-in denied");
      throw new Error("Unexpected fixture command");
    }};
    ${hostSource}
  ` });
});

test("production native bundle renders sign-in and invokes the real host hook", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Prism" })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("native-signin.png") });
  expect(await page.evaluate(() => Object.isFrozen(window.__PRISM_HOST__))).toBe(true);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Sign-in failed: Fixture sign-in denied")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { prismNativeCommands: string[] }).prismNativeCommands)).toContain("sign_in");
  await expect(page.getByRole("heading", { name: "Sign in to Prism" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("an app import failure displays recovery instead of a blank window", async ({ page }) => {
  const html = readFileSync(new URL("../dist-native/index.html", import.meta.url), "utf8");
  const entry = html.match(/<script[^>]+src="([^"]+)"/)![1];
  await page.route("**/assets/*.js", (route) => new URL(route.request().url()).pathname === entry ? route.continue() : route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Prism couldn’t start" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload Prism" })).toBeVisible();
});

test("a pending native credential request explains the system prompt and resumes afterward", async ({ page }) => {
  await page.goto("/?pending-credentials");
  await expect(page.getByRole("heading", { name: "Opening your workspace" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Checking your saved sign-in…");
  await expect(page.getByText("If your device shows a security prompt for Prism, respond there to continue.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    history.replaceState(null, "", "/");
    (window as unknown as { prismResolveCredential: (token: null) => void }).prismResolveCredential(null);
  });
  await expect(page.getByRole("heading", { name: "Sign in to Prism" })).toBeVisible();
});
