/**
 * NP-OF-04 "Make available offline": favorites, the last 20 opened pages and
 * pages the user pins are fetched while online and kept in the IndexedDB read
 * cache (exempt from its LRU), so they open with no connection.
 *
 * - Everything is per account + vault (`scopeKey`), on this device only.
 * - Reads go through the normal `rest.getNote` (gateway permission check, the
 *   same read-through cache); a page the user lost access to answers 403/404
 *   and the cache drops it — prefetch never widens what can be read.
 * - Bounded and quiet: ≤ 60 pages per pass, 2 at a time, only while the tab is
 *   visible, and only pages whose tree `updatedAt` changed since the last copy
 *   (or whose copy is over a week old, so a pinned page never ages out). Passes
 *   run 2 s after start, on reconnect, on a pin, when the tab becomes visible
 *   after an hour, and hourly.
 */
import { setOfflineAvailability, useUIStore, isVaultNoteId } from "@prism/core";
import { getNote, treeStamps } from "../parachute/rest";
import { getPreferences } from "../parachute/pages";
import { captureWriteContext, scopeKey } from "./writeScope";
import { cacheDeletePrefix, setProtectedCacheKeys, sweepReadCache } from "./readCache";

const MAX_RECENT = 20;
const MAX_PINNED = 200;
const MAX_PER_PASS = 60;
const PASS_INTERVAL_MS = 60 * 60_000;
const REFRESH_COPY_MS = 7 * 24 * 60 * 60_000;
const listeners = new Set<() => void>();
/** id → [tree updatedAt it was copied at, when]. Persisted per scope (ids + timestamps only). */
let fetched = new Map<string, [string, number]>();
let lastPass = 0;
const stampsKey = (s: string) => `prism:offline-stamps:${s}`;
function loadStamps(s: string): Map<string, [string, number]> {
  try {
    const v = JSON.parse(localStorage.getItem(stampsKey(s)) ?? "{}") as Record<string, [string, number]>;
    return new Map(Object.entries(v).filter(([id, e]) => isVaultNoteId(id) && Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number"));
  } catch { return new Map(); }
}
function saveStamps(s: string): void {
  try { localStorage.setItem(stampsKey(s), JSON.stringify(Object.fromEntries(fetched))); } catch { /* in-memory only */ }
}
let scope: string | null = null;
let pinned: string[] = [];
let recent: string[] = [];
let running: Promise<void> | null = null;
let again = false;

const storeKey = (kind: "pinned" | "recent", s: string) => `prism:offline-${kind}:${s}`;
function readList(kind: "pinned" | "recent", s: string, cap: number): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(kind, s)) ?? "[]");
    return Array.isArray(v) ? v.filter((id): id is string => typeof id === "string" && isVaultNoteId(id)).slice(0, cap) : [];
  } catch { return []; }
}
function writeList(kind: "pinned" | "recent", s: string, ids: string[]): void {
  try { localStorage.setItem(storeKey(kind, s), JSON.stringify(ids)); } catch { /* private mode: in-memory only */ }
}

async function currentScope(): Promise<string | null> {
  const context = await captureWriteContext().catch(() => null);
  return context ? scopeKey(context.scope) : null;
}

async function syncScope(): Promise<string | null> {
  const next = await currentScope();
  if (next !== scope) {
    scope = next;
    pinned = next ? readList("pinned", next, MAX_PINNED) : [];
    recent = next ? readList("recent", next, MAX_RECENT) : [];
    fetched = next ? loadStamps(next) : new Map();
    listeners.forEach((fn) => fn());
  }
  return scope;
}

async function favorites(): Promise<string[]> {
  try { return (await getPreferences()).preferences.favorites ?? []; } catch { return []; }
}

const cacheKeyFor = (s: string, id: string) => `${s}|/notes/${encodeURIComponent(id)}`;

async function pass(): Promise<void> {
  const s = await syncScope();
  if (!s || !navigator.onLine || document.visibilityState === "hidden") return;
  lastPass = Date.now();
  const targets = [...new Set([...pinned, ...(await favorites()), ...recent])].filter(isVaultNoteId).slice(0, MAX_PER_PASS);
  if (s !== scope) return;
  setProtectedCacheKeys(targets.map((id) => cacheKeyFor(s, id)));
  for (const id of [...fetched.keys()]) if (!targets.includes(id)) fetched.delete(id);
  const tree = treeStamps.scope === s ? treeStamps.rows : null;
  const due = targets.filter((id) => {
    if (tree && !tree.has(id)) return false; // no longer visible to this account: never fetch
    const copy = fetched.get(id);
    if (!copy || Date.now() - copy[1] > REFRESH_COPY_MS) return true;
    const stamp = tree?.get(id);
    return stamp ? stamp !== copy[0] : false; // changed-only; unknown revision → keep the copy
  });
  const worker = async () => {
    for (let id = due.shift(); id; id = due.shift()) {
      if (!navigator.onLine || s !== scope) return;
      try {
        const note = await getNote(id);
        fetched.set(id, [note.updatedAt ?? "", Date.now()]);
      } catch { fetched.delete(id); /* lost access or offline: the cache already reflects it */ }
    }
  };
  await Promise.all([worker(), worker()]);
  if (s === scope) saveStamps(s);
}

export function prefetchOfflinePages(): Promise<void> {
  if (running) { again = true; return running; }
  running = pass().finally(() => {
    running = null;
    if (again) { again = false; void prefetchOfflinePages(); }
  });
  return running;
}

async function rememberOpened(noteId: string | undefined): Promise<void> {
  if (!noteId || !isVaultNoteId(noteId)) return;
  const s = await syncScope();
  if (!s || s !== scope) return;
  if (recent[0] === noteId) return;
  recent = [noteId, ...recent.filter((id) => id !== noteId)].slice(0, MAX_RECENT);
  writeList("recent", scope, recent);
}

let started = false;
export function startOfflineAvailability(): void {
  if (started) return;
  started = true;
  setOfflineAvailability({
    isAvailable: (id) => pinned.includes(id),
    setAvailable: (id, on) => {
      if (!scope || !isVaultNoteId(id)) return;
      pinned = on ? [id, ...pinned.filter((p) => p !== id)].slice(0, MAX_PINNED) : pinned.filter((p) => p !== id);
      writeList("pinned", scope, pinned);
      if (on) fetched.delete(id);
      else {
        // "Remove offline copy" really removes it: the cached body, and the
        // page from this device's recent list (so it isn't simply re-fetched).
        recent = recent.filter((r) => r !== id);
        writeList("recent", scope, recent);
        fetched.delete(id);
        saveStamps(scope);
        void cacheDeletePrefix(cacheKeyFor(scope, id));
      }
      listeners.forEach((fn) => fn());
      void prefetchOfflinePages();
    },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  });
  let lastTab: string | null = null;
  const onTabs = (state: ReturnType<typeof useUIStore.getState>) => {
    if (state.activeTabId === lastTab) return;
    lastTab = state.activeTabId;
    void rememberOpened(state.openTabs.find((t) => t.id === state.activeTabId)?.noteId);
  };
  void syncScope().then(() => onTabs(useUIStore.getState()));
  useUIStore.subscribe(onTabs);
  window.addEventListener("online", () => { void sweepReadCache(); void prefetchOfflinePages(); });
  window.addEventListener("prism:vault-changed", () => { scope = null; void prefetchOfflinePages(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastPass > PASS_INTERVAL_MS) void prefetchOfflinePages();
  });
  void sweepReadCache();
  window.setTimeout(() => void prefetchOfflinePages(), 2_000);
  window.setInterval(() => void prefetchOfflinePages(), PASS_INTERVAL_MS);
}
