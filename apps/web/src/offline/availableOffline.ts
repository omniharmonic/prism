/**
 * NP-OF-04 "Make available offline": favorites, the last 20 opened pages and
 * pages the user pins are fetched while online and kept in the IndexedDB read
 * cache (exempt from its LRU), so they open with no connection.
 *
 * - Everything is per account + vault (`scopeKey`), on this device only.
 * - Reads go through the normal `rest.getNote` (gateway permission check, the
 *   same read-through cache); a page the user lost access to answers 403/404
 *   and the cache drops it — prefetch never widens what can be read.
 * - Bounded: ≤ 60 pages per pass, 2 at a time, each page at most every 10 min;
 *   passes run 2 s after start, on reconnect, on a pin, and every 15 min.
 */
import { setOfflineAvailability, useUIStore, isVaultNoteId } from "@prism/core";
import { getNote } from "../parachute/rest";
import { getPreferences } from "../parachute/pages";
import { captureWriteContext, scopeKey } from "./writeScope";
import { setProtectedCacheKeys } from "./readCache";

const MAX_RECENT = 20;
const MAX_PINNED = 200;
const MAX_PER_PASS = 60;
const REFRESH_MS = 10 * 60_000;
const listeners = new Set<() => void>();
const fetchedAt = new Map<string, number>();
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
    fetchedAt.clear();
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
  if (!s || !navigator.onLine) return;
  const targets = [...new Set([...pinned, ...(await favorites()), ...recent])].filter(isVaultNoteId).slice(0, MAX_PER_PASS);
  if (s !== scope) return;
  setProtectedCacheKeys(targets.map((id) => cacheKeyFor(s, id)));
  const due = targets.filter((id) => (fetchedAt.get(id) ?? 0) < Date.now() - REFRESH_MS);
  const worker = async () => {
    for (let id = due.shift(); id; id = due.shift()) {
      if (!navigator.onLine || s !== scope) return;
      try { await getNote(id); fetchedAt.set(id, Date.now()); } catch { /* lost access or offline: the cache already reflects it */ }
    }
  };
  await Promise.all([worker(), worker()]);
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
      if (on) fetchedAt.delete(id);
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
  window.addEventListener("online", () => void prefetchOfflinePages());
  window.addEventListener("prism:vault-changed", () => { scope = null; void prefetchOfflinePages(); });
  window.setTimeout(() => void prefetchOfflinePages(), 2_000);
  window.setInterval(() => void prefetchOfflinePages(), 15 * 60_000);
}
