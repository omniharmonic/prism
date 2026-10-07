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

test("trees share a 32 MB total (newest kept) and an unchanged tree is not written to IndexedDB again", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/e2e-fixtures/harness.html");
  const result = await page.evaluate(async (mod) => {
    const cache = await import(/* @vite-ignore */ mod);
    cache.setProtectedCacheKeys([]);
    const stats = () => ({ ...(cache.cacheStats ?? { bodyWrites: -1, unchangedSkips: -1 }) });
    const scope = (n: number) => JSON.stringify(["http://x/api", "w", `vault-${n}`, "user:a@test.local"]);
    const tree = (n: number) => JSON.stringify({ vault: n, rows: "r".repeat(11 * 1024 * 1024) });
    const has = async (key: string) => !!(await cache.cacheGet(key));
    // The same tree arrives three times (a start, an event refetch, another start): written once.
    const first = tree(1);
    await cache.cachePut(`${scope(1)}|/tree`, first, "application/json");
    const afterFirst = stats();
    await cache.cachePut(`${scope(1)}|/tree`, first, "application/json");
    await cache.cachePut(`${scope(1)}|/tree`, first, "application/json");
    const afterRepeats = stats();
    const stillServed = (await cache.cacheGet(`${scope(1)}|/tree`))?.body.length === first.length;
    // A changed tree IS written.
    const changed = first.replace('"vault":1', '"vault":9');
    await cache.cachePut(`${scope(1)}|/tree`, changed, "application/json");
    const afterChange = stats();
    const servesChange = (await cache.cacheGet(`${scope(1)}|/tree`))?.body === changed;
    // Two more vaults' trees: 3 × 11 MB is over the trees' 32 MB — the OLDEST goes, a cached page stays.
    await cache.cachePut(`${scope(1)}|/notes/a`, '{"id":"a"}', "application/json");
    await new Promise((r) => setTimeout(r, 20));
    await cache.cachePut(`${scope(2)}|/tree`, tree(2), "application/json");
    await new Promise((r) => setTimeout(r, 20));
    await cache.cachePut(`${scope(3)}|/tree`, tree(3), "application/json");
    return { afterFirst, afterRepeats, afterChange, stillServed, servesChange, t1: await has(`${scope(1)}|/tree`), t2: await has(`${scope(2)}|/tree`), t3: await has(`${scope(3)}|/tree`), pageKept: await has(`${scope(1)}|/notes/a`) };
  }, mod);
  expect(result.afterFirst.bodyWrites).toBe(1);
  expect(result.afterRepeats, "the same tree again: no second write of the body").toMatchObject({ bodyWrites: 1, unchangedSkips: 2 });
  expect(result.stillServed).toBe(true);
  expect(result.afterChange.bodyWrites).toBe(2);
  expect(result.servesChange).toBe(true);
  expect([result.t1, result.t2, result.t3], "the oldest tree is dropped, the two newest stay").toEqual([false, true, true]);
  expect(result.pageKept, "trees never push a cached page out for their own total").toBe(true);
});

test("tree cache: an arriving tree is fingerprinted only when it has the stored tree's length (a different length cannot be the same body)", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/e2e-fixtures/harness.html");
  const mod = "/src/offline/readCache.ts";
  const result = await page.evaluate(async (mod) => {
    const cache = await import(/* @vite-ignore */ mod);
    cache.setProtectedCacheKeys([]);
    const stats = () => ({ compared: -1, ...cache.cacheStats });
    const key = `${JSON.stringify(["http://x/api", "w", "vault-9", "user:a@test.local"])}|/tree`;
    const a = JSON.stringify({ rows: "a".repeat(3 * 1024 * 1024) });
    const longer = JSON.stringify({ rows: "a".repeat(3 * 1024 * 1024 + 7) });
    const sameLength = JSON.stringify({ rows: "b".repeat(3 * 1024 * 1024 + 7) });
    const base = stats();
    await cache.cachePut(key, a, "application/json");
    await cache.cachePut(key, longer, "application/json"); // another length: written without hashing to compare
    const afterGrow = stats();
    await cache.cachePut(key, longer, "application/json"); // the same body: one comparison, no write
    const afterSame = stats();
    await cache.cachePut(key, sameLength, "application/json"); // same length, other content: compared, written
    const afterOther = stats();
    const served = (await cache.cacheGet(key))?.body === sameLength;
    const d = (x: ReturnType<typeof stats>) => ({ bodyWrites: x.bodyWrites - base.bodyWrites, unchangedSkips: x.unchangedSkips - base.unchangedSkips, compared: x.compared - base.compared });
    return { afterGrow: d(afterGrow), afterSame: d(afterSame), afterOther: d(afterOther), served };
  }, mod);
  expect(result.afterGrow).toEqual({ bodyWrites: 2, unchangedSkips: 0, compared: 0 });
  expect(result.afterSame).toEqual({ bodyWrites: 2, unchangedSkips: 1, compared: 1 });
  expect(result.afterOther).toEqual({ bodyWrites: 3, unchangedSkips: 1, compared: 2 });
  expect(result.served).toBe(true);
});
