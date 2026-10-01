import { Mark } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * TipTap extension that renders [[wikilinks]] as clean clickable links.
 * Supports: [[target]], [[path/to/note]], [[path/to/note|Display Name]]
 * Shows only the clean display name using CSS content replacement.
 *
 * Approach: A single Decoration.inline over the full [[...]] span sets
 * font-size: 0 on the raw text and uses a ::after pseudo-element with
 * content: attr(data-wikilink-display) to show the clean name.
 */

export interface WikilinkOptions {
  onNavigate: (target: string) => void;
}

const WIKILINK_REGEX = /\[\[([^\[\]]+)\]\]/g;

function decorate(doc: ProseMirrorNode) {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const text = node.text;
    WIKILINK_REGEX.lastIndex = 0;
    let match;

    while ((match = WIKILINK_REGEX.exec(text)) !== null) {
      const start = pos + match.index;
      const end = start + match[0].length;
      const inner = match[1];
      const target = inner.includes("|")
        ? inner.split("|")[0].trim()
        : inner.trim();
      const displayName = inner.includes("|")
        ? inner.split("|")[1].trim()
        : inner.split("/").pop()?.trim() || inner.trim();

      decorations.push(
        Decoration.inline(start, end, {
          class: "wikilink",
          "data-wikilink-target": target,
          "data-wikilink-display": displayName,
          title: target,
          role: "link",
          tabindex: "0",
          contenteditable: "false",
          "aria-label": displayName,
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

const wikilinkKey = new PluginKey<DecorationSet>("wikilink-decoration");
export const WikilinkDecoration = (options: WikilinkOptions) => {
  return new Plugin({
    key: wikilinkKey,
    state: {
      init: (_config,state) => decorate(state.doc),
      apply: (transaction,previous) => transaction.docChanged ? decorate(transaction.doc) : previous,
    },
    view(view) {
      // A focused link is a navigation control. Handle it before the editor's
      // Enter/Space keymaps turn the same keystroke into a document edit.
      const keydown = (event: KeyboardEvent) => {
        if (event.isComposing || (event.key !== "Enter" && event.key !== " ")) return;
        const focused = view.dom.ownerDocument.activeElement as HTMLElement|null;
        const element = (event.target as HTMLElement)?.closest?.(".wikilink")
          ?? (focused && view.dom.contains(focused) ? focused.closest(".wikilink") : null);
        const target = element?.getAttribute("data-wikilink-target");
        if (!target) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        options.onNavigate(target);
      };
      view.dom.addEventListener("keydown",keydown,true);
      return {destroy:()=>view.dom.removeEventListener("keydown",keydown,true)};
    },
    props: {
      decorations: state => wikilinkKey.getState(state) ?? DecorationSet.empty,

      handleDOMEvents: {
        click(_view, event) {
          const target = event.target as HTMLElement;
          let el: HTMLElement | null = target;
          for (let i = 0; i < 5 && el; i++) {
            if (el.classList?.contains("wikilink")) {
              const wikilinkTarget = el.getAttribute("data-wikilink-target");
              if (wikilinkTarget) {
                event.preventDefault();
                event.stopPropagation();
                options.onNavigate(wikilinkTarget);
                return true;
              }
            }
            el = el.parentElement;
          }
          return false;
        },
      },
    },
  });
};

export const WikilinkExtension = Mark.create<WikilinkOptions>({
  name: "wikilink",

  addOptions() {
    return {
      onNavigate: () => {},
    };
  },

  addProseMirrorPlugins() {
    return [WikilinkDecoration(this.options)];
  },
});
