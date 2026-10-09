import { test, expect, type Page, type Browser, type BrowserContext } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

/**
 * Slice I · NP-PG-03 "a collab title edit syncs to other clients": a rename (a move of the page)
 * made by one person reaches everyone who has the page OPEN as a live document — in the workspace
 * and on the share page — without reopening it, without remounting the editor, and without
 * replacing a title someone is typing. Real server (gateway, move route, collab socket) over the
 * in-memory vault; this fixture bridges no `/api/events`, so the signal asserted here is the
 * server's "prism:page-changed" socket message (the workspace also follows its own note query).
 */
let server: RealServer;
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());
test.setTimeout(90_000);

type Who = "owner" | "sam" | "eve" | "gina";
const editor = (page: Page) => page.locator(".tiptap").first();
async function device(browser: Browser, who: Who, url: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await connect(page, context, server, who);
  await page.goto(url);
  return { page, context };
}
const share = (id: string) => `/e2e-fixtures/collab-route.html?target=${id}`;
const inApp = (id: string) => `/e2e-fixtures/collab-route.html?page=${id}`;
async function live(page: Page) {
  await expect(editor(page)).toBeVisible();
  await expect(page.getByText(/Live · /)).toBeVisible();
  await expect(editor(page)).not.toHaveText("");
}
const pathOf = async (id: string) => ((await server.note(id)) as unknown as { path?: string } | null)?.path;
async function rename(page: Page, from: string, to: string) {
  await page.getByRole("button", { name: `Rename ${from}`, exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill(to);
  await title.press("Enter");
  await expect(page.getByRole("heading", { name: `Rename ${to}`, exact: true })).toBeVisible();
}
/** Mark the editor's DOM node, to see later that it is the same one (never remounted). */
const tag = (page: Page) => page.evaluate(() => { (document.querySelector(".tiptap") as any).__same = true; });
const sameEditor = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as any)?.__same === true);

test("a rename reaches another client that has the page open — workspace and share page — and the editor is never remounted", async ({ browser }) => {
  const owner = await device(browser, "owner", inApp("notes"));
  const eve = await device(browser, "eve", inApp("notes"));
  const guest = await device(browser, "sam", share("notes")); // the share page: no workspace shell
  for (const d of [owner, eve, guest]) await live(d.page);
  for (const d of [eve, guest]) await expect(d.page.getByRole("heading", { name: /Notes$/ })).toBeVisible();
  // Eve is typing in the body; her caret is in the text.
  await eve.page.getByText("Child notes about the plan.").click();
  await eve.page.keyboard.press("End");
  await eve.page.keyboard.type(" Eve was here");
  await tag(eve.page);
  await tag(guest.page);

  await rename(owner.page, "Notes", "Meeting notes");
  await expect.poll(() => pathOf("notes")).toBe("vault/Shared/Plan/Meeting notes");

  // Both other clients show the new title without reopening the page.
  await expect(eve.page.getByRole("heading", { name: "Rename Meeting notes", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(eve.page.getByRole("heading", { name: "Rename Notes", exact: true })).toHaveCount(0);
  await expect(guest.page.getByRole("heading", { name: /Meeting notes$/ })).toBeVisible({ timeout: 15_000 });
  // The live document was never interrupted: same editor node, still live, and Eve keeps typing where she was.
  expect(await sameEditor(eve.page)).toBe(true);
  expect(await sameEditor(guest.page)).toBe(true);
  await expect(eve.page.getByText(/Live · /)).toBeVisible();
  await eve.page.keyboard.type(" and still is.");
  await expect(editor(owner.page)).toContainText("Eve was here and still is.");
  // The breadcrumb under the title follows too.
  await expect(eve.page.locator(".document-page-heading")).not.toContainText("Rename Notes");
  for (const d of [owner, eve, guest]) await d.context.close();
});

test("a title someone is typing is not replaced by a rename made elsewhere; a person's own renames always win", async ({ browser }) => {
  const owner = await device(browser, "owner", inApp("plan"));
  const eve = await device(browser, "eve", inApp("plan"));
  for (const d of [owner, eve]) await live(d.page);
  // Another page than the first test's (that one was just typed in: its live document is still being
  // stored, and this fixture's request bridge drops the `no-cache` of the rename's fresh read).
  const current = (await pathOf("plan"))!.split("/").pop()!;
  // Eve opens the title field and types a draft.
  await eve.page.getByRole("button", { name: `Rename ${current}`, exact: true }).click();
  const draft = eve.page.getByRole("textbox", { name: "Document title" });
  await draft.fill("Eve's draft title");
  // The owner renames the page meanwhile — twice, quickly: the second name is the one that stays.
  await rename(owner.page, current, "First title");
  await rename(owner.page, "First title", "Second title");
  await expect.poll(() => pathOf("plan")).toBe("vault/Shared/Second title");
  await owner.page.waitForTimeout(2000); // every echo of the first rename has arrived by now
  await expect(owner.page.getByRole("heading", { name: "Rename Second title", exact: true })).toBeVisible();
  await expect(owner.page.getByRole("heading", { name: "Rename First title", exact: true })).toHaveCount(0);
  // Eve's field still holds what she typed (no echo replaced it) …
  await expect(draft).toHaveValue("Eve's draft title");
  // … and when she leaves it, the title is where the page is now.
  await draft.press("Escape");
  await expect(eve.page.getByRole("heading", { name: "Rename Second title", exact: true })).toBeVisible({ timeout: 15_000 });
  for (const d of [owner, eve]) await d.context.close();
});

/**
 * I-1: a page with a stored title whose FILE is moved / renamed elsewhere keeps showing its stored
 * title on other clients — the open document's name is "stored title, else file name", as at open.
 * (Last: it changes the shared "notes" page for good.)
 */
test("a page with a stored title keeps that title on another client's tab when its file moves", async ({ browser }) => {
  const owner = await device(browser, "owner", inApp("plan"));
  await live(owner.page);
  // The page gets a stored title (as imported pages and older database rows have).
  const api = (path: string, body: unknown) => owner.page.evaluate(async ([p, b]) => {
    const r = await fetch(p as string, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return r.status;
  }, [path, body] as const);
  expect(await api("/api/properties/notes", { set: { title: "A stored title" } })).toBe(200);
  const eve = await device(browser, "eve", inApp("notes"));
  await live(eve.page);
  const tabs = eve.page.getByRole("navigation", { name: "Open document tabs" });
  await expect(tabs.getByRole("button", { name: "Open A stored title", exact: true })).toBeVisible();
  // Its file is renamed through the move route alone (the stored title is not touched).
  const before = (await pathOf("notes"))!;
  const fresh = await owner.page.evaluate(async () => (await (await fetch("/api/notes/notes", { credentials: "include", cache: "no-store" })).json()).updatedAt as string);
  // (Beside where it is now — the earlier tests renamed its parent — so it stays inside the shared page.)
  const target = `${before.slice(0, before.lastIndexOf("/"))}/notes-file-2`;
  expect(await api("/api/notes/notes/move", { newPath: target, if_updated_at: fresh })).toBe(200);
  await expect.poll(() => pathOf("notes")).toBe(target);
  // Eve's open document learned of it (the page heading is the file name) …
  await expect(eve.page.getByRole("heading", { name: "Rename notes-file-2", exact: true })).toBeVisible({ timeout: 15_000 });
  // … and her tab still carries the stored title, not the file name.
  await eve.page.waitForTimeout(500);
  await expect(tabs.getByRole("button", { name: "Open A stored title", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /notes-file-2/ })).toHaveCount(0);
  for (const d of [owner, eve]) await d.context.close();
});
