/**
 * The standalone share route (`/collab/:id`) against the REAL server (real-server.ts):
 * the phone comments panel.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());

const editor = (page: Page) => page.locator(".tiptap").first();

test("phone: the comments panel's close button has an accessible name (and no button on the share route is unnamed)", async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await phone.newPage();
  await connect(page, phone, server, "sam");
  await page.goto("/e2e-fixtures/collab-route.html?target=plan");
  await expect(editor(page)).toContainText("Alpha beta gamma");
  await page.getByRole("button", { name: "Comments", exact: true }).tap();
  const close = page.getByRole("button", { name: "Close comments", exact: true });
  await expect(close).toBeVisible();
  // The whole surface with the panel open: every button has a name a screen reader can say.
  const unnamed = (await new AxeBuilder({ page }).withRules(["button-name"]).analyze()).violations.flatMap((v) => v.nodes.map((n) => n.html.slice(0, 160)));
  expect(unnamed).toEqual([]);
  await close.tap();
  await expect(close).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
  await phone.close();
});
