/**
 * Suggesting-mode fixture (slice J, NP-CO-12): the live editor on a local Y.Doc with an
 * Editing / Suggesting toggle, plus a second (headless) editor bound to the SAME Y.Doc that
 * plays a collaborator. Fictional text; no server. `?content=` seeds other stored HTML, `?dark` the dark theme.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEditor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { CollabEditor, type Editor } from "@prism/core";
import { collabExtensions } from "../../../packages/core/src/editor/collabSchema";
import { updateMentionByUid } from "../../../packages/core/src/lib/tiptap/MentionContext";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
import "../../../packages/core/src/styles/workspace.css";
import "../../../packages/core/src/styles/collab.css";

const doc = new Y.Doc();
let updates = 0;
doc.on("update", () => { updates++; });
let editor: Editor | null = null;
let peer: Editor | null = null;
const find = (e: Editor, text: string) => {
  let at = -1;
  e.state.doc.descendants((node, pos) => { if (at < 0 && node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text); });
  if (at < 0) throw new Error(`no such text: ${text}`);
  return at;
};
const kept = new Map<string, unknown>();
Object.assign(window, {
  suggestFixture: {
    // What a COLLABORATOR has (the second editor, fed only by the shared Y.Doc) — not the author's
    // local state: a mark or node that never reaches the Y.Doc must never satisfy a spec.
    html: () => peer!.getHTML(),
    authorHtml: () => editor!.getHTML(),
    /** All the text of the collaborator's copy, block after block. */
    text: () => peer!.state.doc.textBetween(0, peer!.state.doc.content.size, "\n"),
    /** The text the collaborator sees struck (tracked deletions), in document order; blocks joined by "|". */
    struckText: () => {
      const out: string[] = [];
      peer!.state.doc.descendants((node) => {
        if (!node.isTextblock) return true;
        let run = "";
        node.forEach((child) => { if (child.isText && child.marks.some((m) => m.type.name === "deletion")) run += child.text; });
        if (run) out.push(run);
        return false;
      });
      return out.join("|");
    },
    /** "" when the author's document and the collaborator's are the same (text, nodes AND marks). */
    // (Compared as JSON: the two editors have a schema instance each, so `Node.eq` — which
    // compares node TYPES by identity — is false for any pair of their documents.)
    diverged: () => {
      if (!editor || editor.isDestroyed || !peer) return "";
      const mine = JSON.stringify(editor.state.doc.toJSON());
      const theirs = JSON.stringify(peer.state.doc.toJSON());
      return mine === theirs ? "" : `author: ${mine}\npeer:   ${theirs}`;
    },
    /** The text of the author's selection, blocks joined by "|" (as the editor holds it after any normalising). */
    selectedText: () => { const { from, to } = editor!.state.selection; return editor!.state.doc.textBetween(from, to, "|"); },
    updates: () => updates,
    select(text: string) { const at = find(editor!, text); editor!.chain().focus().setTextSelection({ from: at, to: at + text.length }).run(); },
    /** From the start of `a` to the end of `b` (they may sit in different blocks). */
    selectAcross(a: string, b: string) { editor!.chain().focus().setTextSelection({ from: find(editor!, a), to: find(editor!, b) + b.length }).run(); },
    caretAfter(text: string) { editor!.chain().focus().setTextSelection(find(editor!, text) + text.length).run(); },
    paste(text: string) {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      editor!.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    /** What ProseMirror dispatches when a selection is dragged elsewhere: remove it, insert it there. */
    dropSelectionAfter(text: string) {
      const { state } = editor!.view;
      const slice = state.selection.content();
      const tr = state.tr.deleteSelection();
      const at = tr.mapping.map(find(editor!, text) + text.length);
      editor!.view.dispatch(tr.replaceRange(at, at, slice).setMeta("uiEvent", "drop"));
    },
    /** An attribute change of the first leaf of this type (what a node view's `updateAttributes` dispatches). */
    setLeafAttrs(type: string, attrs: Record<string, unknown>) {
      let at = -1;
      editor!.state.doc.descendants((node, pos) => { if (at < 0 && node.type.name === type) at = pos; });
      if (at < 0) throw new Error(`no ${type}`);
      editor!.view.dispatch(editor!.state.tr.setNodeMarkup(at, undefined, { ...editor!.state.doc.nodeAt(at)!.attrs, ...attrs }));
    },
    /** What a native drag of a block dispatches: the node is removed and inserted after `text`'s block, in ONE transaction. */
    dragNodeAfter(type: string, text: string) {
      const { state } = editor!.view;
      let at = -1;
      state.doc.descendants((node, pos) => { if (at < 0 && node.type.name === type) at = pos; });
      if (at < 0) throw new Error(`no ${type}`);
      const node = state.doc.nodeAt(at)!;
      const tr = state.tr.delete(at, at + node.nodeSize);
      const $to = tr.doc.resolve(tr.mapping.map(find(editor!, text)));
      editor!.view.dispatch(tr.insert($to.after(1), node).setMeta("uiEvent", "drop"));
    },
    /** A paste over a node-selected leaf: the selected node is replaced by another of its kind. */
    pasteNodeOver(type: string, attrs: Record<string, unknown>) {
      let at = -1;
      editor!.state.doc.descendants((node, pos) => { if (at < 0 && node.type.name === type) at = pos; });
      if (at < 0) throw new Error(`no ${type}`);
      editor!.commands.setNodeSelection(at);
      const { state } = editor!.view;
      editor!.view.dispatch(state.tr.replaceSelectionWith(state.schema.nodes[type]!.create(attrs)).setMeta("paste", true).setMeta("uiEvent", "paste"));
    },
    /** What "@Remind me…" does after its chip is in: stamp the reminder id on it. */
    remind: (uid: string) => updateMentionByUid(editor!, uid, { reminder: "r-1" }),
    chips: () => { const out: Array<{ uid: string; date: string; marks: string[] }> = []; peer!.state.doc.descendants((node) => { if (node.type.name === "mention") out.push({ uid: node.attrs.uid, date: node.attrs.date, marks: node.marks.map((m) => m.type.name) }); }); return out; },
    blur: () => (editor!.view.dom as HTMLElement).blur(),
    unmount: () => setMounted?.(false),
    /** The shared document itself (what every collaborator and the server hold). */
    ydoc: () => doc.getXmlFragment("default").toString(),
    count: (type: string) => { let n = 0; peer!.state.doc.descendants((node) => { if (node.type.name === type) n++; }); return n; },
    /** A collaborator's change, arriving through Yjs. */
    peerDelete(text: string) { const at = find(peer!, text); peer!.commands.deleteRange({ from: at, to: at + text.length }); },
    /** This person types `extra` right after `text` (inside whatever marks that text carries). */
    typeAfter(text: string, extra: string) { const at = find(editor!, text) + text.length; editor!.view.dispatch(editor!.state.tr.insertText(extra, at)); },
    /** A collaborator types `extra` right after `text` (inside whatever marks that text carries). */
    peerTypeAfter(text: string, extra: string) { const at = find(peer!, text) + text.length; peer!.view.dispatch(peer!.state.tr.insertText(extra, at)); },
    /** Remember the Yjs element behind top-level block `index`, to see later that it was not rebuilt. */
    keepBlock(name: string, index: number) { kept.set(name, doc.getXmlFragment("default").get(index)); },
    sameBlock: (name: string, index: number) => kept.get(name) === doc.getXmlFragment("default").get(index),
    blocks: () => doc.getXmlFragment("default").length,
  },
});

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
// ?content=<stored HTML> seeds another page (slice K: callout colours, an agent's marks).
const body = params.get("content") ?? "<p>The rollout plan is ready for review.</p><p>Second paragraph stays here.</p><hr><p>Closing line.</p>";
function Peer() {
  peer = useEditor({ extensions: [...collabExtensions(), Collaboration.configure({ document: doc })] });
  return null;
}
let setMounted: ((on: boolean) => void) | null = null;
function Fixture() {
  const [suggesting, setSuggesting] = useState(false);
  const [mounted, mount] = useState(true);
  setMounted = mount;
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24, minHeight: "100vh", background: "var(--bg-base)", color: "var(--text-primary)" }}>
      {mounted && <CollabEditor ydoc={doc} provider={null} user={{ name: "You", color: "#2563eb" }} seedReady seedContent={async () => body} toolbar canReview suggesting={suggesting} onSetSuggesting={setSuggesting} onEditor={(value) => { editor = value; }} />}
      <Peer />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>);
