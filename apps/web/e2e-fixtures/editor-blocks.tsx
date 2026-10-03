/** Plain block editor with fictional content. Never connects to a live server. */
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformProvider, VaultClientProvider, type Note, type VaultClient } from "@prism/core";
import DocumentRenderer from "../../../packages/core/src/components/renderers/DocumentRenderer";

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const date = "2026-10-02T12:00:00.000Z";
const content = params.get("content") ?? "<h2>Alpha</h2><p>Bravo paragraph</p><ul><li><p>Charlie item</p></li><li><p>Delta item</p></li></ul><blockquote><p>Echo quote</p></blockquote><p>Foxtrot closing</p>";
const notes: Note[] = [
  { id: "blocks", path: "Projects/Prism/Block editor", content, tags: [], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "roadmap", path: "Projects/Prism/Roadmap", content: "<p>Roadmap</p>", tags: [], metadata: { type: "document" }, createdAt: date, updatedAt: date },
];
const writes: Array<{ id: string; content?: string; ifUpdatedAt?: string }> = [];
const uploads: Array<{ noteId: string; name: string; type: string; size: number }> = [];
const controls = { failMove: false, failUpload: false, hold: null as null | Promise<void>, release: () => {} };
const client = {
  getNote: async (id: string) => notes.find((n) => n.id === id)!,
  listNotes: async () => notes,
  listTree: async () => notes.map(({ id, path, tags, updatedAt }) => ({ id, path, tags, updatedAt })),
  getTags: async () => [],
  getLinks: async () => [],
  updateNote: async (id: string, changes: Partial<Note> & { ifUpdatedAt?: string }) => {
    if (controls.failMove && id !== "blocks") throw new Error("PATCH /notes failed: 409");
    writes.push({ id, content: changes.content, ifUpdatedAt: changes.ifUpdatedAt });
    const note = notes.find((n) => n.id === id)!;
    Object.assign(note, changes, { updatedAt: new Date().toISOString() });
    return note;
  },
  ...(params.has("upload") ? {
    uploadAttachment: async (noteId: string, file: File) => {
      await new Promise((r) => setTimeout(r, 30)); // a real round-trip is async
      if (controls.hold) await controls.hold;
      uploads.push({ noteId, name: file.name, type: file.type, size: file.size });
      if (controls.failUpload) throw new Error("fixture upload refused");
      return { id: `att-${uploads.length}`, url: `/e2e-fixtures/fixture-image.svg?u=${uploads.length}`, name: file.name, mimeType: file.type, size: file.size };
    },
  } : {}),
} as unknown as VaultClient;
Object.assign(window, {
  prismHoldUploads: () => { controls.hold = new Promise<void>((r) => { controls.release = () => { controls.hold = null; r(); }; }); },
  prismBlockWrites: writes,
  prismBlockUploads: uploads,
  prismBlockControls: controls,
  prismEditor: () => (document.querySelector(".tiptap") as unknown as { editor: unknown })?.editor,
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlatformProvider value="web">
      <QueryClientProvider client={new QueryClient()}>
        <VaultClientProvider client={client}>
          <main style={{ background: "var(--bg-base)", color: "var(--text-primary)", height: "100dvh", display: "flex", flexDirection: "column" }}>
            <DocumentRenderer note={notes[0]} onMetadataChange={() => {}} readOnly={params.has("readonly")} />
          </main>
        </VaultClientProvider>
      </QueryClientProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
