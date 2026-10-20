import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * `@` trigger for the mention menu (NP-RF-02). Reports `{active, query, from, to}`
 * to the React layer (MentionMenu). Never opens:
 *  - while an IME composition is in progress (`view.composing`);
 *  - inside a word or an email address (`ada@example.com`): the character before
 *    `@` must be the start of the block, whitespace or opening punctuation;
 *  - inside inline code or a code block.
 * The query may contain single spaces ("tomorrow 9am", "next monday"), up to 40
 * characters; two spaces, a newline or a second `@` closes it.
 */
export interface MentionSuggestState {
  active: boolean;
  query: string;
  from: number;
  to: number;
}

export const mentionSuggestKey = new PluginKey("mentionSuggest");
const CLOSED: MentionSuggestState = { active: false, query: "", from: 0, to: 0 };

/** Dismiss the menu until the user types something new after `from`. */
export function dismissMentionSuggest(editor: { storage: unknown }, from: number): void {
  const s = (editor.storage as Record<string, { dismissedAt?: number }>).mentionSuggest;
  if (s) s.dismissedAt = from;
}

export const MentionSuggest = Extension.create<{ onStateChange: (s: MentionSuggestState) => void }, { dismissedAt: number }>({
  name: "mentionSuggest",
  addOptions() {
    return { onStateChange: () => {} };
  },
  addStorage() {
    return { dismissedAt: -1 };
  },
  addProseMirrorPlugins() {
    const onStateChange = this.options.onStateChange;
    const storage = this.storage;
    const editor = this.editor;
    let last: MentionSuggestState = CLOSED;
    const emit = (next: MentionSuggestState) => {
      if (next.active === last.active && next.query === last.query && next.from === last.from && next.to === last.to) return;
      last = next;
      onStateChange(next);
    };
    return [
      new Plugin({
        key: mentionSuggestKey,
        view() {
          return {
            update(view) {
              const { selection } = view.state;
              if (!editor.isEditable || view.composing || !selection.empty) return emit(CLOSED);
              const $pos = selection.$from;
              if ($pos.parent.type.spec.code || $pos.marks().some((m) => m.type.name === "code")) return emit(CLOSED);
              // Text before the caret in this block (atoms count as one char, like positions).
              const before = $pos.parent.textBetween(0, $pos.parentOffset, "\n", "￼");
              const at = before.lastIndexOf("@");
              if (at < 0) return emit(CLOSED);
              const prev = at > 0 ? before[at - 1]! : "";
              if (prev && !/[\s([{"'“‘￼]/.test(prev)) return emit(CLOSED);
              const query = before.slice(at + 1);
              if (query.length > 40 || /\n|\s\s|@|￼/.test(query) || /^\s/.test(query)) return emit(CLOSED);
              const from = $pos.start() + at;
              if (storage.dismissedAt === from) return emit(CLOSED);
              if (storage.dismissedAt >= 0 && storage.dismissedAt !== from) storage.dismissedAt = -1;
              emit({ active: true, query, from, to: $pos.pos });
            },
            destroy() {
              emit(CLOSED);
            },
          };
        },
      }),
    ];
  },
});
