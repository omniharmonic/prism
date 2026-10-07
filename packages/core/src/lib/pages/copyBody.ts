/**
 * The body of a COPY of a page (Save as template, a page made from a template,
 * Duplicate) — what must not travel with the text:
 *
 *  - review state: text that is only a pending SUGGESTED insertion is left out, a
 *    suggested deletion keeps its text (nothing was deleted yet), and comment
 *    anchors are unwrapped (their threads stay with the original);
 *  - sub-page rows (`<div data-type="child-page">`): they name the ORIGINAL's
 *    sub-pages, which the copy does not have — unless the copy brings its sub-pages
 *    along (`pageId`, "Duplicate with sub-pages"): then a row whose page was copied
 *    is kept and re-pointed at the copy, and a page-mention chip likewise;
 *  - mention identity: every chip gets a NEW `data-mention-uid` (the server tells
 *    new mentions from old by uid — a copied uid would never notify, or notify for
 *    the wrong page) and loses its `data-reminder` (the reminder belongs to the
 *    original chip). Same rule as `freshCopy` for in-editor duplication.
 *
 * One pass over STORED HTML, so it works whether or not the page is open. Pure and
 * LINEAR: a hand-written tag scanner, no regular expression over the body (see the
 * linear-scanner rule in CLAUDE.md). Anything that is not HTML (Markdown, plain
 * text) is returned as it is.
 */

interface Tag {
  /** Index just past the closing `>`; -1 when the tag never closes (kept as text). */
  end: number;
  name: string;
  closing: boolean;
  /** Attributes in order; names lower-cased. `raw` is the attribute exactly as written. */
  attrs: Array<{ name: string; value: string; raw: string }>;
}

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** Read the tag that starts at `html[at] === "<"`, or null when it is not a tag. */
function readTag(html: string, at: number): Tag | null {
  let i = at + 1;
  const closing = html.charCodeAt(i) === 47; // "/"
  if (closing) i++;
  if (!isNameStart(html.charCodeAt(i))) return null;
  const nameStart = i;
  while (i < html.length) {
    const c = html.charCodeAt(i);
    if (isSpace(c) || c === 62 || c === 47) break;
    i++;
  }
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs: Tag["attrs"] = [];
  for (;;) {
    while (i < html.length && (isSpace(html.charCodeAt(i)) || html.charCodeAt(i) === 47)) i++;
    if (i >= html.length) return { end: -1, name, closing, attrs };
    if (html.charCodeAt(i) === 62) return { end: i + 1, name, closing, attrs };
    const rawStart = i;
    while (i < html.length) {
      const c = html.charCodeAt(i);
      if (isSpace(c) || c === 61 || c === 62 || c === 47) break;
      i++;
    }
    if (i === rawStart) { i++; continue; } // a stray "=" — skip it
    const attrName = html.slice(rawStart, i).toLowerCase();
    let j = i;
    while (j < html.length && isSpace(html.charCodeAt(j))) j++;
    let value = "";
    if (html.charCodeAt(j) === 61) {
      j++;
      while (j < html.length && isSpace(html.charCodeAt(j))) j++;
      const quote = html.charCodeAt(j);
      if (quote === 34 || quote === 39) {
        const close = html.indexOf(quote === 34 ? '"' : "'", j + 1);
        if (close === -1) return { end: -1, name, closing, attrs };
        value = html.slice(j + 1, close);
        i = close + 1;
      } else {
        const start = j;
        while (j < html.length && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++;
        value = html.slice(start, j);
        i = j;
      }
    }
    attrs.push({ name: attrName, value, raw: html.slice(rawStart, i) });
  }
}

const attr = (tag: Tag, name: string): string | undefined => tag.attrs.find((a) => a.name === name)?.value;

const defaultUid = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID().replace(/-/g, "").slice(0, 16) : Math.random().toString(36).slice(2, 18);
};

/** Does the body start as HTML (an element)? Markdown / plain text is never rewritten. */
function startsAsHtml(body: string): boolean {
  let i = 0;
  while (i < body.length && isSpace(body.charCodeAt(i))) i++;
  return body.charCodeAt(i) === 60 && isNameStart(body.charCodeAt(i + 1));
}

type Frame = "keep" | "unwrap";

export interface CopyBodyOptions {
  /** The copy of page `id` when that page is copied along with this one, else null.
   *  Sub-page rows and page mentions that name it are re-pointed at the copy. */
  pageId?: (id: string) => string | null | undefined;
}

/** A tag as written, with one attribute's value replaced (the value must be attribute-safe). */
const withAttr = (tag: Tag, name: string, value: string): string =>
  `<${tag.name} ${tag.attrs.map((a) => (a.name === name ? `${name}="${value}"` : a.raw)).join(" ")}>`;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function cleanCopyBody(body: string, uid: () => string = defaultUid, opts: CopyBodyOptions = {}): string {
  if (!body || !startsAsHtml(body)) return body;
  const copyOf = (id: string | undefined): string | null => {
    const next = id && opts.pageId ? opts.pageId(id) : null;
    return next && SAFE_ID.test(next) ? next : null;
  };
  let out = "";
  let copied = 0; // everything before this index is already in `out` (or dropped)
  // One entry per OPEN <span>: whether its closing tag is written. (Only spans are tracked.)
  const spans: Frame[] = [];
  // While dropping an element: its tag name and how many of them are open inside it.
  let dropping: { name: string; depth: number } | null = null;
  let at = body.indexOf("<");
  while (at !== -1) {
    const tag = readTag(body, at);
    if (!tag) { at = body.indexOf("<", at + 1); continue; }
    if (tag.end === -1) break; // an unterminated tag: the rest is text, kept as it is
    if (dropping) {
      if (tag.name === dropping.name) {
        if (!tag.closing) dropping.depth++;
        else if (--dropping.depth === 0) { dropping = null; copied = tag.end; }
      }
      at = body.indexOf("<", tag.end);
      continue;
    }
    let replacement: string | null = null; // null = keep the tag as written
    if (tag.name === "span") {
      if (tag.closing) {
        if (spans.pop() === "unwrap") replacement = "";
      } else {
        const suggestion = attr(tag, "data-suggestion");
        if (suggestion === "insert") {
          out += body.slice(copied, at);
          dropping = { name: "span", depth: 1 };
          at = body.indexOf("<", tag.end);
          continue;
        }
        if (suggestion === "delete" || attr(tag, "data-comment-id") !== undefined) {
          spans.push("unwrap");
          replacement = "";
        } else {
          spans.push("keep");
          if (attr(tag, "data-type") === "mention") {
            const target = attr(tag, "data-kind") === "page" ? copyOf(attr(tag, "data-id")) : null;
            const kept = tag.attrs.filter((a) => a.name !== "data-reminder" && a.name !== "data-mention-uid").map((a) => (target && a.name === "data-id" ? `data-id="${target}"` : a.raw));
            replacement = `<span ${[...kept, `data-mention-uid="${uid()}"`].join(" ")}>`;
          }
        }
      }
    } else if (tag.name === "div" && !tag.closing && attr(tag, "data-type") === "child-page") {
      const target = copyOf(attr(tag, "data-page-id"));
      if (target) replacement = withAttr(tag, "data-page-id", target);
      else {
        out += body.slice(copied, at);
        dropping = { name: "div", depth: 1 };
        at = body.indexOf("<", tag.end);
        continue;
      }
    }
    if (replacement !== null) {
      out += body.slice(copied, at) + replacement;
      copied = tag.end;
    }
    at = body.indexOf("<", tag.end);
  }
  // An element being dropped that never closed: nothing after it is kept (it was all inside).
  return dropping ? out : out + body.slice(copied);
}

/**
 * `[[wikilinks]]` whose target is a page that was copied along (full PATH targets
 * only — a bare name is resolved by the vault and may mean another page) re-pointed
 * at the copy; `|alias` and `#anchor` are kept. `pathOf(target)` gets the target with
 * a trailing `.md` removed and returns the copy's path or null. Linear: one
 * `indexOf` walk, a link is at most 600 characters on one line.
 */
export function repointWikilinks(body: string, pathOf: (target: string) => string | null | undefined): string {
  if (!body || !body.includes("[[")) return body;
  let out = "";
  let copied = 0;
  let at = body.indexOf("[[");
  while (at !== -1) {
    const limit = Math.min(body.length, at + 602);
    let end = -1;
    for (let i = at + 2; i < limit; i++) {
      const c = body.charCodeAt(i);
      if (c === 10 || c === 13 || c === 91) break; // a line break or another "[" — not a link
      if (c === 93) { if (body.charCodeAt(i + 1) === 93) end = i; break; }
    }
    if (end === -1) { at = body.indexOf("[[", at + 2); continue; }
    const inner = body.slice(at + 2, end);
    let cut = inner.length;
    for (let i = 0; i < inner.length; i++) { const c = inner.charCodeAt(i); if (c === 124 || c === 35) { cut = i; break; } }
    const raw = inner.slice(0, cut);
    const target = raw.trim();
    const next = target ? pathOf(target.toLowerCase().endsWith(".md") ? target.slice(0, -3) : target) : null;
    if (next && !next.includes("]") && !next.includes("[") && !next.includes("|") && !next.includes("#")) {
      out += body.slice(copied, at) + "[[" + next + inner.slice(cut) + "]]";
      copied = end + 2;
    }
    at = body.indexOf("[[", end + 2);
  }
  return out + body.slice(copied);
}
