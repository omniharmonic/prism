import * as Y from "yjs";
import { scopeKey, type WriteScope } from "../offline/writeScope";

export type LocalSaveState = "saving" | "saved" | "unavailable";
const DATABASE = "prism-collab-v3";

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
  try {
    const stored = await new Promise<Uint8Array | undefined>((resolve, reject) => {
      const request = db.transaction("documents").objectStore("documents").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (stored) Y.applyUpdate(doc, stored);
  } catch (error) { db.close(); throw error; }
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
          const previous = store.get(key);
          // A second tab can persist the same document while this one is offline.
          // Merge inside the write transaction so neither tab erases the other.
          previous.onsuccess = () => store.put(previous.result ? Y.mergeUpdates([previous.result, snapshot]) : snapshot, key);
          await done;
        }
        onState("saved");
      } catch { onState("unavailable"); }
      finally { writing = null; if (stopped) db.close(); }
    })();
  };
  doc.on("update", write);
  onState("saved");
  return {
    async flush() { if (writing) await writing; },
    close() { stopped = true; doc.off("update", write); if (!writing) db.close(); },
  };
}
