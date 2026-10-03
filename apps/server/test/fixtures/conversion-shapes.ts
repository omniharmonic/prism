/**
 * The audited shapes of the conversion pre-check (rounds 5 and 6): inputs that are
 * multiplicative, recursive, or simply not what a counter once counted. Each is a
 * function of the size aimed for, in bytes. A new shape goes HERE — both rounds'
 * tests then hold it to the same rule: at every size it is either not "cheap"
 * (never converted on the main thread) or measured there under the lag budget.
 */
/** `marked` pads every body row to the header's width: ~4C + 2R characters, C × R cells. */
export const table = (cols: number, rows: number, pipe = "|") => pipe + ("a" + pipe).repeat(cols) + "\n|" + "-|".repeat(cols) + "\n" + "x\n".repeat(rows);
/** A table's header + delimiter row, `cols` columns wide. */
export const tableHead = (cols: number) => "|a".repeat(cols) + "\n" + "|-".repeat(cols) + "\n";
export const lines = (n: number, line: (i: number) => string): string => {
  let out = "";
  for (let i = 0; out.length < n; i++) out += line(i);
  return out;
};
/** Markdown shapes that are multiplicative, recursive or simply not what the old counters counted. `n` = bytes aimed for. */
export const MD_SHAPES: Array<[string, (n: number) => string]> = [
  ["table (C × R cells)", (n) => table(Math.ceil(n / 6), Math.ceil(n / 6))],
  ["table, no leading pipe", (n) => "a|".repeat(n / 6) + "\n" + "-|".repeat(n / 6) + "\n" + "x\n".repeat(n / 6)],
  ["table, escaped-backslash pipes", (n) => "|" + "a\\\\|".repeat(n / 10) + "\n|" + "-|".repeat(n / 10) + "\n" + "x\n".repeat(n / 6)],
  ["table, wide rows", (n) => lines(n, () => "|a|b|c|d|\n").replace("\n", "\n|-|-|-|-|\n")],
  ["table inside a blockquote", (n) => "> |" + "a|".repeat(n / 8) + "\n> |" + "-|".repeat(n / 8) + "\n" + "> x\n".repeat(n / 16)],
  ["raw HTML block of lone >", (n) => "<div>\n" + ">".repeat(n)],
  ["raw HTML block of &", (n) => "<div>\n" + "&".repeat(n)],
  ["raw HTML block of entities", (n) => "<div>\n" + "&amp;".repeat(n / 5)],
  ["raw HTML, boolean attributes", (n) => "<div " + "a ".repeat(n / 2) + ">x</div>"],
  ["raw HTML, attributes", (n) => "<div " + "a=1 ".repeat(n / 4) + ">x</div>"],
  ["raw HTML comment tails", (n) => "<div>\n" + "-->".repeat(n / 3)],
  ["< flood", (n) => "<".repeat(n)],
  ["a < b", (n) => "a < b ".repeat(n / 6)],
  ["unclosed tags", (n) => "<a ".repeat(n / 3)],
  ["nested lists on one line", (n) => "- ".repeat(n / 2) + "x"],
  ["nested ordered lists on one line", (n) => "1. ".repeat(n / 3) + "x"],
  ["nested mixed containers on one line", (n) => "> - 1. ".repeat(n / 7) + "x"],
  ["nested blockquotes on one line", (n) => "> ".repeat(n / 2) + "x"],
  ["nested lists by indentation", (n) => lines(n, (i) => "  ".repeat(i) + "- x\n")],
  ["nested emphasis", (n) => "*_".repeat(n / 4) + "x" + "_*".repeat(n / 4)],
  ["one long * run", (n) => "a " + "*".repeat(n) + " b"],
  ["one long _ run", (n) => "a" + "_".repeat(n) + "b"],
  ["one long ~ run", (n) => "a " + "~".repeat(n) + " b"],
  ["unmatched emphasis", (n) => "*a ".repeat(n / 3)],
  ["link reference definitions", (n) => lines(n / 2, (i) => `[r${i}]: http://x.test/${i}\n`) + "\n" + lines(n / 2, (i) => `[r${i}] `)],
  ["one long backtick run", (n) => "a " + "`".repeat(n) + " b"],
  ["unmatched backticks", (n) => "`a ".repeat(n / 3)],
  ["backtick runs of growing length", (n) => lines(n, (i) => "`".repeat((i % 40) + 1) + "a ")],
  ["[ flood", (n) => "[".repeat(n)],
  ["] flood", (n) => "]".repeat(n)],
  ["footnote-like [^1]", (n) => "[^1]".repeat(n / 4)],
  ["empty links []", (n) => "[]".repeat(n / 2)],
  ["image openers ![", (n) => "![".repeat(n / 2)],
  ["link openers [a](", (n) => "[a](".repeat(n / 4)],
  ["( flood after a link", (n) => "[a](" + "(".repeat(n)],
  ["delimiter soup on one line", (n) => "*_~`[]()!<>&|\\".repeat(n / 14)],
  ["hard-wrapped delimiters, one line", (n) => "**a**_b_~~c~~`d`".repeat(n / 16)],
  ["bare autolinks", (n) => "www.a.b ".repeat(n / 8)],
  ["scheme autolinks", (n) => "http://a.b ".repeat(n / 11)],
  ["e-mail autolinks", (n) => "a@b.cd ".repeat(n / 7)],
  ["backslashes", (n) => "\\".repeat(n)],
  ["# flood", (n) => "#".repeat(n)],
  ["trailing blanks", (n) => "a" + " ".repeat(n) + "\nb"],
  ["blank lines of spaces", (n) => lines(n, () => "    \n")],
  ["tabs", (n) => "\t".repeat(n) + "x"],
  ["setext underlines", (n) => "a\n===\n".repeat(n / 6)],
  // ── round 6: whatever a table's rows, a blank line or a nesting level may look like ──
  ["list items", (n) => "- a\n".repeat(n / 4)],
  ["table, then tab-only lines", (n) => tableHead(61) + "\t\n".repeat(n / 2) + "x\n"],
  ["table, then space-and-tab lines", (n) => tableHead(61) + " \t \n".repeat(n / 4) + "x\n"],
  ["table, then NBSP-only lines", (n) => tableHead(61) + "\u00a0\n".repeat(n / 2) + "x\n"],
  ["narrow table, then tab-only lines", (n) => tableHead(3) + "\t\n".repeat(n / 2) + "x\n"],
  ["table, then lines of spaces", (n) => tableHead(20) + lines(n, () => "    \n") + "x\n"],
  ["table, a row of trailing blanks", (n) => tableHead(20) + "a" + " ".repeat(n) + "\nb\n"],
  ["table, a row of tabs", (n) => tableHead(20) + "\t".repeat(n) + "x\n"],
  ["table inside a list item", (n) => "- " + "|a".repeat(40) + "\n  " + "|-".repeat(40) + "\n" + "  x\n".repeat(n / 4)],
  ["a delimiter row deep in prose", (n) => "word\n".repeat(n / 10) + tableHead(30) + "x\n".repeat(n / 4)],
  ["one-column table (:-)", (n) => "a\n:-\n" + "x\n".repeat(n / 2)],
  ["quote + growing indent + list item", (n) => lines(n, (i) => "> " + "  ".repeat(i) + "- x\n")],
  ["list + growing indent after the marker", (n) => lines(n, (i) => "- " + "  ".repeat(i) + "- x\n")],
  ["deep quotes on every other line", (n) => lines(n, () => "> ".repeat(30) + "x\n\n")],
  ["deep list markers on every other line", (n) => lines(n, () => "- ".repeat(30) + "x\n\n")],
];
/** Stored-HTML shapes the round-4 counter did not know. */
export const HTML_SHAPES: Array<[string, (n: number) => string]> = [
  ["boolean attributes", (n) => "<p " + "a ".repeat(n / 2) + ">x</p>"],
  ["quoted attributes", (n) => "<p " + 'a="1" '.repeat(n / 6) + ">x</p>"],
  ["one attribute, = flood", (n) => "<p a" + "=".repeat(n) + ">x</p>"],
  ["table cells", (n) => "<table><tbody><tr>" + "<td><p>x</p></td>".repeat(n / 17) + "</tr></tbody></table>"],
];

/** Line breaks other than `\n` that some rule of some parser treats as one (or as a blank): every shape is tried with each. */
export const BREAK_VARIANTS: Array<[string, (s: string) => string]> = [
  ["lone CR", (s) => s.replaceAll("\n", "\r")],
  ["CRLF", (s) => s.replaceAll("\n", "\r\n")],
  ["mixed CR / LF / CRLF", (s) => { let i = 0; return s.replace(/\n/g, () => ["\r", "\n", "\r\n"][i++ % 3]!); }],
  ["form feed", (s) => s.replaceAll("\n", "\f")],
  ["vertical tab", (s) => s.replaceAll("\n", "\v")],
  ["U+2028", (s) => s.replaceAll("\n", "\u2028")],
  ["U+2029", (s) => s.replaceAll("\n", "\u2029")],
  ["NEL", (s) => s.replaceAll("\n", "\u0085")],
  ["LF + form feed", (s) => s.replaceAll("\n", "\n\f")],
];
