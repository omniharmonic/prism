/**
 * The standalone share route (`/collab/:id`) against the REAL server (real-server.ts):
 * the phone comments panel, and where a Prism page link goes for a share-link viewer.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connect, connectLink, startRealServer, type RealServer } from "./real-server";

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

test("a share-link viewer's page link opens the share route for the target with the SAME link; the gateway decides access", async ({ browser, baseURL }) => {
  // A page inside the shared page's subtree that links to a sibling inside it and to a page outside it.
  expect(await server.add({ id: "hub", path: "vault/Shared/Plan/Hub", content: '<p>Read <a href="/page/notes">the notes</a> first, then <a href="/page/secret">the budget</a>.</p>' })).toBe(true);
  const token = await server.link({ resourceType: "page", resource: "plan", level: "view" });
  const origin = new URL(baseURL!).origin;

  const guest = await browser.newContext(); // no session: the link is the only credential
  // The tab a link opens is inert here (the fixture server has no `/collab/…` page of its own).
  await guest.route((url) => url.pathname.startsWith("/collab/") || url.pathname.startsWith("/page/"), (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>opened</title>" }));
  const page = await guest.newPage();
  await connectLink(page, server);
  const share = (id: string) => `/e2e-fixtures/collab-route.html?target=${id}&token=${encodeURIComponent(token)}`;
  await page.goto(share("hub"));
  await expect(editor(page)).toContainText("the notes");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");

  const opened = async (name: string) => {
    const [tab] = await Promise.all([guest.waitForEvent("page"), page.getByRole("link", { name, exact: true }).click()]);
    await tab.waitForURL((url) => url.origin === origin);
    const url = new URL(tab.url());
    await tab.close();
    return url;
  };
  const inside = await opened("the notes");
  expect(inside.origin).toBe(origin);
  expect(inside.pathname).toBe("/collab/notes");
  expect(inside.searchParams.get("t")).toBe(token);
  expect([...inside.searchParams.keys()]).toEqual(["t"]);
  // This window never moved, and the token is in no other place than that one URL.
  expect(new URL(page.url()).pathname).toBe("/collab/hub");
  expect(await page.locator(".tiptap a").evaluateAll((links) => links.map((a) => a.getAttribute("href")))).toEqual(["/page/notes", "/page/secret"]);

  // The same link really does open the target the grant covers…
  await page.goto(share("notes"));
  await expect(editor(page)).toContainText("Child notes about the plan.");
  // …and a page outside the grant opens the same way and is the ordinary no-access page — not a sign-in.
  const outside = await opened2(page, guest, share("hub"), "the budget", origin);
  expect(outside.pathname).toBe("/collab/secret");
  expect(outside.searchParams.get("t")).toBe(token);
  await page.goto(share("secret"));
  await expect(page.getByRole("alert")).toContainText("This shared document could not be opened");
  await expect(page.getByText("Fictional budget")).toHaveCount(0);
  await guest.close();

  // A signed-in person on the share route has no link token: the page's own address, as before.
  const member = await browser.newContext();
  await member.route((url) => url.pathname.startsWith("/page/"), (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>opened</title>" }));
  const mine = await member.newPage();
  await connect(mine, member, server, "sam");
  await mine.goto("/e2e-fixtures/collab-route.html?target=hub");
  await expect(editor(mine)).toContainText("the notes");
  const [tab] = await Promise.all([member.waitForEvent("page"), mine.getByRole("link", { name: "the notes", exact: true }).click()]);
  await tab.waitForURL((url) => url.origin === origin);
  expect(new URL(tab.url()).pathname).toBe("/page/notes");
  expect(new URL(tab.url()).search).toBe("");
  await member.close();
});

async function opened2(page: Page, context: import("@playwright/test").BrowserContext, back: string, name: string, origin: string): Promise<URL> {
  await page.goto(back);
  await expect(editor(page)).toContainText(name);
  const [tab] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name, exact: true }).click()]);
  await tab.waitForURL((url) => url.origin === origin);
  const url = new URL(tab.url());
  await tab.close();
  return url;
}
