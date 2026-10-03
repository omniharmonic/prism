import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";

/**
 * TipTap extension that highlights all matches of a query string in the document.
 * Mirrors the pattern used by WikilinkDecoration — the plugin state tracks the
 * current query + active match index, and `decorations` derives a DecorationSet
 * from the live doc each time plugin state changes.
 *
 * Important: decorations do NOT mutate the document. We communicate updates
 * via transactions tagged with `tr.setMeta(searchHighlightKey, ...)`. These
 * transactions have no steps, so TipTap's `onUpdate` (which gates auto-save)
 * does not fire.
 */

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchHighlightState {
  query: string;
  matches: SearchMatch[];
  activeIndex: number;
}

export const searchHighlightKey = new PluginKey<SearchHighlightState>(
  "search-highlight",
);

export interface SearchHighlightMeta {
  query?: string;
  activeIndex?: number;
  clear?: boolean;
}

function findMatches(state: EditorState, query: string): SearchMatch[] {
  if (!query) return [];
  const matches: SearchMatch[] = [];
  const needle = query.toLowerCase();
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = node.text.toLowerCase();
    let idx = 0;
    while (idx <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, idx);
      if (found === -1) break;
      matches.push({ from: pos + found, to: pos + found + needle.length });
      idx = found + needle.length;
    }
  });
  return matches;
}

export const SearchHighlight = Extension.create({
  name: "searchHighlight",
  // Above Highlight (whose Mod-Shift-H toggles a highlight mark): in Prism
  // ⌘⇧H opens find-and-replace. The host's keydown listener opens the bar; this
  // only claims the key so no stray stored mark lands on the next replacement.
  priority: 1000,
  addKeyboardShortcuts() {
    return { "Mod-Shift-h": () => true };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchHighlightState>({
        key: searchHighlightKey,
        state: {
          init(): SearchHighlightState {
            return { query: "", matches: [], activeIndex: 0 };
          },
          apply(tr: Transaction, prev: SearchHighlightState, _oldState, newState): SearchHighlightState {
            const meta = tr.getMeta(searchHighlightKey) as SearchHighlightMeta | undefined;

            // Handle explicit meta updates first.
            if (meta) {
              if (meta.clear) {
                return { query: "", matches: [], activeIndex: 0 };
              }
              if (typeof meta.query === "string") {
                const matches = findMatches(newState, meta.query);
                const activeIndex = matches.length === 0 ? 0 : Math.min(meta.activeIndex ?? 0, matches.length - 1);
                return { query: meta.query, matches, activeIndex };
              }
              if (typeof meta.activeIndex === "number") {
                if (prev.matches.length === 0) return prev;
                const wrapped = ((meta.activeIndex % prev.matches.length) + prev.matches.length) % prev.matches.length;
                return { ...prev, activeIndex: wrapped };
              }
            }

            // Doc changed — recompute match positions against new doc.
            if (tr.docChanged && prev.query) {
              const matches = findMatches(newState, prev.query);
              const activeIndex = matches.length === 0
                ? 0
                : Math.min(prev.activeIndex, matches.length - 1);
              return { query: prev.query, matches, activeIndex };
            }

            return prev;
          },
        },
        props: {
          decorations(state) {
            const pluginState = searchHighlightKey.getState(state);
            if (!pluginState || !pluginState.query || pluginState.matches.length === 0) {
              return null;
            }
            const decorations: Decoration[] = pluginState.matches.map((m, i) => {
              const isActive = i === pluginState.activeIndex;
              return Decoration.inline(m.from, m.to, {
                class: isActive
                  ? "prism-search-match prism-search-match-active"
                  : "prism-search-match",
              });
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

type ReplaceEditor = { state: EditorState; view: { dispatch: (tr: Transaction) => void } };

/** Replace the match at `index` with `replacement` (one transaction, one undo step). */
export function replaceMatch(editor: ReplaceEditor, index: number, replacement: string): boolean {
  const ps = searchHighlightKey.getState(editor.state);
  const m = ps?.matches[index];
  if (!m) return false;
  // Replacement text takes the marks of the text it replaces, never a stray stored mark.
  const tr = editor.state.tr.setStoredMarks(null).insertText(replacement, m.from, m.to);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Replace every match in ONE transaction, back to front so earlier positions
 * stay valid. One undo step in the plain editor (history) and in a live doc
 * (one Yjs transaction = one Y.UndoManager item). Returns how many changed.
 */
export function replaceAllMatches(editor: ReplaceEditor, replacement: string): number {
  const ps = searchHighlightKey.getState(editor.state);
  if (!ps?.matches.length) return 0;
  const tr = editor.state.tr;
  for (let i = ps.matches.length - 1; i >= 0; i--) tr.setStoredMarks(null).insertText(replacement, ps.matches[i].from, ps.matches[i].to);
  editor.view.dispatch(tr);
  return ps.matches.length;
}
