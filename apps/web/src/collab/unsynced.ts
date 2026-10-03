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
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { COLLAB_SCHEMA_VERSION, reportSyncSource } from "@prism/core";
import { captureWriteContext, scopeKey, type WriteScope } from "../offline/writeScope";
import { persistLocalDocument, localDocumentKey, purgeLocalDocuments, purgePendingForScope, exportLocalDocument } from "./localDocument";
import { collabWsUrl, collabToken, serverFetch } from "../transport";
import { getCapabilityToken } from "../config";

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
  for (const entry of Object.values(read(scope))) out.push({ noteId: entry.noteId, document: entry.name, yjsUpdateBase64: await exportLocalDocument(localDocumentKey(scope, entry.name)) });
  return out;
}

/** Push one document's local state to the server through a headless provider. */
async function syncOne(scope: WriteScope, headers: Record<string, string>, entry: UnsyncedDoc): Promise<"synced" | "kept"> {
  // Fresh authorization first, exactly like opening the document.
  const response = await serverFetch(`${scope.api}/notes/${encodeURIComponent(entry.noteId)}`, { headers, cache: "no-store" });
  if ([401, 403, 404, 410].includes(response.status)) { markUnsynced(scope, entry.name, entry.noteId, "denied"); return "kept"; }
  if (!response.ok) return "kept";
  const level = ((await response.json()) as { _level?: string })._level ?? "own";
  // Below edit the server accepts no raw updates (suggest-only enforcement): keep the local state for the user.
  if (level !== "own" && level !== "edit") { markUnsynced(scope, entry.name, entry.noteId, "read-only"); return "kept"; }
  const doc = new Y.Doc();
  let persistence: Awaited<ReturnType<typeof persistLocalDocument>> | undefined;
  let provider: HocuspocusProvider | undefined;
  try {
    persistence = await persistLocalDocument(localDocumentKey(scope, entry.name), doc, () => {});
    const outcome = await new Promise<"synced" | "kept" | UnsyncedDoc["blocked"]>((resolve) => {
      const timer = window.setTimeout(() => resolve("kept"), 20_000);
      const done = (value: "synced" | "kept" | UnsyncedDoc["blocked"]) => { window.clearTimeout(timer); resolve(value); };
      provider = new HocuspocusProvider({
        url: `${collabWsUrl()}?schema=${COLLAB_SCHEMA_VERSION}`, name: entry.name, token: collabToken(getCapabilityToken()), document: doc,
        onAuthenticationFailed: ({ reason }) => done(reason?.startsWith("update_required") ? "update-required" : "denied"),
        onSynced: () => {
          if (provider?.authorizedScope === "readonly") { done("read-only"); return; }
          // The server has our state once nothing is left unacknowledged.
          const settle = () => { if ((provider?.unsyncedChanges ?? 0) === 0) done("synced"); };
          provider?.on("unsyncedChanges", settle);
          settle();
        },
      });
    });
    if (outcome === "synced") { clearUnsynced(scope, entry.name); return "synced"; }
    if (outcome && outcome !== "kept") markUnsynced(scope, entry.name, entry.noteId, outcome);
    return "kept";
  } catch {
    return "kept";
  } finally {
    provider?.destroy();
    await persistence?.flush().catch(() => undefined);
    persistence?.close();
    doc.destroy();
  }
}

let running = false;
/** Sync every registered document that is not open in this tab. One at a time. */
export async function syncUnsyncedDocs(): Promise<void> {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const context = await captureWriteContext(true);
    for (const entry of Object.values(read(context.scope))) {
      if (openHere.has(entry.name) || entry.blocked === "update-required") continue;
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
