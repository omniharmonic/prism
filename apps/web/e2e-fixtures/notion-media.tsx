/**
 * Wave 2B fixture: the plain document editor (default) or two LIVE collaborative
 * editors sharing one in-page Y.Doc pair (`?live`), with a mock vault client that
 * stores "attachments" as fixture files and answers link previews. Never talks
 * to a server.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformProvider, VaultClientProvider, CollabEditor, type Note, type VaultClient } from "@prism/core";
import DocumentRenderer from "../../../packages/core/src/components/renderers/DocumentRenderer";

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const date = "2026-10-02T12:00:00.000Z";
const content = params.get("content") ?? "<h1>Field guide</h1><p>Alpha paragraph about the river.</p><h2>Birds</h2><p>Heron and heron again.</p><h3>Waders</h3><p>Closing heron note.</p>";
const metadata: Record<string, unknown> = { type: "document" };
if (params.get("cover")) metadata.cover = params.get("cover");
const note: Note = { id: "media", path: "Projects/Prism/Field guide", content, tags: [], metadata, createdAt: date, updatedAt: date };
const metaWrites: Array<Record<string, unknown>> = [];
const uploads: Array<{ noteId: string; name: string; type: string; kind?: string }> = [];
const unfurls: string[] = [];
const FILES: Record<string, string> = { "application/pdf": "/e2e-fixtures/media/brief.pdf", "audio/wav": "/e2e-fixtures/media/tone.wav", "video/webm": "/e2e-fixtures/media/clip.webm" };
const client = {
  getNote: async () => note,
  listNotes: async () => [note],
  listTree: async () => [{ id: note.id, path: note.path, tags: [], updatedAt: date }],
  getTags: async () => [],
  getLinks: async () => [],
  updateNote: async (_id: string, changes: Partial<Note>) => { Object.assign(note, changes, { updatedAt: new Date().toISOString() }); return note; },
  uploadAttachment: async (noteId: string, file: File, opts?: { kind?: string }) => {
    await new Promise((r) => setTimeout(r, 20));
    uploads.push({ noteId, name: file.name, type: file.type, kind: opts?.kind });
    const url = file.type.startsWith("image/") ? `/e2e-fixtures/media/cover.png?u=${uploads.length}` : FILES[file.type] ?? `/e2e-fixtures/media/brief.pdf?bin=${uploads.length}`;
    return { id: `a_${uploads.length}`, url, name: file.name, mimeType: FILES[file.type] ? file.type : file.type.startsWith("image/") ? file.type : "application/octet-stream", size: file.size };
  },
  unfurl: async (url: string) => {
    unfurls.push(url);
    await new Promise((r) => setTimeout(r, 20));
    return { url, title: "Watershed atlas", description: "Maps and field notes for the Front Range watersheds.", siteName: "Atlas", image: "/e2e-fixtures/media/cover.png", favicon: "/e2e-fixtures/media/cover.png" };
  },
} as unknown as VaultClient;
Object.assign(window, {
  prismMediaMeta: metaWrites,
  prismMediaUploads: uploads,
  prismMediaUnfurls: unfurls,
  prismEditor: (i = 0) => (document.querySelectorAll(".tiptap")[i] as unknown as { editor: unknown })?.editor,
});

function LivePair() {
  // Two clients on two Y.Docs kept in sync in-page — what two browsers see over the server.
  const [docs] = React.useState(() => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(b, u, "remote"); });
    b.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(a, u, "remote"); });
    return [a, b];
  });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, padding: 24 }}>
      {docs.map((doc, i) => (
        <section key={i} aria-label={i === 0 ? "Client A" : "Client B"} style={{ position: "relative", minWidth: 0 }}>
          <CollabEditor
            ydoc={doc}
            provider={null}
            user={{ name: i === 0 ? "Ada" : "Ben", color: i === 0 ? "#3a7bd5" : "#f47c6b" }}
            seedReady={i === 0}
            seedContent={i === 0 ? async () => content : async () => null}
            uploadImage={async (file) => ({ src: `/e2e-fixtures/media/cover.png?live=${file.name}` })}
            uploadFile={async (file) => ({ src: FILES[file.type] ?? "/e2e-fixtures/media/brief.pdf", name: file.name, size: file.size, mimeType: file.type || "application/octet-stream" })}
          />
        </section>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlatformProvider value="web">
      <QueryClientProvider client={new QueryClient()}>
        <VaultClientProvider client={client}>
          {params.has("live") ? <LivePair /> : (
            <main style={{ background: "var(--bg-base)", color: "var(--text-primary)", height: "100dvh", display: "flex", flexDirection: "column" }}>
              <DocumentRenderer
                note={note}
                readOnly={params.has("readonly")}
                onMetadataChange={(patch: Record<string, unknown>) => { metaWrites.push(patch); Object.assign(note.metadata!, patch); }}
              />
            </main>
          )}
        </VaultClientProvider>
      </QueryClientProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
