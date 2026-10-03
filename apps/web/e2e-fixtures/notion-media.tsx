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
import { PlatformProvider, VaultClientProvider, CollabEditor, VaultRequestError, type Note, type VaultClient } from "@prism/core";
import DocumentRenderer from "../../../packages/core/src/components/renderers/DocumentRenderer";
import { useUIStore } from "../../../packages/core/src/app/stores/ui";
import { linkTarget, pageIdFromUrl } from "../../../packages/core/src/lib/tiptap/prismLinks";

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
// Attachments live at the server's own route; the specs fulfil /api/attachments/* from fixture files.
const FILES: Record<string, string> = { "application/pdf": "/api/attachments/a_pdf", "audio/wav": "/api/attachments/a_wav", "video/webm": "/api/attachments/a_webm" };
// A tiny vault: the page, one existing database ("Reading list") and whatever a test creates.
const db: Note = { id: "db1", path: "Projects/Prism/Reading list", content: "", tags: [], metadata: { title: "Reading list", prism_type: "database", prism_database: { version: 1, source: { tags: ["book"] }, views: [{ id: "vtable", name: "All books", type: "table" }] } }, createdAt: date, updatedAt: date };
const book: Note = { id: "b1", path: "Books/Braiding Sweetgrass", content: "", tags: ["book"], metadata: { title: "Braiding Sweetgrass" }, createdAt: date, updatedAt: date };
const vault: Note[] = [note, db, book];
const creates: Array<Record<string, unknown>> = [];
const trashed: string[] = [];
if (params.has("nocreate")) creates.length = 0;
const client = {
  getNote: async (id: string) => { const n = vault.find((x) => x.id === id); if (!n) throw new VaultRequestError(404, "GET /notes failed: 404"); return structuredClone(n); },
  listNotes: async (f?: { tag?: string }) => structuredClone(vault.filter((n) => !f?.tag || n.tags?.includes(f.tag))),
  listTree: async () => vault.map((n) => ({ id: n.id, path: n.path, tags: n.tags, metadata: n.metadata, updatedAt: n.updatedAt })),
  createNote: async (params: { path?: string; content?: string; tags?: string[]; metadata?: Record<string, unknown> }) => {
    if (new URLSearchParams(location.search).has("nocreate")) throw new Error("POST /notes failed: 403");
    creates.push(params as Record<string, unknown>);
    // ?slowcreate: the create stays in flight until the spec releases it (typing meanwhile).
    if (new URLSearchParams(location.search).has("slowcreate")) await new Promise<void>((r) => { (window as unknown as { prismMediaRelease: () => void }).prismMediaRelease = r; });
    // ?offlinecreate: what the web outbox answers when a create is only QUEUED — a temporary id.
    if (new URLSearchParams(location.search).has("offlinecreate")) return { id: `offline-${creates.length}`, path: params.path ?? null, content: "", tags: [], metadata: {}, createdAt: date, updatedAt: date } as Note;
    const n: Note = { id: `new${creates.length}`, path: params.path ?? null, content: params.content ?? "", tags: params.tags ?? [], metadata: params.metadata ?? {}, createdAt: date, updatedAt: date } as Note;
    vault.push(n);
    return structuredClone(n);
  },
  trashPage: async (id: string) => { trashed.push(id); const n = vault.find((x) => x.id === id); if (n) n.tags = [...(n.tags ?? []), "prism-trashed"]; return { rootId: id, trashed: [id] }; },
  search: async () => [],
  getTags: async () => [],
  getLinks: async () => [],
  updateNote: async (id: string, changes: Partial<Note>) => {
    const n = vault.find((x) => x.id === id)!;
    const { metadata, ...rest } = changes;
    Object.assign(n, rest, { updatedAt: new Date().toISOString() });
    if (metadata) n.metadata = { ...n.metadata, ...metadata };
    return structuredClone(n);
  },
  uploadAttachment: async (noteId: string, file: File, opts?: { kind?: string }) => {
    await new Promise((r) => setTimeout(r, 20));
    uploads.push({ noteId, name: file.name, type: file.type, kind: opts?.kind });
    const url = file.type.startsWith("image/") ? `/api/attachments/a_img${uploads.length}` : FILES[file.type] ?? `/api/attachments/a_bin${uploads.length}`;
    return { id: `a_${uploads.length}`, url, name: file.name, mimeType: FILES[file.type] ? file.type : file.type.startsWith("image/") ? file.type : "application/octet-stream", size: file.size };
  },
  unfurl: async (url: string) => {
    unfurls.push(url);
    await new Promise((r) => setTimeout(r, 20));
    return { url, title: "Watershed atlas", description: "Maps and field notes for the Front Range watersheds.", siteName: "Atlas", image: "/api/media/proxy?u=https%3A%2F%2Fatlas.example.org%2Fog.png", favicon: "/api/media/proxy?u=https%3A%2F%2Fatlas.example.org%2Ffavicon.ico" };
  },
} as unknown as VaultClient;
Object.assign(window, {
  prismMediaMeta: metaWrites,
  prismMediaUploads: uploads,
  prismMediaUnfurls: unfurls,
  prismMediaCreates: creates,
  prismMediaTrashed: trashed,
  prismMediaVault: vault,
  prismMediaUI: useUIStore,
  prismLinks: { linkTarget, pageIdFromUrl },
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
            uploadImage={async () => ({ src: "/api/attachments/a_img1" })}
            uploadFile={async (file) => ({ src: FILES[file.type] ?? "/api/attachments/a_bin1", name: file.name, size: file.size, mimeType: file.type || "application/octet-stream" })}
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
