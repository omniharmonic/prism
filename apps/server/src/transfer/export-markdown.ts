/**
 * HTML → Markdown for the EXPORT (NP-ED-24): the import's turndown (escaping, removed
 * elements) plus the block shapes plain turndown loses —
 *
 *   to-do items   `- [x] done` / `- [ ] open`  (GFM task items; nested lists stay nested) —
 *                 written by the ONE list-item rule, `addTaskListRule` (`@prism/core/task-lists`)
 *   tables        GFM pipe tables: the first row is the header row, every row is padded
 *                 to the widest, a cell's line breaks become `<br>`, `|` is escaped.
 *                 Merged cells (colspan / rowspan) are written once — the merge is not kept.
 *   image caption the image, then its caption as an emphasised paragraph under it
 *   bookmark card `[title](url) — description` (the site name and preview image are not kept)
 *
 * Read back by the import (a Markdown body is opened through `marked`'s GFM), task items and
 * tables are the same blocks again; a caption and a bookmark description come back as text.
 *
 * Runs ONLY in the conversion worker (transfer/worker.ts `to-markdown`). Pure: no database,
 * config or network. The helpers that touch converted text are linear scans (no regex with an
 * unbounded quantifier over content).
 */
import { addTaskListRule } from "@prism/core/task-lists";
import { newTurndown } from "./import-plan";

/** The converter `newTurndown()` builds (the library itself is imported only by the conversion modules). */
type TurndownService = ReturnType<typeof newTurndown>;

/** The subset of the DOM turndown hands a rule. */
interface El {
  nodeName: string;
  nodeType?: number;
  parentNode: El | null;
  childNodes: ArrayLike<El>;
  getAttribute(name: string): string | null;
}

const isEl = (n: El | null | undefined): n is El => !!n && typeof n.getAttribute === "function";
const children = (n: El): El[] => Array.from(n.childNodes ?? []).filter(isEl);

/** Drop leading / trailing line breaks and blanks. Linear. */
function trimBreaks(s: string): string {
  let a = 0;
  let b = s.length;
  const blank = (c: number) => c === 10 || c === 13 || c === 32 || c === 9;
  while (a < b && blank(s.charCodeAt(a))) a++;
  while (b > a && blank(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** One table cell on one line: runs of line breaks → one `<br>`, `|` escaped. Linear. */
function cellText(content: string): string {
  const s = trimBreaks(content);
  let out = "";
  let inBreak = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\n" || ch === "\r") { inBreak = true; continue; }
    if (inBreak) {
      // Blanks that only indent the next line belong to the break.
      if (ch === " " || ch === "\t") continue;
      out += "<br>";
      inBreak = false;
    }
    out += ch === "|" ? "\\|" : ch;
  }
  return out;
}

const isCell = (n: El) => n.nodeName === "TH" || n.nodeName === "TD";
const rowCells = (row: El): El[] => children(row).filter(isCell);
function tableOf(node: El): El | null {
  for (let at: El | null = node; at; at = at.parentNode) if (at.nodeName === "TABLE") return at;
  return null;
}
/** Rows that belong to THIS table (not to a table nested in a cell). */
function rowsOf(table: El): El[] {
  const rows: El[] = [];
  for (const child of children(table)) {
    if (child.nodeName === "TR") rows.push(child);
    else if (child.nodeName === "THEAD" || child.nodeName === "TBODY" || child.nodeName === "TFOOT") for (const row of children(child)) if (row.nodeName === "TR") rows.push(row);
  }
  return rows;
}

const HTTP = /^https?:\/\//i;
/** A link destination Markdown reads back as one URL. */
const destination = (url: string): string => url.split("\\").join("%5C").split("(").join("%28").split(")").join("%29").split(" ").join("%20").split("<").join("%3C").split(">").join("%3E");

export function newExportTurndown(): TurndownService {
  const t = newTurndown();
  // Per table, read once: its widest row and its first row (never the row list per row).
  const shapes = new WeakMap<object, { width: number; first: El | null }>();
  const shapeOf = (table: El): { width: number; first: El | null } => {
    let shape = shapes.get(table);
    if (!shape) {
      const rows = rowsOf(table);
      let width = 1;
      for (const row of rows) width = Math.max(width, rowCells(row).length);
      shape = { width, first: rows[0] ?? null };
      shapes.set(table, shape);
    }
    return shape;
  };

  // ── to-do items ────────────────────────────────────────────────────────────
  // THE list-item rule (`@prism/core/task-lists`), shared with every other Markdown writer
  // and read back by `taskListsInHtml`: a to-do item is `- [x] ` / `- [ ] `, nested lists
  // are indented under their item.
  addTaskListRule(t);

  // ── tables ─────────────────────────────────────────────────────────────────
  t.addRule("prismTableCell", {
    filter: ["th", "td"],
    replacement: ((content: string) => ` ${cellText(content)} |`) as never,
  });
  t.addRule("prismTableRow", {
    filter: "tr",
    replacement: ((content: string, node: El) => {
      const table = tableOf(node);
      if (!table) return content;
      const { width, first: firstRow } = shapeOf(table);
      const cells = rowCells(node).length;
      let line = `|${content}`;
      for (let i = cells; i < width; i++) line += "  |";
      const first = firstRow === node;
      return first ? `${line}\n|${" --- |".repeat(width)}\n` : `${line}\n`;
    }) as never,
  });
  t.addRule("prismTableSection", {
    filter: ["thead", "tbody", "tfoot", "colgroup", "col", "caption"] as never,
    replacement: ((content: string, node: El) => (node.nodeName === "COLGROUP" || node.nodeName === "COL" ? "" : node.nodeName === "CAPTION" ? "" : content)) as never,
  });
  t.addRule("prismTable", {
    filter: "table",
    replacement: ((content: string) => `\n\n${trimBreaks(content)}\n\n`) as never,
  });

  // ── image with a caption ───────────────────────────────────────────────────
  t.addRule("prismCaptionedImage", {
    filter: ((node: El) => node.nodeName === "IMG" && !!trimBreaks(node.getAttribute("data-caption") ?? "") && !!node.getAttribute("src")) as never,
    replacement: ((_content: string, node: El) => {
      const alt = t.escape(trimBreaks(node.getAttribute("alt") ?? "")).split("\n").join(" ");
      const caption = t.escape(trimBreaks(node.getAttribute("data-caption") ?? "")).split("\n").join(" ");
      return `\n\n![${alt}](${destination(node.getAttribute("src") ?? "")})\n\n*${caption}*\n\n`;
    }) as never,
  });

  // ── bookmark card ──────────────────────────────────────────────────────────
  t.addRule("prismBookmark", {
    filter: ((node: El) => node.nodeName === "DIV" && node.getAttribute("data-type") === "bookmark" && !!node.getAttribute("data-url")) as never,
    replacement: ((content: string, node: El) => {
      const url = trimBreaks(node.getAttribute("data-url") ?? "");
      const one = (s: string | null) => t.escape(trimBreaks(s ?? "")).split("\n").join(" ");
      const title = one(node.getAttribute("data-title")) || one(url);
      const description = one(node.getAttribute("data-description"));
      // Anything but an http(s) address stays what the card's own fallback link converts to.
      if (!HTTP.test(url)) return `\n\n${trimBreaks(content)}${description ? ` — ${description}` : ""}\n\n`;
      return `\n\n[${title}](${destination(url)})${description ? ` — ${description}` : ""}\n\n`;
    }) as never,
  });

  return t;
}
