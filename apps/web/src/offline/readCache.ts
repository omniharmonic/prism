/**
 * IndexedDB read-through cache for vault GETs (notes, lists, tags, vault info),
 * used by rest.ts in BOTH modes. Network-first: online reads always revalidate
 * and refresh the entry; when offline (navigator.onLine false) or the fetch
 * fails with a network TypeError, the last good response is served instead.
 * Writes keep flowing through the outbox (offline/outbox.ts) — unrelated.
 *
 * Bounded: two stores — `bodies` (key → response text) and `index` (key →
 * {size, at}) — so eviction walks only the small index. LRU by last access,
 * capped at MAX_ENTRIES and MAX_BYTES; a single body over MAX_BODY is not cached.
 * Cleared on sign-out, on a native 401, and when the signed-in account changes.
 * Every IDB failure degrades to "no cache", never to an error.
 */
const DB_NAME = "prism-read-cache";
const MAX_ENTRIES = 300;
const MAX_BYTES = 64 * 1024 * 1024;
// 4 MB: the legacy full-vault tree list is ~16 MB on vault 0.7.9 — too heavy to
// rewrite into IndexedDB on every reload, so it (and any other huge body) is not
// cached. The lean /api/tree projection (WP7.1, ~2-3 MB raw for ~14k notes) fits.
const MAX_BODY = 4 * 1024 * 1024;
const USER_KEY = "prism-cache-user";

interface IndexRow {
  key: string;
  size: number;
  at: number;
}
interface BodyRow {
  key: string;
  body: string;
  contentType: string;
}

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("bodies", { keyPath: "key" });
        req.result.createObjectStore("index", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => {
      dbp = null;
    });
  }
  return dbp;
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function result<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function cacheGet(key: string): Promise<{ body: string; contentType: string } | null> {
  try {
    const db = await open();
    const t = db.transaction(["bodies", "index"], "readwrite");
    const row = await result<BodyRow | undefined>(t.objectStore("bodies").get(key));
    if (!row) return null;
    const idx = await result<IndexRow | undefined>(t.objectStore("index").get(key));
    if (idx) t.objectStore("index").put({ ...idx, at: Date.now() }); // LRU touch
    return { body: row.body, contentType: row.contentType };
  } catch {
    return null;
  }
}

export async function cachePut(key: string, body: string, contentType: string): Promise<void> {
  if (body.length > MAX_BODY) return;
  try {
    const db = await open();
    const t = db.transaction(["bodies", "index"], "readwrite");
    t.objectStore("bodies").put({ key, body, contentType } satisfies BodyRow);
    t.objectStore("index").put({ key, size: body.length, at: Date.now() } satisfies IndexRow);
    await done(t);
    await evict(db);
  } catch {
    /* cache is best-effort */
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const db = await open();
    const t = db.transaction(["bodies", "index"], "readwrite");
    t.objectStore("bodies").delete(key);
    t.objectStore("index").delete(key);
    await done(t);
  } catch {
    /* ignore */
  }
}

async function evict(db: IDBDatabase): Promise<void> {
  const rows = await result<IndexRow[]>(db.transaction("index").objectStore("index").getAll());
  let count = rows.length;
  let bytes = rows.reduce((n, r) => n + r.size, 0);
  if (count <= MAX_ENTRIES && bytes <= MAX_BYTES) return;
  rows.sort((a, b) => a.at - b.at); // oldest first
  const t = db.transaction(["bodies", "index"], "readwrite");
  for (const r of rows) {
    if (count <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    t.objectStore("bodies").delete(r.key);
    t.objectStore("index").delete(r.key);
    count--;
    bytes -= r.size;
  }
  await done(t);
}

/** Remove the old URL-only service-worker API cache on upgrade/sign-out. */
export async function clearLegacyApiCache(): Promise<void> {
  try { if (typeof caches !== "undefined") await caches.delete("vault-api"); }
  catch { /* CacheStorage may be unavailable in private browsing. */ }
}

/** Drop everything (sign-out, 401, account switch). */
export async function clearReadCache(): Promise<void> {
  await clearLegacyApiCache();
  try {
    const db = await open();
    const t = db.transaction(["bodies", "index"], "readwrite");
    t.objectStore("bodies").clear();
    t.objectStore("index").clear();
    await done(t);
  } catch {
    /* ignore */
  }
}

/** Bind the cache to the signed-in account; a different account empties it first. */
export async function bindCacheUser(email: string | undefined): Promise<void> {
  if (!email) return;
  try {
    const prev = localStorage.getItem(USER_KEY);
    if (prev && prev !== email) await clearReadCache();
    localStorage.setItem(USER_KEY, email);
  } catch {
    /* private mode */
  }
}

/** True when `e` means "couldn't reach the server" (vs an HTTP error). */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

/**
 * Network-first fetch with offline fallback. `doFetch` performs the real
 * request. A 2xx refreshes the cache; 403/404/410 evict the entry (the note
 * is gone or no longer visible); any other HTTP status is returned as-is.
 * Offline or TypeError → the cached response, else the original failure.
 */
export async function readThrough(key: string, doFetch: () => Promise<Response>): Promise<Response> {
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  if (!offline) {
    try {
      const resp = await doFetch();
      if (resp.ok) {
        const body = await resp.text();
        const contentType = resp.headers.get("content-type") ?? "application/json";
        void cachePut(key, body, contentType);
        return new Response(body, { status: resp.status, statusText: resp.statusText, headers: { "content-type": contentType } });
      }
      if (resp.status === 403 || resp.status === 404 || resp.status === 410) void cacheDelete(key);
      return resp;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      const hit = await cacheGet(key);
      if (hit) return hit2resp(hit);
      throw e;
    }
  }
  const hit = await cacheGet(key);
  if (hit) return hit2resp(hit);
  throw new TypeError("Offline and not cached");
}

function hit2resp(hit: { body: string; contentType: string }): Response {
  return new Response(hit.body, { status: 200, headers: { "content-type": hit.contentType, "x-prism-cache": "hit" } });
}
