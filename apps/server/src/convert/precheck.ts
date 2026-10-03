/**
 * Linear pre-checks for the conversion service. One pass over the input, no
 * regular expressions, no recursion — they decide (a) whether an input is cheap
 * enough to convert on the main thread and (b) whether it is so far outside what
 * a parser can handle in budget that the worker should not even try.
 *
 * What they look for is what makes the parsers super-linear:
 *  - `marked` re-scans the rest of an inline run for every unmatched emphasis
 *    delimiter (`*a *a *a …`, `_`, `~`) and every unmatched `[` → quadratic in
 *    the number of delimiter runs INSIDE ONE BLOCK;
 *  - `marked` recurses per blockquote level, turndown and the ProseMirror DOM
 *    parser per element level → stack overflow / quadratic work on deep nesting.
 */
import { htmlDepth } from "@prism/core/import-export";

export interface Complexity {
  /** UTF-16 length of the input. */
  chars: number;
  /** Most emphasis/link/code delimiter runs inside one blank-line-separated block. */
  delimiterRuns: number;
  /** Deepest `>` blockquote prefix on a line. */
  quoteDepth: number;
  /** Deepest element nesting (start tags minus end tags, void elements ignored). */
  htmlDepth: number;
  /**
   * How many nodes a parser will build, roughly: HTML pieces, plus — for
   * Markdown — non-blank lines, delimiter runs and TABLE CELLS. Parsing cost
   * follows THIS, not the byte size (2 MB of text in one paragraph parses in
   * milliseconds; 2,500 short paragraphs take a second; a 6 KB table of 1000
   * columns × 1000 one-character rows is a MILLION cells — `marked` pads every
   * body row to the header's width).
   */
  nodes: number;
  /**
   * Deepest container nesting a single line asks for: `>` markers, list markers
   * (`- - - x`, `1. 1. x`) and indentation (two columns = one level). Inline gate
   * only — `marked` and the DOM/ProseMirror parsers recurse per level.
   */
  nestDepth: number;
  /**
   * Markdown-significant characters, whatever they mean. Inline gate only: it
   * bounds every shape the counters above do not know about (a body that is
   * mostly punctuation is never "obviously tiny").
   */
  specials: number;
}

const STAR = 42; // *
const UNDER = 95; // _
const TILDE = 126; // ~
const TICK = 96; // `
const OPEN = 91; // [
const NL = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const GT = 62;
const PIPE = 124; // |
const DASH = 45; // -
const PLUS = 43; // +
const COLON = 58; // :
const DOT = 46; // .
const RPAREN = 41; // )
const AT = 64; // @
const SLASH = 47; // /
const W = 119; // w

/** Characters `marked` (or the HTML it passes through) gives a meaning to. */
const SPECIAL = new Uint8Array(128);
for (const ch of "|`<>[]()*_~\\&!#=:@") SPECIAL[ch.charCodeAt(0)] = 1;

/**
 * What a Markdown source asks of `marked`. One pass, no regex, no recursion.
 *
 * TABLES are the multiplicative shape: a block that holds a delimiter row
 * (`|-|-|`, only `| - :` and blanks) is a table whose every row is padded to the
 * header's width, so it costs (most pipes on one of its lines) × (its lines)
 * cells however short the rows are. Every `|` counts — escaped or not (`\\|`
 * is a cell boundary again; being wrong in the other direction costs a thread hop).
 */
export function markdownComplexity(md: string): Pick<Complexity, "delimiterRuns" | "quoteDepth" | "nodes" | "nestDepth" | "specials"> {
  let nodes = 0; // non-blank lines + every delimiter run + table cells + autolinks
  let runs = 0; // in the current block
  let maxRuns = 0;
  let quote = 0; // `>` seen in the current line's prefix
  let maxQuote = 0;
  let nest = 0; // list markers in the current line's prefix
  let indent = 0; // leading columns of the current line
  let maxNest = 0;
  let specials = 0;
  let inPrefix = true; // still in the line's leading `>` / list-marker / whitespace run
  let lineBlank = true;
  // the current block (blank-line separated)
  let blockLines = 0;
  let blockPipes = 0; // most `|` on one of its lines
  let blockTable = false; // it holds a delimiter row
  // the current line
  let linePipes = 0;
  let lineDelimOnly = true; // nothing but `| - :` and blanks after the prefix
  let lineDash = false;
  let prev = 0;
  const endBlock = (): void => {
    // (a cell is a `<td>` + its paragraph + its text: about two ordinary nodes' work each)
    if (blockTable && blockPipes > 0) nodes += 2 * blockPipes * blockLines;
    blockLines = 0;
    blockPipes = 0;
    blockTable = false;
    runs = 0;
  };
  const endLine = (): void => {
    const depth = quote + nest + (indent >> 1);
    if (!lineBlank && depth > maxNest) maxNest = depth;
    if (lineBlank) endBlock(); // a blank line (blockquote markers alone count as blank) ends the block
    else {
      nodes++;
      blockLines++;
      if (linePipes > blockPipes) blockPipes = linePipes;
      if (lineDelimOnly && lineDash) blockTable = true;
    }
    quote = 0;
    nest = 0;
    indent = 0;
    inPrefix = true;
    lineBlank = true;
    linePipes = 0;
    lineDelimOnly = true;
    lineDash = false;
  };
  for (let i = 0; i < md.length; i++) {
    const c = md.charCodeAt(i);
    if (c < 128 && SPECIAL[c]) specials++;
    if (c === NL) {
      endLine();
      prev = c;
      continue;
    }
    if (inPrefix) {
      if (c === GT) {
        quote++;
        if (quote > maxQuote) maxQuote = quote;
        prev = c;
        continue;
      }
      if (c === SPACE || c === TAB || c === CR) {
        if (quote === 0 && nest === 0) indent += c === TAB ? 4 : c === SPACE ? 1 : 0;
        prev = c;
        continue;
      }
      // A list marker (`- `, `* `, `+ `, `12. `, `3) `) opens one more container on this line.
      const after = md.charCodeAt(i + 1);
      if ((c === DASH || c === STAR || c === PLUS) && (after === SPACE || after === TAB)) {
        nest++;
        lineBlank = false; // an empty list item is still a node
        if (c === DASH) lineDash = true;
        prev = c;
        continue;
      }
      if (c >= 48 && c <= 57) {
        let j = i + 1;
        while (j < md.length && j - i < 9 && md.charCodeAt(j) >= 48 && md.charCodeAt(j) <= 57) j++;
        const mark = md.charCodeAt(j);
        const sp = md.charCodeAt(j + 1);
        if ((mark === DOT || mark === RPAREN) && (sp === SPACE || sp === TAB)) {
          nest++;
          lineBlank = false;
          lineDelimOnly = false;
          i = j; // the marker; its blank is taken by the next turn
          prev = mark;
          continue;
        }
      }
      inPrefix = false;
    }
    if (c !== SPACE && c !== TAB && c !== CR) {
      lineBlank = false;
      if (c === PIPE) linePipes++;
      else if (c === DASH) lineDash = true;
      else if (c !== COLON) lineDelimOnly = false;
    }
    if (c === OPEN || ((c === STAR || c === UNDER || c === TILDE || c === TICK) && prev !== c)) {
      runs++;
      nodes++;
      if (runs > maxRuns) maxRuns = runs;
    } else if (c === AT) nodes++; // an e-mail autolink
    else if (c === COLON && md.charCodeAt(i + 1) === SLASH && md.charCodeAt(i + 2) === SLASH) nodes++; // scheme://
    else if (c === DOT && (prev | 32) === W && (md.charCodeAt(i - 2) | 32) === W && (md.charCodeAt(i - 3) | 32) === W) nodes++; // www.
    prev = c;
  }
  endLine();
  endBlock();
  return { delimiterRuns: maxRuns, quoteDepth: maxQuote, nodes, nestDepth: maxNest, specials };
}

/** Start tags in `html` (`<` + a letter). One pass. (Kept for callers that want elements only.) */
export function htmlTagCount(html: string): number {
  let n = 0;
  let at = html.indexOf("<");
  while (at !== -1) {
    const c = html.charCodeAt(at + 1) | 32;
    if (c >= 97 && c <= 122) n++;
    at = html.indexOf("<", at + 1);
  }
  return n;
}

const LT = 60; // <
const AMP = 38; // &
const EQ = 61; // =

/**
 * How many pieces a DOM parser will make of `html` — an UPPER bound on its
 * nodes, one pass, no regex. Counting only start tags (`<` + a letter) missed
 * everything else happy-dom turns into a node, and its tree building is
 * super-linear in the node count: 100 KB of lone `>` (or of `<!--a-->`) stalled
 * the event loop for 3.4 s, 200 KB for 16.7 s, while "0 tags" let megabytes of
 * it convert inline. Counted here:
 *  - every `<` (start tag, END tag, comment, `<!…>`, `<?…>`, a stray `<`);
 *  - every `>` that closes nothing (a lone `>`, the `>` of `/>` or `-->` after
 *    the tag already closed) — the parser emits a text node per piece;
 *  - attributes (a word inside a tag — boolean ones have no `=` — and each `=`)
 *    and character references (`&`), which cost per item though they are not
 *    nodes — weighted 1/4.
 */
export function htmlNodeCount(html: string): number {
  let n = 0;
  let cheap = 0; // attributes + entities
  let inTag = false;
  let blank = false; // the previous character inside the tag was whitespace
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === LT) {
      n++;
      inTag = true;
      blank = false;
    } else if (c === GT) {
      if (inTag) inTag = false;
      else n++;
    } else if (c === AMP) cheap++;
    else if (inTag) {
      const ws = c === SPACE || c === TAB || c === NL || c === CR;
      // An attribute: its `=`, and its NAME — a boolean attribute has no `=` at all
      // (`<p a b c …>`: one attribute per word).
      if (c === EQ || (blank && !ws)) cheap++;
      blank = ws;
    }
  }
  return n + (cheap >> 2);
}

/** Everything the service decides on, for a note body (`markdown` = it goes through marked). */
export function complexityOf(content: string, markdown: boolean): Complexity {
  const md = markdown ? markdownComplexity(content) : { delimiterRuns: 0, quoteDepth: 0, nodes: 0, nestDepth: 0, specials: 0 };
  // Markdown may carry raw HTML, which marked passes through to the DOM parser —
  // whole BLOCKS of it, verbatim (`<div>` + 20 KB of lone `>` is 20 KB of lone `>`
  // for the DOM parser). So a Markdown body with any `<` is counted exactly like
  // stored HTML, on top of its lines: its blockquote markers then count as pieces
  // too, which only errs towards the worker.
  const hasTags = content.includes("<");
  return { chars: content.length, ...md, nodes: md.nodes + (hasTags || !markdown ? htmlNodeCount(content) : 0), htmlDepth: hasTags ? htmlDepth(content) : 0 };
}

/**
 * Nodes + marks, size and depth of a ProseMirror JSON document, abandoned once
 * past `limit` nodes. Iterative. `chars` = text PLUS every attribute string (a
 * link's href, an image's src, a code block's language…): what a render has to
 * escape and emit, whichever field it sits in.
 */
export function docJsonWeight(json: unknown, limit = Infinity): { nodes: number; chars: number; depth: number; complete: boolean } {
  let nodes = 0;
  let chars = 0;
  let depth = 0;
  const attrChars = (attrs: unknown): void => {
    if (!attrs || typeof attrs !== "object") return;
    for (const v of Object.values(attrs as Record<string, unknown>)) {
      if (typeof v === "string") chars += v.length;
      else if (Array.isArray(v)) chars += v.length * 8;
    }
  };
  const stack: Array<[unknown, number]> = [[json, 1]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (!n || typeof n !== "object") continue;
    const node = n as { text?: unknown; content?: unknown; marks?: unknown; attrs?: unknown };
    nodes += 1 + (Array.isArray(node.marks) ? node.marks.length : 0);
    if (d > depth) depth = d;
    if (typeof node.text === "string") chars += node.text.length;
    attrChars(node.attrs);
    if (Array.isArray(node.marks)) for (const m of node.marks) attrChars((m as { attrs?: unknown } | null)?.attrs);
    if (nodes > limit) return { nodes, chars, depth, complete: false };
    if (Array.isArray(node.content)) for (const child of node.content) stack.push([child, d + 1]);
  }
  return { nodes, chars, depth, complete: true };
}
