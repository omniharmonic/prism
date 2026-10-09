import * as Y from "yjs";
import { PENDING_MAX_CHARS, toBase64, readPending, openDatabase, readStoredDocument, transactionDone, pendingStorageKey, type LocalSaveState } from "./localDocumentStore";
import { IDB_RETRY_DELAYS_MS, idbRetryable } from "../offline/idbRetry";

/** After local saving failed for good, look again this often while an edit is still unconfirmed. */
const RECOVER_MS = 5000;

// The Yjs-free half (keys, purges, rescue-entry names) lives in ./localDocumentStore.
export { pendingStorageKey, purgeLocalDocuments, purgePendingForScope, localDocumentKey, type LocalSaveState } from "./localDocumentStore";

/** Transactional snapshots: every acknowledgement means the complete CRDT reached disk.
 * Snapshot writes are serialized and coalesce edits arriving during a disk write.
 * Unscoped v2 databases are deliberately retained, never loaded or silently deleted.
 */
export async function persistLocalDocument(key: string, doc: Y.Doc, onState: (state: LocalSaveState) => void) {
  // The connection can die under an open document (iOS closes it while the app is in the
  // background): it is replaced and the write tried again before "unavailable" is reported,
  // and a failed save keeps being retried so the state clears itself when storage returns.
  let db: IDBDatabase | null = null;
  const connection = async (): Promise<IDBDatabase> => (db ??= await openDatabase());
  const drop = () => { try { db?.close(); } catch { /* already closed */ } db = null; };
  let stopped = false;
  let dirty = false;
  let failed = false;
  let recover: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | null = null;
  /** State vector of the last snapshot IndexedDB confirmed (null = none yet this session). */
  let confirmed: Uint8Array | null = null;
  /** The rescue value this session has merged into the doc and not yet seen reach IndexedDB. */
  let rescued: string | null = null;
  // THROWS when the stored state cannot be read (after the retries): the caller must not
  // treat that as an empty document.
  const stored = await readStoredDocument(key);
  if (stored) Y.applyUpdate(doc, stored);
  confirmed = Y.encodeStateVector(doc);
  const pending = readPending(key);
  if (pending) {
    try { Y.applyUpdate(doc, pending.update); rescued = pending.raw; }
    catch { try { localStorage.removeItem(pendingStorageKey(key)); } catch { /* unreadable rescue */ } }
  }
  const dropRescue = () => {
    if (rescued === null) return;
    // Only the value this session folded in: another tab may have written a newer one.
    try { if (localStorage.getItem(pendingStorageKey(key)) === rescued) localStorage.removeItem(pendingStorageKey(key)); } catch { /* storage unavailable */ }
    rescued = null;
  };
  /** One snapshot transaction on the current connection. */
  const writeOnce = async () => {
    const transaction = (await connection()).transaction("documents", "readwrite");
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
  };
  const write = () => {
    dirty = true;
    // While local saving is failing the state stays "unavailable" until a write is confirmed.
    if (!failed) onState("saving");
    if (writing) return;
    clearTimeout(recover);
    writing = (async () => {
      try {
        while (dirty) {
          dirty = false;
          for (let attempt = 0; ; attempt++) {
            try { await writeOnce(); break; }
            catch (error) {
              drop(); // an aborted transaction wrote nothing: a new connection may simply work
              if (stopped || attempt >= IDB_RETRY_DELAYS_MS.length || !idbRetryable(error)) throw error;
              await new Promise((resolve) => setTimeout(resolve, IDB_RETRY_DELAYS_MS[attempt]));
            }
          }
        }
        failed = false;
        onState("saved");
      } catch {
        // NOT saved on this device — say so, keep the edit marked unconfirmed, and look again.
        dirty = true;
        failed = true;
        onState("unavailable");
        if (!stopped) recover = setTimeout(write, RECOVER_MS);
      }
      finally { writing = null; if (stopped) drop(); }
    })();
  };
  const wake = () => { if (failed && !stopped && document.visibilityState !== "hidden") write(); };
  if (typeof window !== "undefined") {
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
  }
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
    close() {
      stopped = true;
      clearTimeout(recover);
      doc.off("update", write);
      if (typeof window !== "undefined") {
        window.removeEventListener("pageshow", wake);
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
      }
      if (!writing) drop();
    },
  };
}
