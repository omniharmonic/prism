import { Extension, Mark, Node, mergeAttributes, type Extensions, type NodeViewRenderer } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { safeMediaSrc, isAttachmentKind } from "../lib/media/attachments";
import { safeWebUrl } from "../lib/media/embeds";

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
 *   toggle   → <details data-type="toggle"><summary>…</summary>…blocks…</details> (open/closed is view state)
 *   columns  → <div data-type="columns" data-count="2"><div data-type="column">…</div>…</div>
 *   colours  → data-block-color="blue" on a block, <span data-text-color="red"> inline
 *   image    → <img src alt title width data-align data-caption>   (schema v3: align + caption)
 *   file     → <div data-type="attachment" data-kind="pdf|audio|video|file" data-src data-name data-size data-mime><a href>name</a></div>
 *   embed    → <div data-type="embed" data-url data-height><a href>url</a></div>  (iframe src DERIVED from lib/media/embeds.ts)
 *   bookmark → <div data-type="bookmark" data-url data-title data-description data-image data-favicon data-site><a href>title</a></div>
 *   toc      → <div data-type="toc"></div>   (headings listed live by the view)
 *   code     → <pre><code class="language-x">  (lowlight highlighting is a decoration, not content)
 *
 * Every URL attribute is re-validated on parse (`safeMediaSrc` / `safeWebUrl`):
 * a block whose URL fails is NOT matched, so its fallback <a> is parsed as an
 * ordinary paragraph link — content is preserved, never turned into a live frame.
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
  // Open/closed is per-viewer VIEW state, never part of the document: a click is
  // not an edit (no history version, no untracked change while suggesting, no
  // flapping between collaborators). Stored HTML has no `open`, so other readers
  // of the HTML see a closed <details>; the editor starts every toggle open.
  parseHTML() {
    // Any <details> is a toggle; one without a <summary> gets an empty summary
    // from the content expression's fill rather than losing its body.
    return [{ tag: "details", priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["details", mergeAttributes(HTMLAttributes, { "data-type": "toggle" }), 0];
  },
  addNodeView() {
    return ({ node, editor }) => {
      let current = node;
      let open = true;
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
        open = !open;
        paint();
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
          return mutation.type === "attributes" && (mutation.target === dom || mutation.target === arrow);
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

// ── Browser-only node views (registered by lib/tiptap/mediaViews.ts) ─────────
// The schema below is isomorphic; its node VIEWS (resize handles, players,
// frames, live TOC, code toolbar) need a DOM and only exist in the browser. The
// client registers them once at import; on the server the registry stays empty
// and every node renders through its plain renderHTML.
type ViewName = "image" | "attachment" | "embed" | "bookmark" | "tableOfContents" | "codeBlock";
const VIEWS: Partial<Record<ViewName, NodeViewRenderer>> = {};
export function registerBlockViews(views: Partial<Record<ViewName, NodeViewRenderer>>): void {
  Object.assign(VIEWS, views);
}

const IMAGE_ALIGN = ["left", "center", "right", "wide"] as const;
const clip = (v: string | null | undefined, n: number) => {
  const s = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  return s || null;
};
const intAttr = (v: string | null | undefined, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Image + alignment + caption (v3). Width comes from the base extension (resize writes it). */
export const ImageBlock = Image.extend({
  draggable: true,
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        parseHTML: (el) => {
          const v = (el as unknown as AttrSource).getAttribute("data-align");
          return (IMAGE_ALIGN as readonly string[]).includes(v ?? "") ? v : null;
        },
        renderHTML: (attrs) => (attrs.align ? { "data-align": attrs.align } : {}),
      },
      caption: {
        default: null,
        parseHTML: (el) => clip((el as unknown as AttrSource).getAttribute("data-caption"), 500),
        renderHTML: (attrs) => (attrs.caption ? { "data-caption": attrs.caption } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]", getAttrs: (el) => (safeMediaSrc((el as unknown as AttrSource).getAttribute("src")) ? null : false) }];
  },
  addNodeView() {
    return VIEWS.image ?? null;
  },
});

/** A stored file: generic download card, inline PDF, audio or video player. */
export const Attachment = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    const a = (el: unknown) => el as AttrSource;
    return {
      src: { default: null, parseHTML: (el) => safeMediaSrc(a(el).getAttribute("data-src")), renderHTML: (x) => ({ "data-src": x.src }) },
      name: { default: "Attachment", parseHTML: (el) => clip(a(el).getAttribute("data-name"), 200) ?? "Attachment", renderHTML: (x) => ({ "data-name": x.name }) },
      size: { default: null, parseHTML: (el) => intAttr(a(el).getAttribute("data-size"), 0, 10 * 1024 ** 3), renderHTML: (x) => (x.size != null ? { "data-size": String(x.size) } : {}) },
      mimeType: {
        default: "application/octet-stream",
        parseHTML: (el) => {
          const v = (a(el).getAttribute("data-mime") ?? "").toLowerCase();
          return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(v) ? v : "application/octet-stream";
        },
        renderHTML: (x) => ({ "data-mime": x.mimeType }),
      },
      kind: {
        default: "file",
        parseHTML: (el) => {
          const v = a(el).getAttribute("data-kind");
          return isAttachmentKind(v) ? v : "file";
        },
        renderHTML: (x) => ({ "data-kind": x.kind }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="attachment"]', priority: 60, getAttrs: (el) => (safeMediaSrc((el as unknown as AttrSource).getAttribute("data-src")) ? null : false) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "attachment" }), ["a", { href: node.attrs.src, rel: "noopener noreferrer" }, String(node.attrs.name || "Attachment")]];
  },
  addNodeView() {
    return VIEWS.attachment ?? null;
  },
});

/** An allowlisted embed. Stores ONLY the pasted URL; the frame address is derived at view time. */
export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      url: { default: null, parseHTML: (el) => safeWebUrl((el as unknown as AttrSource).getAttribute("data-url")), renderHTML: (x) => ({ "data-url": x.url }) },
      height: { default: null, parseHTML: (el) => intAttr((el as unknown as AttrSource).getAttribute("data-height"), 80, 2000), renderHTML: (x) => (x.height ? { "data-height": String(x.height) } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="embed"]', priority: 60, getAttrs: (el) => (safeWebUrl((el as unknown as AttrSource).getAttribute("data-url")) ? null : false) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "embed" }), ["a", { href: node.attrs.url, rel: "noopener noreferrer" }, String(node.attrs.url)]];
  },
  addNodeView() {
    return VIEWS.embed ?? null;
  },
});

/** A link preview card (title, description, favicon, image) — filled from GET /api/unfurl. */
export const Bookmark = Node.create({
  name: "bookmark",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    const text = (key: string, attr: string, n: number) => ({
      default: null,
      parseHTML: (el: unknown) => clip((el as AttrSource).getAttribute(attr), n),
      renderHTML: (x: Record<string, unknown>) => (x[key] ? { [attr]: x[key] as string } : {}),
    });
    const link = (key: string, attr: string) => ({
      default: null,
      parseHTML: (el: unknown) => safeMediaSrc((el as AttrSource).getAttribute(attr)),
      renderHTML: (x: Record<string, unknown>) => (x[key] ? { [attr]: x[key] as string } : {}),
    });
    return {
      url: { default: null, parseHTML: (el) => safeWebUrl((el as unknown as AttrSource).getAttribute("data-url")), renderHTML: (x) => ({ "data-url": x.url }) },
      title: text("title", "data-title", 300),
      description: text("description", "data-description", 600),
      siteName: text("siteName", "data-site", 120),
      image: link("image", "data-image"),
      favicon: link("favicon", "data-favicon"),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="bookmark"]', priority: 60, getAttrs: (el) => (safeWebUrl((el as unknown as AttrSource).getAttribute("data-url")) ? null : false) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "bookmark" }), ["a", { href: node.attrs.url, rel: "noopener noreferrer" }, String(node.attrs.title || node.attrs.url)]];
  },
  addNodeView() {
    return VIEWS.bookmark ?? null;
  },
});

/** A live table of contents of the page's headings. Stores nothing but its position. */
export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-type="toc"]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toc" })];
  },
  addNodeView() {
    return VIEWS.tableOfContents ?? null;
  },
});

const lowlight = createLowlight(common);
/** Highlighted code (lowlight decorations, no stored markup) with a language attribute and Tab indent. */
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return VIEWS.codeBlock ?? null;
  },
}).configure({ lowlight, enableTabIndentation: true, tabSize: 2, defaultLanguage: null });

/** The language names the picker offers (all registered with lowlight's `common` set). */
export function codeLanguages(): string[] {
  return lowlight.listLanguages().sort();
}

/**
 * Every block-level extension beyond StarterKit/Link/Highlight/Tasks. Both
 * editors and the server include exactly this list.
 */
export function blockSchemaExtensions(): Extensions {
  return [
    ImageBlock,
    Attachment,
    Embed,
    Bookmark,
    TableOfContents,
    CodeBlock,
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
