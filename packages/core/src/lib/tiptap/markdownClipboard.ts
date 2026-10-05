import type { Fragment, Node as PMNode, Slice } from "@tiptap/pm/model";
import { marked } from "marked";
import { taskListsInHtml } from "../html/taskLists";

/**
 * Clipboard fidelity (NP-ED-21), pure helpers:
 *  - `sliceToMarkdown`: what a copy puts in `text/plain` (rich text stays in `text/html`);
 *  - `looksLikeMarkdown` + `markdownToPasteHtml`: plain-text Markdown pasted with no
 *    HTML flavour becomes blocks;
 *  - `normalizePastedTodos`: checkbox lists from Notion / GitHub / Markdown become to-do lists.
 *
 * `[[wikilinks]]` are never escaped or re-interpreted on either path.
 */

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 160;

const inlineText = (node: PMNode): string => {
  let out = "";
  node.forEach((child) => {
    if (child.type.name === "hardBreak") { out += "\n"; return; }
    if (!child.isText) { out += child.type.spec.leafText?.(child) ?? child.textContent; return; }
    let text = child.text ?? "";
    const has = (name: string) => child.marks.some((m) => m.type.name === name);
    if (has("code")) text = `\`${text}\``;
    else {
      // Emphasis markers hug the words, never the surrounding spaces.
      // (linear: two index scans, no regex over the text)
      const wrap = (mark: string) => {
        let a = 0;
        let b = text.length;
        while (a < b && isSpace(text.charCodeAt(a))) a++;
        while (b > a && isSpace(text.charCodeAt(b - 1))) b--;
        if (b > a) text = `${text.slice(0, a)}${mark}${text.slice(a, b)}${mark}${text.slice(b)}`;
      };
      if (has("bold")) wrap("**");
      if (has("italic")) wrap("*");
      if (has("strike")) wrap("~~");
    }
    const link = child.marks.find((m) => m.type.name === "link");
    if (link?.attrs.href) text = `[${text}](${String(link.attrs.href)})`;
    out += text;
  });
  return out;
};

const indent = (text: string, pad: string) => text.split("\n").map((l, i) => (i === 0 || !l ? l : pad + l)).join("\n");

function listToMarkdown(list: PMNode): string {
  const lines: string[] = [];
  let n = Number(list.attrs.start) || 1;
  list.forEach((item) => {
    const marker = list.type.name === "orderedList" ? `${n++}. ` : list.type.name === "taskList" ? `- [${item.attrs.checked ? "x" : " "}] ` : "- ";
    const body = blocksToMarkdown(item.content, "\n");
    lines.push(marker + indent(body, " ".repeat(marker.length > 4 ? 2 : marker.length)));
  });
  return lines.join("\n");
}

function tableToMarkdown(table: PMNode): string {
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(blocksToMarkdown(cell.content, " ").replace(/\|/g, "\\|").replace(/\n/g, " ")));
    rows.push(cells);
  });
  if (!rows.length) return "";
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(rows[0]), line(rows[0].map(() => "---")), ...rows.slice(1).map(line)].join("\n");
}

function blockToMarkdown(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph": return inlineText(node);
    case "heading": return `${"#".repeat(Math.max(1, Math.min(6, Number(node.attrs.level) || 1)))} ${inlineText(node)}`;
    case "bulletList": case "orderedList": case "taskList": return listToMarkdown(node);
    case "blockquote": return blocksToMarkdown(node.content, "\n\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    case "codeBlock": return `\`\`\`${node.attrs.language ?? ""}\n${node.textContent}\n\`\`\``;
    case "horizontalRule": return "---";
    case "image": return `![${String(node.attrs.alt ?? "")}](${String(node.attrs.src ?? "")})`;
    case "table": return tableToMarkdown(node);
    case "toggleSummary": return inlineText(node);
    case "bookmark": case "embed": return String(node.attrs.url ?? "");
    case "attachment": return `[${String(node.attrs.name ?? "Attachment")}](${String(node.attrs.src ?? "")})`;
    default:
      if (node.isTextblock) return inlineText(node);
      if (node.isLeaf) return "";
      return blocksToMarkdown(node.content, "\n\n");
  }
}

function blocksToMarkdown(content: Fragment, separator: string): string {
  const parts: string[] = [];
  content.forEach((child) => { const md = blockToMarkdown(child); if (md || child.type.name === "paragraph") parts.push(md); });
  return parts.join(separator);
}

/** Markdown for a copied slice. A selection inside ONE text block copies as its plain text. */
export function sliceToMarkdown(slice: Slice): string {
  const { content } = slice;
  // Open on both sides down to ONE text block (a phrase inside a paragraph, list item, cell…).
  if (content.childCount === 1) {
    let node = content.firstChild!;
    let depth = 0;
    while (!node.isTextblock && node.childCount === 1 && depth < slice.openStart) { node = node.firstChild!; depth++; }
    if (node.isTextblock && node.type.name !== "codeBlock" && depth < slice.openStart && depth < slice.openEnd) {
      return node.textBetween(0, node.content.size, "\n", (leaf) => leaf.type.spec.leafText?.(leaf) ?? "");
    }
  }
  if (content.firstChild?.isInline) {
    let text = "";
    content.forEach((n) => { text += n.isText ? n.text : n.type.spec.leafText?.(n) ?? ""; });
    return text;
  }
  return blocksToMarkdown(content, "\n\n");
}

/** Markdown larger than this is pasted as plain text (the parser's cost grows faster than its input). */
export const MARKDOWN_PASTE_MAX = 50_000;
/** More emphasis delimiters than this in ONE paragraph is not prose — and is what makes Markdown parsers quadratic (their inline pass is per paragraph). */
const MAX_PARAGRAPH_DELIMITERS = 400;

export interface MarkdownSignals { strong: number; weak: number; codeLines: number; lines: number; delimiters: number; maxParagraphDelimiters: number }

/** How many KINDS of closed inline construct `line` holds (**b**, `c`, ~~s~~, [text](url)), up to 2. Linear in the line. */
function inlineSignals(line: string): number {
  let n = 0;
  for (const mark of ["**", "~~", "`"]) {
    const open = line.indexOf(mark);
    if (open === -1) continue;
    const close = line.indexOf(mark, open + mark.length + 1);
    if (close !== -1 && !isSpace(line.charCodeAt(open + mark.length)) && !isSpace(line.charCodeAt(close - 1)) && ++n >= 2) return n;
  }
  const at = line.indexOf("](");
  if (at > 0) {
    const open = line.lastIndexOf("[", at);
    const close = line.indexOf(")", at + 2);
    if (open !== -1 && at - open > 1 && close > at + 2 && line.charCodeAt(open - 1) !== 91 /* not [[ */ && line.slice(at + 2, close).indexOf(" ") === -1) n++;
  }
  return n;
}

const CODE_START = ["import ", "export ", "const ", "let ", "var ", "function ", "def ", "class ", "return ", "#include", "#!/", "#define", "if (", "for (", "while (", "} else", "public ", "private ", "package ", "using ", "fn ", "SELECT ", "$ "];

/**
 * One pass over the text, line by line (no regex over the whole input — the old
 * multi-line patterns were quadratic on blank-line runs). Counts Markdown
 * evidence and evidence that the text is program source.
 */
export function markdownSignals(text: string): MarkdownSignals {
  const out: MarkdownSignals = { strong: 0, weak: 0, codeLines: 0, lines: 0, delimiters: 0, maxParagraphDelimiters: 0 };
  let paragraph = 0;
  let inline = 0;
  let prevPipe = false;
  for (let start = 0; start <= text.length;) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let i = start;
    while (i < end && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
    let last = end;
    while (last > i && isSpace(text.charCodeAt(last - 1))) last--;
    if (last > i) {
      out.lines++;
      const c = text[i];
      const next = text.charCodeAt(i + 1);
      const line = text.slice(i, Math.min(last, i + 2000)); // a bounded window per line keeps the pass linear
      const tail = text[last - 1];
      const codey = tail === ";" || tail === "{" || tail === "}" || (tail === ")" && line.indexOf("(") > 0 && line.indexOf(" ") === -1) || line.indexOf("=>") !== -1 || line.indexOf("();") !== -1 || CODE_START.some((k) => line.startsWith(k)) || (c === "#" && next !== 32 && next !== 35) || (c === "/" && next === 47);
      if (codey) out.codeLines++;
      const pipe = c === "|" && tail === "|";
      if (line.startsWith("```") || line.startsWith("~~~")) out.strong++;
      else if (c === "#") {
        let h = 0;
        while (h < 6 && line[h] === "#") h++;
        if (line.charCodeAt(h) === 32 && line.length > h + 1) { if (h >= 2) out.strong++; else out.weak++; }
      } else if ((c === "-" || c === "*" || c === "+") && next === 32) {
        if (line[2] === "[" && (line[3] === " " || line[3] === "x" || line[3] === "X") && line[4] === "]" && line[5] === " ") out.strong++;
        else if (line.length > 2 && !(c === "-" && line.startsWith("- - "))) out.weak++;
      } else if (c === ">" && (next === 32 || line.length > 1)) out.weak++;
      else if (pipe && prevPipe && line.indexOf("---") !== -1) out.strong++;
      else if (c >= "0" && c <= "9") {
        let d = 0;
        while (d < 9 && line[d] >= "0" && line[d] <= "9") d++;
        if ((line[d] === "." || line[d] === ")") && line[d + 1] === " " && line.length > d + 2) out.weak++;
      } else if (line === "---" || line === "***" || line === "___") out.weak++;
      if (inline < 2 && !codey) { const k = Math.min(2 - inline, inlineSignals(line)); inline += k; out.weak += k; }
      prevPipe = pipe;
      // Emphasis delimiters inside the line (a list marker at its start is not one).
      for (let k = i + 1; k < last; k++) {
        const ch = text.charCodeAt(k);
        if (ch === 42 || ch === 95 || ch === 126 || ch === 96) { out.delimiters++; paragraph++; }
      }
      if (paragraph > out.maxParagraphDelimiters) out.maxParagraphDelimiters = paragraph;
    } else { prevPipe = false; paragraph = 0; }
    start = end + 1;
  }
  return out;
}

/**
 * Is this plain text worth parsing as Markdown? One strong signal (a fenced code
 * block, `##` heading, task item, table) or two weaker ones (list items, quotes,
 * `#` title, bold/link/code spans) — and it must not read as program source
 * (`# comment`, `__init__`, lines ending in `;`/`{`). Ordinary prose and bare
 * wikilinks are not Markdown.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length > MARKDOWN_PASTE_MAX) return false;
  const s = markdownSignals(text);
  if (s.maxParagraphDelimiters > MAX_PARAGRAPH_DELIMITERS) return false;
  const fenced = text.startsWith("```") || text.indexOf("\n```") !== -1;
  if (!fenced && s.codeLines >= 2 && s.codeLines * 3 >= s.lines) return false;
  return s.strong >= 1 || s.weak >= 2;
}

/** Why a Markdown-looking paste was NOT converted (for a notice), or null when size/density are fine. */
export function markdownPasteRefusal(text: string): string | null {
  if (text.length > MARKDOWN_PASTE_MAX) {
    const head = text.slice(0, 4000);
    return looksLikeMarkdown(head) ? "Pasted as plain text — that is too much Markdown to convert at once." : null;
  }
  return null;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown → HTML for the editor's paste parser. `[[wikilinks]]` pass through untouched. */
export function markdownToPasteHtml(input: string): string {
  // The two placeholder characters must not already be in the text.
  const text = input.indexOf("\u0001") === -1 && input.indexOf("\u0002") === -1 ? input : input.split("\u0001").join("").split("\u0002").join("");
  const links: string[] = [];
  let source = "";
  // Linear scan: lift every single-line [[…]] out so marked never reads its `|`, `_` or `*`.
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("[[", i);
    if (open === -1) break;
    const close = text.indexOf("]]", open + 2);
    if (close === -1) break;
    const newline = text.indexOf("\n", open + 2);
    if (newline !== -1 && newline < close) {
      // Not a link (the line ends first): keep it as text and look on from the next line.
      source += text.slice(i, newline + 1);
      i = newline + 1;
      continue;
    }
    source += `${text.slice(i, open)}\u0001${links.length}\u0002`;
    links.push(text.slice(open, close + 2));
    i = close + 2;
  }
  source += text.slice(i);
  // Task items become to-do lists by the one rule the stored-Markdown reader follows (`taskListsInHtml`).
  const html = taskListsInHtml(marked.parse(source, { gfm: true, breaks: false, async: false }) as string);
  return html.replace(/\n<\/code><\/pre>/g, "</code></pre>").replace(/\u0001(\d+)\u0002/g, (_, n: string) => escapeHtml(links[Number(n)] ?? ""));
}

/**
 * Checkbox lists → Prism to-do lists (browser only), for pasted HTML. Recognises a list
 * whose EVERY item starts with a checkbox: `<input type=checkbox>` (GitHub / Google
 * Docs exports), or Notion's `<div class="checkbox checkbox-on">`. (Pasted MARKDOWN and
 * stored Markdown follow the same rule through `lib/html/taskLists.ts`.)
 */
export function normalizePastedTodos(html: string): string {
  if (typeof DOMParser === "undefined" || !/checkbox/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const list of Array.from(doc.querySelectorAll("ul, ol"))) {
    const items = Array.from(list.children).filter((el) => el.tagName === "LI");
    if (!items.length) continue;
    const boxes = items.map((li) => li.querySelector(":scope > input[type=checkbox], :scope > label > input[type=checkbox], :scope > p:first-child > input[type=checkbox], :scope > div.checkbox"));
    if (!boxes.every(Boolean)) continue;
    const todo = doc.createElement("ul");
    todo.setAttribute("data-type", "taskList");
    items.forEach((li, i) => {
      const box = boxes[i] as HTMLElement;
      const checked = (box as HTMLInputElement).checked === true || box.hasAttribute("checked") || box.classList.contains("checkbox-on");
      const label = box.closest("label");
      (label && label.parentElement === li && !label.textContent?.trim() ? label : box).remove();
      li.setAttribute("data-type", "taskItem");
      li.setAttribute("data-checked", String(checked));
      const first = li.firstChild?.nodeType === 1 && (li.firstChild as Element).tagName === "P" ? li.firstChild.firstChild : li.firstChild;
      if (first?.nodeType === 3) first.textContent = (first.textContent ?? "").replace(/^\s+/, "");
      todo.appendChild(li);
    });
    list.replaceWith(todo);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}
