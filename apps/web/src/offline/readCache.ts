/**
 * IndexedDB read-through cache for vault GETs (notes, lists, tags, vault info),
 * used by rest.ts in BOTH modes. Network-first: online reads always revalidate
 * and refresh the entry; when offline (navigator.onLine false) or the fetch
 * fails with a network TypeError, the last good response is served instead.
 * Writes keep flowing through the outbox (offline/outbox.ts) — unrelated.
 *
 * Bounded: two stores — `bodies` (key → response text) and `index` (key →
 * {size, at}) — so eviction walks only the small index. LRU by last access,
 * capped at MAX_ENTRIES and MAX_BYTES; a single body over MAX_BODY is not cached
 * (the `/tree` projection has its own, larger limit — TREE_MAX_BODY).
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
// The projection grows ~170 bytes per note and crosses 4 MB at ~20–29k notes; past
// that an offline start had no sidebar at all. It gets its own limit — still inside
// the MAX_BYTES budget — and the LRU drops every other entry before a tree: a
// cached page nobody can navigate to is worth less than the list of pages.
const TREE_MAX_BODY = 16 * 1024 * 1024;
/** `<scope>|/tree` (with or without a query) — the sidebar's projection. */
export const isTreeKey = (key: string): boolean => {
  const path = key.slice(key.indexOf("|") + 1);
  return path === "/tree" || path.startsWith("/tree?");
};
const USER_KEY = "prism-cache-user";
/** Cached pages are a convenience, not an archive: nothing older is ever served. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** "Available offline" pages have their own budget and never push out the tree/lists. */
const PINNED_MAX_BYTES = 200 * 1024 * 1024;
/** Device-local records that name pages or queries; dropped with the cache. */
const LOCAL_PREFIXES = ["prism:offline-pinned:", "prism:offline-recent:", "prism:offline-stamps:", "prism:offline-protected", "prism:recent-searches:", "prism:tree-expanded:"];

interface IndexRow {
  key: string;
  size: number;
  at: number;
  /** When the body was last confirmed by the server (rows written before this field: `at`). */
  stored?: number;
}
interface BodyRow {
  key: string;
  body: string;
  contentType: string;
}

let dbp: Promise<IDBDatabase> | null = null;
/** Keys the LRU never evicts: pages kept "Available offline" (NP-OF-04). */
let protectedKeys = new Set<string>();
/** Until the pinned set is known (right after a reload) the LRU must not run:
 *  it would treat pinned pages as ordinary entries and could evict them. */
let protectedReady = false;
const PROTECTED_KEY = "prism:offline-protected";
try {
  const saved = JSON.parse(localStorage.getItem(PROTECTED_KEY) ?? "null") as unknown;
  if (Array.isArray(saved)) { protectedKeys = new Set(saved.filter((k): k is string => typeof k === "string")); protectedReady = true; }
} catch { /* private mode */ }
export function setProtectedCacheKeys(keys: Iterable<string>): void {
  protectedKeys = new Set(keys);
  protectedReady = true;
  try { localStorage.setItem(PROTECTED_KEY, JSON.stringify([...protectedKeys])); } catch { /* in-memory only */ }
}
/** Capability-link viewers: a short-lived copy only (the link can be revoked at any time). */
const LINK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const isLinkKey = (key: string) => key.includes('"capability:');
const maxAge = (key: string) => (isLinkKey(key) ? LINK_MAX_AGE_MS : MAX_AGE_MS);

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

export async function cacheGet(key: string): Promise<{ body: string; contentType: string; stored?: number } | null> {
  try {
    const db = await open();
    const t = db.transaction(["bodies", "index"], "readwrite");
    const row = await result<BodyRow | undefined>(t.objectStore("bodies").get(key));
    if (!row) return null;
    const idx = await result<IndexRow | undefined>(t.objectStore("index").get(key));
    if (!idx || Date.now() - (idx.stored ?? idx.at) > maxAge(key)) {
      // Too old to trust offline: it is re-validated on reconnect or gone.
      t.objectStore("bodies").delete(key);
      t.objectStore("index").delete(key);
      return null;
    }
    t.objectStore("index").put({ ...idx, at: Date.now() }); // LRU touch
    return { body: row.body, contentType: row.contentType, stored: idx.stored ?? idx.at };
  } catch {
    return null;
  }
}

export async function cachePut(key: string, body: string, contentType: string): Promise<void> {
  if (body.length > (isTreeKey(key) ? TREE_MAX_BODY : MAX_BODY)) return;
  try {
    const db = await open();
    const t = db.transaction(["bodies", "index"], "readwrite");
    t.objectStore("bodies").put({ key, body, contentType } satisfies BodyRow);
    t.objectStore("index").put({ key, size: body.length, at: Date.now(), stored: Date.now() } satisfies IndexRow);
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
  const now = Date.now();
  const expired = rows.filter((r) => now - (r.stored ?? r.at) > maxAge(r.key));
  const live = rows.filter((r) => !expired.includes(r)).sort((a, b) => a.at - b.at); // oldest first
  // Two budgets: pinned ("Available offline") pages count against their own hard
  // cap, everything else against the LRU — so pins never evict the tree or lists.
  const drop: IndexRow[] = [...expired];
  const trim = (set: IndexRow[], maxEntries: number, maxBytes: number) => {
    let count = set.length;
    let bytes = set.reduce((n, r) => n + r.size, 0);
    for (const r of set) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      drop.push(r);
      count--;
      bytes -= r.size;
    }
  };
  // Only once the pinned set is known; expiry above never depends on it.
  // Trees go last: within the shared budget everything else is dropped first.
  const ordinary = live.filter((r) => !protectedKeys.has(r.key));
  if (protectedReady) trim([...ordinary.filter((r) => !isTreeKey(r.key)), ...ordinary.filter((r) => isTreeKey(r.key))], MAX_ENTRIES, MAX_BYTES);
  trim(live.filter((r) => protectedKeys.has(r.key)), Number.MAX_SAFE_INTEGER, PINNED_MAX_BYTES);
  if (!drop.length) return;
  const t = db.transaction(["bodies", "index"], "readwrite");
  for (const r of drop) {
    t.objectStore("bodies").delete(r.key);
    t.objectStore("index").delete(r.key);
  }
  await done(t);
}

/** Delete every cached entry of one audience (scope key). */
export async function cacheDeleteScope(scope: string): Promise<void> {
  try {
    const db = await open();
    const keys = (await result<IDBValidKey[]>(db.transaction("index").objectStore("index").getAllKeys())) as string[];
    const hit = keys.filter((k) => k.startsWith(scope + "|"));
    if (!hit.length) return;
    const t = db.transaction(["bodies", "index"], "readwrite");
    for (const k of hit) { t.objectStore("bodies").delete(k); t.objectStore("index").delete(k); }
    await done(t);
  } catch {
    /* ignore */
  }
}

/** Delete every cached entry whose key starts with `prefix` (e.g. one note, with any query). */
export async function cacheDeletePrefix(prefix: string): Promise<void> {
  try {
    const db = await open();
    const keys = (await result<IDBValidKey[]>(db.transaction("index").objectStore("index").getAllKeys())) as string[];
    const hit = keys.filter((k) => k === prefix || k.startsWith(prefix + "?"));
    if (!hit.length) return;
    const t = db.transaction(["bodies", "index"], "readwrite");
    for (const k of hit) { t.objectStore("bodies").delete(k); t.objectStore("index").delete(k); }
    await done(t);
  } catch {
    /* ignore */
  }
}

/**
 * Access reconciliation (review M4): after a successful tree fetch, any cached
 * page of this audience that the tree no longer lists (access revoked, trashed,
 * deleted) is evicted — and, because list/graph responses may embed its text,
 * those are dropped too when anything was revoked.
 */
export async function reconcileCachedNotes(scopePrefix: string, visibleIds: Set<string>): Promise<number> {
  try {
    const db = await open();
    const keys = (await result<IDBValidKey[]>(db.transaction("index").objectStore("index").getAllKeys())) as string[];
    const mine = keys.filter((k) => k.startsWith(scopePrefix + "|"));
    const revoked = mine.filter((k) => {
      const m = k.slice(scopePrefix.length + 1).match(/^\/notes\/([^/?]+)/);
      if (!m) return false;
      const id = decodeURIComponent(m[1]!);
      return !id.startsWith("offline-") && !visibleIds.has(id);
    });
    if (!revoked.length) return 0;
    const lists = mine.filter((k) => /^\/(notes\?|notes$|graph)/.test(k.slice(scopePrefix.length + 1)));
    const t = db.transaction(["bodies", "index"], "readwrite");
    for (const k of [...revoked, ...lists]) { t.objectStore("bodies").delete(k); t.objectStore("index").delete(k); }
    await done(t);
    return revoked.length;
  } catch {
    return 0;
  }
}

/** Expire old entries now (start-up and on reconnect). */
export async function sweepReadCache(): Promise<void> {
  try { await evict(await open()); } catch { /* ignore */ }
}

/** Remove the old URL-only service-worker API cache on upgrade/sign-out. */
export async function clearLegacyApiCache(): Promise<void> {
  try { if (typeof caches !== "undefined") await caches.delete("vault-api"); }
  catch { /* CacheStorage may be unavailable in private browsing. */ }
}

/** Drop everything (sign-out, 401, account switch). */
export async function clearReadCache(): Promise<void> {
  protectedKeys = new Set();
  try {
    for (const key of Object.keys(localStorage)) if (LOCAL_PREFIXES.some((p) => key.startsWith(p))) localStorage.removeItem(key);
  } catch { /* private mode */ }
  // In-memory device-local state of the previous account goes too (the sidebar's open folders).
  try { window.dispatchEvent(new Event("prism:signed-out")); } catch { /* no window */ }
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
export async function bindCacheUser(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  try {
    const prev = localStorage.getItem(USER_KEY);
    const changed = !!prev && prev !== email;
    if (changed) await clearReadCache();
    localStorage.setItem(USER_KEY, email);
    return changed;
  } catch {
    /* private mode */
    return false;
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
      // A share link that stopped working (revoked / expired) takes ALL of its cached pages with it.
      if (isLinkKey(key) && [401, 403, 404, 410].includes(resp.status)) void cacheDeleteScope(key.slice(0, key.indexOf("|")));
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

function hit2resp(hit: { body: string; contentType: string; stored?: number }): Response {
  // `x-prism-cache-stored`: when this copy was saved on the device (NP-OF-02 "Offline copy from <time>").
  return new Response(hit.body, { status: 200, headers: { "content-type": hit.contentType, "x-prism-cache": "hit", ...(hit.stored ? { "x-prism-cache-stored": String(hit.stored) } : {}) } });
}
