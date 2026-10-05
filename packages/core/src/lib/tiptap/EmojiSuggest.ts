import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { EmojiMenu } from "./EmojiMenu";
import { emojiChar, emojiForShortcode, loadEmojiSet, rememberEmoji } from "./emojiData";

/**
 * Inline emoji (NP-ED-27). Typing `:` plus two characters opens a list filtered by
 * shortcode, name and keyword; ↑/↓ move, ↵/Tab insert the CHARACTER (plain text —
 * no node, no schema change), Esc leaves what was typed. `:smile:` typed in full
 * converts on the closing colon. `/emoji` (or `openEmojiPicker`) opens the full picker.
 *
 * Never opens:
 *  - inside a code block, inline code or a link;
 *  - unless the `:` starts the block or follows whitespace / an opening bracket or
 *    quote — so not in a time (`10:30`), a URL (`http://`) or a word (`a:b`);
 *  - when the first character after `:` is a digit (` :30`);
 *  - while an IME composition is in progress (re-checked after `compositionend`,
 *    like the slash menu).
 *
 * Self-contained: the list and the picker render into their own React root on
 * <body>, so an editor only has to list the extension.
 */
export interface EmojiSuggestState {
  active: boolean;
  query: string;
  from: number; // position of the ":"
  to: number; // the caret
}
const CLOSED: EmojiSuggestState = { active: false, query: "", from: 0, to: 0 };
export const emojiSuggestKey = new PluginKey("emojiSuggest");
export const EMOJI_PICKER_EVENT = "prism:emoji-picker";

const OPENERS = " \t\n ([{\"'“‘￼";
const isQueryChar = (ch: string) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "+" || ch === "-";
const isDigit = (ch: string) => ch >= "0" && ch <= "9";

/** `:query` ending at the caret, or null. `before` is the block's text up to the caret. */
export function emojiTrigger(before: string, min = 2): { at: number; query: string } | null {
  const at = before.lastIndexOf(":");
  if (at < 0) return null;
  if (at > 0 && !OPENERS.includes(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length < min || query.length > 40 || isDigit(query[0] ?? "")) return null;
  for (const ch of query) if (!isQueryChar(ch)) return null;
  return { at, query };
}

function plainContext(view: EditorView, editor: Editor): boolean {
  const { selection } = view.state;
  if (!editor.isEditable || !selection.empty) return false;
  const $pos = selection.$from;
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false;
  return !$pos.marks().some((m) => m.type.spec.code || m.type.name === "code" || m.type.name === "link");
}

/** Close the list for the `:` at `from` until that trigger is gone (Esc). */
export function dismissEmojiSuggest(editor: { storage: unknown }, from: number): void {
  const s = (editor.storage as Record<string, { dismissedAt?: number } | undefined>).emojiSuggest;
  if (s) s.dismissedAt = from;
}

/** Open the full emoji picker at the caret (the `/emoji` command). */
export function openEmojiPicker(editor: Editor): void {
  editor.view.dom.dispatchEvent(new CustomEvent(EMOJI_PICKER_EVENT));
}

export const EmojiSuggest = Extension.create<Record<string, never>, { dismissedAt: number }>({
  name: "emojiSuggest",
  addStorage() {
    return { dismissedAt: -1 };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage;
    let recheck: ((view: EditorView) => void) | null = null;
    return [
      new Plugin({
        key: emojiSuggestKey,
        props: {
          handleDOMEvents: {
            // A ":" produced BY a composition is skipped while composing; look again once it ends
            // (this runs before ProseMirror clears `view.composing`, hence the delay).
            compositionend: (view) => {
              window.setTimeout(() => { if (!view.isDestroyed) recheck?.(view); }, 60);
              return false;
            },
          },
          // `:name:` — the closing colon converts an exact shortcode.
          handleTextInput(view, from, to, text) {
            if (text !== ":" || from !== to || view.composing || !plainContext(view, editor)) return false;
            const $pos = view.state.selection.$from;
            const before = $pos.parent.textBetween(0, $pos.parentOffset, "\n", "￼");
            const trigger = emojiTrigger(before);
            const entry = trigger && emojiForShortcode(trigger.query);
            if (!trigger || !entry) return false;
            const start = $pos.start() + trigger.at;
            view.dispatch(view.state.tr.insertText(emojiChar(entry), start, from).scrollIntoView());
            rememberEmoji(entry.u);
            return true;
          },
        },
        view(view) {
          let host: HTMLElement | null = null;
          let root: Root | null = null;
          let state: EmojiSuggestState = CLOSED;
          let picker = false;
          const render = () => {
            if (!root) {
              if (!state.active && !picker) return;
              host = document.createElement("div");
              host.setAttribute("data-emoji-suggest", "");
              document.body.appendChild(host);
              root = createRoot(host);
            }
            root.render(createElement(EmojiMenu, { editor, state, picker, onClosePicker: () => { picker = false; render(); } }));
          };
          const emit = (next: EmojiSuggestState) => {
            if (next.active === state.active && next.query === state.query && next.from === state.from && next.to === state.to) return;
            if (next.active && !state.active) void loadEmojiSet(); // the full set: a lazy chunk, first needed now
            state = next;
            render();
          };
          const openPicker = () => { picker = true; emit(CLOSED); render(); };
          view.dom.addEventListener(EMOJI_PICKER_EVENT, openPicker);
          const pluginView = {
            update(v: EditorView) {
              // Never OPENS mid-composition; an open list keeps filtering (soft keyboards compose every word).
              if (v.composing && !state.active) return;
              if (!plainContext(v, editor)) return emit(CLOSED);
              const $pos = v.state.selection.$from;
              const before = $pos.parent.textBetween(0, $pos.parentOffset, "\n", "￼");
              const trigger = emojiTrigger(before);
              if (!trigger) { storage.dismissedAt = -1; return emit(CLOSED); }
              const from = $pos.start() + trigger.at;
              if (storage.dismissedAt === from) return emit(CLOSED);
              storage.dismissedAt = -1;
              emit({ active: true, query: trigger.query, from, to: $pos.pos });
            },
            destroy() {
              view.dom.removeEventListener(EMOJI_PICKER_EVENT, openPicker);
              recheck = null;
              const r = root;
              const h = host;
              root = null;
              host = null;
              // Not inside React's own commit (the editor is torn down from an effect cleanup).
              window.setTimeout(() => { r?.unmount(); h?.remove(); }, 0);
            },
          };
          recheck = (v) => pluginView.update(v);
          return pluginView;
        },
      }),
    ];
  },
});
