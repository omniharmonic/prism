/**
 * When a native session ends — the page half, end to end: the shell's REAL host hook
 * (apps/client/src-tauri/src/host.js, platform "ios") over a scripted IPC, and the REAL
 * native transport (`serverFetch`, `fetchMe`, `logout`) against a scripted server.
 *
 * What happened on the first iOS run (qa/ios-simulator-findings-2026-10-08.md #4, #5): one
 * 401 threw away a good token, the page went on asking the server with NO bearer behind a
 * workspace that still said "Synced", and every recovery was a new sign-in = a new device.
 *
 * The native transport is a BUILD-time switch, so these cases need the fixture server in
 * native mode and are skipped otherwise:
 *
 *   VITE_PRISM_NATIVE=1 PRISM_TEST_NATIVE=1 E2E_PORT=5203 npx playwright test e2e-fixtures/native-session.spec.ts
 *
 * The rule itself is pinned without a browser by `npm run verify:session -w @prism/web`
 * (src/native/sessionGuard.ts), and the hook's part in every run by ios-shell.spec.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page, type Route } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = fs.readFileSync(path.resolve(here, "../../client/src-tauri/src/host.js"), "utf8");
const TOKEN = "pd_fictional_device_token";

test.skip(process.env.PRISM_TEST_NATIVE !== "1", "Needs the fixture server in native mode (VITE_PRISM_NATIVE=1).");

/** One request the scripted server saw: path + whether OUR bearer rode it. */
type Seen = { path: string; bearer: string | null };
type Server = { seen: Seen[]; me: (bearer: string | null, n: number) => number; api: (bearer: string | null) => number };

/**
 * The shell: token and call log live in sessionStorage so they survive the page's own
 * reloads the way the real shell's state does (the stub only — host.js itself uses no storage).
 */
async function boot(page: Page, token: string | null = TOKEN): Promise<Server> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(
    ({ source, token }) => {
      if (window.top !== window) return;
      const w = window as any;
      if (sessionStorage.getItem("shell:booted") == null) {
        sessionStorage.setItem("shell:booted", "1");
        if (token) sessionStorage.setItem("shell:token", token);
        sessionStorage.setItem("shell:calls", "[]");
      }
      const log = (c: string) => sessionStorage.setItem("shell:calls", JSON.stringify([...JSON.parse(sessionStorage.getItem("shell:calls")!), c]));
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          if (cmd === "get_token") return Promise.resolve(args.origin === location.origin ? sessionStorage.getItem("shell:token") : null);
          log(cmd === "sign_out" ? `sign_out:${String(args.revoke)}` : cmd);
          if (cmd === "sign_out") sessionStorage.removeItem("shell:token");
          if (cmd === "sign_in") return new Promise(() => {}); // a sheet nobody finishes
          return Promise.resolve(null);
        },
      };
      const meta = document.createElement("meta");
      meta.name = "prism-server-origin";
      meta.content = location.origin; // the "server" is the fixture origin; the spec answers it
      const put = () => document.head.appendChild(meta);
      if (document.head) put();
      else new MutationObserver((_, o) => { if (document.head) { put(); o.disconnect(); } }).observe(document, { childList: true, subtree: true });
      new Function(source.replace("__PRISM_ORIGIN__", JSON.stringify("")).replace("__PRISM_PLATFORM__", JSON.stringify("ios")))();
    },
    { source: HOST_JS, token },
  );
  const server: Server = { seen: [], me: (b) => (b === TOKEN ? 200 : 401), api: (b) => (b === TOKEN ? 200 : 401) };
  let meCount = 0;
  const bearerOf = (route: Route) => route.request().headers()["authorization"]?.replace(/^Bearer /, "") ?? null;
  await page.route("**/auth/me", (route) => {
    const bearer = bearerOf(route);
    server.seen.push({ path: "/auth/me", bearer });
    const status = server.me(bearer, ++meCount);
    return route.fulfill({ status, json: status === 200 ? { authenticated: true, email: "sam@example.com", name: "Sam", isOwner: false, role: "member", vaultId: "v", workspace: { id: "w", name: "W" } } : status === 401 ? { authenticated: false } : { error: "upstream" } });
  });
  await page.route("**/api/**", (route) => {
    const bearer = bearerOf(route);
    server.seen.push({ path: new URL(route.request().url()).pathname, bearer });
    const status = server.api(bearer);
    return route.fulfill({ status, json: status === 200 ? [] : { error: "unauthorized" } });
  });
  await page.route("**/auth/device/revoke", (route) => {
    server.seen.push({ path: "/auth/device/revoke", bearer: bearerOf(route) });
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  return server;
}
const open = async (page: Page) => {
  await page.goto("/e2e-fixtures/ios-shell.html?view=session");
  await expect.poll(() => page.evaluate(() => (window as any).iosFixture?.ready === true)).toBe(true);
  expect(await page.evaluate(() => (window as any).iosFixture.native), "the fixture server must run in native mode").toBe(true);
};
const shell = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("shell:calls") ?? "[]") as string[]);
const get = (page: Page, p: string) => page.evaluate((p) => (window as any).iosFixture.get(p) as Promise<number>, p);
const workspace = (page: Page) => page.getByTestId("workspace");
const signInHeading = (page: Page) => page.getByRole("heading", { name: "Sign in to Prism" });
const anonymous = (s: Server) => s.seen.filter((r) => r.bearer === null);

test("one 401 for a token the server still accepts changes nothing: no sign-out, no sign-in, no new device", async ({ page }) => {
  const server = await boot(page);
  await open(page);
  await expect(workspace(page)).toHaveText("Signed in as sam@example.com");

  // The vault refused the SERVER's token and the 401 reached the app (finding 8, as it was).
  server.api = () => 401;
  const before = server.seen.length;
  expect(await Promise.all(["/api/notes", "/api/actions", "/api/events", "/api/vaults"].map((p) => get(page, p)))).toEqual([401, 401, 401, 401]);
  await page.waitForTimeout(400);
  // The app asked ONE question about its token — and it was fine.
  const asked = server.seen.slice(before).filter((r) => r.path === "/auth/me");
  expect(asked).toEqual([{ path: "/auth/me", bearer: TOKEN }]);
  expect(await shell(page)).toEqual([]); // the token was not forgotten; nothing was started
  await expect(workspace(page)).toBeVisible();

  // The next request simply works, with the same token.
  server.api = (b) => (b === TOKEN ? 200 : 401);
  expect(await get(page, "/api/notes")).toBe(200);
  expect(anonymous(server)).toEqual([]);
});

test("a server that cannot say (502, no answer) is not a sign-out either", async ({ page }) => {
  const server = await boot(page);
  await open(page);
  await expect(workspace(page)).toBeVisible();
  server.api = () => 401;
  server.me = () => 502;
  expect(await get(page, "/api/notes")).toBe(401);
  await page.waitForTimeout(400);
  expect(await shell(page)).toEqual([]);
  await expect(workspace(page)).toBeVisible();
  // "Who am I" answers "could not check", never "signed out".
  expect(await page.evaluate(() => (window as any).iosFixture.me())).toBe("unavailable");
});

test("launch: a 401 on the first /auth/me for a good token does not show the sign-in screen", async ({ page }) => {
  const server = await boot(page);
  server.me = (b, n) => (n === 1 ? 401 : b === TOKEN ? 200 : 401); // the first answer is the flake
  await open(page);
  await expect(workspace(page)).toHaveText("Signed in as sam@example.com");
  await expect(signInHeading(page)).toHaveCount(0);
  expect(await shell(page)).toEqual([]);
});

test("a token the server really revoked: forgotten once, the sign-in SCREEN — and the app starts no sign-in", async ({ page }) => {
  const server = await boot(page);
  await open(page);
  await expect(workspace(page)).toBeVisible();

  // Revoked (Settings → Account → Signed-in devices, on another device).
  server.api = () => 401;
  server.me = () => 401;
  const before = server.seen.length;
  const reloaded = page.waitForEvent("load");
  void Promise.all(["/api/notes", "/api/actions", "/api/events"].map((p) => get(page, p))).catch(() => {});
  await reloaded;
  await expect(signInHeading(page)).toBeVisible();
  await expect(page.getByText("This device was signed out by the server. Sign in again to continue.")).toBeVisible();
  await page.waitForTimeout(600);

  // Forgotten locally once (no revoke call: it is dead already). NO sign_in: no sheet, no
  // consent prompt, no new device — until the person presses the button.
  expect(await shell(page)).toEqual(["sign_out:false"]);
  // And nothing went to the server without a bearer, before or after the reload.
  expect(anonymous(server)).toEqual([]);
  expect(server.seen.slice(before).filter((r) => r.path === "/auth/me")).toEqual([{ path: "/auth/me", bearer: TOKEN }]);

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect(await shell(page)).toEqual(["sign_out:false", "sign_in"]); // one press, one sheet
});

test("the token gone from under a running page: no request leaves without a bearer; the page reloads into sign-in", async ({ page }) => {
  const server = await boot(page);
  await open(page);
  await expect(workspace(page)).toBeVisible();
  const before = server.seen.length;

  // The shell no longer has a token (signed out from the menu, Keychain item removed).
  const reloaded = page.waitForEvent("load");
  await page.evaluate(() => sessionStorage.removeItem("shell:token"));
  // What the workspace would keep asking for (the paths from the server's log, finding 5).
  const statuses = await Promise.all(["/api/notes", "/api/actions", "/api/events", "/auth/me", "/api/vaults"].map((p) => get(page, p).catch(() => -1)));
  for (const s of statuses) expect([401, -1]).toContain(s); // answered locally, or cut off by the reload
  await reloaded;
  await expect(signInHeading(page)).toBeVisible();
  await page.waitForTimeout(400);
  expect(server.seen.slice(before)).toEqual([]); // NOTHING reached the server
  expect(await shell(page)).toEqual([]); // nothing to forget, and no sign-in started
});

test("signing out: the revoke carries the bearer, and nothing is sent after the token is gone", async ({ page }) => {
  const server = await boot(page);
  await open(page);
  await expect(workspace(page)).toBeVisible();
  const before = server.seen.length;
  expect(await page.evaluate(() => (window as any).iosFixture.logout())).toBe(true);
  // A straggler from the workspace that is still mounted until the reload.
  expect(await get(page, "/api/notes")).toBe(401);
  expect(server.seen.slice(before)).toEqual([{ path: "/auth/device/revoke", bearer: TOKEN }]);
  expect(await shell(page)).toEqual(["sign_out:false"]); // onSignedOut: forget; the page revoked
});

test("never signed in: the sign-in screen asks the server nothing and reloads nothing", async ({ page }) => {
  const server = await boot(page, null);
  let loads = 0;
  page.on("load", () => loads++);
  await open(page);
  await expect(signInHeading(page)).toBeVisible();
  await page.waitForTimeout(500);
  expect(server.seen).toEqual([]);
  expect(loads).toBe(1);
  expect(await shell(page)).toEqual([]);
});
