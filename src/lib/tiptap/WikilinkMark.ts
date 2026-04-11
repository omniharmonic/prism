import { Mark } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * TipTap extension that renders [[wikilinks]] as styled clickable spans.
 * Supports three formats:
 *   [[simple name]]           → target = "simple name"
 *   [[path/to/note]]          → target = "path/to/note"
 *   [[path/to/note|Display]]  → target = "path/to/note", displays "Display"
 *
 * When clicked, calls onNavigate(target) which resolves the target
 * to a Parachute note and opens it in a tab.
 */

export interface WikilinkOptions {
  onNavigate: (target: string) => void;
}

const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

export const WikilinkDecoration = (options: WikilinkOptions) => {
  return new Plugin({
    key: new PluginKey("wikilink-decoration"),
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        const doc = state.doc;

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

            decorations.push(
              Decoration.inline(start, end, {
                class: "wikilink",
                "data-wikilink-target": target,
              }),
            );
          }
        });

        return DecorationSet.create(doc, decorations);
      },

      // Handle clicks on wikilink decorations
      handleDOMEvents: {
        click(_view, event) {
          const target = event.target as HTMLElement;
          // Walk up the DOM tree to find the wikilink span
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

/**
 * TipTap Extension wrapper.
 * Usage: WikilinkExtension.configure({ onNavigate: (target) => ... })
 */
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
