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

test("the tree has its own 16 MB limit: a 6 MB tree is cached for an offline start, other bodies keep the 4 MB cap, and the LRU drops pages before the tree", async ({ page }) => {
  test.setTimeout(120_000); // 6 MB and 17 MB bodies through IndexedDB, then 305 writes to overflow the entry cap
  await page.goto("/e2e-fixtures/harness.html");
  const result = await page.evaluate(async (mod) => {
    const cache = await import(/* @vite-ignore */ mod);
    cache.setProtectedCacheKeys([]);
    const scope = JSON.stringify(["http://x/api", "w", "v", "user:a@test.local"]);
    // ~35k rows of the projection's shape: a little over 6 MB of JSON.
    const rows = Array.from({ length: 35_000 }, (_, i) => ({ id: `n${String(i).padStart(22, "0")}`, path: `Projects/Area ${i % 97}/A page with an ordinary sort of title ${i}`, tags: ["page", `area-${i % 40}`], updatedAt: "2026-10-01T10:00:00.000Z", type: "document" }));
    const tree = JSON.stringify(rows);
    const respond = (body: string) => () => Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    // Through the real read path, online: the tree, a big list and one page.
    await (await cache.readThrough(`${scope}|/tree`, respond(tree))).text();
    await (await cache.readThrough(`${scope}|/notes?limit=50000`, respond(tree))).text();
    await (await cache.readThrough(`${scope}|/notes/a`, respond('{"id":"a"}'))).text();
    await new Promise((r) => setTimeout(r, 1500));
    // Offline start: no network at all.
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    const read = async (key: string) => { try { return (await (await cache.readThrough(key, offline)).text()).length; } catch { return -1; } };
    const treeBytes = await read(`${scope}|/tree`);
    const listBytes = await read(`${scope}|/notes?limit=50000`);
    const huge = "x".repeat(17 * 1024 * 1024);
    await cache.cachePut(`${scope}|/tree?big`, huge, "application/json");
    const hugeTree = !!(await cache.cacheGet(`${scope}|/tree?big`));
    // Make the tree the OLDEST entry, then overflow the entry cap: pages go, the tree stays.
    await new Promise<void>((resolve) => {
      const open = indexedDB.open("prism-read-cache");
      open.onsuccess = () => { const s = open.result.transaction("index", "readwrite").objectStore("index"); const g = s.get(`${scope}|/tree`); g.onsuccess = () => { s.put({ ...g.result, at: 1 }); s.transaction.oncomplete = () => resolve(); }; };
    });
    for (let i = 0; i < 305; i++) await cache.cachePut(`${scope}|/notes/n${i}`, "{}", "application/json");
    return { size: tree.length, treeBytes, listBytes, hugeTree, treeAfterOverflow: await read(`${scope}|/tree`), oldestPage: await read(`${scope}|/notes/a`), newestPage: await read(`${scope}|/notes/n304`) };
  }, mod);
  expect(result.size).toBeGreaterThan(6 * 1024 * 1024);
  expect(result.treeBytes, "the 6 MB tree is served offline").toBe(result.size);
  expect(result.listBytes, "any other body over 4 MB is still not cached").toBe(-1);
  expect(result.hugeTree, "a tree over 16 MB is not cached").toBe(false);
  expect(result.treeAfterOverflow, "the LRU drops pages before the tree").toBe(result.size);
  expect(result.oldestPage).toBe(-1);
  expect(result.newestPage).toBe(2);
});
