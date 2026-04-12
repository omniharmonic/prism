import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * TipTap extension that detects when the user types @ or [[ and exposes
 * the autocomplete state for the React dropdown to read.
 *
 * Two triggers:
 *   @ — Notion-style mention. Inserts a styled @mention link.
 *   [[ — Wiki-style link. Inserts [[path/to/note]].
 */

export interface WikilinkAutocompleteState {
  active: boolean;
  query: string;
  from: number;
  to: number;
  trigger: "@" | "[[" | "";
}

const PLUGIN_KEY = new PluginKey<WikilinkAutocompleteState>("wikilink-autocomplete");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getWikilinkAutocompleteState(state: any): WikilinkAutocompleteState | null {
  return PLUGIN_KEY.getState(state) || null;
}

export const WikilinkAutocomplete = Extension.create({
  name: "wikilinkAutocomplete",

  addProseMirrorPlugins() {
    return [
      new Plugin<WikilinkAutocompleteState>({
        key: PLUGIN_KEY,

        state: {
          init() {
            return { active: false, query: "", from: 0, to: 0, trigger: "" as const };
          },

          apply(tr, _prev) {
            const { selection } = tr;
            if (!selection.empty) return { active: false, query: "", from: 0, to: 0, trigger: "" as const };

            const pos = selection.$from;
            const textBefore = pos.parent.textContent.slice(0, pos.parentOffset);

            // Check for [[ trigger (wiki-style)
            const lastOpen = textBefore.lastIndexOf("[[");
            const lastClose = textBefore.lastIndexOf("]]");
            if (lastOpen >= 0 && lastOpen > lastClose) {
              const query = textBefore.slice(lastOpen + 2);
              if (query.length <= 60) {
                return {
                  active: true,
                  query,
                  from: pos.start() + lastOpen,
                  to: pos.pos,
                  trigger: "[[",
                };
              }
            }

            // Check for @ trigger (Notion-style)
            // Must be at start of word (preceded by space, newline, or start of text)
            const lastAt = textBefore.lastIndexOf("@");
            if (lastAt >= 0) {
              // Check that @ is at word boundary (not inside an email)
              const charBefore = lastAt > 0 ? textBefore[lastAt - 1] : " ";
              if (charBefore === " " || charBefore === "\n" || lastAt === 0) {
                const query = textBefore.slice(lastAt + 1);
                // Don't trigger if there's a space in the query (user finished typing)
                if (query.length <= 60 && !query.includes(" ")) {
                  return {
                    active: true,
                    query,
                    from: pos.start() + lastAt,
                    to: pos.pos,
                    trigger: "@",
                  };
                }
              }
            }

            return { active: false, query: "", from: 0, to: 0, trigger: "" as const };
          },
        },
      }),
    ];
  },
});
