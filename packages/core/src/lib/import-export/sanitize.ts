/**
 * A linear, allowlist HTML sanitiser for EXPORTED pages (a stored body is
 * whatever any writer put there, and the exported file is opened from `file://`).
 *
 * It never passes markup through: the input is tokenised in one forward pass and
 * the output is REBUILT — only allowlisted elements, only allowlisted attributes,
 * every attribute value entity-decoded, checked and re-encoded. Elements whose
 * content is not page text (script, style, iframe, svg, math, …) are dropped
 * with their content; unknown elements (form, meta, base, link, button, input,
 * custom elements) lose their tags and keep their text. URL attributes accept
 * http(s), mailto and relative targets only (the scheme is read after decoding
 * entities and removing the whitespace/control characters browsers ignore).
 *
 * No regular expression runs over the document; nesting is capped.
 */
import { decodeHTML } from "entities";

const ALLOWED = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "b", "i", "u", "s",
  "del", "ins", "mark", "sub", "sup", "small", "a", "img", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "div", "span", "figure", "figcaption", "details", "summary", "kbd", "abbr", "cite", "q", "dl", "dt", "dd", "label", "time",
]);
const VOID = new Set(["br", "hr", "img", "col", "meta", "base", "link", "input", "area", "source", "track", "wbr", "embed", "param"]);
/** Dropped WITH their content. */
const DROP_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title", "xmp", "svg", "math", "select", "noembed", "noframes", "frameset", "applet", "head", "audio", "video", "canvas", "plaintext"]);
const ATTRS = new Set(["href", "src", "alt", "title", "colspan", "rowspan", "class", "lang", "dir", "width", "height", "start", "open", "datetime"]);
const URL_ATTRS = new Set(["href", "src"]);

const esc = (s: string): string => s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number): boolean => isLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58;
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/** May this URL be kept? http(s), mailto (links only), or relative. */
export function safeUrl(raw: string, allowMailto: boolean): boolean {
  let compact = "";
  for (let i = 0; i < raw.length && compact.length < 32; i++) {
    const c = raw.charCodeAt(i);
    if (c > 32 && c !== 127) compact += raw[i];
  }
  const colon = compact.indexOf(":");
  if (colon === -1) return true;
  for (const stop of ["/", "?", "#"]) {
    const at = compact.indexOf(stop);
    if (at !== -1 && at < colon) return true; // the colon is in a path/query: a relative URL
  }
  const scheme = compact.slice(0, colon).toLowerCase();
  return scheme === "http" || scheme === "https" || (allowMailto && scheme === "mailto");
}

function dataAttr(name: string): boolean {
  if (!name.startsWith("data-") || name.length > 64) return false;
  for (let i = 5; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return name.length > 5;
}

/** Index just past the tag that starts at `lt`, quotes respected; -1 when it never closes. */
function tagEnd(html: string, from: number): number {
  let quote = 0;
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 62) return i + 1;
  }
  return -1;
}

/** `</name` (ASCII case-insensitive, the name ending there) at or after `from`. */
function closingTag(html: string, name: string, from: number): number {
  let at = html.indexOf("</", from);
  while (at !== -1) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) {
      const after = html.charCodeAt(at + 2 + name.length);
      if (Number.isNaN(after) || after === 62 || after === 47 || isSpace(after)) return at;
    }
    at = html.indexOf("</", at + 2);
  }
  return -1;
}

function attributes(tag: string, nameEnd: number): string {
  let out = "";
  let i = nameEnd;
  const end = tag.length - 1; // the closing `>`
  let count = 0;
  while (i < end && count < 40) {
    while (i < end && (isSpace(tag.charCodeAt(i)) || tag[i] === "/")) i++;
    const start = i;
    while (i < end && !isSpace(tag.charCodeAt(i)) && tag[i] !== "=" && tag[i] !== "/") i++;
    if (i === start) break;
    const name = tag.slice(start, i).toLowerCase();
    while (i < end && isSpace(tag.charCodeAt(i))) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < end && isSpace(tag.charCodeAt(i))) i++;
      const q = tag[i];
      if (q === '"' || q === "'") {
        const close = tag.indexOf(q, i + 1);
        const stop = close === -1 || close > end ? end : close;
        value = tag.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const vs = i;
        while (i < end && !isSpace(tag.charCodeAt(i))) i++;
        value = tag.slice(vs, i);
      }
    }
    count++;
    if (!ATTRS.has(name) && !dataAttr(name)) continue;
    if (value.length > 4000) continue;
    const decoded = decodeHTML(value);
    if (URL_ATTRS.has(name) && !safeUrl(decoded, name === "href")) continue;
    out += ` ${name}="${esc(decoded)}"`;
  }
  return out;
}

export function sanitizeHtml(html: string, maxDepth = 200): string {
  const out: string[] = [];
  const stack: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i).split(">").join("&gt;"));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt).split(">").join("&gt;"));
    const next = html.charCodeAt(lt + 1);
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (next === 33 || next === 63) {
      // <!doctype …>, <?xml …?>
      const close = html.indexOf(">", lt + 2);
      i = close === -1 ? n : close + 1;
      continue;
    }
    const closing = next === 47;
    const nameStart = lt + (closing ? 2 : 1);
    if (!isLetter(html.charCodeAt(nameStart))) {
      out.push("&lt;");
      i = lt + 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < n && isNameChar(html.charCodeAt(nameEnd)) && nameEnd - nameStart < 40) nameEnd++;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = tagEnd(html, nameEnd);
    if (end === -1) break; // an unterminated tag: nothing after it is content
    i = end;
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) {
        for (let k = stack.length - 1; k >= at; k--) out.push(`</${stack[k]}>`);
        stack.length = at;
      }
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!VOID.has(name) && html.charCodeAt(end - 2) !== 47) {
        const close = closingTag(html, name, end);
        if (close === -1) break;
        const closeEnd = html.indexOf(">", close);
        i = closeEnd === -1 ? n : closeEnd + 1;
      }
      continue;
    }
    if (!ALLOWED.has(name)) continue; // unknown element: its tags go, its text stays
    const isVoid = VOID.has(name);
    if (!isVoid && stack.length >= maxDepth) continue;
    out.push(`<${name}${attributes(html.slice(nameEnd, end), 0)}>`);
    if (!isVoid) stack.push(name);
  }
  for (let k = stack.length - 1; k >= 0; k--) out.push(`</${stack[k]}>`);
  return out.join("");
}

/** The deepest element nesting in `html` (approximate, linear): a pre-check before handing it to a DOM parser. */
export function htmlDepth(html: string): number {
  let depth = 0;
  let max = 0;
  let at = html.indexOf("<");
  while (at !== -1) {
    const c = html.charCodeAt(at + 1);
    if (c === 47) depth = Math.max(0, depth - 1);
    else if (isLetter(c)) {
      let e = at + 1;
      while (e < html.length && isNameChar(html.charCodeAt(e)) && e - at < 40) e++;
      if (!VOID.has(html.slice(at + 1, e).toLowerCase())) {
        depth++;
        if (depth > max) max = depth;
      }
    }
    at = html.indexOf("<", at + 1);
  }
  return max;
}

/** Plain text of an HTML body (tags removed, block ends as newlines, entities decoded). Linear. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const gt = html.indexOf(">", lt);
    if (gt === -1) break;
    const tag = html.slice(lt + 1, Math.min(gt, lt + 12)).toLowerCase();
    if (tag.startsWith("/p") || tag.startsWith("/h") || tag.startsWith("/li") || tag.startsWith("/div") || tag.startsWith("br") || tag.startsWith("/tr") || tag.startsWith("/blockquote") || tag.startsWith("/pre")) out.push("\n");
    if (tag.startsWith("script") || tag.startsWith("style")) {
      const close = closingTag(html, tag.startsWith("script") ? "script" : "style", gt);
      if (close === -1) break;
      const ce = html.indexOf(">", close);
      i = ce === -1 ? html.length : ce + 1;
      continue;
    }
    i = gt + 1;
  }
  return decodeHTML(out.join(""));
}
