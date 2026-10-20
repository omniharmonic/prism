import { Extension, isNodeEmpty } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Placeholder hints for empty blocks (NP-ED-25), in BOTH editors.
 *
 * This replaces `@tiptap/extension-placeholder`, whose 3.27+ rewrite keeps its
 * decorations in a plugin state field and MAPS them through every transaction.
 * Two things broke with it:
 *  - mapping a node decoration on an empty list paragraph through the inverse of
 *    a list input rule throws in prosemirror-view (`Position -1 outside of
 *    fragment`), so ⌘Z after typing "- " failed (EditorKeys' input-rule undo);
 *  - the hint callback runs while a transaction is applied, when `editor.state` is
 *    still the old state, so an empty list item read as a plain line.
 * Here the decorations are computed from the state being drawn (the 3.26
 * behaviour): the empty textblock holding the caret, at any depth, gets
 * `is-empty` + `data-placeholder` (and `is-editor-empty` when the whole document
 * is empty). Nothing is stored; read-only editors get no hints.
 */
export interface PrismPlaceholderOptions {
  /** The hint for an empty textblock; `doc` is the document being drawn. */
  placeholder: (props: { node: PMNode; pos: number; doc: PMNode }) => string;
}

const key = new PluginKey("prismPlaceholder");

export const PrismPlaceholder = Extension.create<PrismPlaceholderOptions>({
  name: "prismPlaceholder",

  addOptions() {
    return { placeholder: () => "" };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const hint = this.options.placeholder;
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            if (!editor.isEditable) return null;
            const { doc, selection } = state;
            const anchor = selection.anchor;
            const emptyDoc = isNodeEmpty(doc);
            const decorations: Decoration[] = [];
            doc.descendants((node, pos) => {
              if (!node.type.isTextblock) return true;
              if (anchor >= pos && anchor <= pos + node.nodeSize && !node.isLeaf && isNodeEmpty(node)) {
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: emptyDoc ? "is-empty is-editor-empty" : "is-empty",
                    "data-placeholder": hint({ node, pos, doc }),
                  }),
                );
              }
              return true;
            });
            return decorations.length ? DecorationSet.create(doc, decorations) : null;
          },
        },
      }),
    ];
  },
});
