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
function readPending(key: string): { raw: string; update: Uint8Array } | null {
  try {
    const raw = localStorage.getItem(PENDING_PREFIX + key);
    return raw ? { raw, update: fromBase64(raw) } : null;
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
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("documents");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local document storage is blocked"));
  });
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
      catch { try { localStorage.removeItem(PENDING_PREFIX + key); } catch { /* unreadable rescue */ } }
    }
  } catch (error) { db.close(); throw error; }
  const dropRescue = () => {
    if (rescued === null) return;
    // Only the value this session folded in: another tab may have written a newer one.
    try { if (localStorage.getItem(PENDING_PREFIX + key) === rescued) localStorage.removeItem(PENDING_PREFIX + key); } catch { /* storage unavailable */ }
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
        localStorage.setItem(PENDING_PREFIX + key, raw);
        rescued = raw;
        return true;
      } catch { return false; }
    },
    close() { stopped = true; doc.off("update", write); if (!writing) db.close(); },
  };
}
