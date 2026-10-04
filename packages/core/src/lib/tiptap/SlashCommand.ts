import { Extension } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { Plugin } from "@tiptap/pm/state";

/**
 * Detects a `/` slash-command trigger (Notion/Anytype style) and surfaces the
 * query to the React layer, which renders the block-type menu. Mirrors the
 * WikilinkAutocomplete pattern: trigger when `/` starts a block or follows
 * whitespace and the query has no spaces.
 */

export interface SlashCommandState {
  active: boolean;
  query: string;
  from: number; // position of the "/"
  to: number; // cursor position
}

export interface SlashCommandOptions {
  onStateChange: (state: SlashCommandState) => void;
}

/**
 * Close the menu for the `/` at `from` until that trigger goes away (Escape):
 * typing on, or moving the caret, must not bring it back — Notion behaviour.
 */
export function dismissSlashCommand(editor: { storage: unknown }, from: number): void {
  const storage = (editor.storage as Record<string, { dismissedFrom: number | null } | undefined>).slashCommand;
  if (storage) storage.dismissedFrom = from;
}

export const SlashCommand = Extension.create<SlashCommandOptions, { dismissedFrom: number | null }>({
  name: "slashCommand",

  addOptions() {
    return { onStateChange: () => {} };
  },

  addStorage() {
    return { dismissedFrom: null };
  },

  addProseMirrorPlugins() {
    const onStateChange = this.options.onStateChange;
    const storage = this.storage;
    let lastActive = false;
    let recheck: ((view: EditorView) => void) | null = null;

    const clear = () => {
      if (lastActive) {
        lastActive = false;
        onStateChange({ active: false, query: "", from: 0, to: 0 });
      }
    };

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
              const { selection } = view.state;
              if (!selection.empty) return clear();
              // NP-AX-08: a "/" that is part of an IME composition is not a command yet — the menu never
              // OPENS mid-composition (it may open when the text is committed). A menu that was already
              // open keeps filtering: soft keyboards compose every word of the query.
              if (view.composing && !lastActive) return;

              const $from = selection.$from;
              const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);
              const slashIdx = textBefore.lastIndexOf("/");
              if (slashIdx >= 0) {
                const charBefore = slashIdx > 0 ? textBefore[slashIdx - 1] : "";
                const atStartOrSpace = slashIdx === 0 || charBefore === " " || charBefore === "\n";
                const query = textBefore.slice(slashIdx + 1);
                if (atStartOrSpace && !query.includes(" ") && query.length <= 30) {
                  const from = $from.start() + slashIdx;
                  if (storage.dismissedFrom === from) return clear();
                  lastActive = true;
                  onStateChange({
                    active: true,
                    query,
                    from,
                    to: $from.pos,
                  });
                  return;
                }
              }
              storage.dismissedFrom = null; // the dismissed trigger is gone
              clear();
            },
          };
          recheck = (view) => pluginView.update(view);
          return pluginView;
        },
      }),
    ];
  },
});
