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

/**
 * Case-insensitive matches inside text nodes, with offsets taken from the
 * ORIGINAL text. (Lower-casing the haystack shifts offsets: "İ".toLowerCase()
 * is two code units, so every later match would be off by one.) Matches never
 * touch a `[[wikilink]]` span — its target is hidden text, and replacing inside
 * it would silently re-point the link — and atoms (mentions, files, embeds)
 * have no text to match.
 */
export function findMatchesInText(text: string, query: string): Array<{ from: number; to: number }> {
  if (!query) return [];
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const links: Array<[number, number]> = [];
  for (let i = text.indexOf("[["); i !== -1; i = text.indexOf("[[", i + 2)) {
    const end = text.indexOf("]]", i + 2);
    if (end === -1) break;
    links.push([i, end + 2]);
    i = end;
  }
  const out: Array<{ from: number; to: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const from = m.index;
    const to = from + m[0].length;
    if (!links.some(([a, b]) => from < b && to > a)) out.push({ from, to });
  }
  return out;
}

function findMatches(state: EditorState, query: string): SearchMatch[] {
  if (!query) return [];
  const matches: SearchMatch[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const m of findMatchesInText(node.text, query)) matches.push({ from: pos + m.from, to: pos + m.to });
  });
  return matches;
}

export const SearchHighlight = Extension.create({
  name: "searchHighlight",
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
  // An empty replacement deletes exactly the match (`insertText("")` would call
  // deleteRange, which removes the whole block when the match is all of its text).
  const tr = editor.state.tr.setStoredMarks(null);
  if (replacement) tr.insertText(replacement, m.from, m.to); else tr.delete(m.from, m.to);
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
  for (let i = ps.matches.length - 1; i >= 0; i--) {
    const m = ps.matches[i];
    if (replacement) tr.setStoredMarks(null).insertText(replacement, m.from, m.to); else tr.delete(m.from, m.to);
  }
  editor.view.dispatch(tr);
  return ps.matches.length;
}
