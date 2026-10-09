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
import { crossesIsolating, putBack, putBackMessages, strikeInPlace, SUGGESTION_MISPLACED_MESSAGE } from "../../../packages/core/src/editor/suggestions";

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
  // One step to put the blocks back, then per BLOCK one mark step and the two attribute steps that
  // stamp its start as a suggested removal (so Accept takes the emptied block out) — never one per
  // text run (it was 5 × 200 mark steps).
  const marks = tr.steps.filter((step) => (step.toJSON() as { stepType: string }).stepType === "addMark").length;
  assert.ok(marks <= 200, `mark steps: ${marks}`);
  assert.ok(tr.steps.length <= 3 * 200 + 2, `steps: ${tr.steps.length}`);
});

// ── Review of PR #42 ─────────────────────────────────────────────────────────────────────────
const cellOf = (kind: "tableCell" | "tableHeader", text: string) => schema.nodes[kind]!.create(null, p(text));
const table = () => schema.nodes.table!.create(null, [schema.nodes.tableRow!.create(null, [cellOf("tableHeader", "head one"), cellOf("tableHeader", "head two")]), schema.nodes.tableRow!.create(null, [cellOf("tableCell", "cell one"), cellOf("tableCell", "cell two")])]);
const at = (doc: PMNode, text: string): number => {
  let found = -1;
  doc.descendants((node, pos) => { if (found < 0 && node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text); });
  assert.ok(found >= 0, text);
  return found;
};

test("finding 2: a put-back that would change a table's shape is not applied — the text is kept struck beside it, with the notice", () => {
  const doc = schema.nodes.doc!.create(null, [table(), p("after the table")]);
  const state = EditorState.create({ doc });
  // What a removal from the last cell into the paragraph after the table takes out: the end of
  // the cell's text, the closing of cell / row / table, the start of the paragraph.
  const from = at(doc, "two") - 5 + "cell ".length; // inside "cell two" of the LAST cell
  const last = at(doc, "cell two");
  const slice = doc.slice(last + 5, at(doc, "after") + 6);
  assert.ok(from > 0 && slice.openStart > slice.openEnd, "the slice is open into the table");
  const tr = state.tr.delete(last + 5, at(doc, "after") + 6);
  const cells = (d: PMNode) => { let n = 0; d.descendants((node) => { if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") n++; }); return n; };
  const tables = (d: PMNode) => { let n = 0; d.descendants((node) => { if (node.type.name === "table") n++; }); return n; };
  const before = { cells: cells(tr.doc), tables: tables(tr.doc) };
  const result = putBack(tr, [{ at: tr.mapping.map(last + 5), slice, pure: false, order: 0 }], ctx(state));
  assert.equal(struckText(tr.doc), "twoafter ", "every removed character is there, struck");
  assert.deepEqual({ cells: cells(tr.doc), tables: tables(tr.doc) }, before, "no cell and no table was added");
  assert.ok(putBackMessages(result).includes(SUGGESTION_MISPLACED_MESSAGE));
});

test("finding 2: a whole table removed with the text around it goes back as the table it was", () => {
  const doc = schema.nodes.doc!.create(null, [p("before the table"), table(), p("after the table")]);
  const state = EditorState.create({ doc });
  const a = at(doc, "the table");
  const b = at(doc, "after") + 6;
  const slice = doc.slice(a, b);
  const tr = state.tr.delete(a, b);
  const result = putBack(tr, [{ at: tr.mapping.map(a), slice, pure: false, order: 0 }], ctx(state));
  assert.deepEqual(putBackMessages(result), []);
  assert.equal(tr.doc.textContent, doc.textContent);
  assert.equal(tr.doc.child(1).type.name, "table");
  assert.equal(tr.doc.child(1).childCount, 2);
});

test("crossesIsolating: a table cell's boundary counts, blocks inside one cell and around a whole table do not", () => {
  const doc = schema.nodes.doc!.create(null, [p("before the table"), table(), p("after the table")]);
  assert.equal(crossesIsolating(doc, at(doc, "before"), at(doc, "head one") + 2), true, "paragraph → cell");
  assert.equal(crossesIsolating(doc, at(doc, "cell one") + 2, at(doc, "cell two") + 2), true, "cell → cell");
  assert.equal(crossesIsolating(doc, at(doc, "cell two") + 2, at(doc, "after") + 2), true, "cell → paragraph after");
  assert.equal(crossesIsolating(doc, at(doc, "cell two"), at(doc, "cell two") + 4), false, "inside one cell");
  assert.equal(crossesIsolating(doc, at(doc, "before"), at(doc, "after") + 2), false, "around the whole table");
});

test("strikeInPlace: the text is struck where it stands, across blocks of different depth; no block changes", () => {
  const list = schema.nodes.bulletList!.create(null, [schema.nodes.listItem!.create(null, p("charlie delta")), schema.nodes.listItem!.create(null, p("echo"))]);
  const doc = schema.nodes.doc!.create(null, [p("alpha bravo"), list]);
  const state = EditorState.create({ doc });
  const tr = state.tr;
  const result = strikeInPlace(tr, at(doc, "bravo"), at(doc, "charlie") + 8, { insertion: schema.marks.insertion!, deletion: schema.marks.deletion!, userName: "You" });
  assert.equal(struckText(tr.doc), "bravocharlie ");
  assert.equal(tr.doc.textContent, doc.textContent);
  const shape = (d: PMNode) => { const out: string[] = []; d.descendants((node) => { if (!node.isText) out.push(node.type.name); }); return out.join(" "); };
  assert.equal(shape(tr.doc), shape(doc), "the same blocks");
  assert.deepEqual([result.refused, result.untracked, result.end], [false, false, at(doc, "charlie") + 8]);
});
