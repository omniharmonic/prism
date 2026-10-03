/** Scoped, durable writes. A conflict or unknown outcome is NEVER forced/retried. */
import { serverFetch } from "../transport";
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

function openDb(): Promise<IDBDatabase> {
  if (!database)
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
  return database;
}

/** Request success is not transaction durability: resolve only after commit. */
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(
        tx.error ?? new Error("Could not save this change on this device."),
      );
  });
}
const subscribers = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
function notify() {
  subscribers.forEach((fn) => fn());
}
async function put(item: QueuedWrite): Promise<void> {
  await transaction("readwrite", (s) => s.put(item));
  notify();
}
export async function allQueued(): Promise<QueuedWrite[]> {
  return (await transaction<QueuedWrite[]>("readonly", (s) => s.getAll())).sort(
    (a, b) => (a.id ?? 0) - (b.id ?? 0),
  );
}
/** A closed/crashed tab cannot leave a write looking actively synced forever. */
export async function recoverInterrupted(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      const item = row.value as QueuedWrite;
      if (
        item.state === "sending" &&
        (item.attemptedAt ?? 0) < Date.now() - 90_000
      ) {
        row.update({
          ...item,
          state: "unknown",
          detail:
            "A previous session stopped before confirming this change. Check the note before applying it again.",
        });
      }
      row.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
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
export async function discard(id: number): Promise<void> {
  const context = await captureWriteContext();
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
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
      if (reason) tx.abort();
      else store.delete(id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(new Error(reason || "Could not remove the saved change."));
  });
  notify();
}

function requiresReview(method: string, body?: string): boolean {
  if (method !== "PATCH" || !body) return false;
  const patch = JSON.parse(body) as Record<string, unknown>;
  // Deltas for tags/links are commutative; replacing content/metadata without a
  // base revision is not. Never silently bless a formerly force:true body.
  return (
    !patch.if_updated_at &&
    ["content", "metadata", "path"].some((k) => k in patch)
  );
}
export async function enqueue(
  method: string,
  path: string,
  body: string | undefined,
  context: WriteContext,
  options: { unknown?: boolean; temporaryId?: string; kind?: "meta" } = {},
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
    state: options.unknown ? "unknown" : review ? "conflict" : "queued",
    detail: options.unknown
      ? "The server may have received this change. Check the note before applying it again."
      : review
        ? "This change has no base revision. Review it against the current note before applying it."
        : undefined,
  };
  const patch = method === "PATCH" && body ? (JSON.parse(body) as Record<string, unknown>) : null;
  // Coalesce (review H2/H3): several offline saves of one page are ONE queued
  // write. Content rows keep the FIRST base revision (later saves were typed on
  // top of the earlier local state, not on a newer server copy) and the latest
  // content; metadata merges fold key by key. Only a still-`queued` row of the
  // same shape is folded into — never one being sent or awaiting review.
  const foldable = fresh.state === "queued" && patch && !("path" in patch) &&
    (options.kind === "meta" || (typeof patch.content === "string" && Object.keys(patch).every((k) => k === "content" || k === "if_updated_at")));
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (!foldable) { store.add(fresh); }
    else {
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = (all.result as QueuedWrite[]).filter((r) => sameScope(r.scope, context.scope) && r.method === "PATCH" && r.path === path);
        const last = rows[rows.length - 1];
        const lastPatch = last?.body ? (JSON.parse(last.body) as Record<string, unknown>) : null;
        const sameShape = last && last.state === "queued" && lastPatch && (last.kind ?? null) === (options.kind ?? null) &&
          (options.kind === "meta" || (typeof lastPatch.content === "string" && Object.keys(lastPatch).every((k) => k === "content" || k === "if_updated_at")));
        if (!sameShape) { store.add(fresh); return; }
        const merged = options.kind === "meta"
          ? { metadata: { ...(lastPatch!.metadata as Record<string, unknown>), ...(patch!.metadata as Record<string, unknown>) } }
          : { ...lastPatch, content: patch!.content };
        store.put({ ...last, body: JSON.stringify(merged), operationId: crypto.randomUUID() });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Could not save this change on this device."));
  });
  notify();
}

async function claim(id: number): Promise<QueuedWrite | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
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
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
async function mappings(scope: WriteScope): Promise<Map<string, IdMapping>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
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
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export async function resolveLocalNoteId(id: string): Promise<string> {
  if (!id.startsWith("offline-")) return id;
  const { scope } = await captureWriteContext();
  return (await mappings(scope)).get(id)?.noteId ?? id;
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
    if (
      item.method === "POST" &&
      item.path === "/notes" &&
      item.temporaryId === id &&
      item.body
    ) {
      const body = JSON.parse(item.body);
      note = {
        id,
        content: body.content ?? "",
        path: body.path ?? null,
        metadata: body.metadata ?? null,
        tags: body.tags ?? null,
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
      const body = JSON.parse(item.body) as Record<string, unknown>;
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
  if (item.method === "PATCH" && originalId.startsWith("offline-") && patch) {
    const revision = ids.get(originalId)?.revision;
    if (!revision)
      throw new Error("Waiting for the new note's confirmed revision.");
    delete patch.force;
    patch.if_updated_at = revision;
  }
  const body = patch ? JSON.stringify(patch) : undefined;
  return { path, body };
}
async function confirm(item: QueuedWrite, response: Response): Promise<void> {
  const result = (await response
    .clone()
    .json()
    .catch(() => null)) as { id?: string; updatedAt?: string } | null;
  const originalId = decodeURIComponent(
    item.path.match(/^\/notes\/([^/?]+)/)?.[1] ?? "",
  );
  const temporaryId =
    item.temporaryId ??
    (originalId.startsWith("offline-") ? originalId : undefined);
  const noteId = result?.id;
  if (temporaryId && !noteId)
    throw new Error(
      "The note was accepted but its identity could not be confirmed.",
    );
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, MAPPINGS], "readwrite");
    if (noteId && temporaryId)
      tx.objectStore(MAPPINGS).put({
        key: `${scopeKey(item.scope!)}:${temporaryId}`,
        noteId,
        revision: result?.updatedAt,
      });
    const store = tx.objectStore(STORE);
    store.delete(item.id!);
    if (result?.updatedAt && item.method === "PATCH" && item.scope) rememberRevision(item, result.updatedAt);
    // Re-base (review H2): a content save queued for the SAME note while this one
    // was in flight was typed on top of it. Its base is the revision we just got.
    if (result?.updatedAt && item.method === "PATCH") {
      const all = store.getAll();
      all.onsuccess = () => {
        for (const row of all.result as QueuedWrite[]) {
          if (row.id === item.id || row.state !== "queued" || row.kind || row.method !== "PATCH" || row.path !== item.path || !sameScope(row.scope, item.scope) || !row.body) continue;
          const patch = JSON.parse(row.body) as Record<string, unknown>;
          if (typeof patch.if_updated_at !== "string") continue;
          store.put({ ...row, body: JSON.stringify({ ...patch, if_updated_at: result.updatedAt }) });
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
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

/** Send one row. A metadata merge has no base revision: per-key merge through
 *  the properties route (CAS + live-doc safe); keys it refuses (prism_*, gov_*),
 *  or an older server, fall back to read-current + CAS PATCH. Never `force`. */
async function send(item: QueuedWrite, resolved: { path: string; body?: string }, headers: Record<string, string>): Promise<Response> {
  const base = item.scope!.api;
  const signal = () => AbortSignal.timeout(30_000);
  if (item.kind !== "meta") return serverFetch(`${base}${resolved.path}`, { method: item.method, headers, body: resolved.body, signal: signal() });
  const set = (JSON.parse(resolved.body ?? "{}") as { metadata?: Record<string, unknown> }).metadata ?? {};
  const id = resolved.path.match(/^\/notes\/([^/?]+)/)?.[1] ?? "";
  if (!Object.keys(set).some((k) => /^(prism_|gov_)/.test(k))) {
    const viaProperties = await serverFetch(`${base}/properties/${id}`, { method: "POST", headers, body: JSON.stringify({ set }), signal: signal() });
    if (![400, 403, 404, 405, 501].includes(viaProperties.status)) return viaProperties;
  }
  let last: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await serverFetch(`${base}${resolved.path}`, { headers, cache: "no-store", signal: signal() });
    if (!current.ok) return current;
    const note = (await current.json()) as { updatedAt?: string };
    if (!note.updatedAt) return new Response(null, { status: 409 });
    last = await serverFetch(`${base}${resolved.path}`, { method: "PATCH", headers, body: JSON.stringify({ metadata: set, if_updated_at: note.updatedAt }), signal: signal() });
    if (last.status !== 409) return last;
  }
  return last!;
}

/**
 * The app's in-memory note cache does not learn the revision a replayed write
 * produced, so its next save would name the superseded base and conflict with
 * ITSELF. Per note (this tab only): the bases our own confirmed writes replaced
 * → the revision they produced. A genuinely newer server revision is in neither
 * set, so a real conflict still surfaces.
 */
const superseded = new Map<string, { from: Set<string>; to: string }>();
function rememberRevision(item: QueuedWrite, updatedAt: string): void {
  const key = `${scopeKey(item.scope!)}|${noteKey(item)}`;
  const entry = superseded.get(key) ?? { from: new Set<string>(), to: updatedAt };
  entry.from.add(entry.to);
  const base = item.body ? (JSON.parse(item.body) as { if_updated_at?: unknown }).if_updated_at : undefined;
  if (typeof base === "string") entry.from.add(base);
  entry.to = updatedAt;
  entry.from.delete(updatedAt);
  superseded.set(key, entry);
}
/** The revision to name for a write whose caller still holds one of our own superseded bases. */
export function currentBase(scope: WriteScope, noteId: string, base: string): string {
  const entry = superseded.get(`${scopeKey(scope)}|${noteId}`);
  return entry?.from.has(base) ? entry.to : base;
}

let flushing = false;
let flushAgain = false;
export async function flush(): Promise<void> {
  if (flushing) { flushAgain = true; return; }
  if (!navigator.onLine) return;
  flushing = true;
  try {
    const initial = await captureWriteContext(true);
    // A row that is stuck (needs review, unknown result, waiting on an
    // unconfirmed new note) holds back only LATER rows for the SAME note
    // (review H2): every other note keeps saving.
    const held = new Set<string>();
    for (const saved of await allQueued()) {
      if (!sameScope(saved.scope, initial.scope)) continue;
      const ids = await mappings(initial.scope);
      const key = noteKey(saved);
      const canonical = ids.get(key)?.noteId ?? key;
      if (saved.state !== "queued") { held.add(key); held.add(canonical); continue; }
      if (held.has(key) || held.has(canonical)) continue;
      const current = await captureWriteContext(true);
      if (!sameScope(initial.scope, current.scope)) break;
      let resolved: { path: string; body?: string };
      try {
        resolved = resolveReferences(saved, ids);
      } catch {
        held.add(key); held.add(canonical);
        continue;
      }
      const item = await claim(saved.id!);
      if (!item) { held.add(key); held.add(canonical); continue; } // another tab has it
      notify();
      try {
        const response = await send(item, resolved, current.headers);
        if (response.ok) {
          await confirm(item, response);
          continue;
        }
        const state: WriteState =
          response.status === 409 || response.status === 428
            ? "conflict"
            : response.status === 404 || response.status === 410
              ? "missing"
              : response.status === 401 || response.status === 403
                ? "blocked"
                : "unknown";
        await put({
          ...item,
          state,
          detail:
            state === "conflict"
              ? "The note changed. Your saved change needs review."
              : state === "missing"
                ? "The original note is no longer available. Your saved change is preserved."
                : state === "blocked"
                  ? "Your access changed. Reconnect with the original account to recover this change."
                  : "The result could not be confirmed. Check the note before applying this change again.",
        });
      } catch {
        await put({
          ...item,
          state: "unknown",
          detail:
            "The result could not be confirmed. Your saved change is preserved; it will not be sent twice automatically.",
        });
        if (!navigator.onLine) break; // the connection dropped: stop, don't mark everything unknown
      }
      held.add(key); held.add(canonical);
    }
  } catch {
    /* Offline, signed out, or switched scope: leave durable records intact. */
  } finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; void flush(); }
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
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
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
        body: JSON.stringify({ ...patch, if_updated_at: revision }),
        state: "queued",
        detail: undefined,
        operationId: crypto.randomUUID(),
      });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(
        new Error(
          invalid
            ? "This change was already updated or belongs to another workspace. Refresh before reviewing it again."
            : "Could not save the reviewed change.",
        ),
      );
  });
  notify();
  await flush();
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
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
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
    tx.onerror = tx.onabort = () => reject(tx.error ?? Error("Draft could not be saved on this device."));
  });
  notify();
}
