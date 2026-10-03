import * as Y from "yjs";
import { scopeKey, type WriteScope } from "../offline/writeScope";

export type LocalSaveState = "saving" | "saved" | "unavailable";
const DATABASE = "prism-collab-v3";
/** Unload rescue (wave 3): the part of a document the asynchronous IndexedDB write
 *  had not confirmed when the page went away, written SYNCHRONOUSLY to localStorage
 *  (same per-account/vault key as the IndexedDB row) and folded back into IndexedDB
 *  the next time the document is opened or background-synced. */
const PENDING_PREFIX = "prism:collab-pending:";
const PENDING_MAX_CHARS = 1_500_000;
const toBase64 = (bytes: Uint8Array): string => { let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); };
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
/** A short, non-reversible tag for a string (two 32-bit FNV-1a passes → 16 hex).
 *  Synchronous on purpose: it is used inside `pagehide`. */
function tag(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ ((c << 5) | (c >>> 3)) ^ i, 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
const parts = (key: string): [string, string] => {
  try { const v = JSON.parse(key) as unknown; if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]]; } catch { /* not a scoped key */ }
  return ["", key];
};
/** The localStorage key of a document's rescue entry: `<prefix><scope tag>.<document tag>` —
 *  never the account, vault or document name themselves (review M3). */
export function pendingStorageKey(key: string): string {
  const [scope, name] = parts(key);
  return `${PENDING_PREFIX}${tag(scope)}.${tag(name)}`;
}
function readPending(key: string): { raw: string; update: Uint8Array } | null {
  try {
    const raw = localStorage.getItem(pendingStorageKey(key));
    return raw ? { raw, update: fromBase64(raw) } : null;
  } catch { return null; }
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("documents");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local document storage is blocked"));
  });
}

/**
 * Delete local live-document state (review M3): every IndexedDB row and rescue
 * entry of the scopes `scopes(scopeKey)` selects, except the documents `keep`
 * names. Returns how many rows were removed. Never throws.
 */
export async function purgeLocalDocuments(scopes: (scopeKey: string) => boolean, keep: (scopeKey: string, documentName: string) => boolean): Promise<number> {
  let removed = 0;
  const kept = new Set<string>();
  const purgedScopes = new Set<string>();
  try {
    const db = await openDatabase();
    try {
      const transaction = db.transaction("documents", "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore("documents");
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => { const r = store.getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      for (const key of keys) {
        if (typeof key !== "string") continue;
        const [scope, name] = parts(key);
        if (!scopes(scope)) continue;
        purgedScopes.add(tag(scope));
        if (keep(scope, name)) { kept.add(pendingStorageKey(key)); continue; }
        store.delete(key);
        removed++;
      }
      await done;
    } finally { db.close(); }
  } catch { /* storage unavailable: nothing to remove */ }
  return removed + purgePending((scopeTag) => purgedScopes.has(scopeTag), kept);
}
/** Remove rescue entries of the selected scope tags, except `kept` keys. */
function purgePending(scopeTags: (scopeTag: string) => boolean, kept: Set<string>): number {
  let removed = 0;
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(PENDING_PREFIX) || kept.has(k)) continue;
      if (scopeTags(k.slice(PENDING_PREFIX.length).split(".")[0] ?? "")) { localStorage.removeItem(k); removed++; }
    }
  } catch { /* private mode */ }
  return removed;
}
/** Rescue entries of one scope that have no IndexedDB row yet are removed too. */
export function purgePendingForScope(scopeKey: string, keepKeys: string[]): void {
  const kept = new Set(keepKeys.map(pendingStorageKey));
  purgePending((t) => t === tag(scopeKey), kept);
}

/** Everything this device holds for one document (IndexedDB row + rescue), base64; null if nothing. */
export async function exportLocalDocument(key: string): Promise<string | null> {
  try {
    const db = await openDatabase();
    try {
      const stored = await new Promise<Uint8Array | undefined>((resolve, reject) => {
        const request = db.transaction("documents").objectStore("documents").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const pending = readPending(key);
      const all = [stored, pending?.update].filter((u): u is Uint8Array => !!u);
      return all.length ? toBase64(all.length === 1 ? all[0]! : Y.mergeUpdates(all)) : null;
    } finally { db.close(); }
  } catch { return null; }
}
/** No credentials or unscoped legacy state. Call only after checking document access. */
export function localDocumentKey(scope: WriteScope, documentName: string): string {
  return JSON.stringify([scopeKey(scope), documentName]);
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Local save failed"));
  });
}

/** Transactional snapshots: every acknowledgement means the complete CRDT reached disk.
 * Snapshot writes are serialized and coalesce edits arriving during a disk write.
 * Unscoped v2 databases are deliberately retained, never loaded or silently deleted.
 */
export async function persistLocalDocument(key: string, doc: Y.Doc, onState: (state: LocalSaveState) => void) {
  const db = await openDatabase();
  let stopped = false;
  let dirty = false;
  let writing: Promise<void> | null = null;
  /** State vector of the last snapshot IndexedDB confirmed (null = none yet this session). */
  let confirmed: Uint8Array | null = null;
  /** The rescue value this session has merged into the doc and not yet seen reach IndexedDB. */
  let rescued: string | null = null;
  try {
    const stored = await new Promise<Uint8Array | undefined>((resolve, reject) => {
      const request = db.transaction("documents").objectStore("documents").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (stored) Y.applyUpdate(doc, stored);
    confirmed = Y.encodeStateVector(doc);
    const pending = readPending(key);
    if (pending) {
      try { Y.applyUpdate(doc, pending.update); rescued = pending.raw; }
      catch { try { localStorage.removeItem(pendingStorageKey(key)); } catch { /* unreadable rescue */ } }
    }
  } catch (error) { db.close(); throw error; }
  const dropRescue = () => {
    if (rescued === null) return;
    // Only the value this session folded in: another tab may have written a newer one.
    try { if (localStorage.getItem(pendingStorageKey(key)) === rescued) localStorage.removeItem(pendingStorageKey(key)); } catch { /* storage unavailable */ }
    rescued = null;
  };
  const write = () => {
    dirty = true;
    onState("saving");
    if (writing) return;
    writing = (async () => {
      try {
        while (dirty) {
          dirty = false;
          const transaction = db.transaction("documents", "readwrite");
          const done = transactionDone(transaction);
          const store = transaction.objectStore("documents");
          const snapshot = Y.encodeStateAsUpdate(doc);
          const vector = Y.encodeStateVector(doc);
          const covered = rescued;
          const previous = store.get(key);
          // A second tab can persist the same document while this one is offline.
          // Merge inside the write transaction so neither tab erases the other.
          previous.onsuccess = () => store.put(previous.result ? Y.mergeUpdates([previous.result, snapshot]) : snapshot, key);
          await done;
          confirmed = vector;
          // A rescue taken while this transaction ran is not covered by it: write once more.
          if (rescued !== null) { if (covered === rescued) dropRescue(); else dirty = true; }
        }
        onState("saved");
      } catch { onState("unavailable"); }
      finally { writing = null; if (stopped) db.close(); }
    })();
  };
  doc.on("update", write);
  if (rescued !== null) write(); else onState("saved");
  return {
    async flush() { if (writing) await writing; },
    /** True while an edit has not been confirmed by IndexedDB. */
    pending: () => dirty || writing !== null,
    /**
     * Page is going away (pagehide / hidden): put whatever IndexedDB has not confirmed
     * into localStorage NOW — a synchronous write survives a navigation that aborts
     * the IndexedDB transaction. Returns false when nothing could be stored (private
     * mode, quota, oversized) — the caller's beforeunload warning is the fallback.
     */
    rescue(): boolean {
      if (!dirty && writing === null) return true;
      try {
        let update = Y.encodeStateAsUpdate(doc, confirmed ?? undefined);
        const earlier = readPending(key);
        if (earlier) update = Y.mergeUpdates([earlier.update, update]);
        const raw = toBase64(update);
        if (raw.length > PENDING_MAX_CHARS) return false;
        localStorage.setItem(pendingStorageKey(key), raw);
        rescued = raw;
        return true;
      } catch { return false; }
    },
    close() { stopped = true; doc.off("update", write); if (!writing) db.close(); },
  };
}
