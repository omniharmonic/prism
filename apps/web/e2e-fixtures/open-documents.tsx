import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PlatformProvider,
  VaultClientProvider,
  useUIStore,
  type Note,
  type VaultClient,
} from "@prism/core";
import { TabBar } from "../../../packages/core/src/components/layout/TabBar";
import DocumentRenderer from "../../../packages/core/src/components/renderers/DocumentRenderer";
if (new URLSearchParams(location.search).has("dark"))
  document.documentElement.classList.remove("light");
const notes: Note[] = Array.from({ length: 20 }, (_, i) => ({
  id: `doc-${i + 1}`,
  path: `Projects/Prism/${i === 0 ? "Working draft" : `Document ${i + 1} — Research and long-term collaborative workspace planning`}`,
  content: `<p>Document ${i + 1} body</p>`,
  tags: [],
  metadata: { type: "document" },
  createdAt: "2026-10-02T12:00:00Z",
  updatedAt: "2026-10-02T12:00:00Z",
}));
const writes: Partial<Note>[] = [];
const client = {
  getNote: async (id: string) => notes.find((note) => note.id === id)!,
  getTags: async () => [],
  updateNote: async (id: string, changes: Partial<Note>) => {
    writes.push(changes);
    const note = notes.find((note) => note.id === id)!;
    Object.assign(note, changes);
    return note;
  },
} as unknown as VaultClient;
useUIStore.getState().closeAllTabs();
for (const note of notes)
  useUIStore
    .getState()
    .openTab(note.id, note.path!.split("/").at(-1)!, "document");
useUIStore.getState().setActiveTab(useUIStore.getState().openTabs[0].id);
useUIStore.getState().markTabDirty(useUIStore.getState().openTabs[4].id, true);
Object.assign(window, { prismTabs: useUIStore, prismTabWrites: writes });
function Fixture() {
  const active = useUIStore((state) => state.activeTabId);
  const tabs = useUIStore((state) => state.openTabs);
  const note = notes.find(
    (item) => item.id === tabs.find((tab) => tab.id === active)?.noteId,
  );
  return (
    <main
      style={{
        background: "var(--bg-base)",
        color: "var(--text-primary)",
        minHeight: "100dvh",
      }}
    >
      <TabBar />
      <div style={{ maxWidth: 760, padding: "48px 24px", margin: "auto" }}>
        {note ? (
          <DocumentRenderer key={note.id} note={note} />
        ) : (
          <p>No document selected.</p>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlatformProvider value="web">
      <QueryClientProvider client={new QueryClient()}>
        <VaultClientProvider client={client}>
          <Fixture />
        </VaultClientProvider>
      </QueryClientProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
