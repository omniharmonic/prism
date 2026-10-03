/**
 * Live documents with edits the server has not taken (re-review M1).
 *
 * A live (Yjs) document saves to IndexedDB first; if its socket is down when the
 * tab is switched or closed, those edits sit on the device. This registry
 * remembers WHICH documents (names + ids only, per account/vault scope) so:
 *  - the sync badge says "Changes on this device — will sync" instead of "Saved";
 *  - on reconnect each one is synced in the background — a headless provider
 *    loads the local state, waits for the server to take it, and closes.
 * Local state is never discarded here. The server's own rules still apply: a
 * read-only (suggest/view) socket, a refused schema version or lost access
 * leaves the entry in place (with the reason) for the user to open and resolve.
 */
import { reportSyncSource } from "@prism/core/shell";
import { captureWriteContext, scopeKey, type WriteScope } from "../offline/writeScope";
// Storage only (no Yjs): this module is on the app's boot path (the sync badge). The parts that
// read or push a document's CRDT state are imported when they are needed.
import { localDocumentKey, purgeLocalDocuments, purgePendingForScope } from "./localDocumentStore";

export interface UnsyncedDoc { name: string; noteId: string; at: number; blocked?: "read-only" | "update-required" | "denied" }
const storeKey = (scope: WriteScope) => `prism:collab-unsynced:${scopeKey(scope)}`;
const listeners = new Set<() => void>();
/** Documents open in THIS tab look after themselves. */
const openHere = new Set<string>();

function read(scope: WriteScope): Record<string, UnsyncedDoc> {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(scope)) ?? "{}") as Record<string, UnsyncedDoc>;
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function write(scope: WriteScope, docs: Record<string, UnsyncedDoc>): void {
  try {
    if (Object.keys(docs).length) localStorage.setItem(storeKey(scope), JSON.stringify(docs));
    else localStorage.removeItem(storeKey(scope));
  } catch { /* private mode: the open document still shows its own state */ }
  listeners.forEach((fn) => fn());
}
export function markUnsynced(scope: WriteScope, name: string, noteId: string, blocked?: UnsyncedDoc["blocked"]): void {
  const docs = read(scope);
  if (docs[name] && docs[name]!.blocked === blocked) return;
  docs[name] = { name, noteId, at: docs[name]?.at ?? Date.now(), ...(blocked ? { blocked } : {}) };
  write(scope, docs);
}
export function clearUnsynced(scope: WriteScope, name: string): void {
  const docs = read(scope);
  if (!docs[name]) return;
  delete docs[name];
  write(scope, docs);
}
export function setOpenHere(name: string, open: boolean): void {
  if (open) openHere.add(name); else openHere.delete(name);
  listeners.forEach((fn) => fn());
}
export async function unsyncedDocs(): Promise<UnsyncedDoc[]> {
  const context = await captureWriteContext().catch(() => null);
  return context ? Object.values(read(context.scope)) : [];
}

// ── sign-out / account change (review M3) ────────────────────────────────────
const REGISTRY_PREFIX = "prism:collab-unsynced:";
/** Names registered as unsynced under a raw scope key (any account on this device). */
function registeredNames(rawScopeKey: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(REGISTRY_PREFIX + rawScopeKey) ?? "{}") as Record<string, UnsyncedDoc>;
    return new Set(v && typeof v === "object" ? Object.keys(v) : []);
  } catch { return new Set(); }
}
/**
 * Signing out of `scope`: live-document bodies must not stay on the device. Synced
 * documents are always removed; unsynced ones (edits the server never took) only
 * after the person chose to download or discard them (`includeUnsynced`).
 */
export async function purgeScopeDocuments(scope: WriteScope, includeUnsynced: boolean): Promise<number> {
  const raw = scopeKey(scope);
  const unsynced = includeUnsynced ? new Set<string>() : registeredNames(raw);
  const removed = await purgeLocalDocuments((s) => s === raw, (_s, name) => unsynced.has(name));
  purgePendingForScope(raw, [...unsynced].map((name) => localDocumentKey(scope, name)));
  if (includeUnsynced) { try { localStorage.removeItem(REGISTRY_PREFIX + raw); } catch { /* private mode */ } listeners.forEach((fn) => fn()); }
  return removed;
}
/** Another account now uses this browser: remove every OTHER scope's synced documents
 *  (its unsynced ones stay for that account, exactly like its queued writes). */
export async function purgeOtherScopes(current: WriteScope | null): Promise<number> {
  const mine = current ? scopeKey(current) : null;
  return purgeLocalDocuments((s) => s !== mine, (s, name) => registeredNames(s).has(name));
}
/** The unsynced live documents of `scope`, with their local state, for the leave prompt's download. */
export async function exportUnsynced(scope: WriteScope): Promise<Array<{ noteId: string; document: string; yjsUpdateBase64: string | null }>> {
  const out: Array<{ noteId: string; document: string; yjsUpdateBase64: string | null }> = [];
  const { exportLocalDocument } = await import("./localDocument");
  for (const entry of Object.values(read(scope))) out.push({ noteId: entry.noteId, document: entry.name, yjsUpdateBase64: await exportLocalDocument(localDocumentKey(scope, entry.name)) });
  return out;
}

let running = false;
/** Sync every registered document that is not open in this tab. One at a time. */
export async function syncUnsyncedDocs(): Promise<void> {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    // Each document is re-authorized by its own fresh read before anything is sent.
    const context = await captureWriteContext("recent");
    const todo = Object.values(read(context.scope)).filter((entry) => !openHere.has(entry.name) && entry.blocked !== "update-required");
    if (!todo.length) return;
    // Yjs + the socket provider load only when there is a document to push.
    const { syncOne } = await import("./unsyncedSync");
    for (const entry of todo) {
      if (openHere.has(entry.name)) continue;
      if (!navigator.onLine) break;
      await syncOne(context.scope, context.headers, entry).catch(() => "kept");
    }
  } catch {
    /* signed out or offline: entries stay */
  } finally {
    running = false;
  }
}

let started = false;
/** Feed the shell's sync badge and sync in the background on reconnect. */
export function startUnsyncedDocs(): void {
  if (started) return;
  started = true;
  const report = () => void unsyncedDocs().then((docs) => {
    // Documents open in this tab report their own (more precise) state.
    const waiting = docs.filter((d) => !openHere.has(d.name)).length;
    reportSyncSource("collab-unsynced", waiting ? "device" : null);
  });
  listeners.add(report);
  window.addEventListener("storage", (e) => { if (e.key?.startsWith("prism:collab-unsynced:")) report(); });
  window.addEventListener("prism:vault-changed", report);
  window.addEventListener("online", () => void syncUnsyncedDocs());
  window.setInterval(() => void syncUnsyncedDocs(), 60_000);
  report();
  void syncUnsyncedDocs();
}
