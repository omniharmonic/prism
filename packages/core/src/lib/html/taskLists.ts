/**
 * GFM task items → Prism to-do lists, on the HTML a Markdown parser produced.
 *
 * `marked` renders `- [x] done` as a bullet whose text starts with a disabled
 * `<input type="checkbox">`. The editor's schema has no such input, so the list
 * opened as plain bullets and the checked state was lost. This rewrites the HTML:
 *
 *  - a list (`<ul>` or `<ol>`) whose EVERY item starts with a checkbox becomes the
 *    editor's to-do list: `<ul data-type="taskList">` of
 *    `<li data-type="taskItem" data-checked="true|false">` (nested lists are judged
 *    on their own items) — the same rule a pasted checkbox list follows;
 *  - in a MIXED list (some items with a box, some without) the list stays what it
 *    was and each box becomes its Markdown text, `[x] ` / `[ ] `, so nothing is lost
 *    and the next Markdown export says the same thing.
 *
 * Pure and isomorphic (no DOM): the server's conversion worker, the web shell and
 * the paste path all call it. ONE pass over the string (each list tag read
 * within a fixed bound) plus a sort of the edits it found; no regex runs over the content.
 */

interface Box { start: number; end: number; checked: boolean }
interface Item { tagStart: number; tagEnd: number; box: Box | null }
interface Frame { openStart: number; openEnd: number; items: Item[] }
interface Edit { start: number; end: number; text: string }

const TAG_MAX = 512;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** The tag starting at `<` (index `at`): its lower-cased name, whether it closes, and the index after `>`; null if not a tag. */
function tagAt(html: string, at: number): { name: string; close: boolean; end: number } | null {
  let i = at + 1;
  const close = html.charCodeAt(i) === 47; // "/"
  if (close) i++;
  const nameStart = i;
  for (; i < html.length; i++) {
    const c = html.charCodeAt(i) | 32;
    const digit = html.charCodeAt(i) >= 48 && html.charCodeAt(i) <= 57;
    if (!((c >= 97 && c <= 122) || (digit && i > nameStart))) break;
  }
  if (i === nameStart || i - nameStart > 5) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  // Only the five tags this module reads are measured; every other tag is stepped past by the caller.
  if (name !== "ul" && name !== "ol" && name !== "li" && name !== "p" && name !== "input") return null;
  // To the closing ">", stepping over quoted attribute values. Bounded: a tag longer than TAG_MAX
  // is not one a Markdown parser wrote, and an unclosed "<li" must not cost a scan to the end each time.
  let quote = 0;
  const stop = Math.min(html.length, i + TAG_MAX);
  for (; i < stop; i++) {
    const c = html.charCodeAt(i);
    if (quote) { if (c === quote) quote = 0; }
    else if (c === 34 || c === 39) quote = c;
    else if (c === 62) return { name, close, end: i + 1 };
  }
  return null;
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
  if (tag && !tag.close && tag.name === "p") {
    i = tag.end;
    while (i < html.length && isSpace(html.charCodeAt(i))) i++;
    if (html.charCodeAt(i) !== 60) return null;
    tag = tagAt(html, i);
  }
  if (!tag || tag.close || tag.name !== "input") return null;
  const box = checkboxOf(html.slice(i, tag.end));
  if (!box) return null;
  // The blanks between the box and the item's words go with it.
  let end = tag.end;
  while (end < html.length && isSpace(html.charCodeAt(end))) end++;
  return { start: i, end, checked: box.checked };
}

/** See the module comment. Returns the input unchanged when it holds no checkbox. */
export function taskListsInHtml(html: string): string {
  if (!html || html.indexOf("checkbox") === -1) return html;
  const edits: Edit[] = [];
  const stack: Frame[] = [];
  let i = html.indexOf("<");
  while (i !== -1 && i < html.length) {
    const tag = tagAt(html, i);
    if (!tag) { i = html.indexOf("<", i + 1); continue; }
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
