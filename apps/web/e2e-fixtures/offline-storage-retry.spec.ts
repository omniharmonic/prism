import { test, expect, type Page } from "@playwright/test";

/**
 * IndexedDB that fails for a moment (iOS: the app resumes from the background, the storage
 * process restarts, an app update) must not raise an alarm or read as "nothing stored" — and
 * IndexedDB that really stays broken must still be reported, clearly, until it works again.
 *
 * The real modules run against a fault injector installed before the app:
 *   __idb.killConnections()  every connection opened so far answers InvalidStateError (new ones work)
 *   __idb.fail(n)            the next n open()/transaction() calls throw "Connection to Indexed
 *                            Database server lost" (Infinity = storage stays broken)
 */
declare global { interface Window { __idb: { killConnections(): void; fail(n: number): void; calls: number; remaining: number }; __pills: string[] } }

async function inject(page: Page) {
  await page.addInitScript(() => {
    const state = { dead: new WeakSet<IDBDatabase>(), live: new Set<IDBDatabase>(), remaining: 0, calls: 0 };
    const lost = () => new DOMException("Connection to Indexed Database server lost. Refresh the page to try again", "UnknownError");
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, ...args: [string, number?]) {
      if (state.remaining > 0) { state.remaining--; state.calls++; throw lost(); }
      const request = open.apply(this, args);
      request.addEventListener("success", () => state.live.add(request.result));
      return request;
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
      if (state.dead.has(this)) { state.calls++; throw new DOMException("The database connection is closing.", "InvalidStateError"); }
      if (state.remaining > 0) { state.remaining--; state.calls++; throw lost(); }
      return transaction.apply(this, args);
    };
    window.__idb = {
      killConnections() { for (const db of state.live) state.dead.add(db); state.live.clear(); },
      fail(n: number) { state.remaining = n; },
      get calls() { return state.calls; },
      get remaining() { return state.remaining; },
    };
    // Every text the floating pill ever showed (a pill that flashes for a second still counts).
    window.__pills = [];
    const watch = () => new MutationObserver(() => {
      const pill = document.querySelector(".offline-indicator-pill");
      const text = pill?.textContent?.trim();
      if (text && window.__pills[window.__pills.length - 1] !== text) window.__pills.push(text);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    if (document.documentElement) watch(); else document.addEventListener("readystatechange", watch, { once: true });
  });
}

const editor = (page: Page) => page.locator(".tiptap[contenteditable=true]");
const badge = (page: Page) => page.locator(".sync-state-header");
const pill = (page: Page) => page.locator(".offline-indicator-pill");
const savedChanges = (page: Page) => page.getByRole("dialog", { name: "Saved changes" });
async function type(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}
async function ready(page: Page) {
  await inject(page);
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(editor(page)).toBeVisible();
  await expect(badge(page)).toHaveText("Saved");
}
/** Rows in the outbox, read on a connection of the test's own (only call while storage works). */
const outbox = (page: Page) => page.evaluate(() => new Promise<Array<{ body?: string; state?: string }>>((resolve) => {
  const open = indexedDB.open("prism-web");
  open.onsuccess = () => { const all = open.result.transaction("outbox").objectStore("outbox").getAll(); all.onsuccess = () => { resolve(all.result); open.result.close(); }; };
  open.onerror = () => resolve([]);
}));
const serverContent = (page: Page) => page.evaluate(() => (window as any).prismShell.note("workspace").content as string);
const wake = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
const openDialog = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("prism:open-saved-changes")));
const storageAlarms = (page: Page) => page.evaluate(() => window.__pills.filter((t) => /storage|attention/i.test(t)));

test("a connection that died in the background is replaced: no alarm, the queued change is listed and reaches the server", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await type(page, " BEFORE.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  // iOS closes the app's connections while it is in the background.
  await page.evaluate(() => window.__idb.killConnections());
  await wake(page);
  await type(page, " AFTER.");
  // The second save went through a NEW connection and was folded into the same row.
  await expect.poll(async () => (await outbox(page)).map((r) => r.body ?? "").join("|"), { timeout: 10000 }).toContain("AFTER.");
  expect(await page.evaluate(() => window.__idb.calls)).toBeGreaterThan(0); // the dead connection was really used
  // Longer than a poll (5 s) + the retries: nothing was ever said about storage.
  await page.waitForTimeout(6500);
  expect(await storageAlarms(page)).toEqual([]);
  await expect(page.locator(".offline-storage-banner")).toHaveCount(0);
  await openDialog(page);
  await expect(savedChanges(page).getByText("Saved on this device")).toHaveCount(1);
  await expect(savedChanges(page).locator(".offline-storage-down")).toHaveCount(0);
  await savedChanges(page).getByRole("button", { name: "Close" }).click();
  await context.setOffline(false);
  await expect(badge(page)).toHaveText("Saved", { timeout: 20000 });
  expect(await serverContent(page)).toContain("BEFORE.");
  expect(await serverContent(page)).toContain("AFTER.");
  expect(await outbox(page)).toHaveLength(0);
});

for (const failures of [3, 5, 7]) {
  test(`IndexedDB failing ${failures} times and then working shows nothing; the queued row appears`, async ({ page, context }) => {
    await ready(page);
    await context.setOffline(true);
    await type(page, " QUEUED.");
    await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
    await page.evaluate((n) => window.__idb.fail(n), failures);
    await wake(page);
    await expect.poll(() => page.evaluate(() => window.__idb.remaining), { timeout: 15000 }).toBe(0);
    expect(await page.evaluate(() => window.__idb.calls)).toBe(failures);
    await page.waitForTimeout(6500);
    expect(await storageAlarms(page)).toEqual([]);
    await expect(pill(page)).toHaveCount(0);
    await expect(page.locator(".offline-storage-banner")).toHaveCount(0);
    await openDialog(page);
    await expect(savedChanges(page).getByText("Saved on this device")).toHaveCount(1);
    await savedChanges(page).getByRole("button", { name: "Close" }).click();
    await context.setOffline(false);
    await expect(badge(page)).toHaveText("Saved", { timeout: 20000 });
    expect(await serverContent(page)).toContain("QUEUED.");
  });
}

test("IndexedDB that stays broken is reported by name, explained, never shown as saved — and the report clears when storage returns", async ({ page, context }) => {
  await ready(page);
  await page.evaluate(() => window.__idb.fail(Infinity));
  await wake(page);
  await expect(pill(page)).toHaveText("Offline storage unavailable", { timeout: 20000 });
  await expect(pill(page)).toHaveAccessibleName("Offline storage unavailable");
  expect((await page.evaluate(() => window.__pills)).some((t) => /Save needs attention/.test(t))).toBe(false);
  // A change made now cannot be kept on the device: that is said, and the header never says "Saved".
  await context.setOffline(true);
  await type(page, " LOST?");
  await expect(page.getByRole("alert").filter({ hasText: "Changes are not being saved on this device" })).toBeVisible({ timeout: 15000 });
  await expect(badge(page)).not.toHaveText("Saved");
  await pill(page).click();
  const down = savedChanges(page).locator(".offline-storage-down");
  await expect(down).toContainText("can’t read this device’s offline storage");
  await expect(down).toContainText("goes away by itself when storage works again");
  await expect(down).toContainText("close and reopen Prism");
  await expect(savedChanges(page).getByText("No pending changes")).toHaveCount(0); // unknown is not "none"
  // Storage comes back: the dialog's notice and (after closing) the pill go away without a relaunch.
  await page.evaluate(() => window.__idb.fail(0));
  await wake(page);
  await expect(down).toHaveCount(0, { timeout: 15000 });
  await savedChanges(page).getByRole("button", { name: "Close" }).click();
  await expect(pill(page).filter({ hasText: "storage" })).toHaveCount(0, { timeout: 15000 });
});

test("read cache: a dead connection is not 'never cached'", async ({ page }) => {
  await inject(page);
  await page.goto("/e2e-fixtures/harness.html");
  const result = await page.evaluate(async (mod) => {
    const cache = await import(/* @vite-ignore */ mod);
    await cache.cachePut("scope|/notes/a", JSON.stringify({ id: "a" }), "application/json");
    window.__idb.killConnections();
    const afterKill = await cache.cacheGet("scope|/notes/a");
    window.__idb.fail(2);
    const offline = await cache.readThrough("scope|/notes/a", () => Promise.reject(new TypeError("offline")));
    window.__idb.fail(Infinity);
    const broken = await cache.cacheGet("scope|/notes/a"); // really broken: degrades to "no cache", no throw
    window.__idb.fail(0);
    return { afterKill: afterKill?.body, offline: await offline.text(), broken, again: (await cache.cacheGet("scope|/notes/a"))?.body };
  }, "/src/offline/readCache.ts");
  expect(result).toEqual({ afterKill: '{"id":"a"}', offline: '{"id":"a"}', broken: null, again: '{"id":"a"}' });
});

test("live document: local saving replaces a dead connection, says 'unavailable' only when storage stays broken, and recovers by itself", async ({ page }) => {
  await inject(page);
  await page.goto("/e2e-fixtures/collab-storage.html");
  const fx = <T,>(fn: string) => page.evaluate((fn) => (0, eval)(`(async () => { const f = window.prismCollabFixture; return ${fn}; })()`), fn) as Promise<T>;
  expect(await fx(`f.open("doc")`)).toBe("");
  expect(await fx(`f.append("doc", "ONE ")`)).toBe("saved");
  await page.evaluate(() => window.__idb.killConnections());
  expect(await fx(`f.append("doc", "TWO ")`)).toBe("saved");
  await page.evaluate(() => window.__idb.fail(2));
  expect(await fx(`f.append("doc", "THREE ")`)).toBe("saved");
  // Really broken: reported, never "saved".
  await page.evaluate(() => window.__idb.fail(Infinity));
  expect(await fx(`f.append("doc", "FOUR ")`)).toBe("unavailable");
  // Storage returns: the unconfirmed edit is written without another keystroke.
  await page.evaluate(() => window.__idb.fail(0));
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect.poll(() => fx(`f.state("doc")`), { timeout: 10000 }).toBe("saved");
  await page.reload();
  expect(await fx(`f.open("again")`)).toBe("ONE TWO THREE FOUR ");
});
