import { Extension } from "@tiptap/core";
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

    const clear = () => {
      if (lastActive) {
        lastActive = false;
        onStateChange({ active: false, query: "", from: 0, to: 0 });
      }
    };

    return [
      new Plugin({
        view() {
          return {
            update(view) {
              const { selection } = view.state;
              if (!selection.empty) return clear();

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
        },
      }),
    ];
  },
});
