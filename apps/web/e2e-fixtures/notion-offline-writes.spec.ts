import { test, expect, type Page } from "@playwright/test";

/**
 * Wave 2E review H2/H3/M3: offline writes through the REAL App + React Query +
 * HttpVaultClient + outbox, against a fixture that enforces the vault's CAS.
 */
const editor = (page: Page) => page.locator(".tiptap[contenteditable=true]");
async function type(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}
const outbox = (page: Page) => page.evaluate(() => new Promise<Array<{ method: string; path: string; body?: string; state?: string; kind?: string }>>((resolve) => {
  const open = indexedDB.open("prism-web");
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("outbox")) return resolve([]);
    const all = db.transaction("outbox").objectStore("outbox").getAll();
    all.onsuccess = () => resolve(all.result);
    all.onerror = () => resolve([]);
  };
  open.onerror = () => resolve([]);
}));
const writes = (page: Page) => page.evaluate(() => (window as any).prismShell.writes as Array<{ method: string; path: string; body: any }>);
const serverNote = (page: Page, id: string) => page.evaluate((id) => { const n = (window as any).prismShell.note(id); return { content: n.content as string, metadata: n.metadata as Record<string, unknown> }; }, id);
async function ready(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/notion-shell.html${query}`);
  await expect(editor(page)).toBeVisible();
  await expect(page.locator(".sync-state-header")).toHaveText("Saved");
}

test("two offline edits to one page land as one save on reconnect, with no review", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await type(page, " First offline edit.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  await type(page, " Second offline edit.");
  await expect.poll(async () => (await outbox(page))[0]?.body ?? "", { timeout: 8000 }).toContain("Second offline edit.");
  const rows = await outbox(page);
  expect(rows).toHaveLength(1); // coalesced: one row, first base revision, latest content
  expect(rows[0]!.state).toBe("queued");
  await context.setOffline(false);
  await expect(page.locator(".sync-state-header")).toHaveText("Saved", { timeout: 15000 });
  const sent = (await writes(page)).filter((w) => w.method === "PATCH" && w.path.endsWith("/workspace"));
  expect(sent).toHaveLength(1);
  const server = await serverNote(page, "workspace");
  expect(server.content).toContain("First offline edit.");
  expect(server.content).toContain("Second offline edit.");
  expect(await outbox(page)).toHaveLength(0);
  await expect(page.getByText("Needs review")).toHaveCount(0);
  // The editor keeps saving afterwards (the queue is not frozen).
  await type(page, " Back online.");
  await expect.poll(async () => (await serverNote(page, "workspace")).content, { timeout: 8000 }).toContain("Back online.");
});

test("offline property edits merge on reconnect and never change the page's type", async ({ page, context }) => {
  await ready(page);
  // The database page was read (and cached on this device) before the connection dropped.
  await page.evaluate(() => (window as any).prismShellClient.getNote("tracker"));
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("prism-read-cache");
    open.onsuccess = () => { const k = open.result.transaction("bodies").objectStore("bodies").getAllKeys(); k.onsuccess = () => resolve((k.result as string[]).some((x) => x.endsWith("|/notes/tracker"))); };
    open.onerror = () => resolve(false);
  }))).toBe(true);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Serif font/ }).click();
  await expect(page.locator("[data-content-font=serif]").first()).toBeVisible();
  await page.evaluate(() => (window as any).prismShellClient.updateProperties("tracker", { status: "active" }));
  const rows = await outbox(page);
  expect(rows.map((r) => [r.kind, r.state])).toEqual([["meta", "queued"], ["meta", "queued"]]);
  expect(rows.every((r) => !r.body!.includes("force"))).toBe(true);
  // The local overlay MERGES metadata: the database is still a database, the document a document.
  const local = await page.evaluate(async () => { const c = (window as any).prismShellClient; return [(await c.getNote("tracker")).metadata, (await c.getNote("workspace")).metadata]; });
  expect(local[0]).toMatchObject({ prism_type: "database", status: "active" });
  expect(local[1]).toMatchObject({ type: "document", contentFont: "serif" });
  await context.setOffline(false);
  await expect.poll(async () => (await outbox(page)).length, { timeout: 15000 }).toBe(0);
  expect((await serverNote(page, "tracker")).metadata).toMatchObject({ prism_type: "database", status: "active" });
  expect((await serverNote(page, "workspace")).metadata).toMatchObject({ type: "document", contentFont: "serif" });
  const sent = await writes(page);
  expect(sent.filter((w) => w.path.startsWith("/api/properties/")).map((w) => w.body.set)).toEqual([{ contentFont: "serif" }, { status: "active" }]);
  expect(sent.some((w) => w.body?.force)).toBe(false);
  await expect(page.getByText("Needs review")).toHaveCount(0);
});

test("offline rename and delete are refused with a clear message; nothing is queued", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Rename A living workspace", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill("Renamed offline");
  await title.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "You’re offline. Renaming or moving a page needs a connection" })).toBeVisible();
  // NP-PG-03: a rename is never queued — the title goes back and says why.
  await expect(page.getByRole("button", { name: "Rename A living workspace", exact: true })).toBeVisible();
  await expect(page.locator("[data-title-refused]")).toContainText("You’re offline");
  const refused = await page.evaluate(() => (window as any).prismShellClient.deleteNote("agenda").then(() => "deleted", (e: Error) => e.message));
  expect(refused).toContain("Deleting a page needs a connection");
  expect(await outbox(page)).toHaveLength(0);
  await context.setOffline(false);
  await page.waitForTimeout(500);
  expect(await writes(page)).toHaveLength(0);
  expect((await serverNote(page, "agenda")).content).toContain("Saturday");
  // Online, the same rename goes through — as a move of the page (and any sub-pages).
  await page.getByRole("button", { name: "Rename A living workspace", exact: true }).click();
  await title.fill("Renamed offline");
  await title.press("Enter");
  await expect(page.getByRole("button", { name: "Rename Renamed offline", exact: true })).toBeVisible();
  expect((await writes(page)).map((w) => w.path)).toEqual(["/api/notes/workspace/move"]);
});

test("a real conflict needs review for that page only; other pages keep saving", async ({ page, context }) => {
  await ready(page);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(page.getByText("Saturday: opening discussion", { exact: false })).toBeVisible();
  await context.setOffline(true);
  await type(page, " Agenda edited offline.");
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("workspace", "A living workspace", "document"));
  await expect(page.getByText("A shared place to think", { exact: false })).toBeVisible();
  await type(page, " Mine, typed offline.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(2);
  // Meanwhile another device changes the workspace page on the server.
  await page.evaluate(() => (window as any).prismShell.serverEdit("workspace", "<p>Server version from another device.</p>"));
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: /Needs review/ }).first()).toBeVisible({ timeout: 15000 });
  // The other page's save was not held back…
  await expect.poll(async () => (await serverNote(page, "agenda")).content, { timeout: 8000 }).toContain("Agenda edited offline.");
  // …and the conflicting one neither overwrote the server nor lost the local text.
  expect((await serverNote(page, "workspace")).content).toBe("<p>Server version from another device.</p>");
  const stuck = await outbox(page);
  expect(stuck).toHaveLength(1);
  expect(stuck[0]!.state).toBe("conflict");
  expect(stuck[0]!.body).toContain("Mine, typed offline.");
  // A third page still saves straight to the server while that row waits.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.getByText("Notes from the last conversation", { exact: false })).toBeVisible();
  await type(page, " Saved while another page waits.");
  await expect.poll(async () => (await serverNote(page, "field-notes")).content, { timeout: 8000 }).toContain("Saved while another page waits.");
});

test("queued writes are never replayed under another account", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await type(page, " Written by the owner offline.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  await page.evaluate(() => { (window as any).prismShell.actor = "someone-else@example.test"; });
  await context.setOffline(false);
  await page.evaluate(() => (window as any).prismShell.switchActor("someone-else@example.test"));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1500);
  expect((await writes(page)).filter((w) => w.method === "PATCH")).toHaveLength(0);
  expect(await outbox(page)).toHaveLength(1);
  // Back as the original account, the same row is delivered.
  await page.evaluate(() => (window as any).prismShell.switchActor("owner@example.test"));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await serverNote(page, "workspace")).content, { timeout: 15000 }).toContain("Written by the owner offline.");
  expect(await outbox(page)).toHaveLength(0);
});
