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
 *
 * ROUND 6 — the counters are CONSERVATIVE BOUNDS, not a model of `marked`. Five
 * reviews in a row found a shape where this file's idea of a block, a blank line
 * or a line break differed from the parser's (a lone `\r`, a tab-only line inside
 * a table), and each difference was megabytes of work on the event loop. So
 * nothing here depends on block structure any more:
 *  - every line is at least one node, whatever is on it (blank lines included),
 *    plus one per container its leading markers can open, and everything any
 *    parser could read as a line break ends a line;
 *  - table cells are bounded for the DOCUMENT: (most `|` on any line + 1) × (the
 *    lines after the first line that could be a delimiter row) — for the inline
 *    gate; the up-front refusal uses a per-table bound (`parseNodes`);
 *  - nesting is bounded by a line's whole leading run of markers and blanks.
 * Being too conservative costs a thread hop; being too lax stalls production.
 * The property test in test/conversion-round6.test.ts asserts the invariant
 * directly: what `marked` produces is ≤ a constant × `nodes`.
 */
import { htmlDepth } from "@prism/core/import-export";

export interface Complexity {
  /** UTF-16 length of the input. */
  chars: number;
  /** Most emphasis/link/code delimiter runs between two EMPTY (or spaces-only) lines. */
  delimiterRuns: number;
  /** Deepest `>` blockquote prefix on a line. */
  quoteDepth: number;
  /** Deepest element nesting (start tags minus end tags, void elements ignored). */
  htmlDepth: number;
  /**
   * An upper bound on the nodes a parser will build: HTML pieces, plus — for
   * Markdown — EVERY line, delimiter runs, autolinks and TABLE CELLS. Parsing
   * cost follows THIS, not the byte size (2 MB of text in one paragraph parses in
   * milliseconds; 2,500 short paragraphs take a second; a 6 KB table of 1000
   * columns × 1000 one-character rows is a MILLION cells — `marked` pads every
   * body row to the header's width).
   */
  nodes: number;
  /**
   * The same count with table cells bounded PER TABLE instead of for the whole
   * document: what the up-front refusal (`too_many_nodes`) is decided on. The
   * document-wide bound in `nodes` would refuse a long, ordinary note for one
   * small table near its top (every later line taken for a row) — fine for "is
   * this tiny?", wrong for "can this be converted at all?". Sound all the same: a
   * table cannot run across an empty or spaces-only line (`marked`'s own rule — a
   * tab-only line does NOT end it), and its width is at most the pipes of a
   * delimiter-row candidate within it + 1. A miss here costs a worker thread, never
   * the event loop.
   */
  parseNodes: number;
  /**
   * Deepest container nesting a single line can ask for: every `>` and list
   * marker (`- - - x`, `1. 1. x`) in its leading run plus that run's blanks (two
   * columns = one level, a tab = four columns) — wherever they stand, also after
   * a `>` or a marker. Inline gate only — `marked` and the DOM/ProseMirror
   * parsers recurse per level.
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
 * The ONE normalisation of line breaks, applied before BOTH the pre-check and the
 * parsers (convert/service.ts and convert/core.ts call it; it is idempotent).
 * `marked` does exactly this to its input (`\r\n|\r` → `\n`), and a body that
 * used a lone `\r` as its separator used to be ONE line to the pre-check and six
 * thousand list items to the parser.
 */
export function normalizeLineBreaks(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/**
 * Characters that END A LINE for the count of lines, besides `\n` and `\r`: form
 * feed, vertical tab, NEL, LS, PS. A JavaScript regex `.` stops at LS / PS and
 * `\s` matches all of them, so some rule of some parser may treat each as a line
 * break — counting a line too many costs nothing.
 */
const isOtherBreak = (c: number): boolean => c === 12 || c === 11 || c === 0x85 || c === 0x2028 || c === 0x2029;
/** Blank characters (JavaScript's `\s`, minus the line breaks above): indentation, as far as nesting goes. */
const isBlank = (c: number): boolean =>
  c === SPACE || c === TAB || c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;

/**
 * What a Markdown source asks of `marked`, as conservative bounds. One pass, no
 * regex, no recursion, no notion of blocks (see the file comment).
 *
 * TABLES are the multiplicative shape: a table's every row is padded to the
 * header's width, so R short rows under a header of C cells are C × R cells. A
 * table needs a delimiter row — a line of nothing but `|`, `-`, `:` and blanks
 * with a `-` and a `|` or `:` (`marked` asks for exactly that) — and its column
 * count is at most that row's pipes + 1. Bounded here for the whole document,
 * independent of blank lines and of what a row looks like: if a line that could
 * be a delimiter row exists ANYWHERE (container markers `>`, `-`, `*`, `+`, `1.`
 * and any blank are allowed on it), every line after the first such line is
 * taken for a row of (the most `|` on any line of the document + 1) cells. Every
 * `|` counts — escaped or not.
 */
export function markdownComplexity(md: string): Pick<Complexity, "delimiterRuns" | "quoteDepth" | "nodes" | "parseNodes" | "nestDepth" | "specials"> {
  let nodes = 0; // every line (+ the containers it can open) + every delimiter run + autolinks (+ table cells, added at the end)
  let runs = 0; // since the last empty / spaces-only line
  let maxRuns = 0;
  let quote = 0; // `>` in the current line's leading run
  let maxQuote = 0;
  let nest = 0; // list markers in the current line's leading run
  let indent = 0; // blank columns in the current line's leading run (wherever they stand)
  let maxNest = 0;
  let specials = 0;
  let inPrefix = true; // still in the line's leading run of `>` / list markers / blanks
  // the current line
  let lineSpacesOnly = true; // nothing but U+0020: the only line that ends a paragraph for `marked`
  let linePipes = 0;
  let lineTableChars = true; // nothing a delimiter row (inside any container) could not hold
  let lineDash = false;
  let linePipeOrColon = false;
  // the document
  let maxPipes = 0;
  let delimiterSeen = false;
  let linesAfterDelimiter = 0;
  // the current table region (for `parseNodes`): from a delimiter-row candidate to the next empty / spaces-only line
  let regionOpen = false;
  let regionPipes = 0; // most `|` on a candidate line of the region
  let regionLines = 0; // lines after its first candidate
  let regionCells = 0; // closed regions
  const closeRegion = (): void => {
    if (regionOpen) regionCells += 2 * (regionPipes + 2) * (regionLines + 1);
    regionOpen = false;
  };
  let prev = 0;
  const endLine = (): void => {
    const depth = quote + nest + (indent >> 1);
    if (depth > maxNest) maxNest = depth;
    // A line, and every container its leading run can open: `> > > x` + an empty line, 120 times
    // over, is 120 × 4 nodes (lines × depth is as multiplicative as a table).
    nodes += 1 + depth;
    if (linePipes > maxPipes) maxPipes = linePipes;
    const candidate = lineTableChars && lineDash && linePipeOrColon;
    if (delimiterSeen) linesAfterDelimiter++;
    else if (candidate) delimiterSeen = true;
    if (lineSpacesOnly) {
      runs = 0;
      closeRegion();
    } else if (regionOpen) {
      regionLines++;
      if (candidate && linePipes > regionPipes) regionPipes = linePipes;
    } else if (candidate) {
      regionOpen = true;
      regionPipes = linePipes;
      regionLines = 0;
    }
    quote = 0;
    nest = 0;
    indent = 0;
    inPrefix = true;
    lineSpacesOnly = true;
    linePipes = 0;
    lineTableChars = true;
    lineDash = false;
    linePipeOrColon = false;
  };
  for (let i = 0; i < md.length; i++) {
    const c = md.charCodeAt(i);
    if (c === NL || c === CR) {
      // (`\r` is normalised away before this runs; counted as a break anyway.)
      endLine();
      prev = c;
      continue;
    }
    if (c < 128 && SPECIAL[c]) specials++;
    if (c !== SPACE) lineSpacesOnly = false;
    if (isOtherBreak(c)) {
      // A line more for the count; for everything else, a blank.
      nodes++;
      if (delimiterSeen) linesAfterDelimiter++;
      if (regionOpen) regionLines++;
      if (inPrefix) indent++;
      prev = c;
      continue;
    }
    const blank = isBlank(c);
    if (inPrefix) {
      if (c === GT) {
        quote++;
        if (quote > maxQuote) maxQuote = quote;
        prev = c;
        continue;
      }
      if (blank) {
        indent += c === TAB ? 4 : 1;
        prev = c;
        continue;
      }
      // A list marker (`- `, `* `, `+ `, `12. `, `3) `) opens one more container on this line.
      const after = md.charCodeAt(i + 1);
      if ((c === DASH || c === STAR || c === PLUS) && (after === SPACE || after === TAB)) {
        nest++;
        if (c === DASH) lineDash = true; // (a marker's dash counts as a delimiter row's: only errs towards the worker)
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
          i = j; // the marker; its blank is taken by the next turn
          prev = mark;
          continue;
        }
      }
      inPrefix = false;
    }
    // Past the leading run: a delimiter row holds nothing but `|`, `-`, `:` and blanks.
    if (c === PIPE) {
      linePipes++;
      linePipeOrColon = true;
    } else if (c === DASH) lineDash = true;
    else if (c === COLON) linePipeOrColon = true;
    else if (!blank) lineTableChars = false;
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
  // (a cell is a `<td>` + its paragraph + its text: about two ordinary nodes' work each — and so
  // is the row itself; + the header row. Measured: 80 one-cell rows ≈ 80–130 ms on the event loop.)
  closeRegion();
  const parseNodes = nodes + regionCells;
  if (delimiterSeen) nodes += 2 * (maxPipes + 2) * (linesAfterDelimiter + 1);
  return { delimiterRuns: maxRuns, quoteDepth: maxQuote, nodes, parseNodes, nestDepth: maxNest, specials };
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
      // Anything a tokenizer could take for the gap between two attributes (form feed included).
      const ws = c === NL || c === CR || isOtherBreak(c) || isBlank(c);
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
  const md = markdown ? markdownComplexity(content) : { delimiterRuns: 0, quoteDepth: 0, nodes: 0, parseNodes: 0, nestDepth: 0, specials: 0 };
  // Markdown may carry raw HTML, which marked passes through to the DOM parser —
  // whole BLOCKS of it, verbatim (`<div>` + 20 KB of lone `>` is 20 KB of lone `>`
  // for the DOM parser). So a Markdown body with any `<` is counted exactly like
  // stored HTML, on top of its lines: its blockquote markers then count as pieces
  // too, which only errs towards the worker.
  const hasTags = content.includes("<");
  const pieces = hasTags || !markdown ? htmlNodeCount(content) : 0;
  return { chars: content.length, ...md, nodes: md.nodes + pieces, parseNodes: md.parseNodes + pieces, htmlDepth: hasTags ? htmlDepth(content) : 0 };
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
