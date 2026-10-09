import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

/**
 * Suggested STRUCTURE (isomorphic — no DOM): a paragraph break or a line break that was put in,
 * or is to be taken out, while Suggesting.
 *
 * Suggestion MARKS go on text only (the sync layer carries marks on text and nowhere else), so a
 * break — which holds no text — is recorded as two ATTRIBUTES on the node itself; node attributes
 * do travel through Yjs and through the stored HTML:
 *
 *   suggestion    "insert" | "delete" | null
 *   suggestionBy  the person's name (the same name the insertion / deletion marks carry)
 *
 * On a TEXT BLOCK (paragraph, heading, code block, toggle summary) the attribute speaks about
 * the block's START — the paragraph break in front of it:
 *   insert  the break was suggested (Enter, a pasted paragraph, a new block): Accept keeps the
 *           block, Reject takes its start out again (the block joins the one before; a block
 *           with nothing left in it is removed, together with a list / table / callout that
 *           holds nothing else; a suggested CODE block goes with its text, which can carry
 *           no mark of its own);
 *   delete  the break is suggested for removal (Backspace at the start of a block): Accept
 *           joins the block to the one before, Reject keeps it.
 * On a LINE BREAK (`hardBreak`) it speaks about the break itself: Accept of an insert / Reject
 * of a delete keeps it, the other two remove it.
 *
 * Both the live editor (./suggestions) and the server's review (accept / reject of a stored
 * page) resolve them with `resolveNodeSuggestions` below — one implementation.
 */
export type NodeSuggestionKind = "insert" | "delete";

/** The text blocks of the shared schema — every node type whose content is inline. */
export const SUGGESTION_TEXTBLOCKS = ["paragraph", "heading", "codeBlock", "toggleSummary"] as const;
/** Every node type that carries the two attributes. */
export const SUGGESTION_NODE_TYPES = [...SUGGESTION_TEXTBLOCKS, "hardBreak"] as const;

const kindOf = (value: unknown): NodeSuggestionKind | null => (value === "insert" || value === "delete" ? value : null);
type Source = { getAttribute(name: string): string | null };

export const SuggestionNodeAttributes = Extension.create({
  name: "suggestionNodes",
  addGlobalAttributes() {
    return [{
      types: [...SUGGESTION_NODE_TYPES],
      attributes: {
        suggestion: {
          default: null,
          // A block made by splitting this one is stamped on its own account (or not at all).
          keepOnSplit: false,
          parseHTML: (el: Source) => kindOf(el.getAttribute("data-suggestion-node")),
          renderHTML: (attrs: Record<string, unknown>) => (kindOf(attrs.suggestion) ? { "data-suggestion-node": attrs.suggestion } : {}),
        },
        suggestionBy: {
          default: null,
          keepOnSplit: false,
          parseHTML: (el: Source) => (kindOf(el.getAttribute("data-suggestion-node")) ? el.getAttribute("data-suggestion-by") ?? "" : null),
          renderHTML: (attrs: Record<string, unknown>) => (kindOf(attrs.suggestion) ? { "data-suggestion-by": String(attrs.suggestionBy ?? "") } : {}),
        },
      },
    }];
  },
});

export interface NodeSuggestion { pos: number; node: PMNode; kind: NodeSuggestionKind; by: string }

/** The suggestion a node carries, or null. */
export function nodeSuggestionOf(node: PMNode): { kind: NodeSuggestionKind; by: string } | null {
  const kind = node.isText ? null : kindOf(node.attrs.suggestion);
  return kind ? { kind, by: String(node.attrs.suggestionBy ?? "") } : null;
}

/** Every suggested break in the document, in document order (`author` null = everybody's). */
export function nodeSuggestions(doc: PMNode, author: string | null = null): NodeSuggestion[] {
  const out: NodeSuggestion[] = [];
  doc.descendants((node, pos) => {
    const s = nodeSuggestionOf(node);
    if (s && (author === null || s.by === author)) out.push({ pos, node, ...s });
    return !node.isTextblock || node.childCount > 0;
  });
  return out;
}

/** Stamp (or, with `kind` null, clear) the suggestion on the node at `pos`. Positions do not move. */
export function setNodeSuggestion(tr: Transform, pos: number, kind: NodeSuggestionKind | null, by: string | null = null): void {
  const node = tr.doc.nodeAt(pos);
  if (!node || node.isText || !("suggestion" in node.attrs)) return;
  if (node.attrs.suggestion !== kind) tr.setNodeAttribute(pos, "suggestion", kind);
  const who = kind ? by ?? "" : null;
  if (node.attrs.suggestionBy !== who) tr.setNodeAttribute(pos, "suggestionBy", who);
}

/** Where the nearest ISOLATING ancestor of a position starts (a table cell, a column…), or -1. */
function isolatedAt(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.spec.isolating) return $pos.before(d);
  return -1;
}

/**
 * The text block the block at `pos` would join when its start is taken out: the nearest text
 * block before it, provided nothing stands between the two (an image, a divider…) and they are
 * in the same table cell / column. Null when there is none.
 */
export function joinTarget(doc: PMNode, pos: number): { pos: number; node: PMNode; end: number } | null {
  let found: { pos: number; node: PMNode } | null = null;
  doc.nodesBetween(0, pos, (node, at) => {
    if (!node.isTextblock) return true;
    if (at + node.nodeSize <= pos) found = { pos: at, node };
    return false;
  });
  const prev = found as { pos: number; node: PMNode } | null;
  if (!prev) return null;
  const end = prev.pos + prev.node.nodeSize - 1;
  let barrier = false;
  doc.slice(end, pos + 1).content.descendants((node) => { if (node.isLeaf) barrier = true; return !barrier; });
  if (barrier || isolatedAt(doc, end) !== isolatedAt(doc, pos + 1)) return null;
  return { ...prev, end };
}

/** A part of the page that holds nothing but empty text blocks which `going` says are on their way out. */
function holdsNothing(node: PMNode, going: (block: PMNode) => boolean): boolean {
  if (node.isTextblock) return node.content.size === 0 && going(node);
  if (node.isLeaf) return false;
  let empty = true;
  node.descendants((child) => {
    if (!empty) return false;
    if (child.isTextblock) { if (child.content.size > 0 || !going(child)) empty = false; return false; }
    if (child.isLeaf) empty = false;
    return empty;
  });
  return empty;
}

/** How many leaves that are not text a document holds (an image, a chip, a line break…). */
function leafCount(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => { if (node.isLeaf && !node.isText) n++; });
  return n;
}

/**
 * Take the START of the text block at `pos` out of the document — the opposite of the split
 * that made it. `going` names the other blocks the same action removes (so a list, a table or a
 * callout that holds nothing else goes with them). Returns false when nothing could be done
 * (the caller then only clears the attribute).
 *  - a block with nothing in it is removed — with the largest part of the page around it that
 *    holds nothing else (never a single table cell or row: that would leave a ragged table);
 *  - a block with content joins the text block before it; when that one is EMPTY it is the one
 *    removed instead (the block with the content keeps its kind — a heading stays a heading);
 *  - never across an image / divider, nor out of a table cell or a column; never at the cost
 *    of a character or a leaf (tried on a copy first).
 */
export function removeBlockStart(tr: Transform, pos: number, going: (block: PMNode) => boolean = () => false): boolean {
  const doc = tr.doc;
  const node = doc.nodeAt(pos);
  if (!node || !node.isTextblock) return false;
  const $in = doc.resolve(pos + 1);
  if (node.content.size === 0) {
    let best: [number, number] | null = null;
    for (let d = $in.depth; d >= 1; d--) {
      const at = $in.node(d);
      if (d < $in.depth && !holdsNothing(at, (block) => block === node || going(block))) break;
      const role = at.type.spec.tableRole as string | undefined;
      if (role === "row" || role === "cell" || role === "header_cell") continue;
      const index = $in.index(d - 1);
      if ($in.node(d - 1).canReplace(index, index + 1)) best = [$in.before(d), $in.after(d)];
    }
    if (best) { tr.delete(best[0], best[1]); return true; }
  }
  const prev = joinTarget(doc, pos);
  if (!prev) return false;
  const probe = new Transform(doc);
  try {
    const $prev = doc.resolve(prev.pos);
    if (prev.node.content.size === 0 && node.content.size > 0 && $prev.parent.canReplace($prev.index(), $prev.index() + 1)) {
      // The block that stays stands where the empty one stood: it takes over THAT block's own
      // suggestion (none, usually — or a pending one, which is then resolved in its turn).
      const kept = nodeSuggestionOf(prev.node);
      probe.delete(prev.pos, prev.pos + prev.node.nodeSize);
      setNodeSuggestion(probe, probe.mapping.map(pos), kept?.kind ?? null, kept?.by ?? null);
    } else probe.delete(prev.end, pos + 1);
  } catch { return false; }
  if (!probe.steps.length || probe.doc.textContent !== doc.textContent || leafCount(probe.doc) !== leafCount(doc)) return false;
  for (const step of probe.steps) tr.step(step);
  return true;
}

/** Resolve the ONE suggested break at `pos` (see the file header for what each case does). */
export function resolveNodeSuggestion(tr: Transform, pos: number, action: "accept" | "reject", author: string | null = null): boolean {
  const node = tr.doc.nodeAt(pos);
  const s = node && nodeSuggestionOf(node);
  if (!node || !s) return false;
  const remove = (s.kind === "insert") === (action === "reject");
  if (remove) {
    if (!node.isTextblock) { tr.delete(pos, pos + node.nodeSize); return true; }
    // A suggested CODE block: its text can carry no insertion mark, so the block is the whole
    // record — rejecting it takes its text with it. (The editor only lets a block become code
    // while it holds nothing that was there before.)
    if (s.kind === "insert" && node.type.spec.code && node.content.size) tr.delete(pos + 1, pos + 1 + node.content.size);
    const going = (block: PMNode) => { const o = nodeSuggestionOf(block); return !!o && o.kind === s.kind && (author === null ? o.by === s.by : o.by === author); };
    const before = tr.steps.length;
    try { if (removeBlockStart(tr, pos, going)) return true; } catch { /* the block stays: its attribute is cleared below */ }
    if (tr.steps.length !== before) return true;
  }
  setNodeSuggestion(tr, pos, null);
  return true;
}

/**
 * Accept / reject every suggested break of `author` (null = everybody's). Call it AFTER the
 * suggestion marks are resolved: inserted text must be gone before its block can be seen to be
 * empty. Last one first, so a block joins a block that is itself still to be resolved.
 */
export function resolveNodeSuggestions(tr: Transform, author: string | null, action: "accept" | "reject"): boolean {
  let any = false;
  for (let guard = 0; guard < 100_000; guard++) {
    const all = nodeSuggestions(tr.doc, author);
    const last = all[all.length - 1];
    if (!last) break;
    const steps = tr.steps.length;
    resolveNodeSuggestion(tr, last.pos, action, author);
    if (tr.steps.length === steps) break; // nothing moved: never loop on it
    any = true;
  }
  return any;
}

/** The same on a document: the resolved document (the one given, when it holds no suggested break). */
export function resolveNodeSuggestionsInDoc(doc: PMNode, author: string | null, action: "accept" | "reject"): PMNode {
  const tr = new Transform(doc);
  resolveNodeSuggestions(tr, author, action);
  return tr.doc;
}
