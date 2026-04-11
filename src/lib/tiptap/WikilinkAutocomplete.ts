import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * TipTap extension that detects when the user types [[ and exposes
 * the autocomplete state for the React dropdown to read.
 */

export interface WikilinkAutocompleteState {
  active: boolean;
  query: string;
  from: number;
  to: number;
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
            return { active: false, query: "", from: 0, to: 0 };
          },

          apply(tr, _prev) {
            const { selection } = tr;
            if (!selection.empty) return { active: false, query: "", from: 0, to: 0 };

            const pos = selection.$from;
            const textBefore = pos.parent.textContent.slice(0, pos.parentOffset);

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
                };
              }
            }

            return { active: false, query: "", from: 0, to: 0 };
          },
        },
      }),
    ];
  },
});
