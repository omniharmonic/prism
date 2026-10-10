/**
 * NP-CO-11 — presence avatars in the page header, against the REAL server's
 * collab socket: two people on one page; clicking an avatar jumps to that
 * person's caret; a phone shows one compact count.
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());

async function open(page: Page, who: "owner" | "eve", id = "plan") {
  await connect(page, page.context(), server, who);
  await page.goto(`/e2e-fixtures/collab-route.html?target=${id}`);
  await expect(page.locator(".tiptap")).not.toHaveText("");
  await expect(page.getByText(/Live · /)).toBeVisible();
}

test("header avatars and jump to cursor", async ({ page, browser }) => {
  await open(page, "owner");
  const eve = await browser.newPage();
  await open(eve, "eve");
  // Eve puts her caret in the second paragraph.
  await eve.getByText("Second paragraph here.").click();
  // Mounted through PageHeader's `presence` slot (the page's top line), not the status row.
  const presence = page.locator('.document-page-header [data-slot="presence"]').getByRole("group", { name: /on this page/ });
  const avatar = presence.getByRole("button", { name: "Eve Editor: jump to their cursor" });
  await expect(avatar).toBeVisible();
  await expect(avatar).toContainText("EE");
  await expect(page.locator(".collaboration-carets__caret", { hasText: "Eve Editor" })).toHaveCount(1);
  await avatar.click();
  await expect(page.locator('.collaboration-carets__caret[data-prism-flash]')).toContainText("Eve Editor");
  await expect(page.getByRole("status").filter({ hasText: "Jumped to Eve Editor." })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("presence-desktop.png") });
  // Phone: one compact count that lists who is here.
  await page.setViewportSize({ width: 390, height: 844 });
  const count = presence.getByRole("button", { name: /1 person on this page/ });
  await expect(count).toBeVisible();
  await count.click();
  await expect(page.getByRole("list", { name: "On this page" })).toContainText("Eve Editor");
  await page.screenshot({ path: test.info().outputPath("presence-phone.png") });
  await eve.close();
});
