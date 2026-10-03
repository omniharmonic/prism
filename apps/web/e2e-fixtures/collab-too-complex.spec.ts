/**
 * A page the live editor cannot convert, against the REAL server (actual gateway
 * and collab socket over the in-memory fake vault — real-server.ts).
 *
 * The server opens no live document for such a page: the socket is refused
 * `too_complex` and NOTHING of the page enters this browser's local document
 * store. So the page shows as plain text (with a plain-text editor for people who
 * may edit — the stored content is intact), and once the content is fixed the
 * SAME browser profile opens it in the live editor: no reload loop, nothing to
 * purge, nothing duplicated.
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());

const BOMB = `${"> ".repeat(300)}deep words`;
const plain = (page: Page) => page.getByTestId("plain-text-page");
const liveEditor = (page: Page) => page.locator(".tiptap").first();

/** A page reload, same profile and storage (the fixture boots from its own URL, not the rewritten /collab/… one). */
const reopen = (page: Page, id = "bomb") => page.goto(`/e2e-fixtures/collab-route.html?target=${id}`);

/** Everything this origin keeps of live documents (IndexedDB rows + rescue entries). */
const localDocumentBytes = (page: Page) =>
  page.evaluate(async () => {
    let bytes = 0;
    for (const { name } of await indexedDB.databases()) {
      if (!name || !name.startsWith("prism-collab")) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const r = db.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => resolve(r.result as unknown[]);
          r.onerror = () => reject(r.error);
        });
        bytes += JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array || v instanceof ArrayBuffer ? Array.from(new Uint8Array(v as ArrayBuffer)) : v)).length;
      }
      db.close();
    }
    return bytes + Object.keys(localStorage).filter((k) => k.startsWith("prism:collab-pending:")).length;
  });

test("a page too complex for the live editor shows as plain text, read-only for a viewer", async ({ page }) => {
  await connect(page, page.context(), server, "sam");
  await page.goto("/e2e-fixtures/collab-route.html?target=bomb");
  await expect(plain(page)).toBeVisible();
  await expect(plain(page)).toContainText("too large or complex for the live editor");
  await expect(page.getByTestId("plain-text-body")).toHaveText(BOMB);
  await expect(page.getByRole("button", { name: "Edit as plain text" })).toHaveCount(0);
  await expect(page.locator(".tiptap")).toHaveCount(0);
});

test("degrades → heals → the SAME browser profile opens it live (nothing poisoned locally, no reload loop)", async ({ page }) => {
  test.setTimeout(120_000);
  await connect(page, page.context(), server, "eve");
  await page.goto("/e2e-fixtures/collab-route.html?target=bomb");
  await expect(plain(page)).toBeVisible();
  await expect(page.getByTestId("plain-text-body")).toHaveText(BOMB);
  // Reloading while it is still too complex stays on the plain-text page (no "Update required").
  await reopen(page);
  await expect(plain(page)).toBeVisible();
  await expect(page.getByText("Update required")).toHaveCount(0);
  const before = await localDocumentBytes(page);

  // An editor fixes the page with the plain-text editor: an ordinary REST write.
  await page.getByRole("button", { name: "Edit as plain text" }).click();
  const box = page.getByLabel("Page content as plain text");
  await expect(box).toHaveValue(BOMB);
  await box.fill("# Fixed\n\nNow an *ordinary* page.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  expect((await server.note("bomb"))!.content).toBe("# Fixed\n\nNow an *ordinary* page.");
  // Nothing of the unconvertible page ever reached this profile's local document store.
  expect(await localDocumentBytes(page)).toBe(before);

  // Same profile, same storage: the live editor opens it.
  await page.getByRole("button", { name: "Open in the live editor" }).click();
  await expect(liveEditor(page)).toBeVisible();
  await expect(page.getByText(/Live · Editing/)).toBeVisible();
  await expect(liveEditor(page)).toContainText("Now an ordinary page.");
  await expect(plain(page)).toHaveCount(0);
  await expect(page.getByText("Update required")).toHaveCount(0);
  // …and again after a reload (the local copy it now keeps is the healthy document).
  await reopen(page);
  await expect(liveEditor(page)).toBeVisible();
  await expect(page.getByText(/Live · Editing/)).toBeVisible();
  await expect(liveEditor(page)).toContainText("Now an ordinary page.");
  // It is really editable: typing reaches the stored note, once.
  await liveEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed live.");
  await expect.poll(async () => (await server.note("bomb"))!.content, { timeout: 15_000 }).toContain("Typed live.");
  const stored = (await server.note("bomb"))!.content;
  expect(stored.match(/Now an/g)).toHaveLength(1);
});

test("a live page whose content becomes too complex falls back to plain text and comes back when fixed", async ({ page }) => {
  test.setTimeout(120_000);
  await connect(page, page.context(), server, "eve");
  await page.goto("/e2e-fixtures/collab-route.html?target=rich");
  await expect(liveEditor(page)).toBeVisible();
  await expect(page.getByText(/Live · Editing/)).toBeVisible();
  const original = (await server.note("rich"))!.content;
  // The note is replaced elsewhere by something no parser can take.
  await server.put("rich", BOMB);
  await expect(plain(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("plain-text-body")).toHaveText(BOMB);
  expect((await server.note("rich"))!.content).toBe(BOMB); // the live document was not stored over it
  // Fixed elsewhere: the same tab's profile opens it live again, with the note's content — once.
  await server.put("rich", original);
  await page.getByRole("button", { name: "Try the live editor again" }).click();
  await expect(liveEditor(page)).toBeVisible();
  await expect(page.getByText(/Live · Editing/)).toBeVisible();
  await expect(liveEditor(page).getByRole("heading", { name: "Purpose" })).toHaveCount(1);
  await expect(page.getByText("Update required")).toHaveCount(0);
});
