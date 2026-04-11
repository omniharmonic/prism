import { Mark } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * TipTap extension that renders [[wikilinks]] as styled clickable spans
 * in the document editor. When clicked, navigates to the linked note.
 *
 * This is a decoration-based approach (not a schema change) so it works
 * with existing markdown content without modifying the document structure.
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
          let match;
          WIKILINK_REGEX.lastIndex = 0;

          while ((match = WIKILINK_REGEX.exec(text)) !== null) {
            const start = pos + match.index;
            const end = start + match[0].length;
            const target = match[1].includes("|")
              ? match[1].split("|")[0].trim()
              : match[1].trim();

            decorations.push(
              Decoration.inline(start, end, {
                class: "wikilink",
                "data-wikilink-target": target,
                style: `
                  color: var(--color-accent);
                  cursor: pointer;
                  text-decoration: underline;
                  text-decoration-style: dotted;
                  text-underline-offset: 3px;
                  border-radius: 2px;
                  transition: background 0.15s;
                `,
              }),
            );
          }
        });

        return DecorationSet.create(doc, decorations);
      },

      handleClick(_view, _pos, event) {
        const target = event.target as HTMLElement;
        if (target.classList.contains("wikilink")) {
          const wikilinkTarget = target.getAttribute("data-wikilink-target");
          if (wikilinkTarget) {
            event.preventDefault();
            options.onNavigate(wikilinkTarget);
            return true;
          }
        }
        return false;
      },
    },
  });
};

/**
 * TipTap Extension wrapper for the wikilink decoration plugin.
 * Usage: add WikilinkExtension.configure({ onNavigate: (target) => ... }) to extensions array.
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
