/**
 * Fixture for mouse block selection (NP-ED-26) and inline emoji (NP-ED-27): the plain
 * document editor (default; `?readonly`) or two LIVE editors on one in-page Y.Doc pair
 * (`?live`; `?viewer` makes client B read-only, `?suggesting` / `?commentonly` put client A in
 * that mode). Never talks to a server.
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
// The relay between the two live clients can be HELD: what each side did meanwhile then arrives
// as ONE merged update — what a reconnect after a dropped socket delivers.
const relay = { held: false, queue: [] as Array<{ to: Y.Doc; update: Uint8Array }> };
const deliver = (to: Y.Doc, update: Uint8Array) => { if (relay.held) relay.queue.push({ to, update }); else Y.applyUpdate(to, update, "remote"); };
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
    /** A text field INSIDE block `n`, as an inline database cell or a caption is: its own keys and clipboard events stay in it. */
    field: (i: number, n: number) => {
      const ed = editor(i);
      const view = ed.view as unknown as { nodeDOM(pos: number): Node | null; domObserver: { stop(): void; start(): void } };
      let pos = 0;
      for (let k = 0; k < n; k++) pos += ed.state.doc.child(k).nodeSize;
      const wrap = document.createElement("span");
      wrap.contentEditable = "false";
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Cell");
      wrap.appendChild(input);
      for (const type of ["keydown", "keypress", "keyup", "beforeinput", "input", "mousedown", "copy", "cut", "paste"]) wrap.addEventListener(type, (e) => e.stopPropagation());
      view.domObserver.stop();
      (view.nodeDOM(pos) as HTMLElement).appendChild(wrap);
      view.domObserver.start();
    },
    html: (i = 0) => (editor(i) as unknown as { getHTML(): string }).getHTML(),
    hold: () => { relay.held = true; },
    release: () => {
      relay.held = false;
      const queued = relay.queue.splice(0);
      for (const to of new Set(queued.map((q) => q.to))) Y.applyUpdate(to, Y.mergeUpdates(queued.filter((q) => q.to === to).map((q) => q.update)), "remote");
    },
    emojiSetIsFull,
  },
});

function LivePair() {
  const [docs] = React.useState(() => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "remote") deliver(b, u); });
    b.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "remote") deliver(a, u); });
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
            commentOnly={i === 0 && params.has("commentonly")}
            canComment
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
