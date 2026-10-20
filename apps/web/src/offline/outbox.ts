/** Scoped, durable writes. A conflict or unknown outcome is NEVER forced/retried. */
import { serverFetch } from "../transport";
import { idbRetry } from "./idbRetry";
import {
  captureWriteContext,
  sameScope,
  scopeKey,
  type WriteContext,
  type WriteScope,
} from "./writeScope";

export type WriteState =
  | "queued"
  | "sending"
  | "conflict"
  | "missing"
  | "blocked"
  | "unknown"
  | "quarantined";
export interface QueuedWrite {
  id?: number;
  version?: 2;
  operationId?: string;
  scope?: WriteScope;
  method: string;
  path: string;
  body?: string;
  queuedAt: number;
  attemptedAt?: number;
  state?: WriteState;
  detail?: string;
  temporaryId?: string;
  /** "meta": a metadata-only merge with no base revision. Replayed as a per-key
   *  merge against the CURRENT note (properties route, else read + CAS), never forced. */
  kind?: "meta";
  /** Meta rows: each key's value BEFORE the first offline edit (per-key CAS on replay). */
  expect?: Record<string, unknown>;
  /** Automatic retries so far, and when the next one may run (retry-safe rows only). */
  attempts?: number;
  nextAttemptAt?: number;
}

/** The note a row targets (or its temporary id for a queued create); other paths key on themselves. */
export function noteKey(item: Pick<QueuedWrite, "method" | "path" | "temporaryId">): string {
  if (item.method === "POST" && item.path === "/notes" && item.temporaryId) return item.temporaryId;
  const id = item.path.match(/^\/notes\/([^/?]+)/)?.[1];
  return id ? decodeURIComponent(id) : item.path;
}
interface IdMapping {
  key: string;
  noteId: string;
  revision?: string;
}
const DB_NAME = "prism-web";
const STORE = "outbox";
const MAPPINGS = "note-ids";
let database: Promise<IDBDatabase> | undefined;
/** Forget the connection (and close it if it ever opened): the next call opens a new one. */
function dropConnection(): void {
  const stale = database;
  database = undefined;
  void stale?.then((db) => db.close(), () => undefined).catch(() => undefined);
}
/**
 * One unit of storage work on the shared connection. A connection the browser has closed
 * under us (iOS: the storage process restarted while the app was in the background) is
 * replaced and the unit run again — see `idbRetry`. The final failure is the caller's.
 */
function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  return idbRetry(async () => run(await openDb()), dropConnection);
}

function openDb(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains(MAPPINGS))
          db.createObjectStore(MAPPINGS, { keyPath: "key" });
        const cursor = request.transaction!.objectStore(STORE).openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (!row.value.scope)
            row.update({
              ...row.value,
              state: "quarantined",
              detail:
                "This older change has no recorded account or vault. It will not be sent automatically.",
            });
          row.continue();
        };
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        // The browser closed the connection itself (storage process gone): open a new one next time.
        request.result.onclose = () => {
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        database = undefined;
        reject(new Error("Close older Prism tabs to upgrade offline storage."));
      };
    });
  // A refused open (however it is reported) is never kept: the next call opens again.
  const opening = database;
  opening.catch(() => { if (database === opening) database = undefined; });
  return database;
}

/** Request success is not transaction durability: resolve only after commit. */
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return withDb((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () =>
      reject(
        tx.error ?? new Error("Could not save this change on this device."),
      );
  }));
}
const subscribers = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
/** Other tabs share this IndexedDB: tell them when rows or revisions change. */
const channel: BroadcastChannel | null = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("prism-outbox");
function notify(broadcast = true) {
  subscribers.forEach((fn) => fn());
  if (broadcast) channel?.postMessage({ type: "changed" });
}
/** IndexedDB refused a write: the change is NOT on this device (review M5). */
function storageFailed(error: unknown): never {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("prism:storage-failed"));
  throw error instanceof Error ? error : new Error("Could not save this change on this device.");
}
async function put(item: QueuedWrite): Promise<void> {
  await transaction("readwrite", (s) => s.put(item));
  notify();
}
async function getRow(id: number): Promise<QueuedWrite | undefined> {
  return transaction<QueuedWrite | undefined>("readonly", (s) => s.get(id));
}
export async function allQueued(): Promise<QueuedWrite[]> {
  return (await transaction<QueuedWrite[]>("readonly", (s) => s.getAll())).sort(
    (a, b) => (a.id ?? 0) - (b.id ?? 0),
  );
}

type Patch = Record<string, unknown>;
const parse = (body?: string): Patch => (body ? (JSON.parse(body) as Patch) : {});
const CLIENT_OP = "prism_client_op";
const isCreate = (item: Pick<QueuedWrite, "method" | "path">) => item.method === "POST" && item.path === "/notes";

/**
 * May this row be sent again after an outcome we could not confirm (network
 * error, timeout, 5xx, 429)? Yes when a duplicate delivery cannot do harm:
 *  - a write guarded by a base revision (a second delivery gets a 409, which we
 *    recognise as "already applied" by comparing the note);
 *  - a metadata merge (setting the same keys twice is the same result);
 *  - tag / link deltas (set operations);
 *  - a create carrying its client operation id (looked up by path before re-sending).
 * Anything else — a forced content/metadata/path write — is never re-sent blindly.
 */
export function retrySafe(item: Pick<QueuedWrite, "method" | "path" | "body" | "kind">): boolean {
  if (item.kind === "meta") return true;
  const patch = parse(item.body);
  if (isCreate(item)) return typeof (patch.metadata as Patch | undefined)?.[CLIENT_OP] === "string";
  if (item.method !== "PATCH") return false;
  if (typeof patch.if_updated_at === "string") return true;
  return !["content", "metadata", "path"].some((k) => k in patch);
}

/** A sender that died (closed tab, reload mid-send) must not leave a row "sending" forever. */
let staleSendingMs = 35_000; // > the 30 s request timeout, so a live sender is never pre-empted
export function setStaleSendingMsForTests(ms: number): void { staleSendingMs = ms; }
export async function recoverInterrupted(): Promise<void> {
  let changed = false;
  await withDb((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      const item = row.value as QueuedWrite;
      if (item.state === "sending" && (item.attemptedAt ?? 0) < Date.now() - staleSendingMs) {
        changed = true;
        // A retry-safe row simply goes back in the queue; anything else needs a human.
        row.update(retrySafe(item)
          ? { ...item, state: "queued", attempts: (item.attempts ?? 0) + 1, nextAttemptAt: 0 }
          : { ...item, state: "unknown", detail: "A previous session stopped before confirming this change. Check the note before applying it again." });
      }
      row.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  }));
  if (changed) notify();
}
export async function visibleWrites(): Promise<QueuedWrite[]> {
  const context = await captureWriteContext().catch(() => null);
  if (!context) return [];
  await recoverInterrupted();
  const rows = await allQueued();
  const current = await captureWriteContext().catch(() => null);
  return current && sameScope(current.scope, context.scope)
    ? rows.filter((item) => sameScope(item.scope, context.scope))
    : [];
}
export async function pendingCount(): Promise<number> {
  return (await visibleWrites()).length;
}
export async function hasPending(context: WriteContext): Promise<boolean> {
  return (await allQueued()).some((item) =>
    sameScope(item.scope, context.scope),
  );
}
/** Rows for ONE note in this audience: a later write to it must queue behind them;
 *  writes to other notes go straight to the server. */
export async function hasPendingFor(context: WriteContext, key: string): Promise<boolean> {
  const ids = await mappings(context.scope);
  return (await allQueued()).some((item) => {
    if (!sameScope(item.scope, context.scope)) return false;
    const k = noteKey(item);
    return k === key || ids.get(k)?.noteId === key;
  });
}

/** Rows kept for another account / vault / workspace (review M4): never sent from here, never silently lost. */
export const OTHER_SCOPE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export async function otherScopeWrites(): Promise<{ count: number; oldestQueuedAt: number | null; expireSoon: number }> {
  const context = await captureWriteContext().catch(() => null);
  const rows = (await allQueued()).filter((r) => r.scope && (!context || !sameScope(r.scope, context.scope)));
  const soon = Date.now() - (OTHER_SCOPE_RETENTION_MS - 7 * 24 * 60 * 60 * 1000);
  return { count: rows.length, oldestQueuedAt: rows.length ? Math.min(...rows.map((r) => r.queuedAt)) : null, expireSoon: rows.filter((r) => r.queuedAt < soon).length };
}
/** Unsent rows of OTHER audiences are kept 30 days (the dialog warns for the last 7), then removed. */
export async function purgeExpiredOtherScopes(): Promise<number> {
  const context = await captureWriteContext().catch(() => null);
  if (!context) return 0;
  const cutoff = Date.now() - OTHER_SCOPE_RETENTION_MS;
  const expired = (await allQueued()).filter((r) => r.scope && !sameScope(r.scope, context.scope) && r.queuedAt < cutoff);
  for (const row of expired) await transaction("readwrite", (s) => s.delete(row.id!));
  if (expired.length) notify();
  return expired.length;
}
/** Every row of the CURRENT audience (for the sign-out warning's Download / Discard). */
export async function discardAllCurrent(): Promise<void> {
  const context = await captureWriteContext();
  for (const row of await allQueued()) if (sameScope(row.scope, context.scope) && row.state !== "sending") await transaction("readwrite", (s) => s.delete(row.id!));
  notify();
}

export async function discard(id: number): Promise<void> {
  let discardedNote: string | null = null;
  const context = await captureWriteContext();
  await withDb((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    let reason = "";
    request.onsuccess = () => {
      const row = request.result as QueuedWrite | undefined;
      if (!row || !sameScope(row.scope, context.scope))
        reason = "This change belongs to another workspace or account.";
      else if (row.state === "sending")
        reason = "Wait for this change to finish before discarding it.";
      if (reason) { tx.abort(); return; }
      store.delete(id);
      discardedNote = noteKey(row!);
      // Later saves of the same page were typed on top of the discarded one
      // (review M2): they must not go out as if it had been applied.
      const all = store.getAll();
      all.onsuccess = () => {
        for (const later of all.result as QueuedWrite[]) {
          if ((later.id ?? 0) <= id || later.state !== "queued" || !sameScope(later.scope, row!.scope) || noteKey(later) !== noteKey(row!)) continue;
          store.put({ ...later, state: "conflict", detail: "An earlier change to this page was discarded. Review this one against the current page before applying it." });
        }
      };
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(new Error(reason || "Could not remove the saved change."));
  }));
  notify();
  // The open editor may still hold the discarded text: have the app reload the
  // page from the server so the next save is built on what is really there.
  if (discardedNote && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("prism:note-discarded", { detail: { noteId: discardedNote } }));
}

function requiresReview(method: string, body?: string): boolean {
  if (method !== "PATCH" || !body) return false;
  const patch = parse(body);
  // Deltas for tags/links are commutative; replacing content/metadata without a
  // base revision is not. Never silently bless a formerly force:true body.
  return (
    !patch.if_updated_at &&
    ["content", "metadata", "path"].some((k) => k in patch)
  );
}
const contentOnly = (patch: Patch | null) => !!patch && typeof patch.content === "string" && Object.keys(patch).every((k) => k === "content" || k === "if_updated_at");
const backoff = (attempts: number) => Math.min(60_000, 1500 * 2 ** Math.max(0, attempts - 1));

export async function enqueue(
  method: string,
  path: string,
  body: string | undefined,
  context: WriteContext,
  options: { unknown?: boolean; temporaryId?: string; kind?: "meta"; expect?: Record<string, unknown>; retry?: boolean } = {},
): Promise<void> {
  const review = !options.kind && requiresReview(method, body) && !path.includes("offline-");
  const fresh: QueuedWrite = {
    version: 2,
    operationId: crypto.randomUUID(),
    scope: context.scope,
    method,
    path,
    body,
    queuedAt: Date.now(),
    temporaryId: options.temporaryId,
    kind: options.kind,
    expect: options.expect,
    state: options.unknown ? "unknown" : review ? "conflict" : "queued",
    // `retry`: the server did not answer just now — wait before the first re-send.
    ...(options.retry ? { attempts: 1, nextAttemptAt: Date.now() + backoff(1) } : {}),
    detail: options.unknown
      ? "The server may have received this change. Check the note before applying it again."
      : review
        ? "This change has no base revision. Review it against the current note before applying it."
        : undefined,
  };
  const patch = method === "PATCH" && body ? parse(body) : null;
  // Coalesce: several offline saves of one page are ONE queued write. Content
  // rows keep the FIRST base revision and the latest content; metadata merges
  // fold key by key (and keep each key's FIRST pre-edit value). Only the LAST
  // row for the note, still `queued` and of the same shape, is folded into —
  // never one that is being sent or awaits review.
  const foldable = fresh.state === "queued" && patch && !("path" in patch) && (options.kind === "meta" || contentOnly(patch));
  await withDb((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (!foldable) { store.add(fresh); }
    else {
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = (all.result as QueuedWrite[]).filter((r) => sameScope(r.scope, context.scope) && noteKey(r) === noteKey(fresh));
        const last = rows[rows.length - 1];
        const lastPatch = last?.body ? parse(last.body) : null;
        const sameShape = last && last.state === "queued" && last.method === "PATCH" && lastPatch && (last.kind ?? null) === (options.kind ?? null) &&
          (options.kind === "meta" || contentOnly(lastPatch));
        if (!sameShape) { store.add(fresh); return; }
        const merged = options.kind === "meta"
          ? { metadata: { ...(lastPatch!.metadata as Patch), ...(patch!.metadata as Patch) } }
          : { ...lastPatch, content: patch!.content };
        store.put({ ...last, body: JSON.stringify(merged), expect: options.kind === "meta" ? { ...(options.expect ?? {}), ...(last.expect ?? {}) } : last.expect, operationId: crypto.randomUUID() });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Could not save this change on this device."));
  })).catch(storageFailed);
  void navigator.storage?.persist?.().catch(() => false); // ask the browser not to evict unsent work
  notify();
  if (fresh.nextAttemptAt) scheduleFlush(fresh.nextAttemptAt - Date.now()); // the caller flushes ordinary rows
}

/** Atomically take a row for sending. Returns the row AS STORED at that instant —
 *  the only thing that may be sent (review C1: never a snapshot read earlier). */
async function claim(id: number): Promise<QueuedWrite | undefined> {
  return withDb((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    let claimed: QueuedWrite | undefined;
    request.onsuccess = () => {
      const row = request.result as QueuedWrite | undefined;
      if (row?.state !== "queued" || !row.scope) return;
      claimed = { ...row, state: "sending", attemptedAt: Date.now() };
      store.put(claimed);
    };
    tx.oncomplete = () => resolve(claimed);
    tx.onabort = () => reject(tx.error);
  }));
}
async function mappings(scope: WriteScope): Promise<Map<string, IdMapping>> {
  return withDb((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(MAPPINGS, "readonly");
    const request = tx.objectStore(MAPPINGS).getAll();
    tx.oncomplete = () =>
      resolve(
        new Map(
          (request.result as IdMapping[])
            .filter((r) => r.key.startsWith(scopeKey(scope) + ":"))
            .map((r) => [r.key.slice(scopeKey(scope).length + 1), r]),
        ),
      );
    tx.onabort = () => reject(tx.error);
  }));
}
export async function resolveLocalNoteId(id: string): Promise<string> {
  if (!id.startsWith("offline-")) return id;
  const { scope } = await captureWriteContext();
  return (await mappings(scope)).get(id)?.noteId ?? id;
}

/** Queued creates of this audience, for the tree: their paths are taken (review H3). */
export async function queuedCreates(scope: WriteScope): Promise<Array<{ id: string; path: string | null; tags: string[] | null; metadata: Record<string, unknown> | null }>> {
  return (await allQueued())
    .filter((r) => sameScope(r.scope, scope) && isCreate(r) && r.temporaryId && r.body)
    .map((r) => { const b = parse(r.body); return { id: r.temporaryId!, path: (b.path as string) ?? null, tags: (b.tags as string[]) ?? null, metadata: (b.metadata as Record<string, unknown>) ?? null }; });
}

/** Read your durable local draft, including after reload, while it awaits sync. */
export async function localNote(
  id: string,
  base?: import("@prism/core").Note,
): Promise<import("@prism/core").Note | undefined> {
  const { scope } = await captureWriteContext();
  const ids = await mappings(scope);
  let note = base;
  for (const item of await allQueued()) {
    if (!sameScope(item.scope, scope)) continue;
    const target = decodeURIComponent(
      item.path.match(/^\/notes\/([^/?]+)/)?.[1] ?? "",
    );
    if (isCreate(item) && item.temporaryId === id && item.body) {
      const body = parse(item.body);
      note = {
        id,
        content: (body.content as string) ?? "",
        path: (body.path as string) ?? null,
        metadata: (body.metadata as Record<string, unknown>) ?? null,
        tags: (body.tags as string[]) ?? null,
        createdAt: new Date(item.queuedAt).toISOString(),
        updatedAt: new Date(item.queuedAt).toISOString(),
      };
    }
    if (
      note &&
      item.method === "PATCH" &&
      (target === id || ids.get(target)?.noteId === id) &&
      item.body
    ) {
      const body = parse(item.body);
      // A row awaiting review still shows its text (the draft stays recoverable in
      // the editor) — but paired with ITS OWN base revision, never the server's
      // newest one: a save built on it then conflicts instead of overwriting the
      // server (review M2). Saves to this note also queue behind the stuck row.
      const waitingForReview = item.state !== "queued" && item.state !== "sending";
      if (waitingForReview && typeof body.if_updated_at === "string") note = { ...note, updatedAt: body.if_updated_at };
      // Overlay, never replace: a queued metadata write holds only the keys it
      // sets (a database/canvas note must keep prism_type and render as itself).
      note = {
        ...note,
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(typeof body.path === "string" ? { path: body.path } : {}),
        ...(body.metadata && typeof body.metadata === "object"
          ? { metadata: { ...(note.metadata ?? {}), ...(body.metadata as Record<string, unknown>) } }
          : {}),
      };
    }
  }
  return note;
}

function resolveReferences(
  item: QueuedWrite,
  ids: Map<string, IdMapping>,
): { path: string; body?: string } {
  const resolveId = (id: string): string => {
    if (!id.startsWith("offline-")) return id;
    const mapped = ids.get(id);
    if (!mapped)
      throw new Error(
        "Waiting for the original note to be confirmed. Its saved draft is still on this device.",
      );
    return mapped.noteId;
  };
  const path = item.path.replace(
    /^(\/notes\/)([^/?]+)/,
    (_, prefix: string, id: string) =>
      prefix + encodeURIComponent(resolveId(decodeURIComponent(id))),
  );
  const patch = item.body
    ? (JSON.parse(item.body, (key, value: unknown) =>
        ["target", "targetId", "noteId"].includes(key) &&
        typeof value === "string"
          ? resolveId(value)
          : value,
      ) as Record<string, unknown>)
    : undefined;
  const originalId = decodeURIComponent(
    item.path.match(/^\/notes\/([^/?]+)/)?.[1] ?? "",
  );
  if (item.method === "PATCH" && !item.kind && originalId.startsWith("offline-") && patch && ["content", "metadata", "path"].some((k) => k in patch)) {
    const revision = ids.get(originalId)?.revision;
    if (!revision)
      throw new Error("Waiting for the new note's confirmed revision.");
    delete patch.force;
    patch.if_updated_at = revision;
  }
  const body = patch ? JSON.stringify(patch) : undefined;
  return { path, body };
}

/**
 * This tab's (and, via BroadcastChannel, every tab's) memory of which revisions
 * OUR OWN confirmed writes replaced. The app's in-memory note cache does not
 * learn the revision a replayed write produced, so its next save would name a
 * superseded base and conflict with itself. A revision produced by someone else
 * is in no `from` set, so a real conflict still surfaces.
 */
const superseded = new Map<string, { from: Set<string>; to: string }>();
function rememberRevision(scope: WriteScope, noteId: string, from: Array<string | undefined>, to: string, broadcast = true): void {
  const key = `${scopeKey(scope)}|${noteId}`;
  const entry = superseded.get(key) ?? { from: new Set<string>(), to };
  entry.from.add(entry.to);
  for (const f of from) if (typeof f === "string" && f) entry.from.add(f);
  entry.to = to;
  entry.from.delete(to);
  superseded.set(key, entry);
  if (broadcast) {
    channel?.postMessage({ type: "revision", scope, noteId, from: [...entry.from], to });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("prism:note-confirmed", { detail: { noteId, updatedAt: to } }));
  }
}
/** The revision to name for a write whose caller still holds one of our own superseded bases. */
export function currentBase(scope: WriteScope, noteId: string, base: string): string {
  const entry = superseded.get(`${scopeKey(scope)}|${noteId}`);
  return entry?.from.has(base) ? entry.to : base;
}
if (channel) channel.onmessage = (event: MessageEvent) => {
  const data = event.data as { type?: string; scope?: WriteScope; noteId?: string; from?: string[]; to?: string };
  if (data?.type === "changed") notify(false);
  if (data?.type === "revision" && data.scope && data.noteId && data.to) {
    rememberRevision(data.scope, data.noteId, data.from ?? [], data.to, false);
    window.dispatchEvent(new CustomEvent("prism:note-confirmed", { detail: { noteId: data.noteId, updatedAt: data.to } }));
  }
};

interface Delivered { id?: string; updatedAt?: string; from?: Array<string | undefined> }

/**
 * Row is delivered: remove it, learn the new revision, and re-base every later
 * queued write for the same note that was made on top of it.
 */
async function confirmDelivered(item: QueuedWrite, result: Delivered): Promise<void> {
  const originalId = decodeURIComponent(
    item.path.match(/^\/notes\/([^/?]+)/)?.[1] ?? "",
  );
  const temporaryId =
    item.temporaryId ??
    (originalId.startsWith("offline-") ? originalId : undefined);
  const noteId = result.id;
  if (item.temporaryId && !noteId)
    throw new Error(
      "The note was accepted but its identity could not be confirmed.",
    );
  const ownBase = parse(item.body).if_updated_at as string | undefined;
  const from = new Set([ownBase, ...(result.from ?? [])].filter((v): v is string => typeof v === "string" && !!v));
  await withDb((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, MAPPINGS], "readwrite");
    if (temporaryId && (noteId || result.updatedAt)) {
      const key = `${scopeKey(item.scope!)}:${temporaryId}`;
      const maps = tx.objectStore(MAPPINGS);
      const existing = maps.get(key);
      existing.onsuccess = () => {
        const prior = existing.result as IdMapping | undefined;
        const id = noteId ?? prior?.noteId;
        if (id) maps.put({ key, noteId: id, revision: result.updatedAt ?? prior?.revision });
      };
    }
    const store = tx.objectStore(STORE);
    const mine = store.get(item.id!);
    mine.onsuccess = () => {
      const row = mine.result as QueuedWrite | undefined;
      // Delete ONLY what was sent. (A `sending` row is never folded into, so this
      // holds — but if it ever differs, the newer content stays queued, re-based.)
      if (row && row.body !== item.body) {
        const patch = parse(row.body);
        store.put({ ...row, state: "queued", attempts: 0, nextAttemptAt: 0, body: JSON.stringify(result.updatedAt && typeof patch.if_updated_at === "string" ? { ...patch, if_updated_at: result.updatedAt } : patch) });
      } else store.delete(item.id!);
      if (!result.updatedAt) return;
      const all = store.getAll();
      all.onsuccess = () => {
        for (const row of all.result as QueuedWrite[]) {
          if (row.id === item.id || row.state !== "queued" || row.method !== "PATCH" || !sameScope(row.scope, item.scope) || !row.body) continue;
          if (noteKey(row) !== noteKey(item) && noteKey(row) !== (noteId ?? "") && noteKey(row) !== (temporaryId ?? "")) continue;
          const patch = parse(row.body);
          // Re-base only writes made on a revision this delivery replaced.
          if (typeof patch.if_updated_at !== "string" || !from.has(patch.if_updated_at)) continue;
          store.put({ ...row, body: JSON.stringify({ ...patch, if_updated_at: result.updatedAt }) });
        }
      };
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  }));
  const key = noteId ?? (originalId.startsWith("offline-") ? undefined : originalId);
  if (result.updatedAt && key && item.scope) rememberRevision(item.scope, key, [...from], result.updatedAt);
  notify();
  const current = await captureWriteContext().catch(() => null);
  if (
    current &&
    sameScope(current.scope, item.scope) &&
    noteId &&
    item.temporaryId
  ) {
    window.dispatchEvent(
      new CustomEvent("prism:offline-note-resolved", {
        detail: { temporaryId: item.temporaryId, noteId },
      }),
    );
  }
}

type Outcome =
  | { ok: true; result: Delivered }
  | { ok: false; retry: true }
  | { ok: false; retry?: false; state: WriteState; detail: string };
const DETAIL: Record<string, string> = {
  conflict: "The note changed. Your saved change needs review.",
  missing: "The original note is no longer available. Your saved change is preserved.",
  blocked: "Your access changed. Reconnect with the original account to recover this change.",
  unknown: "The result could not be confirmed. Check the note before applying this change again.",
};
const stuck = (state: WriteState, detail = DETAIL[state] ?? ""): Outcome => ({ ok: false, state, detail });
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const uncertain = (status: number) => status >= 500 || status === 429 || status === 408;
function classify(status: number): Outcome {
  return stuck(status === 409 || status === 428 ? "conflict" : status === 404 || status === 410 ? "missing" : status === 401 || status === 403 ? "blocked" : "unknown");
}

/** Deliver one claimed row. Never throws for an HTTP answer; a thrown error = the request never got an answer. */
async function deliver(item: QueuedWrite, resolved: { path: string; body?: string }, headers: Record<string, string>): Promise<Outcome> {
  const base = item.scope!.api;
  const call = (path: string, init: RequestInit = {}) => serverFetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const noteJson = async (path: string, withContent = false) => {
    const r = await call(`${path}?include_content=${withContent}`, { cache: "no-store" });
    return { status: r.status, note: r.ok ? ((await r.json()) as { id?: string; content?: string; metadata?: Patch | null; updatedAt?: string; path?: string | null }) : null };
  };
  const patch = parse(resolved.body);
  const notePath = resolved.path.match(/^\/notes\/[^/?]+/)?.[0];

  // ── create: idempotent through its client operation id ─────────────────────
  if (isCreate(item)) {
    const op = (patch.metadata as Patch | undefined)?.[CLIENT_OP];
    const path = patch.path as string | undefined;
    const lookup = async (): Promise<"none" | "taken" | Delivered> => {
      if (!path) return "none";
      const r = await call(`/notes?${new URLSearchParams({ path, include_content: "false", limit: "20" })}`, { cache: "no-store" });
      if (!r.ok) throw new TypeError("lookup failed");
      const at = ((await r.json()) as Array<{ id: string; path?: string | null; metadata?: Patch | null; updatedAt?: string }>).filter((n) => n.path === path);
      const mine = at.find((n) => typeof op === "string" && n.metadata?.[CLIENT_OP] === op);
      return mine ? { id: mine.id, updatedAt: mine.updatedAt } : at.length ? "taken" : "none";
    };
    const taken = () => stuck("conflict", "A page already exists at this location with this name. Create yours under another name, or discard it.");
    // After an outcome we could not confirm, look before creating again.
    if ((item.attempts ?? 0) > 0) {
      const found = await lookup();
      if (found === "taken") return taken();
      if (found !== "none") return { ok: true, result: found };
    }
    const response = await call(resolved.path, { method: "POST", body: resolved.body });
    if (response.ok) return { ok: true, result: (await response.json().catch(() => null)) as Delivered ?? {} };
    if (uncertain(response.status)) return { ok: false, retry: true };
    if (response.status === 409) {
      const found = await lookup();
      return typeof found === "object" ? { ok: true, result: found } : taken();
    }
    return classify(response.status);
  }

  // ── metadata merge (no base revision): per-key, never forced ───────────────
  if (item.kind === "meta" && notePath) {
    const set = (patch.metadata as Patch) ?? {};
    const expect = item.expect ?? {};
    const before = await noteJson(notePath);
    if (!before.note) return uncertain(before.status) ? { ok: false, retry: true } : classify(before.status);
    const changedElsewhere = (current: Patch | null | undefined) => Object.keys(set).filter((k) => k in expect && !same(current?.[k], expect[k]) && !same(current?.[k], set[k]));
    const elsewhere = changedElsewhere(before.note.metadata);
    const review = (keys: string[]) => stuck("conflict", `Changed somewhere else since you edited offline: ${keys.join(", ")}. Review before applying your value.`);
    if (elsewhere.length) return review(elsewhere);
    const reserved = Object.keys(set).some((k) => /^(prism_|gov_)/.test(k));
    if (!reserved) {
      const stillExpected = Object.fromEntries(Object.keys(set).filter((k) => k in expect && !same(before.note!.metadata?.[k], set[k])).map((k) => [k, expect[k]]));
      const r = await call(`/properties/${notePath.slice("/notes/".length)}`, { method: "POST", body: JSON.stringify({ set, ...(Object.keys(stillExpected).length ? { expect: stillExpected } : {}) }) });
      if (r.ok) { const j = (await r.json().catch(() => null)) as Delivered | null; return { ok: true, result: { id: j?.id, updatedAt: j?.updatedAt, from: [before.note.updatedAt] } }; }
      if (uncertain(r.status)) return { ok: false, retry: true };
      if (r.status === 409) {
        const j = (await r.json().catch(() => null)) as { fields?: string[]; current?: Patch } | null;
        const fields = (j?.fields ?? Object.keys(set)).filter((k) => !same(j?.current?.[k], set[k]));
        if (fields.length) return review(fields);
        const after = await noteJson(notePath);
        return after.note ? { ok: true, result: { id: after.note.id, updatedAt: after.note.updatedAt } } : { ok: false, retry: true };
      }
      // Only "this server has no such route" falls back; 404 = the page is gone (e.g. trashed).
      if (r.status !== 405 && r.status !== 501) return classify(r.status);
    }
    let current = before.note;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current.updatedAt) return stuck("conflict");
      const r = await call(notePath, { method: "PATCH", body: JSON.stringify({ metadata: set, if_updated_at: current.updatedAt }) });
      if (r.ok) { const j = (await r.json().catch(() => null)) as Delivered | null; return { ok: true, result: { id: j?.id, updatedAt: j?.updatedAt, from: [current.updatedAt] } }; }
      if (uncertain(r.status)) return { ok: false, retry: true };
      if (r.status !== 409) return classify(r.status);
      const again = await noteJson(notePath);
      if (!again.note) return uncertain(again.status) ? { ok: false, retry: true } : classify(again.status);
      const now = changedElsewhere(again.note.metadata);
      if (now.length) return review(now);
      current = again.note;
    }
    return stuck("conflict");
  }

  // ── everything else: content / guarded metadata / tag + link deltas ────────
  const guarded = typeof patch.if_updated_at === "string";
  // An unguarded delta moves the note's revision too: note the one it replaces,
  // so later saves made on it can be re-based (review H1).
  const before = !guarded && notePath && item.method === "PATCH" ? await noteJson(notePath).catch(() => null) : null;
  const response = await call(resolved.path, { method: item.method, body: resolved.body });
  if (response.ok) {
    const j = (await response.clone().json().catch(() => null)) as Delivered | null;
    let updatedAt = j?.updatedAt;
    if (!updatedAt && notePath) updatedAt = (await noteJson(notePath).catch(() => null))?.note?.updatedAt;
    return { ok: true, result: { id: j?.id, updatedAt, from: [before?.note?.updatedAt] } };
  }
  if (uncertain(response.status)) return retrySafe(item) ? { ok: false, retry: true } : stuck("unknown");
  if ((response.status === 409 || response.status === 428) && guarded && notePath) {
    // Was it OUR earlier delivery whose answer got lost? Then the server already
    // holds exactly this content / these values: that is success, not a conflict.
    const now = await noteJson(notePath, true).catch(() => null);
    if (now?.note) {
      const applied = (typeof patch.content !== "string" || now.note.content === patch.content)
        && (!patch.metadata || Object.entries(patch.metadata as Patch).every(([k, v]) => same(now.note!.metadata?.[k], v)))
        && (typeof patch.path !== "string" || now.note.path === patch.path)
        && (typeof patch.content === "string" || !!patch.metadata || typeof patch.path === "string");
      if (applied) return { ok: true, result: { id: now.note.id, updatedAt: now.note.updatedAt } };
    }
  }
  return classify(response.status);
}

let flushing = false;
let flushAgain = false;
let flushTimer: number | undefined;
/** Run a flush after `delay` ms (retry backoff); an earlier pending timer wins. */
function scheduleFlush(delay: number): void {
  if (typeof window === "undefined") return;
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flush(), Math.max(0, delay) + 30);
}
export async function flush(): Promise<void> {
  if (flushing) { flushAgain = true; return; }
  if (!navigator.onLine) return;
  flushing = true;
  let nextRetry = Infinity;
  try {
    // Selecting the rows may use an identity confirmed in the last few seconds (boot asks
    // several times at once); every row is still preceded by a FRESH check below.
    const initial = await captureWriteContext("recent");
    await recoverInterrupted();
    // A row that is stuck (needs review, unknown result, waiting to retry, or
    // waiting on an unconfirmed new note) holds back only LATER rows for the
    // SAME note: every other note keeps saving.
    const held = new Set<string>();
    const ids = (await allQueued()).filter((r) => sameScope(r.scope, initial.scope)).map((r) => r.id!);
    for (const id of ids) {
      // Always the row as it is NOW — it may have been folded into, re-based,
      // taken by another tab or confirmed since the list was read (review C1).
      const saved = await getRow(id);
      if (!saved || !sameScope(saved.scope, initial.scope)) continue;
      const map = await mappings(initial.scope);
      const key = noteKey(saved);
      const canonical = map.get(key)?.noteId ?? key;
      const hold = () => { held.add(key); held.add(canonical); };
      if (saved.state !== "queued") {
        // Another sender has it: look again once it could be considered dead.
        if (saved.state === "sending") nextRetry = Math.min(nextRetry, (saved.attemptedAt ?? Date.now()) + staleSendingMs + 50);
        hold();
        continue;
      }
      if (held.has(key) || held.has(canonical)) continue;
      if ((saved.nextAttemptAt ?? 0) > Date.now()) { nextRetry = Math.min(nextRetry, saved.nextAttemptAt!); hold(); continue; }
      const current = await captureWriteContext(true);
      if (!sameScope(initial.scope, current.scope)) break;
      const item = await claim(id);
      if (!item) { hold(); continue; } // another tab has it
      notify();
      let outcome: Outcome;
      try {
        // References are resolved from the CLAIMED row, and only its body is sent.
        const resolved = resolveReferences(item, await mappings(current.scope));
        outcome = await deliver(item, resolved, current.headers);
      } catch (error) {
        if (error instanceof Error && /^Waiting for /.test(error.message)) {
          await put({ ...item, state: "queued" });
          hold();
          continue;
        }
        // No answer at all (network error, timeout).
        outcome = retrySafe(item) ? { ok: false, retry: true } : stuck("unknown", "The result could not be confirmed. Your saved change is preserved; it will not be sent twice automatically.");
      }
      if (outcome.ok) {
        await confirmDelivered(item, outcome.result);
        continue;
      }
      if (outcome.retry) {
        const attempts = (item.attempts ?? 0) + 1;
        const nextAttemptAt = Date.now() + backoff(attempts);
        await put({ ...item, state: "queued", attempts, nextAttemptAt, detail: "The server did not answer. Trying again shortly." });
        nextRetry = Math.min(nextRetry, nextAttemptAt);
        hold();
        if (!navigator.onLine) break;
        continue;
      }
      await put({ ...item, state: outcome.state, detail: outcome.detail });
      hold();
    }
  } catch {
    /* Offline, signed out, or switched scope: leave durable records intact. */
  } finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; void flush(); }
    else if (Number.isFinite(nextRetry)) scheduleFlush(nextRetry - Date.now());
  }
}

/** A reviewed replacement is a new guarded intent, not a forced retry. */
export async function resolveConflict(
  id: number,
  body: string,
  revision: string,
): Promise<void> {
  const context = await captureWriteContext(true);
  if (!revision) throw new Error("A current revision is required.");
  const patch = JSON.parse(body) as Record<string, unknown>;
  delete patch.force;
  await withDb((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    let invalid = false;
    request.onsuccess = () => {
      const item = request.result as QueuedWrite | undefined;
      if (
        !item ||
        !sameScope(item.scope, context.scope) ||
        item.method !== "PATCH" ||
        !["conflict", "unknown", "blocked", "missing"].includes(
          item.state ?? "",
        )
      ) {
        invalid = true;
        tx.abort();
        return;
      }
      store.put({
        ...item,
        kind: undefined,
        expect: undefined,
        attempts: 0,
        nextAttemptAt: 0,
        body: JSON.stringify({ ...patch, if_updated_at: revision }),
        state: "queued",
        detail: undefined,
        operationId: crypto.randomUUID(),
      });
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        new Error(
          invalid
            ? "This change was already updated or belongs to another workspace. Refresh before reviewing it again."
            : "Could not save the reviewed change.",
        ),
      );
  }));
  notify();
  await flush();
}

/** Review dialog → "Retry": put a stuck, retry-safe row (a create, a guarded save) back in the queue. */
export async function retryWrite(id: number): Promise<void> {
  const context = await captureWriteContext(true);
  const row = await getRow(id);
  if (!row || !sameScope(row.scope, context.scope) || row.state === "sending" || !retrySafe(row)) throw new Error("This change can’t be retried automatically. Review it instead.");
  // attempts ≥ 1: a create looks for its own page before posting again.
  await put({ ...row, state: "queued", attempts: Math.max(1, row.attempts ?? 0), nextAttemptAt: 0, detail: undefined });
  await flush();
}
/** Review dialog → "Create under another name": the queued create gets the next free "Name (n)". */
export async function renameQueuedCreate(id: number): Promise<string> {
  const context = await captureWriteContext(true);
  const row = await getRow(id);
  if (!row || !sameScope(row.scope, context.scope) || !isCreate(row) || row.state === "sending") throw new Error("This change is not a new page.");
  const body = parse(row.body);
  const path = String(body.path ?? "Untitled");
  const m = path.match(/^(.*) \((\d+)\)$/);
  const next = m ? `${m[1]} (${Number(m[2]) + 1})` : `${path} (2)`;
  const metadata = { ...((body.metadata as Patch) ?? {}) };
  if (typeof metadata.title === "string") metadata.title = next.split("/").pop();
  metadata[CLIENT_OP] = crypto.randomUUID(); // a different page than the one that collided
  await put({ ...row, body: JSON.stringify({ ...body, path: next, metadata }), state: "queued", attempts: 0, nextAttemptAt: 0, detail: undefined });
  await flush();
  return next;
}

let started = false;
export function startOutboxSync(): void {
  if (started) return;
  started = true;
  window.addEventListener("online", () => void flush());
  window.addEventListener("prism:vault-changed", () => {
    notify();
    void flush();
  });
  window.setInterval(() => void flush(), 30_000);
  void purgeExpiredOtherScopes().catch(() => 0);
  void flush();
}

/** Local-only recovery for an editor whose original audience/access changed.
 * Never queued for automatic replay. Identical repeated cleanup attempts coalesce
 * with the last retained draft for this note; distinct later edits stay ordered. */
export async function retainDraft(noteId: string, content: string, scope: WriteScope, reason: "access" | "conflict" = "access"): Promise<void> {
  const state: WriteState = reason === "conflict" ? "conflict" : "blocked";
  const detail = reason === "conflict"
    ? "This page changed somewhere else while you were editing. Your version is saved only on this device. Review it against the current page before applying it."
    : "Your workspace or access changed. This draft is saved only on this device. Review it in the original workspace before applying it.";
  const path = `/notes/${encodeURIComponent(noteId)}`;
  const body = JSON.stringify({ content });
  await withDb((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const add = () => store.add({ version: 2, operationId: crypto.randomUUID(), scope, method: "PATCH", path, body, queuedAt: Date.now(), state, detail } satisfies QueuedWrite);
    const cursor = store.openCursor(null, "prev");
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) { add(); return; }
      const item = row.value as QueuedWrite;
      if (!sameScope(item.scope, scope) || item.path !== path) { row.continue(); return; }
      if (item.state !== state || item.method !== "PATCH" || item.body !== body) add();
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? Error("Draft could not be saved on this device."));
  })).catch(storageFailed);
  notify();
}
