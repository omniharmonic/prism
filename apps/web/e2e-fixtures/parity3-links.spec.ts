/**
 * Parity pass 3 · NP-PG-16: "Copy link gives a URL that opens the same page on another
 * device … and respects access." The link is `/page/<id>` (pages-nav › "…copy link…").
 * Here that address is opened cold — main.tsx's own routing, against the REAL server
 * (gateway + collab over the fake vault): the page opens for people who may see it and
 * says nothing about itself to people who may not.
 *
 * Fixture: collab-route.html?page=<id> puts the browser at /page/<id> and boots the app.
 * (The iOS app half of the row, NP-NA-04, needs a device.)
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());

const openLink = async (page: Page, who: "owner" | "sam" | "eve" | "gina", id: string) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await connect(page, page.context(), server, who);
  await page.goto(`/e2e-fixtures/collab-route.html?page=${encodeURIComponent(id)}`);
};
const SECRET = "Fictional budget for the plan.";

test("page URL routes to page", async ({ page }) => {
  await openLink(page, "owner", "plan");
  // The address is the page link, and the workspace opened on exactly that page.
  expect(new URL(page.url()).pathname).toBe("/page/plan");
  const doc = page.locator("#workspace-document");
  await expect(doc.locator(".tiptap").first()).toContainText("Alpha beta gamma");
  await expect(doc.locator(".tiptap").first()).toContainText("Second paragraph here.");
  await expect(page.getByRole("navigation", { name: "Open document tabs" }).getByRole("button", { name: "Open Plan", exact: true })).toBeVisible();
  // It is the workspace (sidebar and all), not a bare share page.
  await expect(page.locator(".workspace-navigation").first()).toBeVisible();
});

test("page URL: a second device opens the same page (another account with access)", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openLink(page, "eve", "plan");
  await expect(page.locator("#workspace-document .tiptap").first()).toContainText("Alpha beta gamma");
  // A sub-page link opens the sub-page, not its parent.
  const second = await context.newPage();
  await connect(second, context, server, "eve");
  await second.goto("/e2e-fixtures/collab-route.html?page=notes");
  await expect(second.locator("#workspace-document .tiptap").first()).toContainText("Child notes about the plan.");
  await expect(second.locator("#workspace-document")).not.toContainText("Alpha beta gamma");
  await context.close();
});

test("page URL respects access: a guest opens what was shared and nothing else", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openLink(page, "gina", "plan");
  // Shared with her (view): the page opens, read-only.
  const body = page.locator("#workspace-document .tiptap").first();
  await expect(body).toContainText("Alpha beta gamma");
  await expect(body).toHaveAttribute("contenteditable", "false");
  await context.close();

  // The link to a page that was NOT shared: no title, no text, the same answer as a missing page.
  for (const [who, id] of [["gina", "secret"], ["sam", "secret"], ["gina", "no-such-page"]] as const) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await openLink(p, who, id);
    await expect(p.getByRole("heading", { name: "Document unavailable" })).toBeVisible();
    await expect(p.locator("body")).not.toContainText(SECRET);
    await expect(p.locator("body")).not.toContainText("Budget");
    await expect(p.locator(".tiptap")).toHaveCount(0);
    await ctx.close();
  }
});

test("page URL: signed out, the link shows the sign-in screen and nothing of the page", async ({ browser }, info) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // No session: only the server routing, no cookie.
  await page.route((url) => /^\/(api|auth|acl)(\/|$)/.test(url.pathname), async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:${server.port}${url.pathname}${url.search}` }).catch(() => null);
    if (response) await route.fulfill({ response }); else await route.abort();
  });
  void info;
  await page.goto("/e2e-fixtures/collab-route.html?page=plan");
  await expect(page.getByRole("button", { name: /sign in|log in|continue/i }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Alpha beta gamma");
  await expect(page.locator(".tiptap")).toHaveCount(0);
  await context.close();
});
