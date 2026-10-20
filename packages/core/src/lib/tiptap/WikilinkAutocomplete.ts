import { Extension } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
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
    let recheck: ((view: EditorView) => void) | null = null;

    return [
      new Plugin({
        // A trigger PRODUCED by a composition (IME half-width "/", some Android keyboards) is skipped
        // by `update` while composing, and ProseMirror is not guaranteed to call `update` again once
        // the composition ends. Re-run the same check shortly after `compositionend` (this handler
        // runs before ProseMirror clears `view.composing`, hence the delay).
        props: {
          handleDOMEvents: {
            compositionend: (view) => {
              window.setTimeout(() => { if (!view.isDestroyed) recheck?.(view); }, 60);
              return false;
            },
          },
        },
        view() {
          const pluginView = {
            update(view: EditorView) {
              const { state } = view;
              const { selection } = state;

              if (!selection.empty) {
                if (lastActive) {
                  lastActive = false;
                  onStateChange({ active: false, query: "", from: 0, to: 0, trigger: "" });
                }
                return;
              }

              // NP-AX-08: never open mid-composition (see SlashCommand); an open list keeps filtering.
              if (view.composing && !lastActive) return;

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
          recheck = (view) => pluginView.update(view);
          return pluginView;
        },
      }),
    ];
  },
});
