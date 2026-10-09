/**
 * The owner's emailed sign-in link, mid APP sign-in (qa/ios-simulator-findings-2026-10-08.md
 * #2, #3). The app's sign-in sheet shows the web login at `/?next=/auth/device/continue`; the
 * link from the email opens in the BROWSER, not in the sheet. Both share cookies, so once the
 * link has signed the browser in, the "link sent" page goes on by itself — to the one fixed
 * path, where the server shows the consent page.
 *
 * Pinned here: when it continues, where to, and that it never goes anywhere else. That
 * /auth/device/continue demands the session + the parked request and answers with CONSENT
 * (never a code) is the server's: apps/server/test/device-auth.test.ts.
 */
import { test, expect, type Page } from "@playwright/test";

const CONTINUE = "/auth/device/continue";

async function linkSent(page: Page, search: string) {
  const state = { signedIn: false, asked: 0, navigations: [] as string[] };
  await page.route("**/auth/request", (r) => r.fulfill({ json: { ok: true, emailDelivery: true } }));
  await page.route("**/auth/me", (r) => {
    state.asked++;
    return state.signedIn ? r.fulfill({ json: { authenticated: true, email: "owner@example.com" } }) : r.fulfill({ status: 401, json: { authenticated: false } });
  });
  // Where the page ends up, if it leaves: the consent page is the server's (a stand-in here).
  await page.route(`**${CONTINUE}`, (r) => r.fulfill({ contentType: "text/html", body: "<h1>Allow an app to sign in as you?</h1>" }));
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) state.navigations.push(new URL(f.url()).pathname + new URL(f.url()).search); });
  await page.goto(`/e2e-fixtures/auth-screens.html${search}`);
  await page.getByRole("button", { name: "Owner? Email me a sign-in link instead" }).click();
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByText(/a sign-in link is on its way/)).toBeVisible();
  state.navigations.length = 0;
  return state;
}

test("link sent, mid app sign-in: waits while signed out, then continues to the consent page by itself", async ({ page }) => {
  const state = await linkSent(page, `?next=${encodeURIComponent(CONTINUE)}`);
  await expect(page.getByText("Open it, then come back here — this page continues on its own.")).toBeVisible();
  // Not signed in yet: it keeps asking and goes nowhere.
  await expect.poll(() => state.asked, { timeout: 8000 }).toBeGreaterThanOrEqual(1);
  expect(state.navigations).toEqual([]);

  // The owner opens the emailed link in the browser: the shared cookie jar now has a session.
  state.signedIn = true;
  await expect(page.getByRole("heading", { name: "Allow an app to sign in as you?" })).toBeVisible({ timeout: 8000 });
  // ONE navigation, to the fixed path — where the server asks for consent.
  expect(state.navigations).toEqual([CONTINUE]);
});

test("link sent, mid app sign-in: coming back to the sheet checks at once; the button does the same by hand", async ({ page }) => {
  const state = await linkSent(page, `?next=${encodeURIComponent(CONTINUE)}`);
  const button = page.getByRole("button", { name: "I’ve opened the link — continue" });
  // Pressed too early: told so, and nothing happens. The button cannot skip the sign-in.
  await button.click();
  await expect(page.getByRole("status")).toHaveText("Not signed in yet. Open the link from the email first, then try again.");
  expect(state.navigations).toEqual([]);

  state.signedIn = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // back from Mail / the browser
  await expect(page.getByRole("heading", { name: "Allow an app to sign in as you?" })).toBeVisible({ timeout: 2500 });
  expect(state.navigations).toEqual([CONTINUE]);
});

test("link sent, ordinary web sign-in or any other ?next=: the page never asks and never leaves", async ({ page }) => {
  test.setTimeout(60_000); // each case waits out more than one poll interval
  for (const search of ["", "?next=%2Fauth%2Fdevice%2Fapprove", "?next=https%3A%2F%2Fevil.example%2F", "?next=%2F%2Fevil.example", "?next=%2Fauth%2Fdevice%2Fcontinue%3Fx%3D1", "?next=%2Fauth%2Fdevice%2Fcontinue%2F"]) {
    const state = await linkSent(page, search);
    state.signedIn = true; // even with a session
    await expect(page.getByText("You can close this tab.")).toBeVisible();
    await expect(page.getByRole("button", { name: "I’ve opened the link — continue" })).toHaveCount(0);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(3500); // longer than one poll interval
    expect(state.asked, search).toBe(0);
    expect(state.navigations, search).toEqual([]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
