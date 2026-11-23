import * as Y from "yjs";
import { PENDING_MAX_CHARS, toBase64, readPending, openDatabase, readStoredParts, transactionDone, pendingStorageKey, deltaKey, deltaRange, nextDeltaSeq, type LocalSaveState } from "./localDocumentStore";
import { IDB_RETRY_DELAYS_MS, idbRetryable } from "../offline/idbRetry";

/** After local saving failed for good, look again this often while an edit is still unconfirmed. */
const RECOVER_MS = 5000;
/** L-1: fold the delta rows into the base when they add up to half the base (at least
 *  COMPACT_MIN_BYTES) — a compaction rewrites the whole base, so it is paid by bytes, not by count
 *  (typing makes many tiny updates) — or after COMPACT_EVERY rows, or COMPACT_IDLE_MS of quiet. */
export const COMPACT_MIN_BYTES = 128 * 1024;
export const COMPACT_EVERY = 1_000;
export const COMPACT_IDLE_MS = 30_000;
/** What local persistence wrote (L-1 acceptance: an agent burst must stay far under ~10 MB). */
export const localDocumentStats = { writes: 0, deltaWrites: 0, compactions: 0, bytesWritten: 0 };

// The Yjs-free half (keys, purges, rescue-entry names) lives in ./localDocumentStore.
export { pendingStorageKey, purgeLocalDocuments, purgePendingForScope, localDocumentKey, type LocalSaveState } from "./localDocumentStore";

/** Every acknowledgement means the complete CRDT reached disk: the stored BASE plus the DELTA
 * rows (each an update since the previous write) hold everything up to `confirmed`.
 * Writes are serialized and coalesce edits arriving during a disk write.
 * L-1 (2026-11-08): each write used to re-encode and re-store the WHOLE document (200 KB a write
 * on the incident's page, local and remote updates alike). Now a write stores only the delta since
 * the last confirmed state; the deltas are folded into the base every COMPACT_EVERY writes or after
 * COMPACT_IDLE_MS of quiet, in one transaction that also merges what another tab stored.
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
  const stored = await readStoredParts(key);
  if (stored.base) Y.applyUpdate(doc, stored.base);
  for (const d of stored.deltas) Y.applyUpdate(doc, d);
  /** No base row yet: the first write stores one (deltas never exist without a base). */
  let hasBase = !!stored.base;
  let deltaCount = stored.deltas.length;
  let baseBytes = stored.base?.byteLength ?? 0;
  let deltaBytes = stored.deltas.reduce((n, d) => n + d.byteLength, 0);
  let compactTimer: ReturnType<typeof setTimeout> | undefined;
  let compactNow = false;
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
  /** One write transaction on the current connection: a delta, or a compaction into the base. */
  const writeOnce = async () => {
    const transaction = (await connection()).transaction("documents", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("documents");
    const vector = Y.encodeStateVector(doc);
    const covered = rescued;
    const compact = !hasBase || compactNow || deltaCount >= COMPACT_EVERY || deltaBytes >= Math.max(COMPACT_MIN_BYTES, baseBytes / 2);
    let wrote = 0;
    if (compact) {
      const snapshot = Y.encodeStateAsUpdate(doc);
      const previous = store.get(key);
      const deltas = store.getAll(deltaRange(key));
      // A second tab can persist the same document while this one is offline: merge its base AND
      // deltas inside this transaction, then drop the deltas — nothing is lost, nobody's edit erased.
      deltas.onsuccess = () => {
        const parts = [...(previous.result ? [previous.result as Uint8Array] : []), ...(deltas.result as Uint8Array[]), snapshot];
        const merged = parts.length > 1 ? Y.mergeUpdates(parts) : snapshot;
        store.put(merged, key);
        store.delete(deltaRange(key));
        wrote = merged.byteLength;
        localDocumentStats.bytesWritten += merged.byteLength;
      };
    } else {
      const delta = Y.encodeStateAsUpdate(doc, confirmed ?? undefined);
      store.put(delta, deltaKey(key, nextDeltaSeq()));
      wrote = delta.byteLength;
      localDocumentStats.bytesWritten += delta.byteLength;
    }
    await done;
    localDocumentStats.writes++;
    if (compact) { localDocumentStats.compactions++; hasBase = true; deltaCount = 0; deltaBytes = 0; baseBytes = wrote; compactNow = false; }
    else { localDocumentStats.deltaWrites++; deltaCount++; deltaBytes += wrote; }
    confirmed = vector;
    // Fold the deltas in once the document has been quiet for a while.
    clearTimeout(compactTimer);
    if (deltaCount > 0 && !stopped) compactTimer = setTimeout(() => { compactNow = true; write(); }, COMPACT_IDLE_MS);
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
      clearTimeout(compactTimer); // the deltas stay on disk and are folded in at the next open's first write
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
