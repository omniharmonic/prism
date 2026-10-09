/** The export sanitiser and its helpers (`@prism/core/import-export` sanitize.ts): allowlist output, linear time. */
import { threadCpuMs } from "./probe";
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlDepth, htmlToText, safeUrl, sanitizeHtml } from "@prism/core/import-export";

test("sanitizeHtml rebuilds from an allowlist: no script, handlers, forms, foreign content or unsafe URLs", () => {
  const cases: Array<[string, string]> = [
    ['<p class="a" style="x" onclick="y" data-type="mention" data-x=\'1"2\'>t</p>', '<p class="a" data-type="mention" data-x="1&quot;2">t</p>'],
    ["<script>alert(1)</script><p>a</p><SCRIPT src=x></SCRIPT>b", "<p>a</p>b"],
    ["<p>a<script>alert(1)", "<p>a</p>"],
    ['<a href="JaVaScRiPt:alert(1)">x</a><a href="&#106;avascript:1">y</a><a href="java\nscript:1">z</a><a href="/rel?a=b:c">r</a><a href="mailto:a@b.co">m</a>', '<a>x</a><a>y</a><a>z</a><a href="/rel?a=b:c">r</a><a href="mailto:a@b.co">m</a>'],
    ['<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="a"><img src="mailto:x"><img src="https://e.com/a.png" onerror=alert(1)>', '<img alt="a"><img><img src="https://e.com/a.png">'],
    ['<svg><style><img src=x onerror=alert(1)></style></svg><math><mi xlink:href="javascript:1">x</mi></math>after', "after"],
    ['<form action="https://evil"><input value="v"><button formaction="javascript:1">go</button></form>', "go"],
    ['<meta http-equiv="refresh" content="0;url=//evil"><base href="//evil"><link rel=stylesheet href=x><p>k</p>', "<p>k</p>"],
    ["<!-- c --><!doctype html><?xml v?><p>a &amp; b &lt;script&gt; 1 < 2 > 0</p>", "<p>a &amp; b &lt;script&gt; 1 &lt; 2 &gt; 0</p>"],
    ["<ul><li>a<li>b</ul></div></p>tail", "<ul><li>a<li>b</li></li></ul>tail"],
    ['<p title="a>b" onmouseover="x>y">q</p>', '<p title="a&gt;b">q</p>'],
    ["<iframe src=x>inner</iframe><textarea><script>1</script></textarea><noscript><p>n</p></noscript>ok", "ok"],
    ['<div><custom-el onclick=1>kept text</custom-el></div><p unterminated', "<div>kept text</div>"],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeHtml(input), expected, input);
  assert.equal(safeUrl("https://a", false), true);
  assert.equal(safeUrl("mailto:a", false), false);
  assert.equal(safeUrl("  \tJAVA\nSCRIPT:x", true), false);
  assert.equal(safeUrl("a/b:c", false), true);
  // Nesting is capped; the text survives.
  const deep = sanitizeHtml(`${"<div>".repeat(5000)}x${"</div>".repeat(5000)}`, 50);
  assert.equal(deep, `${"<div>".repeat(50)}x${"</div>".repeat(50)}`);
});

test("htmlDepth / htmlToText, and everything is linear on hostile input", () => {
  assert.equal(htmlDepth("<div><p>a<br><b>c</b></p></div><p>x</p>"), 3);
  assert.equal(htmlDepth("<div>".repeat(1000)), 1000);
  assert.equal(htmlToText("<h1>T</h1><p>a &amp; b<br>c</p><script>x()</script><p>d</p>"), "T\na & b\nc\nd\n");
  const n = 300_000;
  const shapes = ["<".repeat(n), "<a ".repeat(n / 3), "<p".repeat(n / 2), '<a href="'.repeat(n / 9), "<script>".repeat(n / 8), "</".repeat(n / 2), "<!--".repeat(n / 4), "<div>".repeat(n / 5), "<svg><svg>".repeat(n / 10), "&#".repeat(n / 2), `<p ${'a="b" '.repeat(n / 6)}>`, `<a href="${"j".repeat(n)}">`];
  for (const s of shapes) {
    const t0 = threadCpuMs(); // CPU time of this thread (./probe), not the wall clock
    sanitizeHtml(s);
    htmlDepth(s);
    htmlToText(s);
    const ms = threadCpuMs() - t0;
    assert.ok(ms < 2000, `${s.slice(0, 10)}… took ${ms} ms`);
  }
});
