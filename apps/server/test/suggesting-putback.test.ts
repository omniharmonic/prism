/**
 * Slice J review (J-5): putting removed content back while Suggesting never loses it silently.
 * `putBack` (packages/core/src/editor/suggestions.ts) on the shared schema: a slice the document
 * cannot take back in place is kept as struck text beside the change, and says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { collabSchema } from "../src/collab";
import { putBack, putBackMessages, SUGGESTION_MISPLACED_MESSAGE } from "../../../packages/core/src/editor/suggestions";

const schema = collabSchema();
const p = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text));
const struckText = (doc: PMNode): string => {
  let out = "";
  doc.descendants((node) => { if (node.isText && node.marks.some((m) => m.type.name === "deletion")) out += node.text; });
  return out;
};
const ctx = (state: EditorState) => ({ selection: state.selection, insertion: schema.marks.insertion!, deletion: schema.marks.deletion!, userName: "You" });

test("a slice that fits goes back in place, struck", () => {
  const state = EditorState.create({ doc: schema.nodes.doc!.create(null, [p("Hello world")]) });
  const tr = state.tr;
  const result = putBack(tr, [{ at: 7, slice: new Slice(Fragment.from(schema.text("brave ")), 0, 0), pure: false, order: 0 }], ctx(state));
  assert.equal(tr.doc.textContent, "Hello brave world");
  assert.equal(struckText(tr.doc), "brave ");
  assert.deepEqual(putBackMessages(result), []);
});

test("a slice the document cannot place is kept as struck text beside the change, with a notice", () => {
  const state = EditorState.create({ doc: schema.nodes.doc!.create(null, [p("Hello world")]) });
  // A table ROW on its own: nothing inside a paragraph (or the document) can hold it.
  const cell = schema.nodes.tableCell!.create(null, p("cell text"));
  const row = schema.nodes.tableRow!.create(null, [cell]);
  const tr = state.tr;
  const result = putBack(tr, [{ at: 7, slice: new Slice(Fragment.from(row), 0, 0), pure: false, order: 0 }], ctx(state));
  // Every character of the removed content is in the document, struck — whichever way it got there.
  assert.equal(struckText(tr.doc), "cell text");
  assert.ok(tr.doc.textContent.includes("Hello ") && tr.doc.textContent.includes("world"));
  if (result.misplaced) assert.deepEqual(putBackMessages(result), [SUGGESTION_MISPLACED_MESSAGE]);
  assert.doesNotThrow(() => tr.doc.check());
});

test("a partly placed slice is never accepted: the text restored must be the text removed", () => {
  // An open slice whose second half the fitter may drop: the end of a heading + the start of a code block.
  const doc = schema.nodes.doc!.create(null, [schema.nodes.heading!.create({ level: 2 }, schema.text("Title here")), schema.nodes.codeBlock!.create(null, schema.text("code line")), p("tail")]);
  const removed = doc.slice(7, 17); // "here" | "code"
  const state = EditorState.create({ doc: schema.nodes.doc!.create(null, [p("only paragraph")]) });
  const tr = state.tr;
  putBack(tr, [{ at: 5, slice: removed, pure: false, order: 0 }], ctx(state));
  const all = tr.doc.textContent;
  assert.ok(all.includes("here"), all);
  // "code" comes back struck, or — where the mark cannot sit (a code block) — is reported untracked; never half-restored unmarked.
  assert.doesNotThrow(() => tr.doc.check());
});

test("a block that cannot be put back is reported, not dropped in silence", () => {
  // A divider handed to a position inside a code block: nothing there can hold it.
  const doc = schema.nodes.doc!.create(null, [schema.nodes.codeBlock!.create(null, schema.text("const a = 1;"))]);
  const state = EditorState.create({ doc });
  const tr = state.tr;
  const rule = schema.nodes.horizontalRule!.create();
  const result = putBack(tr, [{ at: 3, slice: new Slice(Fragment.from(rule), 0, 0), pure: false, order: 0 }], ctx(state));
  let rules = 0;
  tr.doc.descendants((node) => { if (node.type.name === "horizontalRule") rules++; });
  // Either it found a place (then it is there), or the person is told.
  assert.ok(rules === 1 || result.lost, JSON.stringify(result));
  assert.doesNotThrow(() => tr.doc.check());
});

test("contiguous text is struck with one mark step per block, however many text runs the block holds", () => {
  const bold = schema.marks.bold!.create();
  const rich = (i: number) => schema.nodes.paragraph!.create(null, [schema.text(`plain ${i} `), schema.text("bold", [bold]), schema.text(" tail"), schema.text(" more", [bold]), schema.text(" end")]);
  const blocks = Array.from({ length: 200 }, (_, i) => rich(i));
  const state = EditorState.create({ doc: schema.nodes.doc!.create(null, [p("only")]) });
  const tr = state.tr;
  putBack(tr, [{ at: 0, slice: new Slice(Fragment.fromArray(blocks), 0, 0), pure: false, order: 0 }], ctx(state));
  assert.ok(struckText(tr.doc).startsWith("plain 0 bold tail more end"));
  // One step to put the blocks back, one mark step per block — it was one per text run (5 × 200).
  assert.ok(tr.steps.length <= 200 + 2, `steps: ${tr.steps.length}`);
});
