/**
 * Owner sign-in without email, the browser half (server: apps/server/test/local-signin.test.ts).
 * The local link lands on `/set-password?next=/setup` (no password yet) or `/setup`; `/setup`
 * opens Workspace settings at Server with the first-run checklist, which re-reads by itself.
 */
import { test, expect, type Page } from "@playwright/test";

async function setPasswordWith(page: Page, search: string) {
  const went: string[] = [];
  await page.route("**/auth/me", (r) => r.fulfill({ json: { authenticated: true, email: "owner@example.com", name: "Owner" } }));
  await page.route("**/auth/set-password", (r) => r.fulfill({ json: { ok: true } }));
  // Where the screen goes next: stand-ins for the app's own pages.
  await page.route(/\/(setup)?(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname !== "/" && u.pathname !== "/setup") return r.fallback();
    went.push(u.pathname);
    return r.fulfill({ contentType: "text/html", body: `<h1>${u.pathname === "/setup" ? "Setup" : "Home"}</h1>` });
  });
  await page.goto(`/e2e-fixtures/auth-screens.html?screen=set-password${search}`);
  return went;
}

test("after the local sign-in: setting the first password goes on to the setup checklist", async ({ page }) => {
  const went = await setPasswordWith(page, `&next=${encodeURIComponent("/setup")}`);
  await page.getByLabel("Password (10+ characters)").fill("a-long-enough-password");
  await page.getByLabel("Confirm password").fill("a-long-enough-password");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
  expect(went).toEqual(["/setup"]);
});

test("“Skip for now” also goes to the checklist; any other next is ignored", async ({ page }) => {
  const went = await setPasswordWith(page, `&next=${encodeURIComponent("/setup")}`);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
  expect(went).toEqual(["/setup"]);

  const elsewhere = await setPasswordWith(page, `&next=${encodeURIComponent("https://evil.example/")}`);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  expect(elsewhere).toEqual(["/"]);
});

test("/setup opens Workspace settings at Server with the checklist, which ticks a step the agent finishes", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html?setup");
  await expect(page.getByRole("tab", { name: "Server", exact: true })).toHaveAttribute("aria-selected", "true");
  const setup = page.getByRole("region", { name: "Setup" });
  await expect(setup).toBeVisible();
  const owner = setup.locator('[data-step="owner"]');
  await expect(owner).toHaveAttribute("data-done", "false");
  await expect(owner).toContainText("Set a password");
  await expect(setup.locator('[data-step="email"]')).toContainText("prism signin");
  // The agent finishes a step in the terminal; coming back to the window reads at once.
  const before = await page.evaluate(() => (window as any).prismSetup.reads as number);
  await page.evaluate(() => { (window as any).prismSetup.done("owner"); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(owner).toHaveAttribute("data-done", "true");
  expect(await page.evaluate(() => (window as any).prismSetup.reads as number)).toBeGreaterThan(before);
});
