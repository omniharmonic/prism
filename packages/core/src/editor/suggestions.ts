import { Extension } from "@tiptap/core";
import { Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import { suggestionKey } from "./suggestionMeta";
import { Mapping, ReplaceAroundStep, ReplaceStep, Transform, canJoin } from "@tiptap/pm/transform";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";

/**
 * Inline suggested edits ("track changes"), Google-Docs style — the client-side
 * BEHAVIOR. In suggest mode, typing wraps text in the `insertion` mark and
 * every removal becomes a `deletion` mark instead of removing. Accept/reject
 * resolve them to clean text. The marks themselves are in ./suggestionMarks
 * (shared schema, isomorphic). This file uses the DOM (handleKeyDown) and is
 * client-only — never imported by the Node server.
 *
 * Removals are tracked at the TRANSACTION level (`appendTransaction`), not per key:
 * typing / pasting / composing (IME) / dropping over a selection, Enter over a
 * selection, cut, a phone keyboard's delete, autocorrect — any local `ReplaceStep`
 * that takes content out has that content put back in the same dispatch, marked as
 * a deletion (one undo step, one Yjs update). Backspace / Delete keep their key
 * handler (it also decides where the caret goes). What stays a real removal:
 *  - text that is the same person's own pending insertion (it just disappears);
 *  - removals that hold no content at all (joining two blocks, an empty block) —
 *    untracked, like the split Enter makes;
 *  - structure changes (lift / wrap / turn into): a `ReplaceAroundStep` that takes out node
 *    boundaries only. One that takes out TEXT — a replacement across nesting depth, e.g. from a
 *    paragraph into the first item of the list below — is tracked like any other removal.
 * Suggestion marks go on TEXT only — the sync layer carries marks on text and nowhere else,
 * so a "struck" chip or line break would exist in this session alone. Every leaf that is not
 * text (image, mention chip, divider, embed, sub-page row, database block, line break) is
 * therefore REFUSED: put back unmarked (with `onRefused`; a line break silently); a copy of it
 * that the same dispatch put elsewhere (dragged along with text) is taken out again.
 * Not a removal: a removal made ONLY of such leaves that the same dispatch inserts again
 * (a drag of the chip / block itself: it MOVED). Text that cannot carry the mark (inline code,
 * a code block) is removed for real, with a notice — never put back unmarked beside its
 * replacement.
 * There is NO exemption for "the same kind of node replaced the old one": pasting image B
 * over image A is a removal of A. Attribute changes are either gated off while Suggesting
 * (`structuralEditsAllowed`) or carry `SUGGESTION_UNTRACKED_META`.
 */

export interface SuggestionUser {
  name: string;
  color: string;
}

import type { Fragment, Mark as PMMark, MarkType, Node as PMNode, ResolvedPos, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";

/** The contiguous suggestion run (insertion or deletion) covering `pos`, or null.
 *  Used for per-suggestion accept/reject and to show the inline bubble. */
export function suggestionAt(
  state: EditorState,
  pos: number,
): { type: "insertion" | "deletion"; from: number; to: number; mark: PMMark } | null {
  const size = state.doc.content.size;
  const at = (from: number, to: number): PMMark | null => {
    if (from < 0 || to > size || from >= to) return null;
    let found: PMMark | null = null;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isText) found ??= node.marks.find((m) => m.type.name === "insertion" || m.type.name === "deletion") ?? null;
    });
    return found;
  };
  const mark = at(pos, pos + 1) ?? at(pos - 1, pos);
  if (!mark) return null;
  let from = pos;
  while (from > 0 && state.doc.rangeHasMark(from - 1, from, mark)) from--;
  let to = pos;
  while (to < size && state.doc.rangeHasMark(to, to + 1, mark)) to++;
  return { type: mark.type.name as "insertion" | "deletion", from, to, mark };
}

/** One agent replacement has two marks but one identity and one review action. */
function resolveIdentifiedSuggestion(state: EditorState, tr: Transaction, mark: PMMark, action: "accept" | "reject"): boolean {
  const id = mark.attrs.suggestionId;
  if (!id) return false;
  const remove: Array<[number, number]> = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const candidate of node.marks) {
      if (!["insertion", "deletion"].includes(candidate.type.name) || candidate.attrs.suggestionId !== id || candidate.attrs.actorId !== mark.attrs.actorId || candidate.attrs.user !== mark.attrs.user) continue;
      const deleting = candidate.type.name === (action === "accept" ? "deletion" : "insertion");
      if (deleting) remove.push([pos, pos + node.nodeSize]);
      else {
        tr.removeMark(pos, pos + node.nodeSize, candidate);
        const echo = state.schema.marks[candidate.type.name === "insertion" ? "underline" : "strike"];
        if (echo) tr.removeMark(pos, pos + node.nodeSize, echo);
      }
    }
  });
  for (const [from, to] of remove.reverse()) tr.delete(tr.mapping.map(from), tr.mapping.map(to));
  tr.setMeta(suggestionKey, true);
  return true;
}

/** True if every text node in [a,b] is an insertion authored by `userName` —
 *  i.e. the user is deleting their OWN pending suggestion, so we can truly
 *  remove it instead of marking it struck-through. */
function rangeHasOnlyOwnInsertion(state: EditorState, a: number, b: number, userName: string): boolean {
  const ins = state.schema.marks.insertion;
  if (!ins || a >= b) return false;
  let any = false;
  let allOwn = true;
  state.doc.nodesBetween(a, b, (node) => {
    if (!node.isText) return;
    any = true;
    const m = node.marks.find((mk) => mk.type === ins);
    if (!m || m.attrs.user !== userName) allOwn = false;
  });
  return any && allOwn;
}

/** A removed slice that needs no record: no content at all (a join, an empty block),
 *  or nothing but the person's own pending insertions. */
function keepsNothing(slice: Slice, insertion: MarkType, userName: string): boolean {
  let keep = false;
  slice.content.descendants((node) => {
    if (keep) return false;
    if (!node.isLeaf) return true;
    const mine = node.isText ? node.marks.find((m) => m.type === insertion) : undefined;
    if (!mine || mine.attrs.user !== userName) keep = true;
    return false;
  });
  return !keep;
}

/** Removed content waiting to go back in: where (current document), and what. In a live
 *  document `rel` is the same place as a Yjs relative position (see the plugin's view). */
interface Held { pos: number; slice: Slice; rel?: unknown; /** Its place could not be followed across a collaborator's change. */ unsure?: boolean }
/** The plugin's state: what is held. */
interface HeldState { held: Held[] }
const heldOf = (state: EditorState): Held[] => (suggestionKey.getState(state) as HeldState | undefined)?.held ?? [];

/** A leaf that is not text and not a line break: an image, a mention chip, a divider, an embed…
 *  (inline or block — the name is historical). Removing one raises the notice; a line break does not. */
const isBlockLeaf = (node: PMNode) => node.isLeaf && !node.isText && node.type.name !== "hardBreak";

/**
 * The stretches of TEXT in [from, to), each ended by any leaf that is not text. Suggestion
 * marks go on text only: the sync layer (y-prosemirror) carries marks on text and nowhere else,
 * so a mark on a chip, an image or a line break would exist in this session alone — nobody
 * else, not the stored page, not this person after a reload, would ever see it.
 */
function textRuns(doc: PMNode, from: number, to: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let run: [number, number] | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isLeaf) return;
    if (!node.isText) { if (run) runs.push(run); run = null; return; }
    const a = Math.max(pos, from);
    const b = Math.min(pos + node.nodeSize, to);
    if (b <= a) return;
    if (run) run[1] = b; else run = [a, b];
  });
  if (run) runs.push(run);
  return runs;
}

/** Can this text, under this parent, carry the deletion mark? (Not in a code block; not under a mark that excludes others.) */
function canStrike(node: PMNode, parent: PMNode | null, deletion: MarkType): boolean {
  if (parent && !parent.type.allowsMarkType(deletion)) return false;
  return !node.marks.some((m) => m.type !== deletion && m.type.excludes(deletion));
}

/** Where the nearest ISOLATING ancestor of a position starts (a table cell, a table, a column…), or -1. */
function isolatedIn($pos: ResolvedPos): number {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.spec.isolating) return $pos.before(d);
  return -1;
}

/** How many isolating blocks (table cells, tables, columns…) a document or a fragment holds. */
function isolatingCount(content: PMNode | Fragment): number {
  let n = 0;
  content.descendants((node) => { if (node.type.spec.isolating) n++; return !node.isTextblock; });
  return n;
}

/** The isolating blocks a slice holds WHOLE — not the ones it is open into at either end (those
 *  are a part of a block that is still in the document: putting it back must not make another). */
function wholeIsolating(slice: Slice): number {
  const open = new Set<PMNode>();
  let node: PMNode | null = slice.content.firstChild;
  for (let d = 0; d < slice.openStart && node; d++, node = node.firstChild) open.add(node);
  node = slice.content.lastChild;
  for (let d = 0; d < slice.openEnd && node; d++, node = node.lastChild) open.add(node);
  let partial = 0;
  for (const n of open) if (n.type.spec.isolating) partial++;
  return isolatingCount(slice.content) - partial;
}

/** Does the removal [a, b) cross the boundary of a table cell, a column or another isolating block? */
export function crossesIsolating(doc: PMNode, a: number, b: number): boolean {
  return isolatedIn(doc.resolve(a)) !== isolatedIn(doc.resolve(b));
}

/**
 * For a removal that ended INSIDE nested blocks (its slice is open at the end): which of those
 * blocks went on after the removed range — outermost first, the textblock itself left out.
 * After the put-back each of those is joined with what was left of it (see `putBack`).
 */
function continuedAfter(doc: PMNode, b: number, openEnd: number): boolean[] {
  const $b = doc.resolve(b);
  const out: boolean[] = [];
  for (let j = openEnd - 1; j >= 1; j--) {
    const d = $b.depth - j;
    out.push(d >= 1 && $b.indexAfter(d) < $b.node(d).childCount);
  }
  return out;
}

/**
 * Strike [a, b) WHERE IT IS — no structure is touched (the way Backspace over a selection works).
 * Text that is the person's own pending insertion, and text that cannot carry the mark (code), is
 * removed; text already struck keeps its mark; a leaf that is not text stays (`refused`).
 * Returns where `b` is afterwards.
 */
export function strikeInPlace(tr: Transaction, a: number, b: number, ctx: { insertion: MarkType; deletion: MarkType; userName: string }): { end: number; refused: boolean; untracked: boolean } {
  const { insertion, deletion, userName } = ctx;
  const strike: Array<[number, number]> = [];
  const drop: Array<[number, number]> = [];
  let run: [number, number] | null = null;
  const close = () => { if (run) strike.push(run); run = null; };
  const out = { refused: false, untracked: false };
  tr.doc.nodesBetween(a, b, (node, pos, parent) => {
    if (!node.isLeaf) { close(); return; }
    const range: [number, number] = [Math.max(pos, a), Math.min(pos + node.nodeSize, b)];
    if (range[1] <= range[0]) return;
    if (!node.isText) { close(); if (isBlockLeaf(node)) out.refused = true; return; }
    const mine = node.marks.find((m) => m.type === insertion);
    if (mine && mine.attrs.user === userName) { close(); drop.push(range); }
    else if (node.marks.some((m) => m.type === deletion)) close();
    else if (!canStrike(node, parent, deletion)) { close(); drop.push(range); out.untracked = true; }
    else if (run && run[1] === range[0]) run[1] = range[1];
    else { close(); run = [range[0], range[1]]; }
  });
  close();
  const first = tr.steps.length;
  for (const [x, y] of strike) tr.addMark(x, y, deletion.create({ user: userName, color: "#ef4444" }));
  for (const [x, y] of drop.sort((m, n) => n[0] - m[0])) tr.delete(x, y);
  return { end: tr.mapping.slice(first).map(b, -1), ...out };
}

export interface PutBackResult { refused: boolean; untracked: boolean; misplaced: boolean; lost: boolean; caret: boolean }

/** The notices a put-back raises, for the editor's status line. */
export function putBackMessages(r: PutBackResult): string[] {
  return [r.refused && SUGGESTION_REFUSED_MESSAGE, r.untracked && SUGGESTION_CODE_MESSAGE, r.misplaced && SUGGESTION_MISPLACED_MESSAGE, r.lost && SUGGESTION_LOST_MESSAGE].filter((m): m is string => !!m);
}

/**
 * Put removed content back into `tr` as tracked deletions — last position first, so earlier
 * positions stay valid.
 *  - the person's own pending insertion is not restored; text already struck keeps its mark;
 *  - text that cannot carry the mark (inline code, a code block) stays removed (`untracked`);
 *  - a leaf that is not text (a chip, an image, a divider…) takes no mark: it comes back
 *    unmarked (`refused`; a line break silently), and a copy of it the same dispatch put
 *    elsewhere (`moved` — it was dragged along with text) is taken out again;
 *  - a slice the document cannot take back in place (the fitter places nothing, drops part of
 *    it, or would change the shape of a table / column layout around it) is kept as struck text
 *    beside the change (`misplaced`) — never silently lost;
 *  - `rejoin`: a list / quote the removal ended inside is one block again afterwards.
 * `caret`: a plain removal at the caret leaves the caret BEFORE the struck text.
 */
export function putBack(
  tr: Transaction,
  items: Array<{ at: number; slice: Slice; pure: boolean; order: number; /** `continuedAfter` of the removal, when it ended inside nested blocks. */ rejoin?: boolean[] }>,
  ctx: { selection: Selection; insertion: MarkType; deletion: MarkType; userName: string; /** Block leaves the dispatch inserted… */ moved?: PMNode[]; /** …and where (ranges in `tr.doc` as it is at the call). */ arrivedIn?: Array<[number, number]> },
): PutBackResult {
  const { selection, insertion, deletion, userName } = ctx;
  const moved = [...(ctx.moved ?? [])];
  const sendBack: PMNode[] = [];
  const base = tr.steps.length;
  const struck = () => deletion.create({ user: userName, color: "#ef4444" });
  const back = [...items].sort((x, y) => y.at - x.at || y.order - x.order);
  let caret: { at: number; step: number } | null = null;
  const out = { refused: false, untracked: false, misplaced: false, lost: false };
  for (const r of back) {
    const at = Math.min(Math.max(r.at, 0), tr.doc.content.size);
    const text = r.slice.content.textBetween(0, r.slice.content.size, "");
    // Try on a copy: a put-back that does not bring every character back is not applied.
    const probe = new Transform(tr.doc);
    let fits = false;
    try {
      probe.replace(at, at, r.slice);
      // …and one that changes the SHAPE around it is not applied either: the put-back may add
      // exactly the table cells / tables / columns the removed slice holds, no more (the fitter
      // can wrap a piece in a table of its own, or add a cell to a row) and no fewer.
      fits = probe.steps.length > 0 && probe.doc.textBetween(at, probe.mapping.map(at, 1), "") === text
        && isolatingCount(probe.doc) === isolatingCount(tr.doc) + wholeIsolating(r.slice);
    } catch { fits = false; }
    if (!fits) {
      if (!text) {
        // Nothing but leaves, and nowhere to put them: say so (it must not vanish unnoticed).
        r.slice.content.descendants((node) => { if (isBlockLeaf(node)) out.lost = true; return !out.lost; });
        continue;
      }
      const $at = tr.doc.resolve(at);
      const mark = struck();
      const paragraph = tr.doc.type.schema.nodes.paragraph;
      try {
        if ($at.parent.inlineContent && $at.parent.type.allowsMarkType(deletion)) tr.insert(at, tr.doc.type.schema.text(text, [mark]));
        else if (paragraph) tr.insert($at.depth ? $at.after(1) : at, paragraph.create(null, tr.doc.type.schema.text(text, [mark])));
        out.misplaced = true;
      } catch { /* nowhere to keep it: the removal stays as made */ }
      continue;
    }
    const first = tr.steps.length;
    for (const step of probe.steps) tr.step(step);
    const end = tr.mapping.slice(first).map(at, 1);
    // Contiguous markable content is struck with ONE addMark (a select-all on a long page
    // is one run per stretch between things that must not be re-marked, not one per leaf).
    const strike: Array<[number, number]> = [];
    let run: [number, number] | null = null;
    const close = () => { if (run) strike.push(run); run = null; };
    const drop: Array<[number, number]> = [];
    tr.doc.nodesBetween(at, end, (node, pos, parent) => {
      if (!node.isLeaf) return;
      const range: [number, number] = [Math.max(pos, at), Math.min(pos + node.nodeSize, end)];
      if (range[1] <= range[0]) return;
      if (!node.isText) {
        // ANY leaf that is not text ends the run (a line break included: it takes no mark).
        if (!isBlockLeaf(node)) { close(); return; }
        close();
        // A leaf (an image, a chip…) cannot be struck: it stays where it was. If the same
        // dispatch also put it somewhere else (it was dragged along with text), that copy is
        // taken out again — Reject then restores the original exactly, and nothing is doubled.
        const twin = moved.findIndex((m) => m.eq(node));
        if (twin >= 0) sendBack.push(moved.splice(twin, 1)[0]!);
        out.refused = true;
        return;
      }
      const mine = node.marks.find((m) => m.type === insertion);
      if (mine && mine.attrs.user === userName) { close(); drop.push(range); }
      else if (node.marks.some((m) => m.type === deletion)) close();
      else if (!canStrike(node, parent, deletion)) { close(); drop.push(range); out.untracked = true; }
      else if (run) run[1] = range[1];
      else run = [range[0], range[1]];
    });
    close();
    for (const [a, b] of strike) tr.addMark(a, b, struck());
    // The removal ended inside nested blocks (a list, a quote…) that went on after it: what was
    // left of each stands right behind the part just put back — they are one block again.
    // (Outermost first: a join further out does not move the places further in — nor the
    // ranges deleted below, which all lie before it.)
    if (r.rejoin?.some(Boolean)) {
      const levels = r.rejoin.length;
      r.rejoin.forEach((continued, i) => {
        if (!continued) return;
        try {
          const $end = tr.doc.resolve(tr.mapping.slice(first).map(at, 1));
          const depth = $end.depth - (levels - i);
          if (depth < 1) return;
          const cut = $end.after(depth);
          const $cut = tr.doc.resolve(cut);
          const before = $cut.nodeBefore;
          const after = $cut.nodeAfter;
          if (before && after && !before.isTextblock && before.type === after.type && before.sameMarkup(after) && canJoin(tr.doc, cut)) tr.join(cut);
        } catch { /* the blocks stay apart: nothing is lost */ }
      });
    }
    for (const [a, b] of drop.sort((x, y) => y[0] - x[0])) tr.delete(a, b);
    // A plain removal (cut, a phone keyboard's delete): the caret goes BEFORE the struck
    // text, where Backspace leaves it, so the next delete moves on.
    if (r.pure && selection.empty && selection.from === r.at) caret = { at, step: tr.steps.length };
  }
  for (const node of sendBack) {
    let found = -1;
    for (const [a, b] of ctx.arrivedIn ?? []) {
      const from = tr.mapping.slice(base).map(a, 1);
      const to = tr.mapping.slice(base).map(b, -1);
      if (found >= 0 || to <= from) continue;
      tr.doc.nodesBetween(from, to, (candidate, pos) => { if (found < 0 && pos >= from && candidate.eq(node)) found = pos; return found < 0; });
    }
    if (found >= 0) tr.delete(found, found + node.nodeSize);
  }
  if (caret) {
    const at = Math.min(tr.mapping.slice(caret.step).map(caret.at, -1), tr.doc.content.size);
    const $at = tr.doc.resolve(at);
    tr.setSelection($at.parent.inlineContent ? TextSelection.create(tr.doc, at) : Selection.near($at, -1));
  }
  return { ...out, caret: !!caret };
}

/** What the ySync plugin's state holds (y-tiptap), as far as this file reads it. */
interface YSync { doc: unknown; type: unknown; binding: { mapping: unknown } | null }

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    suggestions: {
      setSuggesting: (on: boolean) => ReturnType;
      acceptAllSuggestions: () => ReturnType;
      rejectAllSuggestions: () => ReturnType;
      acceptSuggestion: () => ReturnType;
      rejectSuggestion: () => ReturnType;
    };
  }
}

export interface SuggestionOptions {
  user: SuggestionUser;
  /** A notice for the editor's status line: a removal suggesting cannot record was put back, applied directly (code) or misplaced (see the file header). */
  onRefused?: (message: string) => void;
}

export { SUGGESTION_UNTRACKED_META } from "./suggestionMeta";

export const SUGGESTION_REFUSED_MESSAGE = "Images, mentions and other blocks can’t be removed while suggesting (or moved along with text) — switch to Editing for that.";
export const SUGGESTION_CODE_MESSAGE = "Changes inside code aren’t tracked while suggesting — this one was applied directly.";
export const SUGGESTION_LOST_MESSAGE = "A block removed while suggesting could not be put back — use Undo to bring it back.";
export const SUGGESTION_TODO_MESSAGE = "Checking a to-do isn’t tracked while suggesting — switch to Editing to check it.";
export const SUGGESTION_ISOLATED_MESSAGE = "A change that starts in one table cell or column and ends outside it can’t be tracked while suggesting — nothing was changed. Select inside one cell, or switch to Editing.";
export const SUGGESTION_MISPLACED_MESSAGE = "Some removed text could not go back where it was — it was kept, struck, next to the change.";

export const SuggestionMode = Extension.create<SuggestionOptions>({
  name: "suggestionMode",

  addOptions() {
    return { user: { name: "Someone", color: "#22c55e" } };
  },

  addStorage() {
    return { suggesting: false };
  },

  addCommands() {
    return {
      setSuggesting:
        (on: boolean) =>
        () => {
          this.storage.suggesting = on;
          return true;
        },

      // Accept: keep inserted text (drop insertion marks); remove deleted text.
      acceptAllSuggestions:
        () =>
        ({ tr, state, dispatch }) => {
          const insertion = state.schema.marks.insertion;
          const deletion = state.schema.marks.deletion;
          const delRanges: Array<[number, number]> = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            if (insertion && node.marks.some((m) => m.type === insertion)) {
              tr.removeMark(pos, pos + node.nodeSize, insertion);
            }
            if (deletion && node.marks.some((m) => m.type === deletion)) {
              delRanges.push([pos, pos + node.nodeSize]);
            }
          });
          // delete from end → start so positions stay valid
          for (const [from, to] of delRanges.reverse()) tr.delete(tr.mapping.map(from), tr.mapping.map(to));
          tr.setMeta(suggestionKey, true); // a review action is never itself a suggestion
          if (dispatch) dispatch(tr);
          return true;
        },

      // Reject: remove inserted text; keep deleted text (drop deletion marks).
      rejectAllSuggestions:
        () =>
        ({ tr, state, dispatch }) => {
          const insertion = state.schema.marks.insertion;
          const deletion = state.schema.marks.deletion;
          const insRanges: Array<[number, number]> = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            if (deletion && node.marks.some((m) => m.type === deletion)) {
              tr.removeMark(pos, pos + node.nodeSize, deletion);
            }
            if (insertion && node.marks.some((m) => m.type === insertion)) {
              insRanges.push([pos, pos + node.nodeSize]);
            }
          });
          for (const [from, to] of insRanges.reverse()) tr.delete(tr.mapping.map(from), tr.mapping.map(to));
          tr.setMeta(suggestionKey, true);
          if (dispatch) dispatch(tr);
          return true;
        },

      // Accept just the suggestion at the cursor (Google-Docs per-change accept).
      acceptSuggestion:
        () =>
        ({ state, tr, dispatch }) => {
          const r = suggestionAt(state, state.selection.from);
          if (!r) return false;
          if (!resolveIdentifiedSuggestion(state, tr, r.mark, "accept")) {
            if (r.type === "deletion") tr.delete(r.from, r.to);
            else tr.removeMark(r.from, r.to, r.mark);
          }
          tr.setMeta(suggestionKey, true);
          if (dispatch) dispatch(tr);
          return true;
        },

      // Reject just the suggestion at the cursor.
      rejectSuggestion:
        () =>
        ({ state, tr, dispatch }) => {
          const r = suggestionAt(state, state.selection.from);
          if (!r) return false;
          if (!resolveIdentifiedSuggestion(state, tr, r.mark, "reject")) {
            if (r.type === "insertion") tr.delete(r.from, r.to);
            else tr.removeMark(r.from, r.to, r.mark);
          }
          tr.setMeta(suggestionKey, true);
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin({
        key: suggestionKey,
        // Text a running IME composition replaced, waiting to be put back (see appendTransaction).
        state: {
          init: (): HeldState => ({ held: [] }),
          apply(tr, state: HeldState, oldState): HeldState {
            const meta = tr.getMeta(suggestionKey) as { hold?: Held[]; release?: boolean } | true | undefined;
            const value = state.held;
            let next = value;
            if (tr.docChanged && next.length) {
              // A collaborator's change (and y-undo) reaches ProseMirror as ONE replace of the
              // whole document: mapping a position through it collapses it to 0. In a live
              // document the place is therefore kept as a Yjs relative position (taken just
              // before the remote change, see `view`), and read back here.
              const y = tr.getMeta(ySyncPluginKey) ? (ySyncPluginKey.getState(oldState) as YSync | undefined) : undefined;
              next = next.map((h) => {
                if (y?.binding) {
                  try {
                    const pos = h.rel ? relativePositionToAbsolutePosition(y.doc as never, y.type as never, h.rel as never, y.binding.mapping as never) : null;
                    if (typeof pos === "number") return { pos: Math.min(pos, tr.doc.content.size), slice: h.slice, rel: h.rel, unsure: h.unsure };
                  } catch { /* fall back to plain mapping */ }
                  // The place could not be named across this change: it goes back as near as mapping says, and says so.
                  return { pos: tr.mapping.map(h.pos, -1), slice: h.slice, unsure: true };
                }
                return { pos: tr.mapping.map(h.pos, -1), slice: h.slice, unsure: h.unsure };
              });
            }
            if (meta && meta !== true) {
              if (meta.release) next = [];
              if (meta.hold?.length) next = [...next, ...meta.hold];
            }
            return next === value ? state : { held: next };
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          let endedAt = 0;
          // Live documents: just before ANY Yjs transaction, note where each held piece sits as a
          // relative position (ProseMirror and Yjs agree at that moment when the change is remote).
          const anchor = () => {
            if (view.isDestroyed) return;
            const held = heldOf(view.state);
            const y = ySyncPluginKey.getState(view.state) as YSync | undefined;
            if (!held.length || !y?.binding) return;
            for (const h of held) {
              try { h.rel = absolutePositionToRelativePosition(h.pos, y.type as never, y.binding.mapping as never); } catch { h.rel = undefined; }
            }
          };
          const ydoc = (ySyncPluginKey.getState(view.state) as YSync | undefined)?.doc as { on?(name: string, fn: () => void): void; off?(name: string, fn: () => void): void } | undefined;
          ydoc?.on?.("beforeAllTransactions", anchor);
          /** Put the held text back NOW, struck. The removal is already in the shared document:
           *  the held slice exists only here, so every way out of the editor flushes it. */
          const flush = () => {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            if (view.isDestroyed) return;
            const held = heldOf(view.state);
            const insertion = view.state.schema.marks.insertion;
            const deletion = view.state.schema.marks.deletion;
            if (!held.length || !insertion || !deletion) return;
            const tr = view.state.tr.setMeta(suggestionKey, { release: true });
            const result = putBack(tr, held.map((h, order) => ({ at: h.pos, slice: h.slice, pure: false, order })), { selection: view.state.selection, insertion, deletion, userName: ext.options.user.name });
            try { view.dispatch(tr); } catch { return; }
            const messages = putBackMessages(result);
            if (held.some((h) => h.unsure) && !messages.includes(SUGGESTION_MISPLACED_MESSAGE)) messages.push(SUGGESTION_MISPLACED_MESSAGE);
            for (const message of messages) ext.options.onRefused?.(message);
          };
          // The composition ended (the browser's own event). ProseMirror clears its flag a moment
          // later — wait for that, but for at most ~1 s: the flag can stay set (it did, in
          // Chromium, after the composing text was redrawn), and the text must not wait on it.
          const settle = () => {
            timer = null;
            if (view.isDestroyed) return;
            if (view.composing && Date.now() - endedAt < 1000) { timer = setTimeout(settle, 80); return; }
            flush();
          };
          // Composition per the browser's own events (ProseMirror's flag can stay set).
          let composingNow = false;
          const onCompositionStart = () => {
            composingNow = true;
            // A new composition inside the wait: the wait starts over at ITS end — nothing is put back mid-composition.
            if (timer !== null) { clearTimeout(timer); timer = null; }
          };
          const onCompositionEnd = () => { composingNow = false; endedAt = Date.now(); if (timer === null) timer = setTimeout(settle, 60); };
          // Focus leaving mid-composition (an IME's own window can take it): its `compositionend` puts the text back.
          const onBlur = () => { if (!composingNow) flush(); };
          // Leaving the editor or the page ends any composition for our purposes.
          const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
          view.dom.addEventListener("compositionstart", onCompositionStart);
          view.dom.addEventListener("compositionend", onCompositionEnd);
          view.dom.addEventListener("blur", onBlur);
          window.addEventListener("pagehide", flush);
          document.addEventListener("visibilitychange", onHidden);
          // A to-do's checkbox writes its attribute as soon as the editor is editable — an
          // untracked change. While Suggesting the click never reaches it (the box stays as it is).
          const onCheckbox = (event: Event) => {
            if (!ext.storage.suggesting) return;
            const target = event.target as HTMLElement | null;
            if (!(target instanceof HTMLInputElement) || target.type !== "checkbox" || !target.closest('li[data-type="taskItem"], ul[data-type="taskList"] li')) return;
            event.preventDefault();
            event.stopPropagation();
            ext.options.onRefused?.(SUGGESTION_TODO_MESSAGE);
          };
          view.dom.addEventListener("click", onCheckbox, true);
          return {
            destroy() {
              // Before the collaboration plugin goes (this plugin is listed before it): the
              // dispatch still reaches the shared document.
              flush();
              view.dom.removeEventListener("compositionstart", onCompositionStart);
              view.dom.removeEventListener("compositionend", onCompositionEnd);
              view.dom.removeEventListener("blur", onBlur);
              window.removeEventListener("pagehide", flush);
              document.removeEventListener("visibilitychange", onHidden);
              view.dom.removeEventListener("click", onCheckbox, true);
              ydoc?.off?.("beforeAllTransactions", anchor);
            },
          };
        },
        // Track the dispatch AFTER ProseMirror applied it (same dispatch → one undo
        // step, one Yjs update): what it put in gets the `insertion` mark, what it
        // took out is put back with the `deletion` mark. Doing it here rather than in
        // handleTextInput / per key means no input path is missed and nothing diverges
        // from the DOM. Remote Yjs syncs, undo/redo and our own transactions are
        // skipped, so collaborators' edits and review actions are never re-marked.
        appendTransaction(transactions, _oldState, newState) {
          if (!ext.storage.suggesting) return null;
          const insertion = newState.schema.marks.insertion;
          const deletion = newState.schema.marks.deletion;
          if (!insertion || !deletion) return null;
          const tracked = (t: Transaction) => t.docChanged && !t.getMeta(suggestionKey) && !t.getMeta(ySyncPluginKey) && !t.getMeta("history$");
          if (!transactions.some(tracked)) return null;
          const { user } = ext.options;

          // Every step of the dispatch in order, so a position after step k can be
          // carried to the final document.
          const all = new Mapping();
          for (const t of transactions) for (const map of t.mapping.maps) all.appendMap(map);
          const added: Array<{ k: number; from: number; to: number }> = [];
          let removed: Array<{ k: number; pos: number; slice: Slice; pure: boolean; rejoin?: boolean[] }> = [];
          // A removal across the boundary of a table cell / column: the whole dispatch is taken back.
          let isolated = false;
          // A removal across nesting depth (see `inPlace` below): [a, b) in the document before the dispatch.
          const deep: { at: { a: number; b: number; /** What the step put in at that place (after the step). */ put: [number, number]; /** It was the dispatch's first step: [a, b) are places in the document before the dispatch. */ first: boolean } | null } = { at: null };
          let steps = 0;
          // Leaves (images, chips, dividers…) this dispatch put in: one that was also taken out, in a
          // removal made of nothing else, MOVED.
          const arrived: PMNode[] = [];
          // Ranges this dispatch itself put in (coordinates of the step being read):
          // taking those out again removes nothing the document ever held.
          let fresh: Array<[number, number]> = [];
          let k = 0;
          for (const t of transactions) {
            const on = tracked(t);
            t.steps.forEach((step, i) => {
              const map = t.mapping.maps[i]!;
              const before = t.docs[i]!;
              const made: Array<[number, number]> = [];
              if (on) {
                if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) step.slice.content.descendants((node) => { if (isBlockLeaf(node)) arrived.push(node); });
                map.forEach((oldStart, oldEnd, newStart, newEnd) => {
                  if (newEnd > newStart) { added.push({ k, from: newStart, to: newEnd }); made.push([newStart, newEnd]); }
                  // Any step that takes content out is read — a ReplaceAroundStep too: a replacement
                  // that crosses nesting depth (from a paragraph into the list, quote or table cell
                  // below it, or out of one) is written as one (the rest of the last block is carried
                  // into the first), and its two removed ranges hold the removed text. Pure structure
                  // (lift / wrap / turn into, a block join) removes only node boundaries: `keepsNothing`.
                  if (oldEnd <= oldStart || !(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return;
                  let at = oldStart;
                  const pieces: Array<[number, number]> = [];
                  for (const [a, b] of fresh) {
                    if (b <= at || a >= oldEnd) continue;
                    if (a > at) pieces.push([at, a]);
                    at = Math.max(at, b);
                  }
                  if (at < oldEnd) pieces.push([at, oldEnd]);
                  for (const [a, b] of pieces) {
                    const slice = before.slice(a, b);
                    if (keepsNothing(slice, insertion, user.name)) continue;
                    if (crossesIsolating(before, a, b)) isolated = true;
                    if (step instanceof ReplaceAroundStep || slice.openStart !== slice.openEnd) deep.at = { a, b, put: [newStart, newEnd], first: k === 0 };
                    removed.push({ k, pos: newStart, slice, pure: newEnd === newStart, rejoin: slice.openEnd > 1 ? continuedAfter(before, b, slice.openEnd) : undefined });
                  }
                });
              }
              fresh = fresh
                .map(([a, b]): [number, number] => [map.map(a, 1), map.map(b, -1)])
                .filter(([a, b]) => b > a)
                .concat(made)
                .sort((x, y) => x[0] - y[0]);
              k++;
              if (on) steps++;
            });
          }
          // A removal that is nothing but leaves which arrived elsewhere in this dispatch is a move.
          if (arrived.length) {
            removed = removed.filter((r) => {
              const pool = [...arrived];
              let onlyMoved = true;
              r.slice.content.descendants((node) => {
                if (!node.isLeaf || !onlyMoved) return onlyMoved;
                const twin = isBlockLeaf(node) ? pool.findIndex((m) => m.eq(node)) : -1;
                if (twin < 0) { if (node.isText || isBlockLeaf(node)) onlyMoved = false; } else pool.splice(twin, 1);
                return false;
              });
              return !onlyMoved;
            });
          }
          if (!added.length && !removed.length) return null;

          const tell = ext.options.onRefused;
          const local = transactions.filter(tracked);
          /** The dispatch, taken back step by step: `tr.doc` is the document before it again. */
          const takenBack = (): Transaction | null => {
            const back = newState.tr.setMeta(suggestionKey, true);
            try {
              for (let i = transactions.length - 1; i >= 0; i--) {
                const t = transactions[i]!;
                for (let j = t.steps.length - 1; j >= 0; j--) back.step(t.steps[j]!.invert(t.docs[j]!));
              }
              if (!back.doc.eq(_oldState.doc)) return null;
              try { back.setSelection(Selection.fromJSON(back.doc, _oldState.selection.toJSON())); } catch { /* the mapped selection stands */ }
              return back;
            } catch { return null; }
          };
          // REFUSED: a removal across the boundary of a table cell or a column. No put-back can be
          // faithful there (the edit leaves an emptied cell behind and the removed part would come
          // back as a table of its own, or as a cell too many) — and Reject could never undo that.
          // Nothing changes, and the person is told.
          if (isolated) {
            const back = takenBack();
            if (back) {
              if (tell) queueMicrotask(() => tell(SUGGESTION_ISOLATED_MESSAGE));
              return back;
            }
          }
          // IN PLACE: one replacement whose removed part crosses NESTING DEPTH (from a paragraph
          // into the first item of the list below, out of a quote…). ProseMirror carries the rest
          // of the last block into the first one and drops the emptied blocks, so a put-back would
          // have to rebuild them. Instead the dispatch is taken back and redone the tracked way:
          // the removed text is struck where it stands (no block is touched — as Backspace over a
          // selection does) and what was put in goes right after it, marked inserted. Reject
          // gives the page back exactly; Accept removes the struck text as the edit would have.
          // The same when the rest of the dispatch only made block boundaries (Enter over such a
          // selection: the blocks are separate already, so the text is struck and the caret moves
          // to the start of what follows). Anything else in several steps (a drop that also puts
          // the text elsewhere) goes through the put-back below.
          const spot = deep.at;
          const one = steps === 1;
          let onlyBoundaries = !one;
          if (!one) for (const { k: at, from, to } of added) {
            const x = all.slice(at + 1).map(from, 1);
            const y = all.slice(at + 1).map(to, -1);
            if (y > x) newState.doc.nodesBetween(x, y, (node) => { if (node.isLeaf) onlyBoundaries = false; return onlyBoundaries; });
          }
          if (spot && spot.first && !isolated && (one || onlyBoundaries) && local.length === 1 && removed.length === 1 && !heldOf(newState).length) {
            // What the one step put in where the removed part was (not what it carried along,
            // and not the block boundaries it rebuilt behind it): content only.
            const raw = one && spot.put[1] > spot.put[0] ? newState.doc.slice(spot.put[0], spot.put[1]) : null;
            let holds = false;
            raw?.content.descendants((node) => { if (node.isLeaf) holds = true; return !holds; });
            const put = holds ? raw : null;
            const back = takenBack();
            if (back) {
              const result = strikeInPlace(back, spot.a, spot.b, { insertion, deletion, userName: user.name });
              // A plain removal (cut): the caret goes BEFORE the struck text, as everywhere.
              let caret = one && removed[0]!.pure ? spot.a : result.end;
              let placed = true;
              if (put && put.content.size) {
                const before = back.steps.length;
                try {
                  // Inline content goes in as it is; anything with blocks is fitted (`replaceRange`).
                  if (put.openStart === 0 && put.openEnd === 0 && !put.content.firstChild?.isBlock) back.replaceWith(result.end, result.end, put.content);
                  else back.replaceRange(result.end, result.end, put);
                  const end = back.mapping.slice(before).map(result.end, 1);
                  for (const [x, y] of textRuns(back.doc, result.end, end)) {
                    back.addMark(x, y, insertion.create({ user: user.name, color: user.color }));
                    back.removeMark(x, y, deletion);
                  }
                  caret = end;
                } catch { placed = false; }
              }
              if (placed) {
                try {
                  const $caret = back.doc.resolve(Math.min(caret, back.doc.content.size));
                  back.setSelection($caret.parent.inlineContent ? TextSelection.create(back.doc, $caret.pos) : Selection.near($caret, -1));
                } catch { /* the selection stands */ }
                if (tell) for (const message of [result.refused && SUGGESTION_REFUSED_MESSAGE, result.untracked && SUGGESTION_CODE_MESSAGE].filter((m): m is string => !!m)) queueMicrotask(() => tell(message));
                return back;
              }
            }
          }

          const tr = newState.tr.setMeta(suggestionKey, true);
          for (const { k: at, from, to } of added) {
            const rest = all.slice(at + 1);
            const a = rest.map(from, 1);
            const b = rest.map(to, -1);
            if (b <= a) continue;
            // On TEXT only (a chip or a line break put in carries no mark — see `textRuns`).
            for (const [x, y] of textRuns(tr.doc, a, b)) {
              tr.addMark(x, y, insertion.create({ user: user.name, color: user.color }));
              // New text typed at the edge of struck text inherits its (inclusive) mark.
              tr.removeMark(x, y, deletion);
            }
            // A leaf that inherited a suggestion mark from where it was put in loses it again.
            tr.doc.nodesBetween(a, b, (node, pos) => {
              if (node.isLeaf && !node.isText && node.marks.some((m) => m.type === insertion || m.type === deletion)) { tr.removeMark(pos, pos + node.nodeSize, insertion); tr.removeMark(pos, pos + node.nodeSize, deletion); }
            });
          }

          // While an IME composition is running the document around the composing text
          // must not be redrawn (the browser would end the composition and commit a
          // half-typed character): what the composition replaced is HELD in plugin state
          // and put back when it ends (`releaseHeld`), or with the next ordinary edit.
          const composing = transactions.some((t) => tracked(t) && t.getMeta("composition") !== undefined);
          const here: Array<{ at: number; slice: Slice; pure: boolean; order: number; rejoin?: boolean[] }> = removed.map((r, order) => ({ at: all.slice(r.k + 1).map(r.pos, -1), slice: r.slice, pure: r.pure, order, rejoin: r.rejoin }));
          if (composing) {
            if (here.length) tr.setMeta(suggestionKey, { hold: here.map(({ at, slice }) => ({ pos: at, slice })) });
            return tr.steps.length || here.length ? tr : null;
          }
          // Held text from a composition that ended without our release (positions already
          // carried through this dispatch by the plugin state).
          const held = heldOf(newState);
          if (held?.length) {
            held.forEach((h, i) => here.push({ at: h.pos, slice: h.slice, pure: false, order: -1 - i }));
            tr.setMeta(suggestionKey, { release: true });
          }
          const arrivedIn = added.map(({ k: at, from, to }): [number, number] => [all.slice(at + 1).map(from, 1), all.slice(at + 1).map(to, -1)]);
          const result = putBack(tr, here, { selection: newState.selection, insertion, deletion, userName: user.name, moved: arrived, arrivedIn });
          if (tell) for (const message of putBackMessages(result)) queueMicrotask(() => tell(message));
          return tr.steps.length || result.caret || held?.length ? tr : null;
        },
        props: {
          handleKeyDown(view, event) {
            if (!ext.storage.suggesting) return false;
            const isBack = event.key === "Backspace";
            const isDel = event.key === "Delete";
            if (!isBack && !isDel) return false;

            const { state } = view;
            const insertion = state.schema.marks.insertion;
            const deletion = state.schema.marks.deletion;
            if (!deletion || !insertion) return false;
            const { user } = ext.options;
            const { from, to, empty } = state.selection;
            const size = state.doc.content.size;

            // Mark [a,b] as a tracked deletion (or truly remove if it's the
            // user's own pending insertion), then place the cursor at `caret`.
            const strike = (a: number, b: number, caret: number) => {
              if (a < 0 || b > size || a >= b) return false;
              // Text that cannot carry the mark (inline code, a code block): let the key do its
              // ordinary work — the removal is then applied directly, with the notice (appendTransaction).
              // …and so does a selection that MIXES such text with ordinary text (the ordinary part is
              // then struck, the code part removed, with the notice). A leaf that is not text (a chip,
              // an image, a line break) cannot be struck at all: the key is refused, and says so.
              let unmarkable = false;
              let leaf = false;
              state.doc.nodesBetween(a, b, (node, _pos, parent) => {
                if (node.isText) { if (!canStrike(node, parent, deletion)) unmarkable = true; }
                else if (node.isLeaf) leaf = true;
              });
              if (leaf) { ext.options.onRefused?.(SUGGESTION_REFUSED_MESSAGE); return true; }
              if (unmarkable) return false;
              const tr = state.tr.setMeta(suggestionKey, true); // not an insertion
              if (rangeHasOnlyOwnInsertion(state, a, b, user.name)) {
                tr.delete(a, b);
                tr.setSelection(TextSelection.create(tr.doc, a));
              } else {
                for (const [x, y] of textRuns(state.doc, a, b)) tr.addMark(x, y, deletion.create({ user: user.name, color: "#ef4444" }));
                const c = Math.min(Math.max(caret, 0), tr.doc.content.size);
                tr.setSelection(TextSelection.create(tr.doc, c));
              }
              view.dispatch(tr);
              return true;
            };

            if (!empty) return strike(from, to, from);
            if (isBack) return strike(from - 1, from, from - 1); // cursor moves before the struck char
            return strike(from, from + 1, from + 1); // forward delete advances over struck text
          },
        },
      }),
    ];
  },
});
