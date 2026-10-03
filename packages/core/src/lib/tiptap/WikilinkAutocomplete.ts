import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/**
 * TipTap extension that detects the [[ trigger for note autocomplete.
 * Uses a callback to notify the React layer instead of plugin state reading.
 */

export interface WikilinkAutocompleteState {
  active: boolean;
  query: string;
  from: number;
  to: number;
  trigger: "@" | "[[" | "";
}

export interface WikilinkAutocompleteOptions {
  onStateChange: (state: WikilinkAutocompleteState) => void;
}

// Legacy export for backward compatibility — no longer used
export function getWikilinkAutocompleteState(_state: unknown): WikilinkAutocompleteState | null {
  return null;
}

export const WikilinkAutocomplete = Extension.create<WikilinkAutocompleteOptions>({
  name: "wikilinkAutocomplete",

  addOptions() {
    return {
      onStateChange: () => {},
    };
  },

  addProseMirrorPlugins() {
    const onStateChange = this.options.onStateChange;
    let lastActive = false;

    return [
      new Plugin({
        view() {
          return {
            update(view) {
              const { state } = view;
              const { selection } = state;

              if (!selection.empty) {
                if (lastActive) {
                  lastActive = false;
                  onStateChange({ active: false, query: "", from: 0, to: 0, trigger: "" });
                }
                return;
              }

              const pos = selection.$from;
              const textBefore = pos.parent.textContent.slice(0, pos.parentOffset);

              // Check [[ trigger
              const lastOpen = textBefore.lastIndexOf("[[");
              const lastClose = textBefore.lastIndexOf("]]");
              if (lastOpen >= 0 && lastOpen > lastClose) {
                const query = textBefore.slice(lastOpen + 2);
                if (query.length <= 60) {
                  lastActive = true;
                  onStateChange({
                    active: true,
                    query,
                    from: pos.start() + lastOpen,
                    to: pos.pos,
                    trigger: "[[",
                  });
                  return;
                }
              }

              // `@` is the mention menu now (MentionSuggest), not a wikilink trigger.

              // No trigger active
              if (lastActive) {
                lastActive = false;
                onStateChange({ active: false, query: "", from: 0, to: 0, trigger: "" });
              }
            },
          };
        },
      }),
    ];
  },
});
