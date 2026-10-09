/**
 * Clipboard helpers of the editor (packages/core/src/lib/tiptap/markdownClipboard.ts),
 * pure parts. Review H3: deciding whether pasted text is Markdown, and converting
 * it, must never freeze the tab — the scanners are linear, the parser input is
 * capped and pathological emphasis density is refused up front. Time-bounded.
 */
// Timed in CPU time of this thread (./probe), never on the wall clock: the figure is the work, not the machine's load.
import { threadCpuMs } from "./probe";
import { test } from "node:test";
import assert from "node:assert/strict";
// Loaded by a computed path (editor code under @prism/core's tsconfig; pure, runs in Node).
const CORE_TIPTAP = "../../../packages/core/src/lib/tiptap/";
const { looksLikeMarkdown, markdownPasteRefusal, markdownSignals, markdownToPasteHtml, MARKDOWN_PASTE_MAX } = (await import(`${CORE_TIPTAP}markdownClipboard`)) as {
  looksLikeMarkdown: (text: string) => boolean;
  markdownPasteRefusal: (text: string) => string | null;
  markdownSignals: (text: string) => unknown;
  markdownToPasteHtml: (text: string) => string;
  MARKDOWN_PASTE_MAX: number;
};

const timed = <T>(fn: () => T): { ms: number; value: T } => {
  const t = threadCpuMs();
  const value = fn();
  return { ms: threadCpuMs() - t, value };
};

test("H3: pathological inputs are decided in linear time", () => {
  const cases: Array<[string, string]> = [
    ["60k blank lines", "\n".repeat(60_000)],
    ["blank lines inside the cap", "\n".repeat(49_000) + "x"],
    ["45 KB of emphasis openers", "*a ".repeat(15_000)],
    ["unclosed bold run", "**a ".repeat(12_000)],
    ["bracket soup", "[a](".repeat(12_000)],
    ["unclosed wikilinks", "[[a ".repeat(12_000)],
    ["one 49 KB line of backticks", "`".repeat(49_000)],
    ["400 KB of pipes", "|a|\n".repeat(100_000)],
    ["1 MB of spaces", " ".repeat(1_000_000)],
  ];
  for (const [name, input] of cases) {
    const a = timed(() => looksLikeMarkdown(input));
    assert.ok(a.ms < 400, `${name}: looksLikeMarkdown took ${Math.round(a.ms)} ms`);
    const b = timed(() => markdownSignals(input));
    assert.ok(b.ms < 400, `${name}: markdownSignals took ${Math.round(b.ms)} ms`);
    const c = timed(() => markdownPasteRefusal(input));
    assert.ok(c.ms < 400, `${name}: markdownPasteRefusal took ${Math.round(c.ms)} ms`);
  }
  // Emphasis density that makes the parser quadratic is never handed to it.
  assert.equal(looksLikeMarkdown("- item\n- item\n" + "*a ".repeat(15_000)), false);
  // Over the cap: never converted; a notice only when it really was Markdown.
  const big = "## Heading\n\n- item\n".repeat(4_000);
  assert.ok(big.length > MARKDOWN_PASTE_MAX);
  assert.equal(looksLikeMarkdown(big), false);
  assert.match(markdownPasteRefusal(big) ?? "", /plain text/);
  assert.equal(markdownPasteRefusal("plain words ".repeat(10_000)), null);
  // What IS converted stays fast at the cap.
  const doc = ("## Section\n\nSome **bold** text with a [link](https://example.test/x) and `code`.\n\n- one\n- two\n\n").repeat(500).slice(0, MARKDOWN_PASTE_MAX);
  assert.equal(looksLikeMarkdown(doc), true);
  const conv = timed(() => markdownToPasteHtml(doc));
  assert.ok(conv.ms < 1500, `a full-size honest document converted in ${Math.round(conv.ms)} ms`);
  // The worst the check still lets through: every paragraph just under the per-paragraph limit, all unmatched.
  const worst = ("- x\n- y\n\n" + (("*a ".repeat(133)) + "\n\n").repeat(200)).slice(0, MARKDOWN_PASTE_MAX);
  assert.equal(looksLikeMarkdown(worst), true);
  const w = timed(() => markdownToPasteHtml(worst));
  assert.ok(w.ms < 1500, `the worst accepted input converted in ${Math.round(w.ms)} ms`);
  for (const dense of ["*a ".repeat(16_000), "- x\n- y\n" + "_a_ ".repeat(3_000), "## T\n\n" + "`a".repeat(9_000)]) assert.equal(looksLikeMarkdown(dense.slice(0, MARKDOWN_PASTE_MAX)), false);
});

test("L3: one strong signal or two weaker ones; prose and program source are left alone", () => {
  for (const md of ["## Plan\n\n- First\n- Second", "- [x] Done\n- [ ] Later", "```\nconst a = 1;\n```", "| a | b |\n| --- | --- |\n| 1 | 2 |", "- one\n- two", "# Title\n\nSome **bold** words", "> quote\n> more", "1. one\n2. two", "See **this** and [that](https://example.test)"]) {
    assert.equal(looksLikeMarkdown(md), true, md);
  }
  for (const plain of [
    "2 * 3 = 6 and snake_case_name",
    "See [[Projects/Prism/Roadmap]] today",
    "- a single dash line",
    "# just one title line",
    "a **bold** word alone",
    "def __init__(self):\n    self.__x__ = 1\n    return self.__x__",
    "#!/bin/sh\n# install things\n# then run\necho hi;\nexit 0;",
    "#include <stdio.h>\nint main() {\n  return 0;\n}",
    "const a = 1;\nconst b = a * 2;\n// - not a list\n// - still not",
    "price: 5 > 3\nand 2 > 1",
    "",
  ]) {
    assert.equal(looksLikeMarkdown(plain), false, plain);
  }
});

test("L2: wikilinks pass through converted Markdown untouched, quotes escaped, a line break ends a non-link", () => {
  assert.equal(markdownToPasteHtml("See [[Projects/my_page|My *page*]] now"), "<p>See [[Projects/my_page|My *page*]] now</p>\n");
  assert.equal(markdownToPasteHtml('A [[say "hi" <b>|x]] b'), "<p>A [[say &quot;hi&quot; &lt;b&gt;|x]] b</p>\n");
  // `[[` with a newline before `]]` is not a link — and the REAL link after it is still protected.
  const out = markdownToPasteHtml("open [[ here\nthen [[Real_page|R *x*]] and ]] close");
  assert.match(out, /\[\[Real_page\|R \*x\*\]\]/);
  assert.match(out, /open \[\[ here/);
  // Placeholder characters in the input cannot forge a substitution.
  assert.doesNotMatch(markdownToPasteHtml("x \u00010\u0002 y [[A]]"), /\u0001|\u0002/);
  assert.match(markdownToPasteHtml("x \u00010\u0002 y [[A]]"), /x 0 y \[\[A\]\]/);
  // Code fences lose only the parser's trailing newline.
  assert.match(markdownToPasteHtml("```\nconst a = 1;\n\n\nconst b = 2;\n```\n"), /<pre><code>const a = 1;\n\n\nconst b = 2;<\/code><\/pre>/);
});
