// Matrix message content -> portable span model (rendered by the Swift app and web UI).
// Input is untrusted: HTML goes through a bounded hand-written tokenizer (no DOM, nothing
// executed or fetched); only allowlisted tags survive, the rest flatten to their children.
import { clipText } from "./wire.js";
import { decodeHTML } from "entities";

export type Span =
  | { t: "text"; v: string }
  | { t: "bold" | "italic" | "strike" | "code"; c: Span[] }
  | { t: "pre"; v: string }
  | { t: "link"; href: string; c: Span[] }
  | { t: "mention"; id: string; name: string }
  | { t: "quote"; c: Span[] }
  | { t: "li"; c: Span[] }
  | { t: "br" };
export type RichText = { spans: Span[]; plain: string; jumboEmoji: boolean; truncated: boolean };

export const MAX_BODY_CHARS = 64_000;
const MAX_DEPTH = 40;
const MAX_HTML_CHARS = MAX_BODY_CHARS * 4;

const DROP = new Set(["script", "style", "iframe", "object", "embed", "head", "template", "noscript", "mx-reply", "title"]);
const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "tr"]);
const WRAP: Record<string, "bold" | "italic" | "strike" | "code"> = {
  b: "bold", strong: "bold", i: "italic", em: "italic",
  del: "strike", s: "strike", strike: "strike", code: "code", tt: "code",
};

export function fromMatrixContent(content: Record<string, unknown>): RichText {
  const body = typeof content.body === "string" ? content.body : "";
  const formatted = content.formatted_body;
  if (content.format === "org.matrix.custom.html" && typeof formatted === "string" && formatted.length > 0) {
    try {
      return finish(parseHtml(formatted.slice(0, MAX_HTML_CHARS)), formatted.length > MAX_HTML_CHARS);
    } catch {
      // Hostile or pathological markup: fall back to the plain body.
      return fromMarkdownLite(stripPlainReplyFallback(body, content));
    }
  }
  return fromMarkdownLite(stripPlainReplyFallback(body, content));
}

export function fromMarkdownLite(text: string): RichText {
  const capped = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS + 1) : text;
  return finish(parseMarkdown(capped, 0), false);
}

/** Plain text with NO markup interpretation (iMessage/SMS bodies): text spans + line breaks. */
export function fromPlainText(text: string): RichText {
  const capped = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS + 1) : text;
  const spans: Span[] = [];
  capped.split("\n").forEach((line, i) => {
    if (i) spans.push({ t: "br" });
    if (line) spans.push({ t: "text", v: line });
  });
  return finish(spans, false);
}

function isReply(content: Record<string, unknown>): boolean {
  const rel = content["m.relates_to"];
  return typeof rel === "object" && rel !== null && "m.in_reply_to" in rel;
}

/** Strip the "> <@user:server> quoted" fallback (up to the first blank line) of a reply only. */
function stripPlainReplyFallback(body: string, content: Record<string, unknown>): string {
  if (!isReply(content) || !/^> <@[^>\s]+> /.test(body)) return body;
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.startsWith("> ") || lines[i] === ">")) i++;
  if (i < lines.length && lines[i] === "") i++;
  return lines.slice(i).join("\n");
}

// ---------- HTML ----------
// Hand-written, single-pass tokenizer (no DOM, no regex over untrusted input except
// whitespace collapsing). Every loop iteration consumes input, and each scan-ahead either
// finds its target or consumes the rest of the input, so total work is linear.

type Frame = { tag: string; spans: Span[]; href?: string; pendingBr: boolean };

const VOID_OR_IGNORED_WRAPPERS = new Set(["br"]);
const LI_TAG = "li";
const FRAME_TAGS = new Set([...Object.keys(WRAP), "a", "blockquote", LI_TAG]);
const MAX_HREF_CHARS = 2048;

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isAlpha(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

function emit(f: Frame, span: Span): void {
  if (f.pendingBr && f.spans.length) f.spans.push({ t: "br" });
  f.pendingBr = false;
  f.spans.push(span);
}

/** Index of the "</name" that closes a raw-content element, or -1. */
function findClose(src: string, from: number, name: string): number {
  let j = from;
  while ((j = src.indexOf("</", j)) !== -1) {
    let k = 0;
    while (k < name.length && (src.charCodeAt(j + 2 + k) | 32) === name.charCodeAt(k)) k++;
    if (k === name.length && !isNameChar(src.charCodeAt(j + 2 + k))) return j;
    j += 2;
  }
  return -1;
}

function stripTags(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const lt = seg.indexOf("<", i);
    if (lt === -1) { out += seg.slice(i); break; }
    out += seg.slice(i, lt);
    const gt = seg.indexOf(">", lt);
    if (gt === -1) break;
    i = gt + 1;
  }
  return out;
}

function parseHtml(src: string): Span[] {
  const root: Frame = { tag: "", spans: [], pendingBr: false };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1]!;
  const closeTop = () => {
    const f = stack.pop()!;
    const parent = top();
    const kids = normalize(f.spans);
    if (f.tag === "a") {
      for (const s of linkSpans(f.href, kids)) emit(parent, s);
    } else if (f.tag === "blockquote" || f.tag === LI_TAG) {
      emit(parent, { t: f.tag === LI_TAG ? "li" : "quote", c: kids });
    } else if (kids.length) {
      emit(parent, { t: WRAP[f.tag]!, c: kids });
    }
  };
  const closeTo = (tag: string) => {
    for (let d = stack.length - 1; d > 0; d--) {
      if (stack[d]!.tag === tag) {
        while (stack.length > d) closeTop();
        return;
      }
    }
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const t = decodeHTML(src.slice(i, textEnd)).replace(/\s+/g, " ");
      const f = top();
      if (t !== " " || (f.spans.length > 0 && !f.pendingBr)) emit(f, { t: "text", v: t });
      i = textEnd;
    }
    if (lt === -1) break;
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 33 /* ! */) {
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
      } else {
        const end = src.indexOf(">", i + 2);
        i = end === -1 ? n : end + 1;
      }
      continue;
    }
    if (c1 === 63 /* ? */) {
      const end = src.indexOf(">", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const closing = c1 === 47; /* / */
    const nameStart = i + (closing ? 2 : 1);
    if (!isAlpha(src.charCodeAt(nameStart))) {
      emit(top(), { t: "text", v: "<" });
      i += 1;
      continue;
    }
    let j = nameStart;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    const tag = src.slice(nameStart, j).toLowerCase();

    // attributes: only href is kept; quotes are honoured so '>' inside values is not a tag end
    let href: string | undefined;
    for (;;) {
      while (j < n && (isSpace(src.charCodeAt(j)) || src.charCodeAt(j) === 47)) j++;
      if (j >= n) break;
      if (src.charCodeAt(j) === 62) { j++; break; }
      const aStart = j;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (isSpace(c) || c === 61 || c === 62 || c === 47) break;
        j++;
      }
      const aName = src.slice(aStart, j).toLowerCase();
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      let value = "";
      if (src.charCodeAt(j) === 61) {
        j++;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        const q = src.charCodeAt(j);
        if (q === 34 || q === 39) {
          const end = src.indexOf(String.fromCharCode(q), j + 1);
          value = src.slice(j + 1, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
        } else {
          const vStart = j;
          while (j < n && !isSpace(src.charCodeAt(j)) && src.charCodeAt(j) !== 62) j++;
          value = src.slice(vStart, j);
        }
      }
      if (aName === "href" && href === undefined && tag === "a") href = decodeHTML(value.slice(0, MAX_HREF_CHARS));
      if (j === aStart) j++; // defensive: always make progress
    }
    i = j;

    if (closing) {
      if (FRAME_TAGS.has(tag)) closeTo(tag);
      else if (BLOCK.has(tag)) top().pendingBr = true;
      continue;
    }
    if (tag === "embed") continue; // void element: nothing to drop but the tag itself
    if (DROP.has(tag)) {
      const end = findClose(src, i, tag);
      if (end === -1) { i = n; } else {
        const gt = src.indexOf(">", end);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    if (tag === "pre") {
      const end = findClose(src, i, "pre");
      const body = src.slice(i, end === -1 ? n : end);
      emit(top(), { t: "pre", v: decodeHTML(stripTags(body)) });
      if (end === -1) { i = n; } else {
        const gt = src.indexOf(">", end);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    if (VOID_OR_IGNORED_WRAPPERS.has(tag)) { emit(top(), { t: "br" }); continue; }
    if (FRAME_TAGS.has(tag)) {
      if (tag === LI_TAG && top().tag === LI_TAG) closeTop();
      if (stack.length < MAX_DEPTH) {
        stack.push({ tag, spans: [], href: tag === "a" ? (href ?? "") : undefined, pendingBr: false });
      }
      continue;
    }
    if (BLOCK.has(tag) && top().spans.length) top().pendingBr = true;
  }
  while (stack.length > 1) closeTop();
  return normalize(root.spans);
}

function linkSpans(rawHref: string | undefined, children: Span[]): Span[] {
  const raw = (rawHref ?? "").trim();
  const m = /^https:\/\/matrix\.to\/#\/(@[^/?#\s]+)/i.exec(raw.slice(0, MAX_HREF_CHARS));
  if (m) {
    let id = m[1]!;
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    const name = plainOf(children).trim() || id;
    return [{ t: "mention", id, name }];
  }
  // Emit the PARSED href (url.href) so every consumer sees what the WHATWG parser saw
  // (e.g. `https://good.test\@evil.test` is `https://good.test/@evil.test`); refuse
  // whitespace/control characters, which URL parsing would silently strip.
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return children;
  let url: URL;
  try { url = new URL(raw); } catch { return children; }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return children;
  return [{ t: "link", href: url.href, c: children }];
}

// ---------- markdown-lite ----------

const ALNUM = /[\p{L}\p{N}]/u;
const MARKS: Array<[string, "bold" | "italic" | "strike"]> = [["*", "bold"], ["_", "italic"], ["~", "strike"]];

function parseMarkdown(src: string, depth: number): Span[] {
  const out: Span[] = [];
  let buf = "";
  const flush = () => { if (buf) { pushText(out, buf); buf = ""; } };
  // Closers never cross a newline and their validity does not depend on the opener, so the
  // next valid closer of each mark is precomputed once per slice (backward scan): linear.
  const closers = new Map<string, Int32Array>();
  const closersFor = (mark: string): Int32Array => {
    let nc = closers.get(mark);
    if (nc) return nc;
    const n = src.length;
    nc = new Int32Array(n + 1);
    nc[n] = -1;
    for (let k = n - 1; k >= 0; k--) {
      const c = src[k]!;
      if (c === "\n") nc[k] = -1;
      else if (c === mark && k > 0 && !/\s/.test(src[k - 1]!) && !(k + 1 < n && ALNUM.test(src[k + 1]!))) nc[k] = k;
      else nc[k] = nc[k + 1]!;
    }
    closers.set(mark, nc);
    return nc;
  };
  let nlPos = -2; // cached first newline at or after some earlier index (-1 = none)
  const noNewlineBefore = (from: number, end: number): boolean => {
    if (nlPos === -2 || (nlPos !== -1 && nlPos < from)) nlPos = src.indexOf("\n", from);
    return nlPos === -1 || nlPos >= end;
  };
  let i = 0;
  outer: while (i < src.length) {
    const ch = src[i]!;
    if (src.startsWith("```", i)) {
      const end = src.indexOf("```", i + 3);
      if (end > i + 3) {
        flush();
        out.push({ t: "pre", v: src.slice(i + 3, end).replace(/^\n/, "") });
        i = end + 3;
        continue;
      }
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1 && noNewlineBefore(i + 1, end)) {
        flush();
        out.push({ t: "code", c: [{ t: "text", v: src.slice(i + 1, end) }] });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH) {
      for (const [mark, t] of MARKS) {
        if (ch !== mark) continue;
        const prev = i > 0 ? src[i - 1]! : "";
        if (prev && ALNUM.test(prev)) break;
        const next = src[i + 1];
        if (!next || /\s/.test(next) || next === mark) break;
        const end = closersFor(mark)[i + 1]!;
        if (end === -1) break;
        flush();
        out.push({ t, c: parseMarkdown(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue outer;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return normalize(out);
}

/** Push text, turning "\n" into br spans. */
function pushText(out: Span[], v: string): void {
  v.split("\n").forEach((part, n) => {
    if (n > 0) out.push({ t: "br" });
    if (part) out.push({ t: "text", v: part });
  });
}

// ---------- shared ----------

/** Merge adjacent text spans; split newlines in text into br spans; recurse. */
function normalize(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.t === "text") {
      if (!s.v) continue;
      if (s.v.includes("\n")) { pushText(out, s.v); continue; }
      const last = out[out.length - 1];
      if (last?.t === "text") last.v += s.v;
      else out.push({ ...s });
    } else if ("c" in s) {
      out.push({ ...s, c: normalize(s.c) } as Span);
    } else out.push(s);
  }
  return out;
}

function plainOf(spans: Span[]): string {
  let out = "";
  for (const s of spans) {
    switch (s.t) {
      case "text": case "pre": out += s.v; break;
      case "br": out += "\n"; break;
      case "mention": out += s.name; break;
      case "li": out += "- " + plainOf(s.c) + "\n"; break;
      default: out += plainOf(s.c);
    }
  }
  return out;
}

/** Trim text so total text/pre/mention length fits `budget`. Returns whether anything was cut. */
function clip(spans: Span[], budget: { left: number }): { spans: Span[]; cut: boolean } {
  const out: Span[] = [];
  let cut = false;
  for (const s of spans) {
    if (budget.left <= 0) { cut = true; break; }
    if (s.t === "text" || s.t === "pre") {
      if (s.v.length <= budget.left) { out.push(s); budget.left -= s.v.length; continue; }
      let n = budget.left;
      const code = s.v.charCodeAt(n - 1);
      const split = code >= 0xd800 && code <= 0xdbff;
      if (split) n--;
      out.push({ ...s, v: s.v.slice(0, n) });
      budget.left = split ? 0 : 0;
      cut = true;
      break;
    }
    if (s.t === "br") { out.push(s); budget.left -= 1; continue; }
    if (s.t === "mention") { out.push(s); budget.left -= s.name.length; continue; }
    const r = clip(s.c, budget);
    out.push({ ...s, c: r.spans } as Span);
    if (r.cut) { cut = true; break; }
  }
  return { spans: out, cut };
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
function isJumbo(spans: Span[], plain: string): boolean {
  if (!spans.every((s) => s.t === "text")) return false;
  const t = plain.trim();
  if (!t || t.length > 64) return false;
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const clusters = Array.from(seg.segment(t), (x) => x.segment);
  return clusters.length >= 1 && clusters.length <= 3 && clusters.every((g) => EMOJI.test(g));
}

function finish(spans: Span[], inputTruncated: boolean): RichText {
  const r = clip(spans, { left: MAX_BODY_CHARS });
  let plain = plainOf(r.spans);
  let truncated = r.cut || inputTruncated;
  if (plain.length > MAX_BODY_CHARS) { plain = clipText(plain, MAX_BODY_CHARS); truncated = true; }
  return { spans: r.spans, plain, jumboEmoji: !truncated && isJumbo(r.spans, plain), truncated };
}
