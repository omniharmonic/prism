import { test, expect } from "@playwright/test";

/** Wave 2E · NP-OF-04: favorites, recents and pinned pages read with no connection. */
test("favorites readable offline after prefetch", async ({ page, context }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html?favorites");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  // The favorite was never opened, yet it is fetched in the background.
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.reads.includes("agenda")), { timeout: 10_000 }).toBe(true);
  // …and is stored on this device (the cache write lands after the read).
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("prism-read-cache");
    open.onsuccess = () => {
      const keys = open.result.transaction("bodies").objectStore("bodies").getAllKeys();
      keys.onsuccess = () => resolve((keys.result as string[]).some((k) => k.endsWith("|/notes/agenda")));
      keys.onerror = () => resolve(false);
    };
    open.onerror = () => resolve(false);
  })), { timeout: 10_000 }).toBe(true);
  // Per-page toggle in the page ⋯ menu, remembered for this account + vault.
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Make available offline/ }).click();
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Remove offline copy/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await context.setOffline(true);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(page.getByText("Saturday: opening discussion", { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath("offline-favorite.png") });
  // An uncached page is honestly unavailable, never a blank editor.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.getByText("Notes from the last conversation")).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByText("Notes from the last conversation")).toBeVisible({ timeout: 15_000 });
});

/** Wave 2E review M4: what is cached on the device is bounded, revocable and tied to the account. */
const cachedKeys = (page: import("@playwright/test").Page) => page.evaluate(() => new Promise<string[]>((resolve) => {
  const open = indexedDB.open("prism-read-cache");
  open.onsuccess = () => { const k = open.result.transaction("bodies").objectStore("bodies").getAllKeys(); k.onsuccess = () => resolve(k.result as string[]); k.onerror = () => resolve([]); };
  open.onerror = () => resolve([]);
}));
const has = (keys: string[], id: string) => keys.some((k) => k.endsWith(`|/notes/${id}`));

test("offline copies: removed on request, evicted when access is revoked, expired after 30 days, cleared at sign-out", async ({ page, context }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?favorites");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect.poll(async () => has(await cachedKeys(page), "agenda"), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => has(await cachedKeys(page), "workspace")).toBe(true);
  // "Remove offline copy" deletes the cached body, not just the pin.
  const menu = () => page.getByRole("button", { name: "Page actions", exact: true }).click();
  await menu();
  await page.getByRole("menuitem", { name: /Make available offline/ }).click();
  await menu();
  await page.getByRole("menuitem", { name: /Remove offline copy/ }).click();
  await expect.poll(async () => has(await cachedKeys(page), "workspace")).toBe(false);
  // Access to the favorite is revoked: the next fresh tree evicts its copy (and cached lists).
  await page.evaluate(() => { (window as any).prismShell.hidden.push("agenda"); });
  await page.evaluate(() => (window as any).prismShellClient.listTree());
  await expect.poll(async () => has(await cachedKeys(page), "agenda")).toBe(false);
  // A copy older than 30 days is never served offline.
  await page.evaluate(() => (window as any).prismShellClient.getNote("field-notes"));
  await expect.poll(async () => has(await cachedKeys(page), "field-notes")).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => {
    const open = indexedDB.open("prism-read-cache");
    open.onsuccess = () => {
      const store = open.result.transaction("index", "readwrite").objectStore("index");
      const all = store.getAll();
      all.onsuccess = () => {
        for (const row of all.result as Array<{ key: string; stored?: number; at: number }>) if (row.key.endsWith("|/notes/field-notes")) store.put({ ...row, stored: Date.now() - 31 * 86_400_000 });
        store.transaction.oncomplete = () => resolve();
      };
    };
  }));
  await context.setOffline(true);
  expect(await page.evaluate(() => (window as any).prismShellClient.getNote("field-notes").then(() => "served", () => "refused"))).toBe("refused");
  await context.setOffline(false);
  // The session ends (PWA 401 / sign-out): cached pages and device-local page lists go with it.
  await page.evaluate(() => { localStorage.setItem("prism:recent-searches:x", '["workshop"]'); });
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("prism:offline-")))).toBe(true);
  await page.evaluate(async () => { (window as any).prismShell.signedOut = true; await (window as any).prismShell.refreshMe(); });
  await expect.poll(async () => (await cachedKeys(page)).length).toBe(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /^prism:(offline-|recent-searches:)/.test(k)))).toEqual([]);
});
