import { Extension } from "@tiptap/core";
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { COLORABLE_BLOCKS, isBlockColor, type BlockColorValue } from "../../editor/blocks";

/**
 * Pure block operations for the block handle, the block menu, the selection
 * toolbar and the Alt/Option+Shift+↑/↓ keymap. Every operation builds ONE
 * transaction with ONE replace step, so it is a single undo entry and a single
 * update for the live collaborative document.
 */

export type TurnIntoKind =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "callout"
  | "toggle";

export const TURN_INTO: Array<{ kind: TurnIntoKind; label: string }> = [
  { kind: "paragraph", label: "Text" },
  { kind: "heading1", label: "Heading 1" },
  { kind: "heading2", label: "Heading 2" },
  { kind: "heading3", label: "Heading 3" },
  { kind: "bulletList", label: "Bulleted list" },
  { kind: "orderedList", label: "Numbered list" },
  { kind: "taskList", label: "To-do list" },
  { kind: "blockquote", label: "Quote" },
  { kind: "codeBlock", label: "Code" },
  { kind: "callout", label: "Callout" },
  { kind: "toggle", label: "Toggle" },
];

export interface TopBlock {
  /** Position before the block (a valid NodeSelection position). */
  pos: number;
  node: PMNode;
  index: number;
}

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
/** Blocks whose text can be re-shaped by "Turn into". */
const TEXTUAL = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "callout", "toggle"]);

export function topLevelBlocks(doc: PMNode): TopBlock[] {
  const out: TopBlock[] = [];
  doc.forEach((node, offset, index) => out.push({ pos: offset, node, index }));
  return out;
}

export function topBlockAt(doc: PMNode, pos: number): TopBlock | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  const index = $pos.depth === 0 ? Math.min($pos.index(0), doc.childCount - 1) : $pos.index(0);
  if (index < 0 || index >= doc.childCount) return null;
  let offset = 0;
  for (let i = 0; i < index; i++) offset += doc.child(i).nodeSize;
  return { pos: offset, node: doc.child(index), index };
}

export function canColor(node: PMNode): boolean {
  return (COLORABLE_BLOCKS as readonly string[]).includes(node.type.name) && "blockColor" in node.attrs;
}

export function canTurnInto(node: PMNode): boolean {
  return TEXTUAL.has(node.type.name);
}

function placeCaret(tr: Transaction, pos: number): Transaction {
  const target = Math.max(0, Math.min(pos, tr.doc.content.size));
  return tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
}

/** The unit a keyboard move acts on: a list item inside its list, else the top-level block. */
function movableUnit(state: EditorState): { from: number; node: PMNode; parent: PMNode; index: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const parent = $from.node(d - 1);
    if (d - 1 === 0 || LISTS.has(parent.type.name)) {
      return { from: $from.before(d), node: $from.node(d), parent, index: $from.index(d - 1) };
    }
  }
  return null;
}

/** Swap the unit around the selection with its previous/next sibling. Null at the edge. */
export function moveSelectionBlock(state: EditorState, dir: -1 | 1): Transaction | null {
  const unit = movableUnit(state);
  if (!unit) return null;
  const { from, node, parent, index } = unit;
  const siblingIndex = index + dir;
  if (siblingIndex < 0 || siblingIndex >= parent.childCount) return null;
  const sibling = parent.child(siblingIndex);
  const caretOffset = state.selection.from - from;
  const tr = state.tr;
  if (dir === -1) {
    const start = from - sibling.nodeSize;
    tr.replaceWith(start, from + node.nodeSize, Fragment.fromArray([node, sibling]));
    placeCaret(tr, start + caretOffset);
  } else {
    const end = from + node.nodeSize + sibling.nodeSize;
    tr.replaceWith(from, end, Fragment.fromArray([sibling, node]));
    placeCaret(tr, from + sibling.nodeSize + caretOffset);
  }
  return tr.scrollIntoView();
}

/**
 * Move the top-level block at `fromIndex` so it lands before the block that is
 * currently at `toIndex` (toIndex === childCount → the end). One replace step
 * spanning only the blocks that actually change order.
 */
export function moveTopBlock(state: EditorState, fromIndex: number, toIndex: number): Transaction | null {
  const { doc } = state;
  const count = doc.childCount;
  if (fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex > count) return null;
  if (toIndex === fromIndex || toIndex === fromIndex + 1) return null; // no-op
  const blocks = topLevelBlocks(doc);
  const lo = Math.min(fromIndex, toIndex);
  const hi = Math.max(fromIndex, toIndex - 1);
  const start = blocks[lo].pos;
  const end = blocks[hi].pos + blocks[hi].node.nodeSize;
  const moving = blocks[fromIndex].node;
  const rest = blocks.slice(lo, hi + 1).filter((b) => b.index !== fromIndex).map((b) => b.node);
  const ordered = fromIndex < toIndex ? [...rest, moving] : [moving, ...rest];
  const tr = state.tr.replaceWith(start, end, Fragment.fromArray(ordered));
  let landed = start;
  for (const n of ordered) { if (n === moving) break; landed += n.nodeSize; }
  placeCaret(tr, landed + 1);
  return tr.scrollIntoView();
}

export function duplicateTopBlock(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const at = pos + node.nodeSize;
  const tr = state.tr.insert(at, node);
  return placeCaret(tr, at + 1);
}

export function deleteTopBlock(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const tr = state.tr;
  if (state.doc.childCount === 1) tr.replaceWith(pos, pos + node.nodeSize, state.schema.nodes.paragraph.create());
  else tr.delete(pos, pos + node.nodeSize);
  return placeCaret(tr, Math.min(pos + 1, tr.doc.content.size));
}

export function setTopBlockColor(state: EditorState, pos: number, color: BlockColorValue | null): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node || !canColor(node)) return null;
  if (color !== null && !isBlockColor(color)) return null;
  return state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockColor: color });
}

/** Every textblock inside `node`, reshaped as paragraphs (code → plain text). */
function flatten(schema: Schema, node: PMNode): PMNode[] {
  const paragraph = schema.nodes.paragraph;
  const asParagraph = (tb: PMNode): PMNode => {
    if (tb.type.name === "codeBlock") {
      return paragraph.create(null, tb.textContent ? schema.text(tb.textContent) : null);
    }
    // Inline content is shared by paragraph/heading/summary; drop anything invalid.
    const inline: PMNode[] = [];
    tb.content.forEach((child) => { if (paragraph.contentMatch.matchType(child.type)) inline.push(child); });
    return paragraph.create(null, inline);
  };
  if (node.isTextblock) return [asParagraph(node)];
  const out: PMNode[] = [];
  node.descendants((child) => {
    if (child.isTextblock) { out.push(asParagraph(child)); return false; }
    return true;
  });
  // Empty filler lines (e.g. a toggle's empty body) don't survive a re-shape.
  const filled = out.filter((p) => p.content.size > 0);
  return filled.length ? filled : [paragraph.create()];
}

function build(schema: Schema, kind: TurnIntoKind, paras: PMNode[], color: BlockColorValue | null): PMNode[] {
  const n = schema.nodes;
  const colored = (attrs: Record<string, unknown> = {}) => (color ? { ...attrs, blockColor: color } : attrs);
  switch (kind) {
    case "paragraph":
      return paras.map((p) => n.paragraph.create(colored(), p.content));
    case "heading1":
    case "heading2":
    case "heading3": {
      const level = Number(kind.slice(-1));
      return paras.map((p) => n.heading.create(colored({ level }), p.content));
    }
    case "codeBlock": {
      const text = paras.map((p) => p.textContent).join("\n");
      return [n.codeBlock.create(null, text ? schema.text(text) : null)];
    }
    case "bulletList":
      return [n.bulletList.create(colored(), paras.map((p) => n.listItem.create(null, p)))];
    case "orderedList":
      return [n.orderedList.create(colored(), paras.map((p) => n.listItem.create(null, p)))];
    case "taskList":
      return [n.taskList.create(colored(), paras.map((p) => n.taskItem.create({ checked: false }, p)))];
    case "blockquote":
      return [n.blockquote.create(colored(), paras)];
    case "callout":
      return [n.callout.create(colored(), paras)];
    case "toggle": {
      const [first, ...rest] = paras;
      return [n.toggle.create(colored({ open: true }), [n.toggleSummary.create(null, first.content), ...(rest.length ? rest : [n.paragraph.create()])])];
    }
  }
}

/**
 * Re-shape the top-level blocks in [from, to] (one block when from === to) into
 * `kind`, keeping every line of text and the first block's colour.
 */
export function turnTopBlocksInto(state: EditorState, from: number, to: number, kind: TurnIntoKind): Transaction | null {
  const { doc, schema } = state;
  const first = topBlockAt(doc, from);
  const last = topBlockAt(doc, Math.max(from, to));
  if (!first || !last) return null;
  const blocks = topLevelBlocks(doc).slice(first.index, last.index + 1);
  if (!blocks.every((b) => canTurnInto(b.node))) return null;
  const typeFor: Record<TurnIntoKind, string> = {
    paragraph: "paragraph", heading1: "heading", heading2: "heading", heading3: "heading", bulletList: "bulletList",
    orderedList: "orderedList", taskList: "taskList", blockquote: "blockquote", codeBlock: "codeBlock", callout: "callout", toggle: "toggle",
  };
  if (!schema.nodes[typeFor[kind]]) return null;
  const paras = blocks.flatMap((b) => flatten(schema, b.node));
  const color = isBlockColor(first.node.attrs.blockColor) ? first.node.attrs.blockColor : null;
  const replacement = build(schema, kind, paras, kind === "codeBlock" ? null : color);
  const start = first.pos;
  const end = last.pos + last.node.nodeSize;
  const tr = state.tr.replaceWith(start, end, Fragment.fromArray(replacement));
  // Keep the caret in the (first) re-shaped block.
  return placeCaret(tr, start + (kind === "paragraph" || kind.startsWith("heading") || kind === "codeBlock" ? 1 : 2));
}

/** The kind a top-level block currently is, for the menu's checkmark. */
export function blockKind(node: PMNode): TurnIntoKind | null {
  switch (node.type.name) {
    case "paragraph": return "paragraph";
    case "heading": return (`heading${node.attrs.level}` as TurnIntoKind);
    case "bulletList": case "orderedList": case "taskList": case "blockquote": case "codeBlock": case "callout": case "toggle":
      return node.type.name as TurnIntoKind;
    default: return null;
  }
}

/** Structural edits are raw edits: off while tracked suggestions or comment-only are active. */
export function structuralEditsAllowed(editor: { isEditable: boolean; storage: unknown }): boolean {
  const storage = editor.storage as Record<string, { suggesting?: boolean; active?: boolean } | undefined>;
  return editor.isEditable && !storage.suggestionMode?.suggesting && !storage.commentOnly?.active;
}

/** Alt/Option+Shift+↑/↓ moves the current block (or list item). */
export const BlockKeymap = Extension.create({
  name: "blockKeymap",
  addKeyboardShortcuts() {
    const move = (dir: -1 | 1) => () => {
      if (!structuralEditsAllowed(this.editor)) return false;
      const tr = moveSelectionBlock(this.editor.state, dir);
      if (!tr) return true; // at the edge: swallow so the selection does not jump
      this.editor.view.dispatch(tr);
      return true;
    };
    return {
      "Alt-Shift-ArrowUp": move(-1),
      "Alt-Shift-ArrowDown": move(1),
    };
  },
});
