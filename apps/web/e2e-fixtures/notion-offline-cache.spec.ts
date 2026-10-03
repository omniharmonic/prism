import { test, expect } from "@playwright/test";

/** Wave 2E re-review lows: the read cache for share-link viewers and pinned pages after a reload. */
const mod = "/src/offline/readCache.ts";
const json = (body: unknown, status = 200) => `new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status}, headers: { "content-type": "application/json" } })`;

test("a share link's cached pages expire after 24 h and all go when the link stops working", async ({ page }) => {
  await page.goto("/e2e-fixtures/harness.html");
  const result = await page.evaluate(async ({ mod, ok, gone }) => {
    const cache = await import(/* @vite-ignore */ mod);
    const link = JSON.stringify(["http://x/api", "w", "v", "capability:abc"]);
    const user = JSON.stringify(["http://x/api", "w", "v", "user:a@test.local"]);
    const fetchOk = () => Promise.resolve((0, eval)(ok) as Response);
    for (const key of [`${link}|/notes/a`, `${link}|/notes/b`, `${user}|/notes/a`]) await (await cache.readThrough(key, fetchOk)).text();
    await new Promise((r) => setTimeout(r, 200));
    const age = (key: string, ms: number) => new Promise<void>((resolve) => {
      const open = indexedDB.open("prism-read-cache");
      open.onsuccess = () => { const s = open.result.transaction("index", "readwrite").objectStore("index"); const g = s.get(key); g.onsuccess = () => { s.put({ ...g.result, stored: Date.now() - ms }); s.transaction.oncomplete = () => resolve(); }; };
    });
    // 25 h old: gone for the link viewer, still fine for a signed-in account (30 days).
    await age(`${link}|/notes/a`, 25 * 3600_000);
    await age(`${user}|/notes/a`, 25 * 3600_000);
    const linkOld = await cache.cacheGet(`${link}|/notes/a`);
    const userOld = await cache.cacheGet(`${user}|/notes/a`);
    // The link now answers 401: every page cached under it is evicted.
    await cache.readThrough(`${link}|/notes/c`, () => Promise.resolve((0, eval)(gone) as Response));
    await new Promise((r) => setTimeout(r, 200));
    return { linkOld: !!linkOld, userOld: !!userOld, linkOther: !!(await cache.cacheGet(`${link}|/notes/b`)), userStill: !!(await cache.cacheGet(`${user}|/notes/a`)) };
  }, { mod, ok: json({ id: "a", content: "x" }), gone: json({ error: "unauthorized" }, 401) });
  expect(result).toEqual({ linkOld: false, userOld: true, linkOther: false, userStill: true });
});

test("pinned pages are protected from the LRU from the first write after a reload", async ({ page }) => {
  await page.goto("/e2e-fixtures/harness.html");
  await page.evaluate(async (mod) => {
    const cache = await import(/* @vite-ignore */ mod);
    cache.setProtectedCacheKeys(["scope|/notes/pinned"]);
    await cache.cachePut("scope|/notes/pinned", "{}", "application/json");
  }, mod);
  await page.reload();
  const kept = await page.evaluate(async (mod) => {
    // Make the pinned entry the oldest, then overflow the LRU before anything re-registers the pins.
    await new Promise<void>((resolve) => {
      const open = indexedDB.open("prism-read-cache");
      open.onsuccess = () => { const s = open.result.transaction("index", "readwrite").objectStore("index"); const g = s.get("scope|/notes/pinned"); g.onsuccess = () => { s.put({ ...g.result, at: 1 }); s.transaction.oncomplete = () => resolve(); }; };
    });
    const cache = await import(/* @vite-ignore */ mod);
    for (let i = 0; i < 305; i++) await cache.cachePut(`scope|/notes/n${i}`, "{}", "application/json");
    return !!(await cache.cacheGet("scope|/notes/pinned"));
  }, mod);
  expect(kept).toBe(true);
});
