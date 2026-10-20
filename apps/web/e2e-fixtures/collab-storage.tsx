import React from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { persistLocalDocument, localDocumentKey, pendingStorageKey, type LocalSaveState } from "../src/collab/localDocument";
import { CollabDoc } from "../src/collab/CollabDoc";
import { ReconnectScreen } from "../src/auth/ReconnectScreen";
import { fetchMe, logout } from "../src/config";
import { unsyncedDocs, syncUnsyncedDocs, startUnsyncedDocs, exportUnsynced } from "../src/collab/unsynced";
import { captureWriteContext } from "../src/offline/writeScope";
import { CollabDocument as LazyCollabDocument, setCollabEditorLoaderForTests } from "../src/collab/lazyCollab";
import { installChunkReloadRecovery } from "../src/chunkReload";
import { RendererBoundary } from "../../../packages/core/src/components/layout/RendererBoundary";
import { deriveSyncStatus, useSyncStore } from "@prism/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, PlatformProvider, type VaultClient } from "@prism/core";
import type { WriteScope } from "../src/offline/writeScope";

const scope: WriteScope = { api: `${location.origin}/api`, workspace: "workspace-a", vault: "vault-a", actor: "user:alice@example.test" };
const opened = new Map<string, { doc: Y.Doc; persistence: Awaited<ReturnType<typeof persistLocalDocument>> }>();
const states: Record<string, LocalSaveState> = {};
Object.assign(window, { prismCollabFixture: {
  async open(label: string, overrides: Partial<WriteScope> = {}, note = "same-note") {
    const doc = new Y.Doc();
    const persistence = await persistLocalDocument(localDocumentKey({ ...scope, ...overrides }, note), doc, (state) => { states[label] = state; });
    opened.set(label, { doc, persistence });
    return doc.getText("content").toString();
  },
  async append(label: string, value: string) {
    const entry = opened.get(label)!;
    entry.doc.getText("content").insert(entry.doc.getText("content").length, value);
    await entry.persistence.flush();
    return states[label];
  },
  /** The last local save state reported for a document opened under `label`. */
  state(label: string) { return states[label]; },
  close(label: string) { const entry = opened.get(label)!; entry.persistence.close(); entry.doc.destroy(); opened.delete(label); },
  async checkAuth() { return fetchMe(); },
  /** Sign out through the real path (review M3). `answer` = what the person picks in the leave prompt. */
  async logout(answer: "stay" | "download" | "discard" = "discard") {
    const asked: number[] = [];
    const onAsk = (event: Event) => { const d = (event as CustomEvent<{ count: number; take: () => void; resolve: (c: string) => void }>).detail; d.take(); asked.push(d.count); d.resolve(answer); };
    window.addEventListener("prism:leave-with-unsent", onAsk);
    try { return { left: await logout(), asked }; } finally { window.removeEventListener("prism:leave-with-unsent", onAsk); }
  },
  /** IndexedDB live-document keys and rescue keys currently on this device. */
  async stored(): Promise<{ rows: string[]; rescue: string[]; registry: string[] }> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("prism-collab-v3", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("documents");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise<string[]>((resolve, reject) => { const r = db.transaction("documents").objectStore("documents").getAllKeys(); r.onsuccess = () => resolve(r.result.map(String)); r.onerror = () => reject(r.error); });
      const keys = Object.keys(localStorage);
      return { rows, rescue: keys.filter((k) => k.startsWith("prism:collab-pending:")), registry: keys.filter((k) => k.startsWith("prism:collab-unsynced:")) };
    } finally { db.close(); }
  },
  // Wave 2E re-review M1: live documents with edits only on this device.
  unsynced: () => unsyncedDocs(),
  /** What the leave prompt's download would hold for this account's unsynced live documents. */
  exportUnsynced: async () => exportUnsynced((await captureWriteContext()).scope),
  syncUnsynced: () => syncUnsyncedDocs(),
  startUnsynced: () => startUnsyncedDocs(),
  syncLabel: () => deriveSyncStatus(useSyncStore.getState()).label,
  /** Unload-rescue entries (localStorage) — wave 3 unload guard. A rescue is a DIFF on
   *  top of the IndexedDB row, so it only reads as text once merged with that row. */
  rescued: (): number => Object.keys(localStorage).filter((k) => k.startsWith("prism:collab-pending:")).length,
  /** Everything this device holds per document: the IndexedDB row + its rescue entry. */
  async deviceTexts(): Promise<string[]> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("prism-collab-v3", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("documents");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const store = db.transaction("documents").objectStore("documents");
      const [keys, rows] = await Promise.all([store.getAllKeys(), store.getAll()].map((request) => new Promise<unknown[]>((resolve, reject) => { request.onsuccess = () => resolve(request.result as unknown[]); request.onerror = () => reject(request.error); })));
      return keys!.map((key, i) => {
        const doc = new Y.Doc(); Y.applyUpdate(doc, rows![i] as Uint8Array);
        const raw = localStorage.getItem(pendingStorageKey(String(key)));
        if (raw) Y.applyUpdate(doc, Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)));
        const text = doc.getXmlFragment("default").toString(); doc.destroy(); return text;
      });
    } finally { db.close(); }
  },
  /** What the local store (IndexedDB) really holds for live documents — read-only, every stored document. */
  async localTexts(): Promise<string[]> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("prism-collab-v3", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("documents");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const stored = await new Promise<Uint8Array[]>((resolve, reject) => {
        const request = db.transaction("documents").objectStore("documents").getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return stored.map((update) => { const doc = new Y.Doc(); Y.applyUpdate(doc, update); const text = doc.getXmlFragment("default").toString(); doc.destroy(); return text; });
    } finally { db.close(); }
  },
}});
// ?lazy — the on-demand editor seam (lazyCollab): the first download(s) of the editor chunk fail
// (`&fails=N`, default 1; the seam retries twice by itself, so N ≥ 3 reaches the page's "Try again").
const lazyMode = new URLSearchParams(location.search).has("lazy");
if (lazyMode) {
  let attempts = 0;
  const fails = Number(new URLSearchParams(location.search).get("fails") ?? "1");
  setCollabEditorLoaderForTests(async () => {
    attempts++;
    (window as unknown as { prismLazyAttempts: number }).prismLazyAttempts = attempts;
    if (attempts <= fails) throw new TypeError("Failed to fetch dynamically imported module");
    return { CollabDocument: () => <p>Editor loaded</p>, useLiveCollab: () => true } as never;
  });
  installChunkReloadRecovery();
  (window as unknown as { prismLazyBooted: number }).prismLazyBooted = Date.now();
}
// ?boundary — RendererBoundary and a download failure thrown from a view (`&always` = every render fails).
const boundaryBoot = Date.now();
function FlakyView() {
  // Fails for the first 300 ms (one burst of failed downloads), or always.
  if (Date.now() - boundaryBoot < 300 || new URLSearchParams(location.search).has("always")) throw new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1/assets/View.js");
  return <p>Recovered view</p>;
}
const client = { listNotes: async () => [], getLinks: async () => [] } as unknown as VaultClient;
const queries = new QueryClient();
const query0 = new URLSearchParams(location.search);
const query = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={queries}><PlatformProvider value="web"><VaultClientProvider client={client}>{query0.has("boundary") ? <RendererBoundary><FlakyView /></RendererBoundary> : lazyMode ? <RendererBoundary><LazyCollabDocument noteId="n1" note={{ id: "n1", path: "Projects/Page", content: "", tags: [], metadata: {}, createdAt: "", updatedAt: null } as never} /></RendererBoundary> : (query.has("denied") || query.has("live")) ? <CollabDoc noteId="denied-note" /> : query.has("reconnect") ? <ReconnectScreen /> : <p>Scoped collaborative storage fixture</p>}</VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
