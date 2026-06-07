import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

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
        props: {
          // Typed text → insertion mark (instead of a plain insert).
          handleTextInput(view, from, to, text) {
            if (!ext.storage.suggesting) return false;
            const { state } = view;
            const insertion = state.schema.marks.insertion;
            const deletion = state.schema.marks.deletion;
            if (!insertion) return false;
            const { user } = ext.options;
            const tr = state.tr;
            // Replacing a selection: mark it deleted rather than removing it.
            if (from !== to && deletion) {
              tr.addMark(from, to, deletion.create({ user: user.name, color: "#ef4444" }));
            }
            const at = to;
            tr.insertText(text, at);
            tr.addMark(at, at + text.length, insertion.create({ user: user.name, color: user.color }));
            tr.removeStoredMark(deletion!);
            view.dispatch(tr);
            return true;
          },

          handleKeyDown(view, event) {
            if (!ext.storage.suggesting) return false;
            const isBack = event.key === "Backspace";
            const isDel = event.key === "Delete";
            if (!isBack && !isDel) return false;

            const { state } = view;
            const insertion = state.schema.marks.insertion;
            const deletion = state.schema.marks.deletion;
            if (!deletion) return false;
            const { user } = ext.options;
            const { from, to, empty } = state.selection;

            const markDeleted = (a: number, b: number) => {
              if (a < 0 || b > state.doc.content.size || a >= b) return false;
              const tr = state.tr;
              // If the target is the user's own pending insertion, truly remove it.
              let onlyInsertion = true;
              state.doc.nodesBetween(a, b, (node) => {
                if (node.isText && insertion && !node.marks.some((m) => m.type === insertion)) onlyInsertion = false;
              });
              if (onlyInsertion && insertion) tr.delete(a, b);
              else tr.addMark(a, b, deletion.create({ user: user.name, color: "#ef4444" }));
              view.dispatch(tr);
              return true;
            };

            if (!empty) return markDeleted(from, to);
            if (isBack) return markDeleted(from - 1, from);
            return markDeleted(from, from + 1);
          },
        },
      }),
    ];
  },
});
