import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

/**
 * Inline suggested edits ("track changes"), Google-Docs style — the client-side
 * BEHAVIOR. In suggest mode, typing wraps text in the `insertion` mark and
 * Backspace/Delete applies the `deletion` mark instead of removing. Accept/reject
 * resolve them to clean text. The marks themselves are in ./suggestionMarks
 * (shared schema, isomorphic). This file uses the DOM (handleKeyDown) and is
 * client-only — never imported by the Node server.
 */

export interface SuggestionUser {
  name: string;
  color: string;
}

const suggestionKey = new PluginKey("suggestionMode");

import type { EditorState } from "@tiptap/pm/state";

/** The contiguous suggestion run (insertion or deletion) covering `pos`, or null.
 *  Used for per-suggestion accept/reject and to show the inline bubble. */
export function suggestionAt(
  state: EditorState,
  pos: number,
): { type: "insertion" | "deletion"; from: number; to: number } | null {
  const ins = state.schema.marks.insertion;
  const del = state.schema.marks.deletion;
  const size = state.doc.content.size;
  const has = (a: number, b: number, t: typeof ins) =>
    a >= 0 && b <= size && a < b && state.doc.rangeHasMark(a, b, t);
  let mark: typeof ins | null = null;
  let type: "insertion" | "deletion" | null = null;
  if (ins && (has(pos, pos + 1, ins) || has(pos - 1, pos, ins))) {
    mark = ins;
    type = "insertion";
  } else if (del && (has(pos, pos + 1, del) || has(pos - 1, pos, del))) {
    mark = del;
    type = "deletion";
  }
  if (!mark || !type) return null;
  let from = pos;
  while (from > 0 && state.doc.rangeHasMark(from - 1, from, mark)) from--;
  let to = pos;
  while (to < size && state.doc.rangeHasMark(to, to + 1, mark)) to++;
  return { type, from, to };
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
}

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
          if (dispatch) dispatch(tr);
          return true;
        },

      // Accept just the suggestion at the cursor (Google-Docs per-change accept).
      acceptSuggestion:
        () =>
        ({ state, tr, dispatch }) => {
          const r = suggestionAt(state, state.selection.from);
          if (!r) return false;
          if (r.type === "deletion") tr.delete(r.from, r.to);
          else tr.removeMark(r.from, r.to, state.schema.marks.insertion!);
          if (dispatch) dispatch(tr);
          return true;
        },

      // Reject just the suggestion at the cursor.
      rejectSuggestion:
        () =>
        ({ state, tr, dispatch }) => {
          const r = suggestionAt(state, state.selection.from);
          if (!r) return false;
          if (r.type === "insertion") tr.delete(r.from, r.to);
          else tr.removeMark(r.from, r.to, state.schema.marks.deletion!);
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
        // Mark newly-inserted text as an insertion AFTER ProseMirror inserts it
        // (in the same dispatch). This is the canonical track-changes pattern:
        // it avoids manually inserting in handleTextInput (which, with
        // contenteditable, diverges from the DOM and feedback-loops). Adjacent
        // inserts share the mark and merge into one run. Remote Yjs syncs and our
        // own appended transactions are skipped, so collaborators' edits and our
        // mark-pass aren't re-marked.
        appendTransaction(transactions, _oldState, newState) {
          if (!ext.storage.suggesting) return null;
          const insertion = newState.schema.marks.insertion;
          if (!insertion) return null;
          const relevant = transactions.filter(
            (t) => t.docChanged && !t.getMeta(suggestionKey) && !t.getMeta(ySyncPluginKey),
          );
          if (!relevant.length) return null;
          const { user } = ext.options;
          const ranges: Array<[number, number]> = [];
          for (const t of relevant) {
            t.mapping.maps.forEach((map) => {
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd > newStart) ranges.push([newStart, newEnd]);
              });
            });
          }
          if (!ranges.length) return null;
          const tr = newState.tr.setMeta(suggestionKey, true);
          for (const [a, b] of ranges) {
            tr.addMark(a, b, insertion.create({ user: user.name, color: user.color }));
          }
          return tr;
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
              const tr = state.tr.setMeta(suggestionKey, true); // not an insertion
              if (rangeHasOnlyOwnInsertion(state, a, b, user.name)) {
                tr.delete(a, b);
                tr.setSelection(TextSelection.create(tr.doc, a));
              } else {
                tr.addMark(a, b, deletion.create({ user: user.name, color: "#ef4444" }));
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
