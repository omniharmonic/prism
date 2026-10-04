/**
 * GFM task items ⇄ Prism to-do lists.
 *
 * READING (`taskListsInHtml`): `marked` renders `- [x] done` as a bullet whose text starts
 * with a disabled `<input type="checkbox">`. The editor's schema has no such input, so the
 * list opened as plain bullets and the checked state was lost. This rewrites the HTML a
 * Markdown parser produced:
 *
 *  - a list (`<ul>` or `<ol>`) whose EVERY item starts with a checkbox becomes the
 *    editor's to-do list: `<ul data-type="taskList">` of
 *    `<li data-type="taskItem" data-checked="true|false">` (nested lists are judged
 *    on their own items) — the same rule a pasted checkbox list follows;
 *  - in a MIXED list (some items with a box, some without) the list stays what it
 *    was and each box becomes its Markdown text, `[x] ` / `[ ] `, so nothing is lost.
 *
 * WRITING (`addTaskListRule`): ONE turndown rule for list items, installed in every
 * turndown instance that writes note Markdown (the server's `convert/core.ts` — the MCP
 * note resource and "Move to" — and the web shell's `html_to_markdown`): a to-do item is
 * written `- [x] ` / `- [ ] `, and a plain item whose text starts with a literal `[x] ` /
 * `[ ] ` (what a mixed list reads as) keeps that marker unescaped, so a mixed list is the
 * same Markdown after every save. (The `.md` EXPORT has its own writer and can adopt the
 * rule; a plain list whose every item starts with such a marker therefore reads back as a
 * to-do list.)
 *
 * Pure and isomorphic (no DOM). The reader tokenises like an HTML parser — tags of ANY
 * name are stepped over with their quoted attribute values, comments / CDATA /
 * declarations and raw-text elements are skipped — so nothing inside an attribute, a
 * comment or a `<textarea>` is ever read (or rewritten) as markup. ONE pass: an
 * unterminated tag or comment ends the scan (to a parser the rest is inside it), so no
 * position is read twice; plus a sort of the edits found.
 */

interface Box { start: number; end: number; checked: boolean }
interface Item { tagStart: number; tagEnd: number; box: Box | null }
interface Frame { openStart: number; openEnd: number; items: Item[] }
interface Edit { start: number; end: number; text: string }

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameChar = (c: number, first: boolean) => ((c | 32) >= 97 && (c | 32) <= 122) || (!first && ((c >= 48 && c <= 57) || c === 45 || c === 58));

/** Elements whose content is text, not markup, up to their own closing tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);

interface Tag { name: string; close: boolean; end: number }
/**
 * What starts at the `<` at `at`:
 *  - a tag (ANY name) → its lower-cased name, whether it closes, the index after its `>`
 *    (attribute values are stepped over as a parser does: quotes count only after `=`);
 *  - a comment / CDATA / declaration / processing instruction → `{ name: "", … end }`;
 *  - `null` → this `<` is text;
 *  - `"eof"` → the construct never ends: the rest of the input is inside it.
 */
function tagAt(html: string, at: number): Tag | null | "eof" {
  const n = html.length;
  let i = at + 1;
  const first = html.charCodeAt(i);
  if (first === 33 || first === 63) { // "<!" or "<?"
    if (html.startsWith("<!--", at)) {
      // "<!-->" and "<!--->" are complete (empty) comments.
      if (html.startsWith(">", at + 4)) return { name: "", close: false, end: at + 5 };
      if (html.startsWith("->", at + 4)) return { name: "", close: false, end: at + 6 };
      const stop = html.indexOf("-->", at + 4);
      return stop === -1 ? "eof" : { name: "", close: false, end: stop + 3 };
    }
    const closer = html.startsWith("<![CDATA[", at) ? "]]>" : ">";
    const stop = html.indexOf(closer, i);
    return stop === -1 ? "eof" : { name: "", close: false, end: stop + closer.length };
  }
  const close = first === 47; // "/"
  if (close) i++;
  const nameStart = i;
  while (i < n && isNameChar(html.charCodeAt(i), i === nameStart)) i++;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  // Attributes, to the closing ">".
  for (;;) {
    while (i < n && (isSpace(html.charCodeAt(i)) || html.charCodeAt(i) === 47)) i++;
    if (i >= n) return "eof";
    if (html.charCodeAt(i) === 62) return { name, close, end: i + 1 };
    // An attribute name (anything up to a blank, "/", ">" or "="; a leading "=" belongs to the name).
    i++;
    while (i < n) { const c = html.charCodeAt(i); if (isSpace(c) || c === 47 || c === 62 || c === 61) break; i++; }
    while (i < n && isSpace(html.charCodeAt(i))) i++;
    if (html.charCodeAt(i) !== 61) continue;
    i++;
    while (i < n && isSpace(html.charCodeAt(i))) i++;
    const q = html.charCodeAt(i);
    if (q === 34 || q === 39) {
      const endQuote = html.indexOf(q === 34 ? '"' : "'", i + 1);
      if (endQuote === -1) return "eof";
      i = endQuote + 1;
    } else {
      while (i < n) { const c = html.charCodeAt(i); if (isSpace(c) || c === 62) break; i++; }
    }
  }
}

/** The index after the closing tag of raw-text element `name` whose content starts at `from`; -1 if it never closes. */
function rawTextEnd(html: string, name: string, from: number): number {
  let i = html.indexOf("</", from);
  while (i !== -1) {
    const after = i + 2 + name.length;
    if (html.slice(i + 2, after).toLowerCase() === name) {
      const c = html.charCodeAt(after);
      if (Number.isNaN(c) || isSpace(c) || c === 47 || c === 62) {
        const close = tagAt(html, i);
        return close === "eof" || !close ? -1 : close.end;
      }
    }
    i = html.indexOf("</", i + 2);
  }
  return -1;
}

/** Does this `<input …>` tag say `type=checkbox`, and is it checked? (Attribute names only, read like an HTML parser.) */
function checkboxOf(tag: string): { checked: boolean } | null {
  let type = "";
  let checked = false;
  let i = 6; // after "<input"
  while (i < tag.length) {
    while (i < tag.length && (isSpace(tag.charCodeAt(i)) || tag[i] === "/")) i++;
    const nameStart = i;
    while (i < tag.length && !isSpace(tag.charCodeAt(i)) && tag[i] !== "=" && tag[i] !== ">" && tag[i] !== "/") i++;
    const name = tag.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < tag.length && isSpace(tag.charCodeAt(i))) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < tag.length && isSpace(tag.charCodeAt(i))) i++;
      const q = tag[i];
      if (q === '"' || q === "'") {
        const endQuote = tag.indexOf(q, i + 1);
        const stop = endQuote === -1 ? tag.length : endQuote;
        value = tag.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const valueStart = i;
        while (i < tag.length && !isSpace(tag.charCodeAt(i)) && tag[i] !== ">") i++;
        value = tag.slice(valueStart, i);
      }
    }
    if (name === "type") type = value.toLowerCase();
    else if (name === "checked") checked = true;
  }
  return type === "checkbox" ? { checked } : null;
}

/** The checkbox an item starts with (after optional blanks and one `<p>`), or null. */
function leadingBox(html: string, from: number): Box | null {
  let i = from;
  while (i < html.length && isSpace(html.charCodeAt(i))) i++;
  if (html.charCodeAt(i) !== 60) return null;
  let tag = tagAt(html, i);
  if (tag && tag !== "eof" && !tag.close && tag.name === "p") {
    i = tag.end;
    while (i < html.length && isSpace(html.charCodeAt(i))) i++;
    if (html.charCodeAt(i) !== 60) return null;
    tag = tagAt(html, i);
  }
  if (!tag || tag === "eof" || tag.close || tag.name !== "input") return null;
  const box = checkboxOf(html.slice(i, tag.end));
  if (!box) return null;
  // The blanks between the box and the item's words go with it.
  let end = tag.end;
  while (end < html.length && isSpace(html.charCodeAt(end))) end++;
  return { start: i, end, checked: box.checked };
}

const CHECKBOX = /checkbox/i; // a fixed word: a linear test

/** See the module comment. Returns the input unchanged when it holds no checkbox. */
export function taskListsInHtml(html: string): string {
  if (!html || !CHECKBOX.test(html)) return html;
  const edits: Edit[] = [];
  const stack: Frame[] = [];
  let i = html.indexOf("<");
  while (i !== -1 && i < html.length) {
    const tag = tagAt(html, i);
    if (tag === "eof") break; // the rest is inside an unterminated tag / comment
    if (!tag) { i = html.indexOf("<", i + 1); continue; }
    if (!tag.close && RAW_TEXT.has(tag.name)) {
      const end = rawTextEnd(html, tag.name, tag.end);
      if (end === -1) break;
      i = html.indexOf("<", end);
      continue;
    }
    if (tag.name === "plaintext" && !tag.close) break;
    if (tag.name === "ul" || tag.name === "ol") {
      if (!tag.close) stack.push({ openStart: i, openEnd: tag.end, items: [] });
      else {
        const frame = stack.pop();
        if (frame && frame.items.length) {
          if (frame.items.every((item) => item.box)) {
            edits.push({ start: frame.openStart, end: frame.openEnd, text: '<ul data-type="taskList">' });
            for (const item of frame.items) {
              edits.push({ start: item.tagStart, end: item.tagEnd, text: `<li data-type="taskItem" data-checked="${item.box!.checked}">` });
              edits.push({ start: item.box!.start, end: item.box!.end, text: "" });
            }
            edits.push({ start: i, end: tag.end, text: "</ul>" });
          } else {
            for (const item of frame.items) if (item.box) edits.push({ start: item.box.start, end: item.box.end, text: item.box.checked ? "[x] " : "[ ] " });
          }
        }
      }
    } else if (tag.name === "li" && !tag.close && stack.length) {
      stack[stack.length - 1]!.items.push({ tagStart: i, tagEnd: tag.end, box: leadingBox(html, tag.end) });
    }
    i = html.indexOf("<", tag.end);
  }
  if (!edits.length) return html;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const edit of edits) {
    if (edit.start < at) continue; // overlapping edits cannot come from well-formed lists; keep the first
    out += html.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + html.slice(at);
}

// ── writing: one turndown rule for list items ───────────────────────────────

interface ListItemNode {
  nodeName: string;
  parentNode: { nodeName: string; children: ArrayLike<unknown>; getAttribute(name: string): string | null } | null;
  nextSibling: unknown;
  getAttribute(name: string): string | null;
}
interface TurndownLike {
  addRule(key: string, rule: { filter: string | ((node: ListItemNode) => boolean); replacement(content: string, node: ListItemNode, options: { bulletListMarker?: string }): string }): unknown;
}

/** `text` without its leading and trailing line breaks (linear; no regex over content). */
function trimLineBreaks(text: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && text.charCodeAt(a) === 10) a++;
  while (b > a && text.charCodeAt(b - 1) === 10) b--;
  return text.slice(a, b);
}

/** The escaped marker turndown writes for a literal `[x] ` / `[ ] ` at the start of an item: `\[x\] `. */
function leadingLiteralBox(body: string): string | null {
  if (body.charCodeAt(0) !== 92 || body[1] !== "[" || body.charCodeAt(3) !== 92 || body[4] !== "]" || body[5] !== " ") return null;
  const mark = body[2];
  return mark === " " || mark === "x" || mark === "X" ? mark : null;
}

/**
 * Install the list-item rule on a turndown service (it replaces turndown's own `li` rule —
 * rules added later win). See the module comment. `export-markdown` style writers can call
 * this too: `addTaskListRule(service)`.
 *
 *  - `li[data-type="taskItem"]` → `- [x] ` / `- [ ] ` + its body (nested lists indented under it);
 *  - any other `li` → turndown's own output, except that a body starting with the literal
 *    marker `[x] ` / `[ ] ` keeps it unescaped.
 */
export function addTaskListRule<T extends TurndownLike>(service: T): T {
  service.addRule("prismListItem", {
    filter: "li",
    replacement(content, node, options) {
      const bullet = options.bulletListMarker ?? "*";
      const task = node.getAttribute("data-type") === "taskItem";
      let body = trimLineBreaks(content);
      let prefix: string;
      if (task) {
        prefix = `${bullet} `;
        body = `[${node.getAttribute("data-checked") === "true" ? "x" : " "}] ${body}`;
      } else {
        // turndown's own prefix: "-   " for bullets, "1.  " for numbered items.
        prefix = `${bullet}   `;
        const parent = node.parentNode;
        if (parent?.nodeName === "OL") {
          const start = parent.getAttribute("start");
          const index = Array.prototype.indexOf.call(parent.children, node);
          prefix = `${start ? Number(start) + index : index + 1}.  `;
        }
        const mark = leadingLiteralBox(body);
        if (mark !== null) body = `[${mark}] ${body.slice(6)}`;
        // turndown keeps one trailing break after a paragraph item (a loose list stays loose).
        if (content.endsWith("\n")) body += "\n";
      }
      const indent = `\n${" ".repeat(prefix.length)}`;
      return prefix + body.split("\n").join(indent) + (node.nextSibling ? "\n" : "");
    },
  });
  return service;
}
