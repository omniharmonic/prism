/**
 * Review H1 — dropping a block BESIDE another (columns) in a LIVE document.
 *
 * Two Y.Docs, the way two browsers hold one page: client A drags "five" beside
 * "two" while client B — not yet synced — types into the unrelated blocks in
 * between. y-prosemirror turns a ProseMirror change into Yjs ops by diffing
 * documents, so the ONE-transaction form rewrites every block between the two
 * (B's typing lands in a neighbour or is lost). `moveBlocksBesideIn` splits a
 * live move into delete + replace-target; only those two places are touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { collabSchema, contentToYUpdate, yDocToHtml, FIELD } from "../src/collab";
// Loaded by a computed path: the module is browser-editor code compiled under @prism/core's own
// tsconfig, not this workspace's stricter one (it has no DOM dependency, so it runs in Node as is).
const CORE_TIPTAP = "../../../packages/core/src/lib/tiptap/";
type Beside = (state: EditorState, from: number, count: number, target: number, side: "left" | "right") => Transaction | null;
type BesideIn = (editor: unknown, from: number, count: number, target: number, side: "left" | "right") => boolean;
const { moveBlocksBeside, moveBlocksBesideIn } = (await import(`${CORE_TIPTAP}blockCommands`)) as { moveBlocksBeside: Beside; moveBlocksBesideIn: BesideIn };

const START = "<p>one</p><p>two</p><p>three</p><p>four</p><p>five</p>";

function pair() {
  const a = new Y.Doc();
  Y.applyUpdate(a, contentToYUpdate(START));
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b };
}
/** A ProseMirror "view" over a Y.Doc: every dispatched transaction is written the way the sync plugin writes it. */
function viewOn(doc: Y.Doc) {
  const schema = collabSchema();
  const view = {
    state: EditorState.create({ schema, doc: yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FIELD), schema) }),
    transactions: 0,
    /** What the sync plugin does when a remote update arrives. */
    refresh() { view.state = EditorState.create({ schema, doc: yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FIELD), schema) }); },
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
      view.transactions++;
      doc.transact(() => updateYFragment(doc, doc.getXmlFragment(FIELD), view.state.doc, { mapping: new Map(), isOMark: new Map() }));
    },
  };
  return view;
}
const typeInto = (doc: Y.Doc, index: number, text: string) => {
  const t = (doc.getXmlFragment(FIELD).get(index) as Y.XmlElement).get(0) as Y.XmlText;
  t.insert(t.length, text);
};
const sync = (a: Y.Doc, b: Y.Doc) => {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, ua);
  Y.applyUpdate(a, ub);
};
const EXPECTED = '<p>one</p><div data-type="columns" data-count="2"><div data-type="column"><p>two</p></div><div data-type="column"><p>five</p></div></div><p>three+B3</p><p>four+B4</p>';

test("live: a block dropped beside another leaves concurrent typing in unrelated blocks where it was typed", () => {
  const { a, b } = pair();
  const view = viewOn(a);
  const editor = { state: view.state, view, extensionManager: { extensions: [{ name: "collaboration" }] } };
  Object.defineProperty(editor, "state", { get: () => view.state });
  // B types into "three" and "four" before it has seen A's move.
  typeInto(b, 2, "+B3");
  typeInto(b, 3, "+B4");
  assert.equal(moveBlocksBesideIn(editor as never, 4, 1, 1, "right"), true);
  assert.equal(view.transactions, 2, "delete, then replace the target");
  sync(a, b);
  assert.equal(yDocToHtml(a), yDocToHtml(b), "both clients converge");
  assert.equal(yDocToHtml(a), EXPECTED);
});

test("live: dropping on the LEFT of a later block, and into an existing layout, is equally contained", () => {
  const { a, b } = pair();
  const view = viewOn(a);
  const editor = { view, extensionManager: { extensions: [{ name: "collaboration" }] } } as Record<string, unknown>;
  Object.defineProperty(editor, "state", { get: () => view.state });
  typeInto(b, 1, "+B2");
  typeInto(b, 2, "+B3");
  assert.equal(moveBlocksBesideIn(editor as never, 0, 1, 3, "left"), true); // "one" beside "four"
  sync(a, b);
  assert.equal(yDocToHtml(a), yDocToHtml(b));
  assert.equal(yDocToHtml(a), '<p>two+B2</p><p>three+B3</p><div data-type="columns" data-count="2"><div data-type="column"><p>one</p></div><div data-type="column"><p>four</p></div></div><p>five</p>');
  view.refresh();
  // A second drop adds a column to that layout; typing elsewhere still lands where it was typed.
  typeInto(b, 0, "!");
  assert.equal(moveBlocksBesideIn(editor as never, 3, 1, 2, "right"), true); // "five" into the layout
  sync(a, b);
  assert.equal(yDocToHtml(a), yDocToHtml(b));
  assert.match(yDocToHtml(a), /^<p>two\+B2!<\/p><p>three\+B3<\/p><div data-type="columns" data-count="3">/);
});

test("control: the one-transaction form (kept for the plain editor) is NOT safe in a live document", () => {
  const { a, b } = pair();
  const view = viewOn(a);
  typeInto(b, 2, "+B3");
  typeInto(b, 3, "+B4");
  view.dispatch(moveBlocksBeside(view.state, 4, 1, 1, "right")!);
  sync(a, b);
  assert.notEqual(yDocToHtml(a), EXPECTED, "if this ever equals EXPECTED, y-prosemirror's diff changed and the split may no longer be needed");
});
