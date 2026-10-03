import type { Fragment, Node as PMNode, Slice } from "@tiptap/pm/model";
import { marked } from "marked";

/**
 * Clipboard fidelity (NP-ED-21), pure helpers:
 *  - `sliceToMarkdown`: what a copy puts in `text/plain` (rich text stays in `text/html`);
 *  - `looksLikeMarkdown` + `markdownToPasteHtml`: plain-text Markdown pasted with no
 *    HTML flavour becomes blocks;
 *  - `normalizePastedTodos`: checkbox lists from Notion / GitHub / Markdown become to-do lists.
 *
 * `[[wikilinks]]` are never escaped or re-interpreted on either path.
 */

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
      const wrap = (mark: string) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!; if (m[2]) text = `${m[1]}${mark}${m[2]}${mark}${m[3]}`; };
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

const BLOCK_SYNTAX = /^(?:#{1,6}\s+\S|\s*[-*+]\s+\S|\s*\d{1,9}[.)]\s+\S|>\s?\S|```|~~~|\s*[-*+]\s+\[[ xX]\]\s|\|.+\|\s*$|(?:-{3,}|\*{3,}|_{3,})\s*$)/m;
const INLINE_SYNTAX = /\*\*[^*\n]+\*\*|(?<!\[)\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|~~[^~\n]+~~/;

/** Is this plain text worth parsing as Markdown? Ordinary prose (and bare wikilinks) is not. */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length > 400_000) return false;
  return BLOCK_SYNTAX.test(text) || INLINE_SYNTAX.test(text);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown → HTML for the editor's paste parser. `[[wikilinks]]` pass through untouched. */
export function markdownToPasteHtml(text: string): string {
  const links: string[] = [];
  let source = "";
  // Linear scan: lift every [[…]] out so marked never reads its `|`, `_` or `*`.
  for (let i = 0; i < text.length;) {
    const open = text.indexOf("[[", i);
    const close = open === -1 ? -1 : text.indexOf("]]", open + 2);
    if (open === -1 || close === -1 || text.slice(open, close).includes("\n")) { source += text.slice(i); break; }
    source += `${text.slice(i, open)}\u0001${links.length}\u0002`;
    links.push(text.slice(open, close + 2));
    i = close + 2;
  }
  const html = marked.parse(source, { gfm: true, breaks: false, async: false }) as string;
  return html.replace(/\n<\/code><\/pre>/g, "</code></pre>").replace(/\u0001(\d+)\u0002/g, (_, n: string) => escapeHtml(links[Number(n)] ?? ""));
}

/**
 * Checkbox lists → Prism to-do lists (browser only). Recognises a list whose EVERY
 * item starts with a checkbox: `<input type=checkbox>` (Markdown/GitHub/Google
 * Docs exports), or Notion's `<div class="checkbox checkbox-on">`.
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
