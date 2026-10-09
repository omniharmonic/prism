/**
 * Native shell bridges, page half (NP-NA-04 universal / deep links · NP-SB-13 ⌘N).
 *
 * The Prism Client (apps/client) hands the web app two things through its host hook:
 *   - an incoming link, as a VALIDATED CLIENT PATH: `__PRISM_SHELL__.openLink("/page/<id>")`
 *     → held by host.js → a payload-free `prism:open-link` event → `native/appLinks.ts`
 *     takes it and opens a TAB (never a navigation);
 *   - File → New Page (⌘N): a payload-free `prism:new-page` window event.
 *
 * These specs load the shell's REAL host hook (apps/client/src-tauri/src/host.js, the
 * script the shell injects before the app) into the fixture page, so what is exercised
 * is the same JavaScript the app ships — with a stub IPC, since no shell is attached.
 * The link journeys run against the REAL server (gateway + collab over the fake vault):
 * a link opens the page for people who may see it and tells the others nothing.
 *
 * What a browser cannot show: the OS handing the URL to the app (needs a signed build
 * whose Associated Domains entitlement matches a host serving the association file),
 * and the Rust validator (cargo test, links.rs).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = fs.readFileSync(path.resolve(here, "../../client/src-tauri/src/host.js"), "utf8");

let server: RealServer;
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());

/** Inject the shell's host hook (as the shell does: before any app script), over a stub IPC. `early` = a link the shell delivered before the app booted. */
async function installHostHook(page: Page, early?: string) {
  await page.addInitScript(
    ({ source, early }) => {
      if (window.top !== window) return;
      (window as any).__TAURI_INTERNALS__ = { invoke: () => Promise.resolve(null) };
      const origin = JSON.stringify(location.origin);
      // host.rs replaces both placeholders with JSON string literals, once each.
      new Function(source.replace("__PRISM_ORIGIN__", origin).replace("__PRISM_PLATFORM__", JSON.stringify("macos")))();
      if (early) (window as any).__PRISM_SHELL__.openLink(early);
    },
    { source: HOST_JS, early: early ?? null },
  );
}

const workspace = async (page: Page, who: "owner" | "sam" | "eve" | "gina", early?: string) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHostHook(page, early);
  await connect(page, page.context(), server, who);
  await page.goto("/e2e-fixtures/collab-route.html?app");
};
const deliver = (page: Page, link: string) => page.evaluate((link) => (window as any).__PRISM_SHELL__.openLink(link), link);
const tabs = (page: Page) => page.getByRole("navigation", { name: "Open document tabs" });
const SECRET = "Fictional budget for the plan.";

test("native link: the shell's path opens that page as a tab — no navigation", async ({ page }) => {
  await workspace(page, "owner");
  await expect(page.locator(".workspace-navigation").first()).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: "Open Plan", exact: true })).toHaveCount(0);
  const navigations: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });

  await deliver(page, "/page/plan");
  const doc = page.locator("#workspace-document");
  await expect(doc.locator(".tiptap").first()).toContainText("Alpha beta gamma");
  await expect(tabs(page).getByRole("button", { name: "Open Plan", exact: true })).toBeVisible();
  // The app stayed where it was: a link is a tab, not an address.
  expect(new URL(page.url()).pathname).toBe("/");
  expect(navigations).toEqual([]);
  // The hook handed the path over once: nothing is left to take.
  expect(await page.evaluate(() => (window as any).__PRISM_SHELL__.takePendingLink())).toBeNull();

  // A second link while the app is running opens the other page.
  await deliver(page, "/page/notes");
  await expect(doc.locator(".tiptap").first()).toContainText("Child notes about the plan.");
  expect(navigations).toEqual([]);
});

test("native link: one delivered before the app mounted is opened once the workspace is up (cold start)", async ({ page }) => {
  await workspace(page, "eve", "/page/plan");
  await expect(page.locator("#workspace-document .tiptap").first()).toContainText("Alpha beta gamma");
  await expect(tabs(page).getByRole("button", { name: "Open Plan", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("native link: one that arrives at the sign-in screen (no session, or a token the server rejects) opens after sign-in", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHostHook(page);
  await connect(page, page.context(), server, "owner");
  await page.context().clearCookies(); // the server answers /auth/me with "not signed in"
  const me = page.waitForResponse((r) => new URL(r.url()).pathname === "/auth/me");
  await page.goto("/e2e-fixtures/collab-route.html?app");
  await me;
  await expect(page.locator(".workspace-navigation")).toHaveCount(0);

  // The shell hands the link over (it only knows that A token exists): nothing opens, nothing navigates…
  await deliver(page, "/page/plan");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("prism:pending-link"))).toContain('"/page/plan"');
  await expect(page.locator(".workspace-navigation")).toHaveCount(0);
  // …and what is kept is the validated path only.
  const kept = JSON.parse((await page.evaluate(() => sessionStorage.getItem("prism:pending-link")))!);
  expect(Object.keys(kept).sort()).toEqual(["at", "path"]);
  // A refused value is never kept, signed out or not.
  await deliver(page, "/auth/logout");
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("prism:pending-link")))!).path).toBe("/page/plan");

  // Sign-in completes and the shell reloads the page (host.js signIn): the hook's own copy is gone.
  await page.context().addCookies([{ name: "prism_session", value: server.sessions.owner, domain: "127.0.0.1", path: "/" }]);
  await page.goto("/e2e-fixtures/collab-route.html?app");
  await expect(page.locator("#workspace-document .tiptap").first()).toContainText("Alpha beta gamma");
  await expect(tabs(page).getByRole("button", { name: "Open Plan", exact: true })).toBeVisible();
  // Opened once: nothing is left to replay on the next reload.
  expect(await page.evaluate(() => sessionStorage.getItem("prism:pending-link"))).toBeNull();
});

test("native link: a link kept for sign-in expires", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHostHook(page);
  await page.addInitScript(() => {
    if (window.top !== window || sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    sessionStorage.setItem("prism:pending-link", JSON.stringify({ path: "/page/plan", at: Date.now() - 11 * 60_000 }));
  });
  await connect(page, page.context(), server, "owner");
  await page.goto("/e2e-fixtures/collab-route.html?app");
  await expect(page.locator(".workspace-navigation").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("prism:pending-link"))).toBeNull();
  await page.waitForTimeout(300);
  await expect(tabs(page).getByRole("button", { name: "Open Plan", exact: true })).toHaveCount(0);
});

test("native link respects access: a page that was not shared says nothing about itself", async ({ browser }) => {
  for (const [who, id] of [["gina", "secret"], ["sam", "secret"], ["gina", "no-such-page"]] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await workspace(page, who);
    await expect(page.locator(".workspace-navigation").first()).toBeVisible();
    await deliver(page, `/page/${id}`);
    await expect(page.getByRole("heading", { name: "Document unavailable" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(SECRET);
    await expect(page.locator("body")).not.toContainText("Budget");
    await context.close();
  }
  // What WAS shared opens, with the access the share gives (view → not editable).
  const context = await browser.newContext();
  const page = await context.newPage();
  await workspace(page, "gina");
  await expect(page.locator(".workspace-navigation").first()).toBeVisible();
  await deliver(page, "/page/plan");
  const body = page.locator("#workspace-document .tiptap").first();
  await expect(body).toContainText("Alpha beta gamma");
  await expect(body).toHaveAttribute("contenteditable", "false");
  await context.close();
});

test("native link: anything but an allowed path is refused — no tab, no navigation, no request", async ({ page }) => {
  await workspace(page, "owner");
  await expect(page.locator(".workspace-navigation").first()).toBeVisible();
  const navigations: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  const logouts: string[] = [];
  page.on("request", (r) => { if (/\/auth\/(logout|device)/.test(new URL(r.url()).pathname)) logouts.push(r.url()); });
  const tabCount = () => tabs(page).getByRole("button", { name: /^Open / }).count();
  const start = await tabCount();

  for (const bad of [
    "/auth/logout", "/auth/device/authorize", "/accept-invite", "/api/notes/plan", "/p/site", "/mcp",
    "/page/plan?t=cap", "/page/plan#x", "/page/a/b", "/page/..", "/page/%2e%2e", "/page/a%2Fb", "/page/", "/page",
    "/collab/plan", // the shell maps a /collab link to /page/<id>; the page half only knows the canonical form
    "/inbox/a/b", "/agent/not-a-uuid", "/PAGE/plan", "/pages/plan", "/home", "/",
  ]) {
    await deliver(page, bad);
  }
  // Values the host hook itself drops (not a path at all): the app is never told.
  for (const bad of ["https://evil.example/page/plan", "//evil.example/page/plan", "javascript:alert(1)", "", "page/plan"]) {
    await deliver(page, bad);
  }
  // A page script that fires the event with a payload of its own gets nothing: the path only comes from the shell object.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:open-link", { detail: { path: "/page/plan" } })));

  await page.waitForTimeout(300);
  expect(await tabCount()).toBe(start);
  await expect(tabs(page).getByRole("button", { name: "Open Plan", exact: true })).toHaveCount(0);
  expect(navigations).toEqual([]);
  expect(logouts).toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/");
  // The person is told, in the shell's own toast.
  await expect(page.locator("#prism-host-toast")).toHaveText("This link can’t be opened in Prism.");
});

test("native link: /inbox opens the Inbox tab", async ({ page }) => {
  await workspace(page, "owner");
  await expect(page.locator(".workspace-navigation").first()).toBeVisible();
  await deliver(page, "/inbox");
  await expect(tabs(page).getByRole("button", { name: "Open Inbox", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

// ── ⌘N (NP-SB-13): File → New Page in the native shell ───────────────────────────────

const openTabs = (page: Page) => page.evaluate(() => (window as any).prismShellUI.getState().openTabs.length as number);
const title = (page: Page) => page.getByRole("textbox", { name: "Document title" });

test("native New Page: the shell's event creates ONE untitled page with its title focused", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const before = await openTabs(page);

  // What menu.rs evals for File → New Page.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:new-page")));
  await expect(title(page)).toBeFocused();
  await expect(title(page)).toHaveValue(/^Untitled/);
  expect(await openTabs(page)).toBe(before + 1);
  await title(page).press("Escape");

  // One key press can reach the app twice (the menu item AND the webview's own keydown): still one page.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("prism:new-page"));
    window.dispatchEvent(new CustomEvent("prism:new-page"));
  });
  await expect(title(page)).toBeFocused();
  await expect.poll(() => openTabs(page)).toBe(before + 2);
  await page.waitForTimeout(400);
  expect(await openTabs(page)).toBe(before + 2);
  await title(page).press("Escape");

  // Never behind a dialog: the menu item is still clickable while a modal is open.
  await page.getByRole("button", { name: "Page actions", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:new-page")));
  await page.waitForTimeout(400);
  expect(await openTabs(page)).toBe(before + 2);
});

test("⌘N is listed only where it works: not in a browser tab, yes in the native shell", async ({ page, browser }) => {
  // A browser tab: the browser keeps ⌘N, so neither the sheet nor the palette advertises it.
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.getByRole("button", { name: "Page actions", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+/");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".prism-shortcuts-row").filter({ hasText: "Quick find" })).toHaveCount(1);
  await expect(sheet.locator(".prism-shortcuts-row").filter({ hasText: /^New page/ })).toHaveCount(0);
  await expect(sheet.locator("kbd").filter({ hasText: /^(⌘N|Ctrl\+N)$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("combobox", { name: "Search notes and commands" });
  await search.fill("new page");
  const commands = page.getByRole("group", { name: "Commands" });
  const row = commands.getByRole("option", { name: "New page", exact: true });
  await expect(row).toBeVisible();
  expect(await row.getAttribute("aria-keyshortcuts")).toBeNull();
  await expect(row.locator("kbd")).toHaveCount(0);
  // A binding that does work here still shows its hint (the table is not simply empty).
  await search.fill("settings");
  await expect(commands.getByRole("option", { name: "Settings", exact: true }).locator("kbd")).toHaveText(/^(⌘,|Ctrl\+,)$/);

  // The native shell (its host hook is present): the row is there, with the key.
  const context = await browser.newContext();
  const native = await context.newPage();
  await installHostHook(native);
  await native.goto("/e2e-fixtures/notion-shell.html");
  await expect(native.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await native.getByRole("button", { name: "Page actions", exact: true }).focus();
  await native.keyboard.press("ControlOrMeta+/");
  const nativeSheet = native.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(nativeSheet).toBeVisible();
  const newPage = nativeSheet.locator(".prism-shortcuts-row").filter({ hasText: /^New page/ });
  await expect(newPage).toHaveCount(1);
  await expect(newPage.locator("kbd")).toHaveText(/^(⌘N|Ctrl\+N)$/);
  await native.keyboard.press("Escape");
  await native.keyboard.press("ControlOrMeta+k");
  await native.getByRole("combobox", { name: "Search notes and commands" }).fill("new page");
  const nativeRow = native.getByRole("group", { name: "Commands" }).getByRole("option", { name: "New page", exact: true });
  await expect(nativeRow.locator("kbd")).toHaveText(/^(⌘N|Ctrl\+N)$/);
  await expect(nativeRow).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+N$/i);
  await context.close();
});

test("Ctrl+N in a text field on a Mac is 'next line', not New Page (the binding there is ⌘N)", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  test.skip(!mac, "Ctrl+N is the binding itself on other platforms");
  const before = await openTabs(page);
  await editor.click();
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(400);
  expect(await openTabs(page)).toBe(before);
  await expect(title(page)).toHaveCount(0);
  // ⌘N reaches the page only in the native shell (a browser never delivers it); the handler takes it.
  await page.evaluate(() => {
    const e = new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(e);
  });
  await expect(title(page)).toBeFocused();
  expect(await openTabs(page)).toBe(before + 1);
});

test("desktop sign-in: a second press RESTARTS the flow (the shell cancels the first), and a 401 never starts one", async ({ page }) => {
  // The desktop half of the one-at-a-time rule (host.js signIn). The browser tab may have been
  // closed, so a second press must be able to start again; the shell (state.rs begin_sign_in,
  // `new_sign_in_cancels_the_previous_one`) cancels the first attempt's listener first.
  await page.addInitScript(
    ({ source }) => {
      if (window.top !== window) return;
      const w = window as any;
      w.ipcCalls = [] as string[];
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          w.ipcCalls.push(cmd === "sign_out" ? `sign_out:${String(args.revoke)}` : cmd);
          if (cmd !== "sign_in") return Promise.resolve(null);
          // As the shell does: starting a sign-in cancels the one before it.
          w.cancelPrevious?.("Sign-in cancelled");
          return new Promise((_, no) => { w.cancelPrevious = no; });
        },
      };
      new Function(source.replace("__PRISM_ORIGIN__", JSON.stringify(location.origin)).replace("__PRISM_PLATFORM__", JSON.stringify("macos")))();
    },
    { source: HOST_JS },
  );
  await page.goto("/e2e-fixtures/harness.html");
  const ipc = () => page.evaluate(() => (window as any).ipcCalls as string[]);
  await page.evaluate(() => { const h = (window as any).__PRISM_HOST__; void h.signIn(); void h.signIn(); });
  await expect.poll(ipc).toEqual(["sign_in", "sign_in"]);
  // The cancelled first attempt is not reported as a failure.
  await expect(page.locator("#prism-host-toast")).toHaveText("Continue in your browser to sign in…");

  // The server refused the token: forget it. Nothing else — no third sign-in.
  await page.evaluate(() => (window as any).__PRISM_HOST__.onUnauthorized());
  await page.waitForTimeout(200);
  expect(await ipc()).toEqual(["sign_in", "sign_in", "sign_out:false"]);
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

test("native embeds: YouTube and Vimeo play in a frame with no popups; every other provider stays an 'Open in …' card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Never reach the internet from a fixture: a provider's frame gets an empty page.
  await page.route(/^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com|www\.loom\.com|www\.figma\.com|docs\.google\.com|open\.spotify\.com|platform\.twitter\.com)\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>player</title>" }));
  // The REAL host hook over an IPC that records what the page asks of the shell.
  await page.addInitScript(({ source }) => {
    if (window.top !== window) return;
    const w = window as any;
    w.ipcCalls = [] as Array<{ cmd: string; args: unknown }>;
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: unknown) => { w.ipcCalls.push({ cmd, args }); return Promise.resolve(null); } };
    new Function(source.replace("__PRISM_ORIGIN__", JSON.stringify(location.origin)).replace("__PRISM_PLATFORM__", JSON.stringify("macos")))();
  }, { source: HOST_JS });
  const popups: string[] = [];
  page.context().on("page", (p) => popups.push(p.url()));
  await page.goto(EMBED_PAGE);

  // What the shell tells the page it may frame: exactly the two players of its CSP, and the page cannot change it.
  const advertised = await page.evaluate(() => {
    const host = (window as any).__PRISM_HOST__;
    let pushed = false;
    try { host.frameOrigins.push("https://evil.example"); pushed = true; } catch { /* frozen */ }
    try { host.frameOrigins = ["https://evil.example"]; } catch { /* frozen */ }
    return { origins: [...host.frameOrigins], pushed };
  });
  expect(advertised).toEqual({ origins: ["https://www.youtube-nocookie.com", "https://player.vimeo.com"], pushed: false });

  const blocks = page.locator(".prism-embed");
  await expect(blocks).toHaveCount(EMBEDS.length);
  const frames = page.locator(".prism-embed iframe");
  await expect(frames).toHaveCount(2);
  for (const [i, [url, label, player]] of EMBEDS.entries()) {
    const block = blocks.nth(i);
    if (player) {
      const frame = block.locator("iframe");
      await expect(frame).toHaveAttribute("src", new RegExp("^" + player.replace(/[.?/]/g, "\\$&")));
      // No allow-popups in the app (and still no top-navigation, forms or downloads).
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
      await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      await expect(block.getByRole("link", { name: `Open in ${label}` })).toHaveAttribute("href", url);
    } else {
      await expect(block).toHaveAttribute("data-fallback", "true");
      await expect(block.locator("iframe")).toHaveCount(0);
      await expect(block).toContainText(`Open in ${label}`);
      await expect(block).toContainText("only YouTube and Vimeo play inside the app");
    }
  }
  // The way out of a player is the block's own link: it goes to the shell (native confirmation), never a popup or a navigation.
  await blocks.nth(0).getByRole("link", { name: "Open in YouTube" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).ipcCalls.filter((c: any) => c.cmd === "open_external"))).toEqual([{ cmd: "open_external", args: { url: EMBEDS[0]![0] } }]);
  expect(popups).toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/e2e-fixtures/notion-media.html");
});
