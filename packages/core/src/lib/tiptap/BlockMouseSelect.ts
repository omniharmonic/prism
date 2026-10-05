import { Extension, type Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { blockSelectionKey, blockSelectionRange, type BlockRange } from "./EditorKeys";
import { freshCopy, isCollaborative, selectionStart, structuralEditsAllowed, topBlockAt, topLevelBlocks } from "./blockCommands";

/**
 * Block selection with the mouse (NP-ED-26). View-only: no schema, never synced.
 *
 * It WRITES the keyboard block selection (`blockSelectionKey`, EditorKeys) — same
 * highlight, same ⌘D / Delete / ⌘⇧↑↓ / handle drag / block menu / copy — and adds:
 *
 *  - Marquee: a drag that starts in the page margin (left / right gutter, the
 *    editor's own padding, the empty area below the last block) draws a rectangle
 *    and selects every TOP-LEVEL block it crosses; the scroller follows at its edges.
 *  - A text drag that leaves its block becomes a selection of the blocks spanned
 *    (and a text selection again when it comes back).
 *  - Shift+click extends the block selection to the clicked block; ⌘⇧click (Ctrl
 *    elsewhere), or ⌘-click on a block's handle, adds or removes one block.
 *  - ⌘A: the block's text → the block → every block.
 *  - Esc (or a click on empty space) clears.
 *
 * NON-CONTIGUOUS sets. `blockSelectionKey` holds ONE run (anchor…head). The runs a
 * ⌘⇧click adds live here (`blockSetKey`: the selected indices OUTSIDE that run).
 * What acts on the whole set: the highlight, copy / cut, Delete / Backspace, ⌘D,
 * typing over the selection. What acts on the primary run only (the run last
 * clicked): ⌘⇧↑↓, dragging by the handle, the block menu, Enter and the arrow keys.
 *
 * Touch: nothing here listens to touch events; a mouse event that follows a touch
 * or pen contact is ignored, so scrolling in the margin is the browser's.
 */

export const blockSetKey = new PluginKey<number[]>("blockMouseSelect");
const NONE: number[] = [];

/** Every selected top-level block index, ascending (the primary run plus the added blocks). */
export function selectedBlockIndices(state: EditorState): number[] {
  const range = blockSelectionRange(state);
  if (!range) return NONE;
  const out = new Set<number>(blockSetKey.getState(state) ?? NONE);
  for (let i = range.from; i <= range.to; i++) out.add(i);
  const max = state.doc.childCount;
  return [...out].filter((i) => i >= 0 && i < max).sort((a, b) => a - b);
}

/** Ascending indices → inclusive runs. */
export function blockRuns(indices: number[]): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && i === last.to + 1) last.to = i;
    else runs.push({ from: i, to: i });
  }
  return runs;
}

function blockPos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/** Select run `anchor`…`head` (plus `extra` blocks outside it) on `tr`. */
function selectionTr(tr: Transaction, anchor: number, head: number, extra: number[] = NONE): Transaction {
  const max = tr.doc.childCount - 1;
  const a = Math.max(0, Math.min(anchor, max));
  const h = Math.max(0, Math.min(head, max));
  const lo = Math.min(a, h);
  const hi = Math.max(a, h);
  const from = blockPos(tr.doc, lo);
  const last = tr.doc.child(hi);
  const to = blockPos(tr.doc, hi) + last.nodeSize;
  if (a === h && NodeSelection.isSelectable(last)) tr.setSelection(NodeSelection.create(tr.doc, from));
  else tr.setSelection(TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(to)));
  const range: BlockRange = { anchor: a, head: h };
  return tr.setMeta(blockSelectionKey, range).setMeta(blockSetKey, extra.filter((i) => i >= 0 && i <= max && (i < lo || i > hi)));
}

function clearTr(tr: Transaction): Transaction {
  return tr.setMeta(blockSelectionKey, null).setMeta(blockSetKey, NONE);
}

/** Select exactly `indices`; the run holding `primary` (else the last run) becomes the keyboard run. */
function setTr(tr: Transaction, indices: number[], primary?: number): Transaction {
  const runs = blockRuns(indices);
  if (!runs.length) return clearTr(tr);
  const run = runs.find((r) => primary !== undefined && primary >= r.from && primary <= r.to) ?? runs[runs.length - 1];
  return selectionTr(tr, run.from, run.to, indices);
}

// ── Remote edits ─────────────────────────────────────────────────────────────
// y-prosemirror applies a collaborator's change as ONE step replacing the whole
// document, so step mapping says nothing. It does reuse the node OBJECT of every
// block the change did not touch: align old and new blocks by identity, and read a
// stretch between two untouched blocks as "edited in place" when it kept its length.
export function alignBlocks(before: PMNode, after: PMNode): (index: number) => number | null {
  const a: PMNode[] = [];
  const b: PMNode[] = [];
  before.forEach((n) => a.push(n));
  after.forEach((n) => b.push(n));
  const map = new Array<number | null>(a.length).fill(null);
  const where = new Map<PMNode, number[]>();
  b.forEach((n, i) => { const at = where.get(n); if (at) at.push(i); else where.set(n, [i]); });
  let cursor = 0;
  let gapA = 0; // first unmatched old index since the last match
  const closeGap = (endA: number, endB: number) => {
    if (endA - gapA === endB - cursor) for (let k = 0; k < endA - gapA; k++) map[gapA + k] = cursor + k;
  };
  for (let i = 0; i < a.length; i++) {
    const j = where.get(a[i])?.find((x) => x >= cursor);
    if (j === undefined) continue;
    closeGap(i, j);
    map[i] = j;
    cursor = j + 1;
    gapA = i + 1;
  }
  closeGap(a.length, b.length);
  return (index) => map[index] ?? null;
}

function isRemote(tr: Transaction): boolean {
  const meta = tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined;
  return !!meta?.isChangeOrigin;
}

// ── Geometry ─────────────────────────────────────────────────────────────────
function blockElement(view: EditorView, pos: number): HTMLElement | null {
  try {
    const dom = view.nodeDOM(pos);
    return dom instanceof HTMLElement ? dom : null;
  } catch { return null; }
}

interface Boxes { count: number; rect(i: number): DOMRect | null }
function boxes(view: EditorView): Boxes {
  const blocks = topLevelBlocks(view.state.doc);
  const cache = new Map<number, DOMRect | null>();
  return {
    count: blocks.length,
    rect(i) {
      if (!cache.has(i)) cache.set(i, blockElement(view, blocks[i].pos)?.getBoundingClientRect() ?? null);
      return cache.get(i) ?? null;
    },
  };
}

/** First block whose bottom edge is at or below `y` (blocks are one vertical stack). */
function firstAtOrBelow(b: Boxes, y: number): number {
  let lo = 0;
  let hi = b.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = b.rect(mid);
    if (r && r.bottom < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The block at height `y`; with `nearest`, the closest one when `y` is in a gap or past either end. */
function indexAtY(view: EditorView, y: number, nearest: boolean): number | null {
  const b = boxes(view);
  if (!b.count) return null;
  const i = firstAtOrBelow(b, y);
  if (i >= b.count) return nearest ? b.count - 1 : null;
  const r = b.rect(i);
  if (r && y >= r.top) return i;
  if (!nearest) return null;
  const prev = i > 0 ? b.rect(i - 1) : null;
  return prev && r && y - prev.bottom < r.top - y ? i - 1 : i;
}

function contentBox(dom: HTMLElement): { left: number; right: number } {
  const r = dom.getBoundingClientRect();
  const style = getComputedStyle(dom);
  return { left: r.left + (parseFloat(style.paddingLeft) || 0), right: r.right - (parseFloat(style.paddingRight) || 0) };
}

/** Blocks crossed by a client rectangle: [first, last], or null. */
function blocksInRect(view: EditorView, top: number, bottom: number, left: number, right: number): [number, number] | null {
  const column = contentBox(view.dom);
  if (right < column.left || left > column.right) return null;
  const b = boxes(view);
  let first = -1;
  let last = -1;
  for (let i = firstAtOrBelow(b, top); i < b.count; i++) {
    const r = b.rect(i);
    if (!r) continue;
    if (r.top > bottom) break;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : [first, last];
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const overflow = getComputedStyle(n).overflowY;
    if (overflow === "auto" || overflow === "scroll") return n;
  }
  return null;
}

/** Of the editors inside `root`, the one closest to the point (two editors can share a margin). */
function nearestEditor(root: Element, x: number, y: number): Element | null {
  let best: Element | null = null;
  let bestDistance = Infinity;
  for (const el of Array.from(root.querySelectorAll(".ProseMirror"))) {
    if (el.parentElement?.closest(".ProseMirror")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) { bestDistance = d; best = el; }
  }
  return best;
}

// ── Announcements ────────────────────────────────────────────────────────────
let liveRegion: HTMLElement | null = null;
function announce(text: string): void {
  if (typeof document === "undefined") return;
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = document.createElement("div");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("data-block-selection-live", "");
    liveRegion.style.cssText = "position:fixed;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0";
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = text;
}

// The last pointer that went down anywhere: a mouse event that follows a touch or a
// pen contact is a compatibility event and never starts a selection here.
let lastPointer = "mouse";
let pointerWatch = 0;
const watchPointer = (event: PointerEvent) => { lastPointer = event.pointerType || "mouse"; };
/** The view whose blocks the mouse selected last: it answers a copy that reaches no editor. */
let lastOwner: EditorView | null = null;

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const toggleKey = (event: MouseEvent) => (MAC ? event.metaKey : event.ctrlKey);
const DRAG_START = 5; // px before a press in the margin is a marquee, not a click
const EDGE = 40; // px from the scroller's edge where it starts to follow
const NO_TEXT_DRAG = "[contenteditable='false'], button, input, textarea, select, a[href], [role='separator'], [draggable='true'], summary";

interface Marquee {
  kind: "marquee";
  x0: number; y0: number; sx: number; sy: number; x: number; y: number;
  scroller: HTMLElement | null;
  inDom: boolean;
  started: boolean;
  box: HTMLElement | null;
  key: string;
}
interface TextDrag {
  kind: "text";
  start: number;
  startPos: number | null;
  x: number; y: number;
  managed: boolean;
  key: string;
}

// ── Set actions (the set-aware halves of Delete, ⌘D and typing) ──────────────
function removeBlocks(editor: Editor, indices: number[], text?: string): void {
  const view = editor.view;
  const schema = view.state.schema;
  const paragraph = (t?: string) => schema.nodes.paragraph.create(null, t ? schema.text(t) : undefined);
  const caret = (tr: Transaction, pos: number) => tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size))), 1));
  const first = blockPos(view.state.doc, indices[0]);
  if (indices.length >= view.state.doc.childCount) {
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, paragraph(text));
    view.dispatch(caret(tr, 1 + (text?.length ?? 0)).scrollIntoView());
    return;
  }
  const runs = blockRuns(indices).reverse();
  const cut = (tr: Transaction, run: { from: number; to: number }) => {
    const from = blockPos(tr.doc, run.from);
    return tr.delete(from, blockPos(tr.doc, run.to) + tr.doc.child(run.to).nodeSize);
  };
  const finish = (tr: Transaction) => {
    if (text !== undefined) { tr.insert(first, paragraph(text)); return caret(tr, first + 1 + text.length); }
    return caret(tr, first + 1);
  };
  if (!isCollaborative(editor)) {
    const tr = view.state.tr;
    for (const run of runs) cut(tr, run);
    view.dispatch(finish(tr).scrollIntoView());
    return;
  }
  // Live document: one transaction per run (bottom first). Several separate deletions in ONE
  // transaction reach y-prosemirror as "every block in between was rewritten" (see blockCommands).
  runs.forEach((run, i) => {
    const tr = cut(view.state.tr, run);
    view.dispatch(i === runs.length - 1 ? finish(tr).scrollIntoView() : tr);
  });
}

function duplicateBlocks(editor: Editor, indices: number[]): void {
  const view = editor.view;
  const runs = blockRuns(indices);
  const copy = (tr: Transaction, run: { from: number; to: number }) => {
    const nodes: PMNode[] = [];
    for (let i = run.from; i <= run.to; i++) nodes.push(freshCopy(tr.doc.child(i)));
    return tr.insert(blockPos(tr.doc, run.to) + tr.doc.child(run.to).nodeSize, Fragment.fromArray(nodes));
  };
  const copies: number[] = [];
  let shift = 0;
  for (const run of runs) {
    const count = run.to - run.from + 1;
    for (let i = 0; i < count; i++) copies.push(run.to + 1 + shift + i);
    shift += count;
  }
  const bottomUp = [...runs].reverse();
  if (!isCollaborative(editor)) {
    const tr = view.state.tr;
    for (const run of bottomUp) copy(tr, run);
    view.dispatch(setTr(tr, copies).scrollIntoView());
    return;
  }
  for (const run of bottomUp) view.dispatch(copy(view.state.tr, run));
  view.dispatch(setTr(view.state.tr, copies).scrollIntoView());
}

function focusedInside(view: EditorView): boolean {
  return typeof document !== "undefined" && document.activeElement === view.dom;
}

export const BlockMouseSelect = Extension.create({
  name: "blockMouseSelect",
  // Above EditorKeys (1100): ⌘A, and the set-aware Delete / ⌘D / Esc, are seen here first.
  priority: 1150,

  addKeyboardShortcuts() {
    const editor = this.editor;
    const extras = () => (blockSetKey.getState(editor.state) ?? NONE).length > 0;
    const remove = () => {
      if (!extras() || !structuralEditsAllowed(editor)) return false;
      removeBlocks(editor, selectedBlockIndices(editor.state));
      return true;
    };
    return {
      // ⌘A: the block's text → the block → every block. A field inside a block keeps its own ⌘A.
      "Mod-a": () => {
        const { state, view } = editor;
        if (!focusedInside(view)) return false;
        const total = state.doc.childCount;
        const range = blockSelectionRange(state);
        if (range) {
          if (range.count < total || extras()) view.dispatch(selectionTr(state.tr, 0, total - 1));
          return true;
        }
        const { selection, doc } = state;
        const { $from, $to } = selection;
        if (selection instanceof TextSelection && $from.sameParent($to) && $from.parent.isTextblock) {
          const start = $from.start();
          const end = $from.end();
          if (end > start && (selection.from > start || selection.to < end)) {
            view.dispatch(state.tr.setSelection(TextSelection.create(doc, start, end)));
            return true;
          }
        }
        const first = topBlockAt(doc, selectionStart(doc, selection.from, selection.to));
        const last = topBlockAt(doc, Math.max(selection.from, selection.to - (selection.empty ? 0 : 1)));
        if (!first || !last) return false;
        view.dispatch(selectionTr(state.tr, first.index, last.index));
        return true;
      },
      // Esc with blocks selected: back to a caret (Esc without a selection still selects — EditorKeys).
      Escape: () => {
        const { state, view } = editor;
        const range = blockSelectionKey.getState(state);
        if (!range) return false;
        const pos = blockPos(state.doc, Math.min(range.head, state.doc.childCount - 1));
        view.dispatch(clearTr(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1), 1))));
        return true;
      },
      Backspace: remove,
      Delete: remove,
      "Mod-d": () => {
        if (!extras() || !structuralEditsAllowed(editor)) return false;
        duplicateBlocks(editor, selectedBlockIndices(editor.state));
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    let guard = false; // a drag (or a DOM re-sync) owns the selection: the browser's own changes are refused
    let drag: Marquee | TextDrag | null = null;
    let onEditorDown: (view: EditorView, event: MouseEvent) => boolean = () => false;

    return [
      new Plugin<number[]>({
        key: blockSetKey,
        state: {
          init: () => NONE,
          apply(tr, prev) {
            const mine = tr.getMeta(blockSetKey) as number[] | undefined;
            if (mine !== undefined) return mine.length ? mine : NONE;
            if (tr.getMeta(blockSelectionKey) !== undefined) return NONE; // a new run (arrow keys, Esc) drops the added blocks
            return tr.docChanged || tr.selectionSet ? NONE : prev;
          },
        },
        filterTransaction(tr) {
          return !(guard && tr.selectionSet && !tr.docChanged && tr.getMeta(blockSelectionKey) === undefined);
        },
        // A collaborator's edit replaces the document and so clears the selection: put it back on
        // the same blocks (a block they deleted drops out).
        appendTransaction(trs, oldState, newState) {
          const remote = (tr: Transaction) => isRemote((tr.getMeta("appendedTransaction") as Transaction | undefined) ?? tr);
          if (!trs.some((tr) => tr.docChanged) || trs.some((tr) => tr.docChanged && !remote(tr))) return null;
          const range = blockSelectionKey.getState(oldState);
          if (!range) return null;
          const at = alignBlocks(oldState.doc, newState.doc);
          const kept = selectedBlockIndices(oldState).map(at).filter((i): i is number => i !== null);
          if (!kept.length) return null;
          const head = at(range.head);
          const anchor = at(range.anchor);
          const run = blockRuns(kept).find((r) => head !== null && head >= r.from && head <= r.to) ?? blockRuns(kept)[0];
          const backwards = head !== null && anchor !== null && head < anchor;
          return selectionTr(newState.tr, backwards ? run.to : run.from, backwards ? run.from : run.to, kept).setMeta("addToHistory", false);
        },
        props: {
          decorations(state) {
            const extra = blockSetKey.getState(state) ?? NONE;
            if (!extra.length || !blockSelectionKey.getState(state)) return null;
            const blocks = topLevelBlocks(state.doc);
            return DecorationSet.create(state.doc, extra.filter((i) => blocks[i]).map((i) => Decoration.node(blocks[i].pos, blocks[i].pos + blocks[i].node.nodeSize, { class: "prism-block-selected" })));
          },
          handleDOMEvents: {
            mousedown: (view, event) => onEditorDown(view, event as MouseEvent),
          },
          // Typing over a selection that has added blocks replaces ALL of them (the browser's own
          // replacement only knows the primary run).
          handleTextInput(view, _from, _to, text) {
            if (!(blockSetKey.getState(view.state) ?? NONE).length || !structuralEditsAllowed(editor) || view.composing) return false;
            removeBlocks(editor, selectedBlockIndices(view.state), text);
            return true;
          },
        },
        view(view) {
          const doc = view.dom.ownerDocument;
          const win = doc.defaultView ?? window;
          let frame = 0;
          let announced = 0;
          let announceTimer = 0;
          let guardTimer = 0;

          const dispatch = (tr: Transaction) => { if (!view.isDestroyed) view.dispatch(tr); };
          const clear = () => { if (blockSelectionKey.getState(view.state)) dispatch(clearTr(view.state.tr)); };
          const usable = (event: MouseEvent) => event.button === 0 && lastPointer === "mouse" && view.dom.isConnected;

          /** Hand the state's selection to the browser (a drag left the two apart; a read-only view never had one). */
          const syncDom = () => {
            win.clearTimeout(guardTimer);
            guard = true;
            if (!view.editable) {
              try { const sel = doc.getSelection(); if (sel && !view.dom.contains(sel.anchorNode)) sel.collapse(view.dom, 0); } catch { /* no selection API */ }
            }
            try { view.focus(); } catch { /* unmounted */ }
            guardTimer = win.setTimeout(() => { guard = false; }, 80);
          };

          const setRange = (anchor: number, head: number) => {
            lastOwner = view;
            dispatch(selectionTr(view.state.tr, anchor, head));
            if (view.editable && !view.hasFocus()) view.focus();
          };

          const modifierClick = (event: MouseEvent, strict: boolean): boolean => {
            const toggle = toggleKey(event) && event.shiftKey;
            const extend = event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !!blockSelectionKey.getState(view.state);
            if (!toggle && !extend) return false;
            const index = indexAtY(view, event.clientY, !strict);
            if (index === null) return false;
            event.preventDefault();
            lastOwner = view;
            if (toggle) {
              const current = selectedBlockIndices(view.state);
              const next = current.includes(index) ? current.filter((i) => i !== index) : [...current, index].sort((a, b) => a - b);
              const primary = current.includes(index) ? next.reduce<number | undefined>((best, i) => (best === undefined || Math.abs(i - index) < Math.abs(best - index) ? i : best), undefined) : index;
              dispatch(setTr(view.state.tr, next, primary));
            } else {
              dispatch(selectionTr(view.state.tr, blockSelectionKey.getState(view.state)!.anchor, index));
            }
            if (view.editable && !view.hasFocus()) view.focus();
            else if (!view.editable) syncDom();
            return true;
          };

          // ── Marquee ──
          const scrollOf = (s: HTMLElement | null) => (s ? { x: s.scrollLeft, y: s.scrollTop } : { x: win.scrollX, y: win.scrollY });
          const startMarquee = (event: MouseEvent, inDom: boolean) => {
            const scroller = scrollParent(view.dom);
            const at = scrollOf(scroller);
            drag = { kind: "marquee", x0: event.clientX, y0: event.clientY, sx: at.x, sy: at.y, x: event.clientX, y: event.clientY, scroller, inDom, started: false, box: null, key: "" };
            listen(true);
          };
          const marqueeTick = () => {
            frame = 0;
            const m = drag;
            if (!m || m.kind !== "marquee" || !m.started || view.isDestroyed) return;
            const at = scrollOf(m.scroller);
            const ox = m.x0 - (at.x - m.sx);
            const oy = m.y0 - (at.y - m.sy);
            const left = Math.min(ox, m.x);
            const top = Math.min(oy, m.y);
            const right = Math.max(ox, m.x);
            const bottom = Math.max(oy, m.y);
            if (m.box) Object.assign(m.box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
            const hit = blocksInRect(view, top, bottom, left, right);
            const key = hit ? `${hit[0]}:${hit[1]}` : "";
            if (key !== m.key) {
              m.key = key;
              if (hit) { if (oy <= m.y) setRange(hit[0], hit[1]); else setRange(hit[1], hit[0]); }
              else clear();
            }
            // Follow at the edges; keep ticking while the page moves under a still pointer.
            const bounds = m.scroller ? m.scroller.getBoundingClientRect() : { top: 0, bottom: win.innerHeight };
            const speed = m.y < bounds.top + EDGE ? -Math.ceil((bounds.top + EDGE - m.y) / 3) : m.y > bounds.bottom - EDGE ? Math.ceil((m.y - (bounds.bottom - EDGE)) / 3) : 0;
            if (speed) {
              const by = Math.max(-28, Math.min(28, speed));
              if (m.scroller) m.scroller.scrollTop += by; else win.scrollBy(0, by);
              const now = scrollOf(m.scroller);
              if (now.y !== at.y) schedule();
            }
          };
          const textTick = () => {
            frame = 0;
            const t = drag;
            if (!t || t.kind !== "text" || view.isDestroyed) return;
            const index = indexAtY(view, t.y, true);
            if (index === null) return;
            if (index !== t.start) {
              // Left its block: from here to the end of the drag the selection is ours, in whole blocks.
              t.managed = true;
              guard = true;
              view.dom.classList.add("prism-block-dragging");
              const key = `b${index}`;
              if (key !== t.key) { t.key = key; setRange(t.start, index); }
            } else if (t.managed && t.startPos !== null) {
              const here = view.posAtCoords({ left: t.x, top: t.y });
              if (!here) return;
              const key = `t${here.pos}`;
              if (key === t.key) return;
              t.key = key;
              const size = view.state.doc.content.size;
              const tr = view.state.tr;
              tr.setSelection(TextSelection.between(tr.doc.resolve(Math.min(t.startPos, size)), tr.doc.resolve(Math.min(here.pos, size))));
              dispatch(clearTr(tr));
            }
          };
          const schedule = () => { if (!frame) frame = win.requestAnimationFrame(() => (drag?.kind === "marquee" ? marqueeTick() : textTick())); };

          const onMove = (event: MouseEvent) => {
            const d = drag;
            if (!d) return;
            if (!(event.buttons & 1)) { finish(event, false); return; }
            d.x = event.clientX;
            d.y = event.clientY;
            if (d.kind === "marquee" && !d.started) {
              if (Math.hypot(d.x - d.x0, d.y - d.y0) < DRAG_START) return;
              d.started = true;
              d.box = doc.createElement("div");
              d.box.className = "prism-block-marquee";
              d.box.setAttribute("aria-hidden", "true");
              doc.body.appendChild(d.box);
              doc.documentElement.classList.add("prism-marquee-active");
            }
            if (d.kind === "marquee") event.preventDefault();
            schedule();
          };
          const swallowClick = () => {
            const stop = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
            doc.addEventListener("click", stop, true);
            win.setTimeout(() => doc.removeEventListener("click", stop, true), 0);
          };
          const finish = (event: MouseEvent | null, cancelled: boolean) => {
            const d = drag;
            if (!d) return;
            if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
            if (d.kind === "marquee" && d.started && !cancelled && event) { d.x = event.clientX; d.y = event.clientY; marqueeTick(); }
            if (d.kind === "text" && !cancelled && event) { d.x = event.clientX; d.y = event.clientY; textTick(); }
            drag = null;
            listen(false);
            if (d.kind === "marquee") {
              d.box?.remove();
              doc.documentElement.classList.remove("prism-marquee-active");
              if (cancelled) { if (d.started) clear(); return; }
              if (d.started) {
                swallowClick();
                if (!view.editable && blockSelectionKey.getState(view.state)) syncDom();
                return;
              }
              // A plain click on empty space: the selection goes; inside the editor the caret lands where it would have.
              if (d.inDom && view.editable) {
                const here = view.posAtCoords({ left: d.x0, top: d.y0 });
                const tr = view.state.tr;
                const $pos = tr.doc.resolve(here ? here.pos : tr.doc.content.size);
                dispatch(clearTr(tr.setSelection(TextSelection.near($pos, here ? 1 : -1))));
                view.focus();
              } else clear();
              return;
            }
            view.dom.classList.remove("prism-block-dragging");
            if (d.managed) syncDom();
          };
          const onUp = (event: MouseEvent) => finish(event, false);
          const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || !drag) return;
            if (drag.kind === "marquee" && drag.started) { event.preventDefault(); event.stopPropagation(); finish(null, true); }
          };
          const onDragStart = () => { if (drag?.kind === "text") { drag = null; listen(false); guard = false; view.dom.classList.remove("prism-block-dragging"); } };
          const onBlur = () => finish(null, drag?.kind === "marquee");
          let listening = false;
          const listen = (on: boolean) => {
            if (on === listening) return;
            listening = on;
            const set = (target: Document | Window, type: string, fn: EventListener, capture: boolean) => (on ? target.addEventListener(type, fn, capture) : target.removeEventListener(type, fn, capture));
            set(doc, "mousemove", onMove as EventListener, true);
            set(doc, "mouseup", onUp as EventListener, true);
            set(doc, "keydown", onKey as EventListener, true);
            set(doc, "dragstart", onDragStart, true);
            set(win, "blur", onBlur, false);
          };

          // A press inside the editor (ProseMirror asks before it acts on it).
          onEditorDown = (v, event) => {
            if (v !== view || !usable(event)) return false;
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (!target) return false;
            if (modifierClick(event, false)) return true;
            if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
            if (target === view.dom) {
              // The editor's own padding beside the column, or below the last block. (A gap BETWEEN
              // blocks inside the column stays a caret position.)
              const column = contentBox(view.dom);
              const b = boxes(view);
              const firstRect = b.count ? b.rect(0) : null;
              const lastRect = b.count ? b.rect(b.count - 1) : null;
              const margin = event.clientX < column.left || event.clientX > column.right || (lastRect ? event.clientY > lastRect.bottom : true) || (firstRect ? event.clientY < firstRect.top : false);
              if (!margin) return false;
              event.preventDefault();
              startMarquee(event, true);
              return true;
            }
            // In a block's text: an ordinary text drag — watched in case it leaves the block.
            const fixed = target.closest(NO_TEXT_DRAG);
            if (fixed && fixed !== view.dom && view.dom.contains(fixed)) return false;
            const start = indexAtY(view, event.clientY, false);
            if (start === null) return false;
            drag = { kind: "text", start, startPos: view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null, x: event.clientX, y: event.clientY, managed: false, key: "" };
            listen(true);
            return false;
          };

          // A press in the page margin: an ancestor of the editor, inside its scroller.
          const onDocDown = (event: MouseEvent) => {
            if (!usable(event) || event.defaultPrevented) return;
            const target = event.target instanceof HTMLElement ? event.target : null;
            const dom = view.dom;
            if (!target || target === dom || dom.contains(target) || !target.contains(dom)) return;
            const scroller = scrollParent(dom);
            if (scroller && !scroller.contains(target)) return;
            // Not the scroller's own scrollbar.
            const box = target.getBoundingClientRect();
            if (event.clientX > box.left + target.clientLeft + target.clientWidth || event.clientY > box.top + target.clientTop + target.clientHeight) return;
            if (nearestEditor(target, event.clientX, event.clientY) !== dom) return;
            if (modifierClick(event, true)) return;
            if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault(); // no native selection drag, no focus change
            startMarquee(event, false);
          };

          // ⌘-click (Ctrl elsewhere) on a block's handle: that block in or out of the selection.
          const onDocClick = (event: MouseEvent) => {
            if (!toggleKey(event) || event.button !== 0) return;
            const grip = event.target instanceof Element ? event.target.closest(".block-gutter-grip") : null;
            const gutter = grip?.closest<HTMLElement>(".block-gutter[data-block-index]");
            if (!grip || !gutter) return;
            let host: Element | null = gutter.parentElement;
            while (host && !host.querySelector(".ProseMirror")) host = host.parentElement;
            const r = gutter.getBoundingClientRect();
            if (!host || nearestEditor(host, r.right, r.top + r.height / 2) !== view.dom) return;
            const index = Number(gutter.dataset.blockIndex);
            if (!Number.isInteger(index) || index < 0 || index >= view.state.doc.childCount) return;
            event.preventDefault();
            event.stopPropagation();
            lastOwner = view;
            const current = selectedBlockIndices(view.state);
            const next = current.includes(index) ? current.filter((i) => i !== index) : [...current, index].sort((a, b) => a - b);
            dispatch(setTr(view.state.tr, next, current.includes(index) ? undefined : index));
            if (view.editable) view.focus();
          };

          /** Is the keyboard in some OTHER text field (a title, a search box, another editor)? */
          const inField = () => {
            const active = doc.activeElement;
            return active instanceof HTMLElement && active !== view.dom && !active.contains(view.dom) && (active.matches("input, textarea, select") || active.isContentEditable);
          };

          // Copy / cut of a selection the browser cannot express: added blocks, or blocks selected
          // in a view that holds no focus (read-only pages).
          const onCopy = (event: ClipboardEvent) => {
            const indices = selectedBlockIndices(view.state);
            if (!indices.length || !event.clipboardData) return;
            const extra = (blockSetKey.getState(view.state) ?? NONE).length > 0;
            const target = event.target instanceof Node ? event.target : null;
            const inside = !!target && view.dom.contains(target);
            if (!extra && inside) return; // ProseMirror's own copy serves a single run
            if (!inside) {
              if (inField()) return;
              const sel = doc.getSelection();
              if (sel && !sel.isCollapsed && sel.anchorNode && !view.dom.contains(sel.anchorNode)) return;
              if (lastOwner !== view) return;
            }
            const nodes = indices.map((i) => view.state.doc.child(i));
            const { dom, text } = view.serializeForClipboard(new Slice(Fragment.fromArray(nodes), 0, 0));
            event.clipboardData.clearData();
            event.clipboardData.setData("text/html", dom.innerHTML);
            event.clipboardData.setData("text/plain", text);
            event.preventDefault();
            event.stopPropagation();
            if (event.type === "cut" && structuralEditsAllowed(editor)) removeBlocks(editor, indices);
          };
          // Read-only views take no key events: Esc still clears a mouse-made selection there.
          const onDocKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || view.editable || !blockSelectionKey.getState(view.state) || inField()) return;
            // Backspace / Delete change nothing here — and must not be the browser's "go back" (Safari) either.
            if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); return; }
            if (event.key !== "Escape") return;
            event.preventDefault();
            clear();
          };

          if (pointerWatch++ === 0) doc.addEventListener("pointerdown", watchPointer, true);
          doc.addEventListener("mousedown", onDocDown, true);
          doc.addEventListener("click", onDocClick, true);
          doc.addEventListener("copy", onCopy, true);
          doc.addEventListener("cut", onCopy, true);
          doc.addEventListener("keydown", onDocKey);

          return {
            update(v) {
              const count = selectedBlockIndices(v.state).length;
              if (count === announced) return;
              const was = announced;
              announced = count;
              win.clearTimeout(announceTimer);
              // After the drag settles: one message, not one per block crossed.
              announceTimer = win.setTimeout(() => announce(announced ? `${announced} block${announced === 1 ? "" : "s"} selected` : was ? "Block selection cleared" : ""), 250);
            },
            destroy() {
              if (lastOwner === view) lastOwner = null;
              finish(null, true);
              listen(false);
              guard = false;
              win.clearTimeout(announceTimer);
              win.clearTimeout(guardTimer);
              if (--pointerWatch === 0) doc.removeEventListener("pointerdown", watchPointer, true);
              doc.removeEventListener("mousedown", onDocDown, true);
              doc.removeEventListener("click", onDocClick, true);
              doc.removeEventListener("copy", onCopy, true);
              doc.removeEventListener("cut", onCopy, true);
              doc.removeEventListener("keydown", onDocKey);
              onEditorDown = () => false;
            },
          };
        },
      }),
    ];
  },
});
