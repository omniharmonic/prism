/**
 * The iOS app's page half (WP5): first-run server setup, the notification registration
 * (APNs), the app-lock setting, and what a tapped notification opens.
 *
 * The shell's REAL host hook (apps/client/src-tauri/src/host.js) runs in the page with
 * platform = "ios" over a scripted IPC, so the page ⇄ shell contract is the shipped one:
 * which command is called with which arguments, and what the person is told. Everything
 * native is elsewhere: the server probe, the origin rules and the lock gate for links are
 * Rust (`cargo test --lib`: auth::, origin::, links::), the lock decision is Swift
 * (scripts/ios-policy-tests), and the sheet / Face ID / APNs themselves need a device.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = fs.readFileSync(path.resolve(here, "../../client/src-tauri/src/host.js"), "utf8");

type Call = { cmd: string; args: Record<string, unknown> };
const UUID = "0b0e0c9e-2f0e-4c59-9a55-0a5b3d5f1a11";
const TOKEN = "ab".repeat(32);

/**
 * Inject the host hook as the iOS shell does (ORIGIN = "", the live origin in a <head> meta)
 * over a scripted IPC. `window.ipc.on[cmd]` answers a command; unanswered ones resolve null.
 */
async function installIosShell(page: Page, serverOrigin: string) {
  await page.addInitScript(
    ({ source, serverOrigin }) => {
      if (window.top !== window) return;
      const w = window as any;
      w.ipc = { calls: [] as Call[], on: {} as Record<string, (args: any) => unknown> };
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          w.ipc.calls.push({ cmd, args });
          const h = w.ipc.on[cmd];
          try {
            return Promise.resolve(h ? h(args) : null);
          } catch (e) {
            return Promise.reject(e);
          }
        },
      };
      // window.rs writes this meta into every page it serves; "" = no server yet.
      const meta = document.createElement("meta");
      meta.name = "prism-server-origin";
      meta.content = serverOrigin;
      const put = () => document.head.appendChild(meta);
      if (document.head) put();
      else new MutationObserver((_, o) => { if (document.head) { put(); o.disconnect(); } }).observe(document, { childList: true, subtree: true });
      new Function(source.replace("__PRISM_ORIGIN__", JSON.stringify("")).replace("__PRISM_PLATFORM__", JSON.stringify("ios")))();
    },
    { source: HOST_JS, serverOrigin },
  );
}
const calls = (page: Page, cmd?: string) => page.evaluate((cmd) => ((window as any).ipc.calls as Call[]).filter((c) => !cmd || c.cmd === cmd), cmd);
const answer = (page: Page, cmd: string, body: string) => page.addInitScript(({ cmd, body }) => { (window as any).ipc.on[cmd] = new Function("args", body); }, { cmd, body });
const fixtureReady = (page: Page) => expect.poll(() => page.evaluate(() => (window as any).iosFixture?.ready === true)).toBe(true);

// ── First run: "Enter your server" ───────────────────────────────────────────

async function setup(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await installIosShell(page, "");
  // Every request this page makes to a host someone typed (the fixture itself is served from 127.0.0.1:<E2E_PORT>).
  const outside: string[] = [];
  page.on("request", (r) => { if (/example\.com|192\.168\.|:8899|:8787/.test(r.url())) outside.push(r.url()); });
  return outside;
}
const openSetup = async (page: Page) => {
  await page.goto("/e2e-fixtures/ios-shell.html?view=setup");
  await expect(page.getByRole("heading", { name: "Enter your server" })).toBeVisible();
};
const field = (page: Page) => page.getByLabel("Server address");
const go = (page: Page) => page.getByRole("button", { name: "Continue" });

test("iOS setup: the shell reports the platform and no server, and the page asks nothing of it yet", async ({ page }) => {
  await setup(page);
  await openSetup(page);
  expect(await page.evaluate(() => (window as any).__PRISM_SHELL__.platform)).toBe("ios");
  expect(await page.evaluate(() => (window as any).__PRISM_HOST__.apiOrigin)).toBe("");
  // No token is asked for and no server command runs before the person submits an address.
  expect((await calls(page)).map((c) => c.cmd)).toEqual([]);
});

test("iOS setup: something that is not an address is refused on the spot — the shell is not asked", async ({ page }) => {
  await setup(page);
  await openSetup(page);
  for (const bad of ["not a url", "https://", "prism example com", "https://prism.example.com\\evil"]) {
    await field(page).fill(bad);
    await go(page).click();
    await expect(page.getByRole("alert")).toContainText("That isn’t a web address");
    await expect(field(page)).toBeEnabled();
  }
  await field(page).fill("   ");
  await go(page).click();
  await expect(page.getByRole("alert")).toHaveText("Enter the address of your Prism Server.");
  expect(await calls(page, "set_server_origin")).toEqual([]);
  // Typing again clears the message.
  await field(page).fill("p");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("iOS setup: plain http, sign-in details in the address, a path or another scheme are refused — nothing is sent anywhere", async ({ page }) => {
  const outside = await setup(page);
  await openSetup(page);
  const refusals: Array<[string, string]> = [
    ["http://prism.example.com", "Use the https:// address of your server"],
    ["http://192.168.1.20:8787", "Use the https:// address of your server"],
    ["ftp://prism.example.com", "The address must start with https://"],
    ["https://sam:secret@prism.example.com", "Enter only the server’s address — you sign in on the next screen."],
    ["https://prism.example.com/page/abc", "Enter only the server’s address, like https://prism.example.com."],
    ["https://prism.example.com/?next=/auth", "Enter only the server’s address, like https://prism.example.com."],
  ];
  for (const [typed, message] of refusals) {
    await field(page).fill(typed);
    await go(page).click();
    await expect(page.getByRole("alert")).toContainText(message);
  }
  expect(await calls(page, "set_server_origin")).toEqual([]);
  expect(outside).toEqual([]);
});

test("iOS setup: an address the shell cannot reach says so, keeps what was typed, and the PAGE contacted nothing", async ({ page }) => {
  const outside = await setup(page);
  await answer(page, "set_server_origin", `return new Promise((_, no) => setTimeout(() => no("Couldn't reach https://prism.example.com. Check the address and your connection."), 150));`);
  await openSetup(page);
  await field(page).fill("prism.example.com");
  await go(page).click();
  // While the shell probes: the form waits.
  await expect(page.getByRole("button", { name: "Checking…" })).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveText("Couldn't reach https://prism.example.com. Check the address and your connection.");
  await expect(field(page)).toHaveValue("prism.example.com");
  await expect(go(page)).toBeEnabled();
  // One command, carrying only the address — no token, no grant, no path.
  const sent = await calls(page, "set_server_origin");
  expect(sent).toEqual([{ cmd: "set_server_origin", args: { origin: "https://prism.example.com" } }]);
  // The typed host was reached by nobody in this page: the probe is the shell's (auth.rs).
  expect(outside).toEqual([]);
  expect(await calls(page, "get_token")).toEqual([]);

  // A server that answers but is not Prism reads as that.
  await page.evaluate(() => { (window as any).ipc.on.set_server_origin = () => Promise.reject("https://prism.example.com doesn't look like a Prism Server."); });
  await go(page).click();
  await expect(page.getByRole("alert")).toHaveText("https://prism.example.com doesn't look like a Prism Server.");
});

test("iOS setup: a good address is handed to the shell once, normalised to https, and the page waits for the shell's reload", async ({ page }) => {
  const outside = await setup(page);
  await answer(page, "set_server_origin", `return Promise.resolve("https://prism.example.com");`);
  await openSetup(page);
  const navigations: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  await field(page).fill("  Prism.Example.com  ");
  await field(page).press("Enter");
  await expect(page.getByRole("button", { name: "Checking…" })).toBeDisabled();
  await expect.poll(() => calls(page, "set_server_origin")).toEqual([{ cmd: "set_server_origin", args: { origin: "https://Prism.Example.com" } }]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The shell reloads the page under the new server's CSP; the page itself goes nowhere and asks once.
  await page.waitForTimeout(300);
  expect(navigations).toEqual([]);
  expect(await calls(page, "set_server_origin")).toHaveLength(1);
  expect(outside).toEqual([]);

  // A loopback test server over http is passed on (the shell allows it in debug builds only).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Enter your server" })).toBeVisible();
  await field(page).fill("http://127.0.0.1:8899");
  await go(page).click();
  await expect.poll(() => calls(page, "set_server_origin")).toEqual([{ cmd: "set_server_origin", args: { origin: "http://127.0.0.1:8899" } }]);
});

// ── Signed in: notifications (APNs), the lock setting, taps ──────────────────

type Push = { method: string; path: string; body: unknown };
async function signedIn(page: Page, opts: { email?: string; permission?: string; lock?: { mode: string; minutes: number } } = {}) {
  await page.setViewportSize({ width: 390, height: 844 });
  await installIosShell(page, "https://prism.example.com");
  const state = { email: opts.email ?? "sam@example.test", pushes: [] as Push[], test: { status: 200, body: { result: "sent" } as unknown }, registerStatus: 200, apnsEnabled: true };
  await page.route("**/auth/me", (r) => r.fulfill({ json: { authenticated: true, email: state.email, name: "Sam", isOwner: false, role: "member", vaultId: "default", workspace: { id: "w", name: "W" } } }));
  await page.route("**/api/push/**", async (r) => {
    const req = r.request();
    const p = new URL(req.url()).pathname;
    state.pushes.push({ method: req.method(), path: p, body: req.postData() ? JSON.parse(req.postData()!) : null });
    if (p === "/api/push/apns/test") return r.fulfill({ status: state.test.status, json: state.test.body });
    if (req.method() === "DELETE") return r.fulfill({ json: { ok: true } });
    return r.fulfill({ status: state.registerStatus, json: state.registerStatus === 200 ? { ok: true, apnsEnabled: state.apnsEnabled } : { error: "device_token_required" } });
  });
  await answer(page, "get_app_settings", `return { serverOrigin: "https://prism.example.com", lock: ${JSON.stringify(opts.lock ?? { mode: "off", minutes: 5 })}, biometry: "faceID", passcodeSet: true };`);
  // The permission follows a registration, like iOS: asking is what grants it.
  await page.addInitScript(({ permission, token }) => {
    const w = window as any;
    w.ipc.permission = permission;
    w.ipc.token = token;
    w.ipc.on.push_status = () => w.ipc.permission;
    w.ipc.on.push_register = () => {
      if (w.ipc.permission === "denied") return Promise.reject("Notifications are turned off for Prism. Turn them on in the iOS Settings app.");
      w.ipc.permission = "authorized";
      return { token: w.ipc.token, environment: "production" };
    };
  }, { permission: opts.permission ?? "notDetermined", token: TOKEN });
  return state;
}
const openSettings = async (page: Page) => {
  await page.goto("/e2e-fixtures/ios-shell.html?view=settings");
  await fixtureReady(page);
  await expect(page.getByText("Lock Prism with Face ID")).toBeVisible();
};
const toggle = (page: Page) => page.getByRole("checkbox");
const apnsKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("prism:apns")).map((k) => [k, localStorage.getItem(k)]));

test("iOS push: nothing is registered or prompted at launch; turning it on registers THIS device's token with the server", async ({ page }) => {
  const state = await signedIn(page);
  await openSettings(page);
  // Launch: no permission prompt (push_register) and no registration by itself.
  expect(await calls(page, "push_register")).toEqual([]);
  expect(state.pushes).toEqual([]);
  await expect(toggle(page)).not.toBeChecked();

  await toggle(page).click(); // a controlled box: it turns on once the shell and the server answered
  await expect(toggle(page)).toBeChecked();
  expect(await calls(page, "push_register")).toHaveLength(1);
  // A member registers too (the routes are open to every signed-in account since wave 2A).
  expect(state.pushes).toEqual([{ method: "POST", path: "/api/push/apns", body: { token: TOKEN, environment: "production" } }]);
  // The choice is remembered per account, under a tag — no address in web storage.
  const keys = await apnsKeys(page);
  expect(keys).toHaveLength(1);
  expect(keys[0]![0]).toMatch(/^prism:apns:[0-9a-f]{16}$/);
  expect(keys[0]![1]).toBe("on");
  expect(JSON.stringify(keys)).not.toContain("sam");
});

test("iOS push: while on, every launch re-registers the CURRENT token (APNs rotates them) — for that account only", async ({ page }) => {
  const state = await signedIn(page);
  await openSettings(page);
  await toggle(page).click(); // a controlled box: it turns on once the shell and the server answered
  await expect(toggle(page)).toBeChecked();
  state.pushes.length = 0;

  // Next launch: iOS already allows notifications and APNs hands out a new token.
  const rotated = "cd".repeat(32);
  await page.addInitScript((t) => { const w = window as any; w.ipc.permission = "authorized"; w.ipc.token = t; }, rotated);
  await page.reload();
  await fixtureReady(page);
  await expect.poll(() => state.pushes).toEqual([{ method: "POST", path: "/api/push/apns", body: { token: rotated, environment: "production" } }]);
  await expect(toggle(page)).toBeChecked();

  // Someone else signs in on this phone: their choice was never made — nothing is registered for them.
  state.pushes.length = 0;
  state.email = "eve@example.test";
  await page.reload();
  await fixtureReady(page);
  await expect(page.getByText("Lock Prism with Face ID")).toBeVisible();
  await expect(toggle(page)).not.toBeChecked();
  await page.waitForTimeout(300);
  expect(state.pushes).toEqual([]);
  expect((await calls(page, "push_register"))).toEqual([]);
});

test("iOS push: turning it off unregisters the device; the test button sends to this device and reports the outcome", async ({ page }) => {
  const state = await signedIn(page);
  await openSettings(page);
  await toggle(page).click(); // a controlled box: it turns on once the shell and the server answered
  await expect(toggle(page)).toBeChecked();

  state.pushes.length = 0;
  await page.getByRole("button", { name: "Send a test notification" }).click();
  await expect(page.getByText("Test sent — it should arrive in a moment.")).toBeVisible();
  expect(state.pushes).toEqual([{ method: "POST", path: "/api/push/apns/test", body: null }]);
  state.test = { status: 404, body: { error: "not_registered" } };
  await page.getByRole("button", { name: "Send a test notification" }).click();
  await expect(page.getByText("This device isn't registered. Turn notifications off and on again.")).toBeVisible();
  state.test = { status: 200, body: { result: "pruned" } };
  await page.getByRole("button", { name: "Send a test notification" }).click();
  await expect(page.getByText("Apple rejected this device's token. Turn notifications off and on again.")).toBeVisible();

  state.pushes.length = 0;
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  expect(state.pushes).toEqual([{ method: "DELETE", path: "/api/push/apns", body: null }]);
  expect((await apnsKeys(page))[0]![1]).toBe("off");
  // Off stays off across a launch: nothing is registered again.
  state.pushes.length = 0;
  await page.reload();
  await fixtureReady(page);
  await page.waitForTimeout(300);
  expect(state.pushes).toEqual([]);
});

test("iOS push: a registration the server refuses, or iOS denies, never reads as on", async ({ page }) => {
  const state = await signedIn(page);
  state.registerStatus = 403; // e.g. a browser-style credential: the route wants the app's device token
  await openSettings(page);
  await toggle(page).click(); // a controlled box: it turns on once the shell and the server answered
  await expect(page.getByText("This sign-in can’t register for notifications. Sign out and in again in the app.")).toBeVisible();
  await expect(toggle(page)).not.toBeChecked();
  expect((await apnsKeys(page))[0]![1]).toBe("off");

  // Registered, but the server has no APNs key yet: said plainly, and it starts working once configured.
  state.registerStatus = 200;
  state.apnsEnabled = false;
  await toggle(page).click(); // a controlled box: it turns on once the shell and the server answered
  await expect(page.getByText(/Apple push isn't turned on on the server yet/)).toBeVisible();

  // Notifications blocked in iOS Settings: no toggle, an explanation instead.
  await page.addInitScript(() => { (window as any).ipc.permission = "denied"; });
  await page.reload();
  await fixtureReady(page);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("iOS lock setting: the choice goes to the shell (which asks for Face ID); a refusal is shown and nothing changes", async ({ page }) => {
  await signedIn(page);
  await answer(page, "set_app_lock", `return { mode: args.mode, minutes: args.minutes };`);
  await openSettings(page);
  const select = page.getByLabel("Lock Prism with Face ID");
  await expect(select).toHaveValue("off");
  await select.selectOption("background-15");
  await expect(select).toHaveValue("background-15");
  expect(await calls(page, "set_app_lock")).toEqual([{ cmd: "set_app_lock", args: { mode: "background", minutes: 15 } }]);
  await expect(page.getByText("Changing this setting asks you to unlock first.")).toBeVisible();

  // Switching it off needs the owner of the phone: the shell refuses without Face ID / the passcode.
  await page.evaluate(() => { (window as any).ipc.on.set_app_lock = () => Promise.reject("Not changed: Face ID or your passcode is needed to change the lock."); });
  await select.selectOption("off");
  await expect(page.getByText("Not changed: Face ID or your passcode is needed to change the lock.")).toBeVisible();
  await expect(select).toHaveValue("background-15");
});

test("iOS lock: a tapped notification opens nothing while the app is locked, then opens once the shell says it is unlocked", async ({ page }) => {
  await signedIn(page, { lock: { mode: "always", minutes: 5 } });
  // Locked at launch: the shell keeps the tap and answers null (mobile_cmds::push_take_opened).
  await answer(page, "push_take_opened", `return null;`);
  await openSettings(page);
  expect((await calls(page, "push_take_opened")).length).toBeGreaterThan(0); // the cold-start ask
  expect(await page.evaluate(() => (window as any).iosFixture.tabs())).toEqual([]);

  // Unlocked: the shell pings (a data-free event) and now hands the validated path over.
  await page.evaluate(() => { (window as any).ipc.on.push_take_opened = () => "/inbox/n_1-a"; });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:native-push-opened", { detail: { path: "/page/smuggled" } })));
  await expect.poll(() => page.evaluate(() => (window as any).iosFixture.tabs())).toEqual(["notifications"]);

  // An agent-turn tap opens that session's chat; anything that is not one of the two routes opens nothing.
  await page.evaluate((id) => { (window as any).ipc.on.push_take_opened = () => `/agent/${id}`; }, UUID);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:native-push-opened")));
  await expect.poll(() => page.evaluate(() => (window as any).iosFixture.tabs().length)).toBe(2);
  const before = await page.evaluate(() => (window as any).iosFixture.tabs());
  for (const bad of ["/auth/logout", "https://evil.example/page/x", "/page/../acl", "/inbox/a b"]) {
    await page.evaluate((bad) => { (window as any).ipc.on.push_take_opened = () => bad; }, bad);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:native-push-opened")));
  }
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).iosFixture.tabs())).toEqual(before);
});

test("iOS server: 'Sign out & change server' is the shell's (native confirmation); cancelling keeps a link that waits for sign-in", async ({ page }) => {
  await signedIn(page);
  await answer(page, "reset_server", `return false;`);
  await openSettings(page);
  await expect(page.getByText("https://prism.example.com", { exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem("prism:pending-link", JSON.stringify({ path: "/page/abc", at: Date.now() })));
  await page.getByRole("button", { name: "Sign out & change server…" }).click();
  await expect.poll(() => calls(page, "reset_server")).toEqual([{ cmd: "reset_server", args: {} }]);
  // Cancelled in the native dialog: nothing changed.
  expect(await page.evaluate(() => sessionStorage.getItem("prism:pending-link"))).toContain("/page/abc");

  // Confirmed: the link belonged to the server that is gone.
  await page.evaluate(() => { (window as any).ipc.on.reset_server = () => true; });
  await page.getByRole("button", { name: "Sign out & change server…" }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("prism:pending-link"))).toBeNull();
});

// ── Sign-in: one at a time, and only when the person asks ───────────────────────
// (qa/ios-simulator-findings-2026-10-08.md #4: six "Prism on iPhone" devices in an hour, two
// of them 3.4 s apart. Every sign-in mints a device, so the hook may start one only for a
// press, and never a second while the sheet is up.)

async function signInScreen(page: Page, script?: () => Promise<unknown>) {
  await page.setViewportSize({ width: 390, height: 844 });
  await installIosShell(page, "https://prism.example.com");
  await script?.(); // IPC answers go in after the shell (they hang off its `window.ipc`)
  await page.route("**/auth/me", (r) => r.fulfill({ status: 401, json: { authenticated: false } }));
  await page.goto("/e2e-fixtures/ios-shell.html?view=session");
  await fixtureReady(page);
  await expect(page.getByRole("heading", { name: "Sign in to Prism" })).toBeVisible();
}

test("iOS sign-in: nothing starts one by itself, and presses while the sheet is up join it — one sheet, one device", async ({ page }) => {
  // The sheet stays up until the spec lets it finish.
  await signInScreen(page, () => answer(page, "sign_in", `return new Promise((yes, no) => { window.ipc.finishSignIn = yes; window.ipc.cancelSignIn = no; });`));
  // Signed out and looking at the screen: no sign-in was started for the person.
  await page.waitForTimeout(300);
  expect(await calls(page, "sign_in")).toEqual([]);

  const button = page.getByRole("button", { name: "Sign in", exact: true });
  await button.click();
  await button.click();
  await button.click();
  // …and the hook itself, called directly (anything else in the page): still the same one.
  expect(await page.evaluate(() => { const h = (window as any).__PRISM_HOST__; return h.signIn() === h.signIn(); })).toBe(true);
  expect(await calls(page, "sign_in")).toEqual([{ cmd: "sign_in", args: {} }]);

  // Dismissed: said to nobody (a cancel is not an error), and the next press is a NEW sign-in.
  await page.evaluate(() => (window as any).ipc.cancelSignIn("Sign-in cancelled"));
  await expect(page.locator("#prism-host-toast")).toHaveCount(0);
  await button.click();
  await expect.poll(async () => (await calls(page, "sign_in")).length).toBe(2);

  // Finished: the page re-boots once, so the gate asks who is signed in with the new token.
  const reloaded = page.waitForEvent("load");
  await page.evaluate(() => (window as any).ipc.finishSignIn(null));
  await reloaded;
  await fixtureReady(page);
  expect(await calls(page, "sign_in")).toEqual([]); // a fresh page: nothing started again
});

test("iOS sign-in: a token the server refused is only FORGOTTEN — the hook never signs in again by itself", async ({ page }) => {
  await signInScreen(page);
  await page.evaluate(() => (window as any).__PRISM_HOST__.onUnauthorized());
  await page.evaluate(() => (window as any).__PRISM_HOST__.onUnauthorized());
  await page.waitForTimeout(300);
  const made = (await calls(page)).filter((c) => c.cmd !== "get_token");
  // Forget locally, without a server call (the token is dead) — and no sign_in, ever.
  expect(made).toEqual([{ cmd: "sign_out", args: { revoke: false } }, { cmd: "sign_out", args: { revoke: false } }]);
  await expect(page.getByRole("heading", { name: "Sign in to Prism" })).toBeVisible();
});

// ── Embeds in the app (NP-ED-15, owner decision c.7: YouTube no-cookie + Vimeo only) ──────────
const EMBEDS: Array<[url: string, label: string, player: string | null]> = [
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
  ["https://vimeo.com/76979871", "Vimeo", "https://player.vimeo.com/video/76979871"],
  ["https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184", "Loom", null],
  ["https://www.figma.com/design/AbCdEf123456/Atlas", "Figma", null],
  ["https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit", "Google Docs", null],
  ["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "Spotify", null],
  ["https://x.com/prism/status/1234567890123", "Post on X", null],
];
const EMBED_PAGE = "/e2e-fixtures/notion-media.html?content=" + encodeURIComponent(EMBEDS.map(([u]) => `<div data-type="embed" data-url="${u}"></div>`).join(""));

test("iOS embeds: with a server set, YouTube and Vimeo are frames (no popups) and the rest are cards; before a server is set nothing is framed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Never reach the internet from a fixture: a provider's frame gets an empty page.
  await page.route(/^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com|www\.loom\.com|www\.figma\.com|docs\.google\.com|open\.spotify\.com|platform\.twitter\.com)\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>player</title>" }));
  // A server is configured: the shell's CSP names the two players and the hook advertises them.
  await installIosShell(page, "https://prism.example.com");
  await page.goto(EMBED_PAGE);
  expect(await page.evaluate(() => [...(window as any).__PRISM_HOST__.frameOrigins])).toEqual(["https://www.youtube-nocookie.com", "https://player.vimeo.com"]);
  const blocks = page.locator(".prism-embed");
  await expect(blocks).toHaveCount(EMBEDS.length);
  const frames = page.locator(".prism-embed iframe");
  await expect(frames).toHaveCount(2);
  await expect(frames.nth(0)).toHaveAttribute("src", /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  await expect(frames.nth(1)).toHaveAttribute("src", /^https:\/\/player\.vimeo\.com\/video\/76979871/);
  for (const i of [0, 1]) await expect(frames.nth(i)).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
  await expect(page.locator(".prism-embed[data-fallback]")).toHaveCount(EMBEDS.length - 2);
  for (const [, label, player] of EMBEDS) if (!player) await expect(page.locator(".prism-embed[data-fallback]").filter({ hasText: `Open in ${label}` })).toHaveCount(1);
  // The player fits a phone: no sideways scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The player's own way out goes through the shell, like every external link.
  await blocks.nth(1).getByRole("link", { name: "Open in Vimeo" }).click();
  await expect.poll(() => calls(page, "open_external")).toEqual([{ cmd: "open_external", args: { url: EMBEDS[1]![0] } }]);
});

test("iOS embeds: before a server is configured the hook advertises no player (the first-run CSP reaches nothing remote)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requested: string[] = [];
  page.on("request", (r) => { if (/youtube|vimeo/.test(new URL(r.url()).hostname)) requested.push(r.url()); });
  await installIosShell(page, "");
  await page.goto(EMBED_PAGE);
  expect(await page.evaluate(() => [...(window as any).__PRISM_HOST__.frameOrigins])).toEqual([]);
  await expect(page.locator(".prism-embed")).toHaveCount(EMBEDS.length);
  await expect(page.locator(".prism-embed iframe")).toHaveCount(0);
  await expect(page.locator(".prism-embed[data-fallback]")).toHaveCount(EMBEDS.length);
  expect(requested).toEqual([]);
});
