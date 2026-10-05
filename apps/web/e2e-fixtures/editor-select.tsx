/**
 * Fixture for mouse block selection (NP-ED-26) and inline emoji (NP-ED-27): the plain
 * document editor (default; `?readonly`) or two LIVE editors on one in-page Y.Doc pair
 * (`?live`; `?viewer` makes client B read-only). Never talks to a server.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformProvider, VaultClientProvider, CollabEditor, VaultRequestError, type Note, type VaultClient } from "@prism/core";
import DocumentRenderer from "../../../packages/core/src/components/renderers/DocumentRenderer";
import { blockSelectionRange } from "../../../packages/core/src/lib/tiptap/EditorKeys";
import { blockSetKey, selectedBlockIndices } from "../../../packages/core/src/lib/tiptap/BlockMouseSelect";
import { emojiSetIsFull } from "../../../packages/core/src/lib/tiptap/emojiData";

const params = new URLSearchParams(location.search);
const date = "2026-10-04T12:00:00.000Z";
const count = Number(params.get("blocks") ?? 6);
const WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const content = params.get("content") ?? Array.from({ length: count }, (_, i) => `<p>${WORDS[i] ?? `Block ${i + 1}`} paragraph with some words in it.</p>`).join("");
const note: Note = { id: "select", path: "Projects/Prism/Selection", content, tags: [], metadata: { type: "document" }, createdAt: date, updatedAt: date };
const client = {
  getNote: async (id: string) => { if (id !== note.id) throw new VaultRequestError(404, "GET /notes failed: 404"); return structuredClone(note); },
  listNotes: async () => [structuredClone(note)],
  listTree: async () => [{ id: note.id, path: note.path, tags: note.tags, metadata: note.metadata, updatedAt: note.updatedAt }],
  search: async () => [],
  getTags: async () => [],
  getLinks: async () => [],
  updateNote: async (_id: string, changes: Partial<Note>) => { Object.assign(note, changes, { updatedAt: new Date().toISOString() }); return structuredClone(note); },
} as unknown as VaultClient;

interface PmEditor {
  state: Parameters<typeof selectedBlockIndices>[0];
  view: { dom: HTMLElement; nodeDOM(pos: number): Node | null };
  on(event: "transaction", fn: () => void): void;
}
const editor = (i = 0) => (document.querySelectorAll(".tiptap")[i] as unknown as { editor: PmEditor }).editor;
const box = (r: DOMRect) => ({ x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom });
const logs: number[][] = [];
Object.assign(window, {
  prismSelect: {
    editor,
    /** Every selected top-level block index. */
    blocks: (i = 0) => selectedBlockIndices(editor(i).state),
    /** The keyboard run (what ⌘⇧↑↓, the handle and the block menu act on). */
    run: (i = 0) => blockSelectionRange(editor(i).state),
    extra: (i = 0) => blockSetKey.getState(editor(i).state) ?? [],
    texts: (i = 0) => { const out: string[] = []; editor(i).state.doc.forEach((node) => { out.push(node.textContent); }); return out; },
    /** Client box of top-level block `n`, and of the editor itself. */
    rect: (i: number, n: number) => { const ed = editor(i); let pos = 0; for (let k = 0; k < n; k++) pos += ed.state.doc.child(k).nodeSize; return box((ed.view.nodeDOM(pos) as HTMLElement).getBoundingClientRect()); },
    column: (i = 0) => box(editor(i).view.dom.getBoundingClientRect()),
    /** Record how many blocks are selected after every transaction (a flicker shows as a 0 between two counts). */
    watch: (i = 0) => { const log: number[] = []; logs[i] = log; editor(i).on("transaction", () => { log.push(selectedBlockIndices(editor(i).state).length); }); },
    log: (i = 0) => logs[i] ?? [],
    emojiSetIsFull,
  },
});

function LivePair() {
  const [docs] = React.useState(() => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(b, u, "remote"); });
    b.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(a, u, "remote"); });
    return [a, b];
  });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 160, padding: "24px 96px" }}>
      {docs.map((doc, i) => (
        <section key={i} aria-label={i === 0 ? "Client A" : "Client B"} style={{ position: "relative", minWidth: 0 }}>
          <CollabEditor
            ydoc={doc}
            provider={null}
            editable={!(i === 1 && params.has("viewer"))}
            suggesting={i === 0 && params.has("suggesting")}
            user={{ name: i === 0 ? "Ada" : "Ben", color: i === 0 ? "#3a7bd5" : "#f47c6b" }}
            seedReady={i === 0}
            seedContent={i === 0 ? async () => content : async () => null}
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
          {params.has("live") ? <div id="workspace-document"><LivePair /></div> : (
            <main id="workspace-document" style={{ background: "var(--bg-base)", color: "var(--text-primary)", height: "100dvh", display: "flex", flexDirection: "column" }}>
              <DocumentRenderer note={note} readOnly={params.has("readonly")} onMetadataChange={() => {}} />
            </main>
          )}
        </VaultClientProvider>
      </QueryClientProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
