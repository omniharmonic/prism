import * as Y from "yjs";
import { PENDING_MAX_CHARS, toBase64, readPending, openDatabase, transactionDone, pendingStorageKey, type LocalSaveState } from "./localDocumentStore";

// The Yjs-free half (keys, purges, rescue-entry names) lives in ./localDocumentStore.
export { pendingStorageKey, purgeLocalDocuments, purgePendingForScope, localDocumentKey, type LocalSaveState } from "./localDocumentStore";

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
