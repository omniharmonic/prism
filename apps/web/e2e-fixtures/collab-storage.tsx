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
}});
const client = { listNotes: async () => [], getLinks: async () => [] } as unknown as VaultClient;
const queries = new QueryClient();
const query = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={queries}><PlatformProvider value="web"><VaultClientProvider client={client}>{(query.has("denied") || query.has("live")) ? <CollabDoc noteId="denied-note" /> : query.has("reconnect") ? <ReconnectScreen /> : <p>Scoped collaborative storage fixture</p>}</VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
