/**
 * Offline write outbox. Mutations that can't reach the vault (offline / network
 * error) are queued in IndexedDB and replayed in order when connectivity
 * returns. Reads are handled separately by the service worker's NetworkFirst
 * cache, so together they give a real offline experience.
 *
 * Queued requests store the method + the api-relative path + the JSON body, so
 * replay is a plain fetch against the current connection — no coupling to the
 * typed rest layer.
 */
import { apiBase, capabilityHeader } from "../config";

export interface QueuedWrite {
  id?: number;
  method: string;
  /** Path relative to the vault api base, e.g. "/notes/123". */
  path: string;
  body?: string;
  queuedAt: number;
}

const DB_NAME = "prism-web";
const STORE = "outbox";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

// --- subscribers (for the offline indicator) ---
const subscribers = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
function notify() {
  subscribers.forEach((fn) => fn());
}

export async function enqueue(method: string, path: string, body?: string): Promise<void> {
  await tx("readwrite", (s) => s.add({ method, path, body, queuedAt: Date.now() }));
  notify();
}

export async function pendingCount(): Promise<number> {
  return tx("readonly", (s) => s.count());
}

async function allQueued(): Promise<QueuedWrite[]> {
  const items = await tx<QueuedWrite[]>("readonly", (s) => s.getAll());
  return items.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

async function remove(id: number): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
  notify();
}

let flushing = false;

/**
 * Replay queued writes in order. Stops on the first network failure (still
 * offline) so ordering is preserved. Terminal HTTP responses (2xx, 404, 410)
 * drop the item; a 409 is retried once with force:true (offline edits win).
 */
export async function flush(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    // Auth via the session cookie (credentials: "include"); capability-link
    // recipients also send the Capability header. No vault token.
    const auth = { "Content-Type": "application/json", ...capabilityHeader() };
    for (const item of await allQueued()) {
      let resp: Response;
      try {
        resp = await fetch(`${apiBase()}${item.path}`, {
          method: item.method,
          credentials: "include",
          headers: auth,
          body: item.body,
        });
      } catch {
        break; // network error — still offline, keep the rest queued
      }

      if (resp.status === 409 && item.method === "PATCH" && item.body) {
        // Stale precondition — re-send as a forced last-write-wins update.
        const forced = JSON.stringify({ ...JSON.parse(item.body), if_updated_at: undefined, force: true });
        try {
          resp = await fetch(`${apiBase()}${item.path}`, { method: "PATCH", credentials: "include", headers: auth, body: forced });
        } catch {
          break;
        }
      }

      if (resp.ok || resp.status === 404 || resp.status === 410) {
        await remove(item.id!);
      } else {
        // 5xx or other — stop and retry on the next flush.
        break;
      }
    }
  } catch {
    /* no connection configured yet — nothing to flush */
  } finally {
    flushing = false;
  }
}

/** Start background replay: on reconnect, on a timer, and once at startup. */
export function startOutboxSync(): void {
  window.addEventListener("online", () => void flush());
  window.setInterval(() => void flush(), 30_000);
  void flush();
}
