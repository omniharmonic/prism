import React from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { persistLocalDocument, localDocumentKey, type LocalSaveState } from "../src/collab/localDocument";
import { CollabDoc } from "../src/collab/CollabDoc";
import { ReconnectScreen } from "../src/auth/ReconnectScreen";
import { fetchMe } from "../src/config";
import { unsyncedDocs, syncUnsyncedDocs, startUnsyncedDocs } from "../src/collab/unsynced";
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
  close(label: string) { const entry = opened.get(label)!; entry.persistence.close(); entry.doc.destroy(); opened.delete(label); },
  async checkAuth() { return fetchMe(); },
  // Wave 2E re-review M1: live documents with edits only on this device.
  unsynced: () => unsyncedDocs(),
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
        const raw = localStorage.getItem("prism:collab-pending:" + String(key));
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
const client = { listNotes: async () => [], getLinks: async () => [] } as unknown as VaultClient;
const queries = new QueryClient();
const query = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={queries}><PlatformProvider value="web"><VaultClientProvider client={client}>{(query.has("denied") || query.has("live")) ? <CollabDoc noteId="denied-note" /> : query.has("reconnect") ? <ReconnectScreen /> : <p>Scoped collaborative storage fixture</p>}</VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
