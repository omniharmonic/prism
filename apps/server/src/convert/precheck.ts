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
  /** Most emphasis/link delimiter runs inside one blank-line-separated block. */
  delimiterRuns: number;
  /** Deepest `>` blockquote prefix on a line. */
  quoteDepth: number;
  /** Deepest element nesting (start tags minus end tags, void elements ignored). */
  htmlDepth: number;
  /**
   * How many nodes a parser will build, roughly: HTML start tags, plus — for
   * Markdown — non-blank lines and delimiter runs. Parsing cost follows THIS, not
   * the byte size (2 MB of text in one paragraph parses in milliseconds; 2,500
   * short paragraphs take a second).
   */
  nodes: number;
}

const STAR = 42; // *
const UNDER = 95; // _
const TILDE = 126; // ~
const OPEN = 91; // [
const NL = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const GT = 62;

/** Delimiter runs per block and blockquote depth of a Markdown source. One pass. */
export function markdownComplexity(md: string): Pick<Complexity, "delimiterRuns" | "quoteDepth" | "nodes"> {
  let nodes = 0; // non-blank lines + every delimiter run
  let runs = 0; // in the current block
  let maxRuns = 0;
  let quote = 0; // `>` seen in the current line's prefix
  let maxQuote = 0;
  let inPrefix = true; // still in the line's leading `>`/whitespace run
  let lineBlank = true;
  let prev = 0;
  for (let i = 0; i < md.length; i++) {
    const c = md.charCodeAt(i);
    if (c === NL) {
      // A blank line (blockquote markers alone count as blank) ends the block.
      if (lineBlank) runs = 0;
      else nodes++;
      quote = 0;
      inPrefix = true;
      lineBlank = true;
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
        prev = c;
        continue;
      }
      inPrefix = false;
    }
    if (c !== SPACE && c !== TAB && c !== CR) lineBlank = false;
    if (c === OPEN || ((c === STAR || c === UNDER || c === TILDE) && prev !== c)) {
      runs++;
      nodes++;
      if (runs > maxRuns) maxRuns = runs;
    }
    prev = c;
  }
  if (!lineBlank) nodes++;
  return { delimiterRuns: maxRuns, quoteDepth: maxQuote, nodes };
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
 *  - attributes (`=` inside a tag) and character references (`&`), which cost
 *    per item though they are not nodes — weighted 1/4.
 */
export function htmlNodeCount(html: string, markdown = false): number {
  let n = 0;
  let cheap = 0; // attributes + entities
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === LT) {
      n++;
      inTag = true;
    } else if (c === GT) {
      if (inTag) inTag = false;
      else if (!markdown) n++; // in Markdown a bare `>` is a blockquote marker or text (escaped by marked)
    } else if (!markdown && (c === AMP || (c === EQ && inTag))) cheap++;
  }
  return n + (cheap >> 2);
}

/** Everything the service decides on, for a note body (`markdown` = it goes through marked). */
export function complexityOf(content: string, markdown: boolean): Complexity {
  const md = markdown ? markdownComplexity(content) : { delimiterRuns: 0, quoteDepth: 0, nodes: 0 };
  // Markdown may carry raw HTML, which marked passes through to the DOM parser.
  const hasTags = content.includes("<");
  // Stored HTML goes straight to the DOM parser: count every piece it will make.
  // Markdown's `>` and `&` are blockquotes and text for `marked` (already counted
  // per line / held to the inline byte cap), so only its `<` pieces are added.
  return { chars: content.length, ...md, nodes: md.nodes + (markdown ? (hasTags ? htmlNodeCount(content, true) : 0) : htmlNodeCount(content)), htmlDepth: hasTags ? htmlDepth(content) : 0 };
}

/** Nodes + marks and text length of a ProseMirror JSON document, abandoned once past `limit` nodes. Iterative. */
export function docJsonWeight(json: unknown, limit = Infinity): { nodes: number; chars: number; depth: number; complete: boolean } {
  let nodes = 0;
  let chars = 0;
  let depth = 0;
  const stack: Array<[unknown, number]> = [[json, 1]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (!n || typeof n !== "object") continue;
    const node = n as { text?: unknown; content?: unknown; marks?: unknown };
    nodes += 1 + (Array.isArray(node.marks) ? node.marks.length : 0);
    if (d > depth) depth = d;
    if (typeof node.text === "string") chars += node.text.length;
    if (nodes > limit) return { nodes, chars, depth, complete: false };
    if (Array.isArray(node.content)) for (const child of node.content) stack.push([child, d + 1]);
  }
  return { nodes, chars, depth, complete: true };
}
