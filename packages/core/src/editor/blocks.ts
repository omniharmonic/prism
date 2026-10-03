import { Extension, Mark, Node, mergeAttributes, type Extensions } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";

/**
 * Block-level content shared by EVERY document editor (plain renderer, live
 * collaborative editor) and by the Prism Server's HTML⇄Yjs persistence.
 *
 * Isomorphic on purpose: nothing here touches the DOM at import time, so the
 * server can build the schema in Node. Node views (toggle open/close) only run
 * inside an EditorView, i.e. in the browser.
 *
 * Every node serialises to plain, readable HTML that a non-Prism reader can
 * still make sense of:
 *   callout  → <div data-type="callout" data-emoji="💡">…blocks…</div>
 *   toggle   → <details data-type="toggle" open><summary>…</summary>…blocks…</details>
 *   columns  → <div data-type="columns" data-count="2"><div data-type="column">…</div>…</div>
 *   colours  → data-block-color="blue" on a block, <span data-text-color="red"> inline
 *
 * ⚠ Adding a node here is a SCHEMA change for live collaboration: a client built
 * before the change cannot represent the node and y-prosemirror drops it from
 * the shared document. Ship server and every client together.
 */

/** Structural DOM types: this module also compiles for Node (no DOM lib). */
type AttrSource = { getAttribute(name: string): string | null; hasAttribute(name: string): boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DomNode = any;

/** The colour vocabulary (Notion-style). Values map to existing tokens in editor-blocks.css. */
export const BLOCK_COLORS = ["gray", "blue", "green", "yellow", "red"] as const;
export type BlockColorName = (typeof BLOCK_COLORS)[number];
/** A block colour is a text colour ("blue") or a background ("blue_background"). */
export type BlockColorValue = BlockColorName | `${BlockColorName}_background`;

export function isBlockColor(value: unknown): value is BlockColorValue {
  if (typeof value !== "string") return false;
  const base = value.endsWith("_background") ? value.slice(0, -"_background".length) : value;
  return (BLOCK_COLORS as readonly string[]).includes(base);
}

/** Node types that may carry a block colour. */
export const COLORABLE_BLOCKS = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "taskList",
  "callout",
  "toggle",
] as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textColor: {
      setTextColor: (color: BlockColorName) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
  }
}

/** `data-block-color` on colourable blocks. Unknown values are dropped on parse. */
export const BlockColor = Extension.create({
  name: "blockColor",
  addGlobalAttributes() {
    return [
      {
        types: [...COLORABLE_BLOCKS],
        attributes: {
          blockColor: {
            default: null,
            keepOnSplit: true,
            parseHTML: (el) => {
              const value = (el as unknown as AttrSource).getAttribute("data-block-color");
              return isBlockColor(value) ? value : null;
            },
            renderHTML: (attrs) =>
              isBlockColor(attrs.blockColor) ? { "data-block-color": attrs.blockColor } : {},
          },
        },
      },
    ];
  },
});

/** Inline text colour: `<span data-text-color="red">`. Background colour reuses Highlight. */
export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => {
          const value = (el as unknown as AttrSource).getAttribute("data-text-color");
          return (BLOCK_COLORS as readonly string[]).includes(value ?? "") ? value : null;
        },
        renderHTML: (attrs) => (attrs.color ? { "data-text-color": attrs.color } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-text-color]", getAttrs: (el) => ((BLOCK_COLORS as readonly string[]).includes((el as unknown as AttrSource).getAttribute("data-text-color") ?? "") ? null : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setTextColor: (color) => ({ commands }) => commands.setMark(this.name, { color }),
      unsetTextColor: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

/** A highlighted box with an emoji, holding ordinary blocks. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      emoji: {
        default: "💡",
        parseHTML: (el) => (el as unknown as AttrSource).getAttribute("data-emoji") || "💡",
        renderHTML: (attrs) => ({ "data-emoji": attrs.emoji || "💡" }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout" }), 0];
  },
});

/** The always-visible first line of a toggle. */
export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  defining: true,
  selectable: false,
  parseHTML() {
    return [{ tag: "summary", priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["summary", HTMLAttributes, 0];
  },
});

/** A collapsible block: a summary line plus nested blocks. */
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "toggleSummary block+",
  defining: true,
  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => (el as unknown as AttrSource).hasAttribute("open"),
        renderHTML: (attrs) => (attrs.open ? { open: "" } : {}),
      },
    };
  },
  parseHTML() {
    // Any <details> is a toggle; one without a <summary> gets an empty summary
    // from the content expression's fill rather than losing its body.
    return [{ tag: "details", priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["details", mergeAttributes(HTMLAttributes, { "data-type": "toggle" }), 0];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      let localOpen: boolean | null = null; // read-only viewers toggle locally
      const doc: DomNode = (editor.view.dom as DomNode).ownerDocument;
      const dom: DomNode = doc.createElement("div");
      dom.className = "prism-toggle";
      dom.setAttribute("data-type", "toggle");
      const arrow: DomNode = doc.createElement("button");
      arrow.type = "button";
      arrow.className = "prism-toggle-arrow";
      arrow.contentEditable = "false";
      const body: DomNode = doc.createElement("div");
      body.className = "prism-toggle-body";
      dom.append(arrow, body);
      const paint = () => {
        const open = localOpen ?? !!current.attrs.open;
        dom.setAttribute("data-open", String(open));
        arrow.setAttribute("aria-expanded", String(open));
        arrow.setAttribute("aria-label", open ? "Collapse toggle" : "Expand toggle");
        const color = current.attrs.blockColor;
        if (isBlockColor(color)) dom.setAttribute("data-block-color", color);
        else dom.removeAttribute("data-block-color");
      };
      arrow.addEventListener("mousedown", (event: DomNode) => event.preventDefault());
      arrow.addEventListener("click", (event: DomNode) => {
        event.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (!editor.isEditable || typeof pos !== "number") {
          localOpen = !(localOpen ?? !!current.attrs.open);
          paint();
          return;
        }
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, open: !current.attrs.open }),
        );
      });
      paint();
      return {
        dom,
        contentDOM: body,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          paint();
          return true;
        },
        ignoreMutation(mutation) {
          return mutation.type === "attributes" && mutation.target === dom;
        },
      };
    };
  },
});

/** One column of a column layout. */
export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-type="column"]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "column" }), 0];
  },
});

/** Two or three side-by-side columns (stacked on phones by CSS). */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,3}",
  isolating: true,
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-type="columns"]', priority: 60 }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns", "data-count": String(node.childCount) }), 0];
  },
});

/**
 * Every block-level extension beyond StarterKit/Link/Highlight/Tasks. Both
 * editors and the server include exactly this list.
 */
export function blockSchemaExtensions(): Extensions {
  return [
    Image,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Callout,
    Toggle,
    ToggleSummary,
    Columns,
    Column,
    BlockColor,
    TextColor,
  ];
}
