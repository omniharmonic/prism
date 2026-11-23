import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpuOf } from "./probe.js";
import {
  fromMarkdownLite,
  fromMatrixContent,
  MAX_BODY_CHARS,
  type Span,
} from "../src/comms/richtext.js";

const html = (formatted_body: string, body = "fallback") =>
  fromMatrixContent({ msgtype: "m.text", body, format: "org.matrix.custom.html", formatted_body });

describe("comms richtext", () => {
  it("formatted_body allowlist", () => {
    const r = html(
      '<b>a</b><i>b</i><del>c</del><code>d</code><a href="https://x.test">e</a><blockquote>f</blockquote><script>g</script>',
    );
    assert.deepEqual(r.spans, [
      { t: "bold", c: [{ t: "text", v: "a" }] },
      { t: "italic", c: [{ t: "text", v: "b" }] },
      { t: "strike", c: [{ t: "text", v: "c" }] },
      { t: "code", c: [{ t: "text", v: "d" }] },
      { t: "link", href: "https://x.test/", c: [{ t: "text", v: "e" }] },
      { t: "quote", c: [{ t: "text", v: "f" }] },
    ] satisfies Span[]);
    assert.ok(!r.plain.includes("g"));
    assert.ok(!r.plain.includes("script"));
  });

  it("drops contents of dangerous elements", () => {
    const r = html(
      'x<style>.a{}</style><iframe src="https://e.test">frame</iframe><object>obj</object><embed src="x">y<head><title>t</title></head>',
    );
    assert.equal(r.plain, "xy");
  });

  it("javascript: links dropped", () => {
    const r = html('<a href="javascript:alert(1)">x</a>');
    assert.deepEqual(r.spans, [{ t: "text", v: "x" }]);
    for (const href of ["data:text/html,x", " JaVaScript:alert(1)", "vbscript:x", "//evil.test", "/rel"]) {
      const s = html(`<a href="${href}">x</a>`);
      assert.deepEqual(s.spans, [{ t: "text", v: "x" }], href);
    }
    const m = html('<a href="mailto:a@b.test">m</a>');
    assert.equal(m.spans[0]?.t, "link");
  });

  it("strips event handlers and unknown attributes", () => {
    const r = html('<b onclick="x()" style="color:red">a</b><img src="https://e.test/x.png" onerror="y()">');
    assert.deepEqual(r.spans, [{ t: "bold", c: [{ t: "text", v: "a" }] }]);
  });

  it("mention", () => {
    const r = html('<a href="https://matrix.to/#/@alice:staging.local">Alice</a>');
    assert.deepEqual(r.spans, [{ t: "mention", id: "@alice:staging.local", name: "Alice" }]);
  });

  it("reply fallback stripped", () => {
    assert.equal(html("<mx-reply><blockquote>old</blockquote></mx-reply>hi").plain, "hi");
    const r = fromMatrixContent({
      msgtype: "m.text",
      body: "> <@a:b> quoted\n\nhi",
      "m.relates_to": { "m.in_reply_to": { event_id: "$e" } },
    });
    assert.equal(r.plain, "hi");
  });

  it("markdown-lite", () => {
    const r = fromMarkdownLite("*bold* _it_ ~st~ `c`");
    const types = r.spans.map((s) => s.t).filter((t) => t !== "text");
    assert.deepEqual(types, ["bold", "italic", "strike", "code"]);
    assert.equal(r.plain, "bold it st c");
    const pre = fromMarkdownLite("```a\nb```");
    assert.deepEqual(pre.spans, [{ t: "pre", v: "a\nb" }]);
    assert.equal(fromMarkdownLite("snake_case_name").plain, "snake_case_name");
  });

  it("jumbo emoji", () => {
    assert.equal(fromMatrixContent({ body: "👨‍👩‍👧‍👦🇺🇸👍🏽" }).jumboEmoji, true);
    assert.equal(fromMatrixContent({ body: "😀😀😀😀" }).jumboEmoji, false);
    assert.equal(fromMatrixContent({ body: "hi 😀" }).jumboEmoji, false);
  });

  it("truncation", () => {
    const r = fromMatrixContent({ body: "x".repeat(70_000) });
    assert.equal(r.plain.length, 64000);
    assert.equal(MAX_BODY_CHARS, 64000);
    assert.equal(r.truncated, true);
    const h = html("<b>" + "y".repeat(70_000) + "</b>");
    assert.equal(h.plain.length, 64000);
    assert.equal(h.truncated, true);
    assert.equal(fromMatrixContent({ body: "short" }).truncated, false);
  });

  it("newlines preserved", () => {
    const r = fromMatrixContent({ body: "a\n\nb" });
    assert.deepEqual(r.spans, [
      { t: "text", v: "a" },
      { t: "br" },
      { t: "br" },
      { t: "text", v: "b" },
    ]);
    assert.equal(r.plain, "a\n\nb");
  });

  it("deeply nested html does not blow the stack", () => {
    const r = html("<b>".repeat(5000) + "deep" + "</b>".repeat(5000));
    assert.ok(r.plain.includes("deep"));
  });

  it("missing body is empty", () => {
    const r = fromMatrixContent({});
    assert.deepEqual(r, { spans: [], plain: "", jumboEmoji: false, truncated: false });
  });

  it("adversarial nesting 10k deep does not throw and is bounded", () => {
    for (const open of ["<b>", "<blockquote>", "<a href=\"https://x.test\">", "<li>", "<"]) {
      const r = html(open.repeat(10_000) + "deep");
      assert.ok(r.plain.length <= MAX_BODY_CHARS);
    }
    const r = html("<b>".repeat(10_000) + "deep");
    assert.ok(r.plain.includes("deep"));
    const depth = (spans: Span[]): number =>
      Math.max(0, ...spans.map((s) => ("c" in s ? 1 + depth(s.c) : 0)));
    assert.ok(depth(r.spans) <= 41);
    // unterminated constructs consume the rest of the input once, never loop
    assert.doesNotThrow(() => html("<!--".repeat(50_000) + "<a href=\"" .repeat(50_000)));
    assert.doesNotThrow(() => html("<script>".repeat(50_000)));
  });

  it("unclosed tags are closed implicitly", () => {
    assert.deepEqual(html("<b>a<i>b").spans, [
      { t: "bold", c: [{ t: "text", v: "a" }, { t: "italic", c: [{ t: "text", v: "b" }] }] },
    ]);
    assert.deepEqual(html("<b>a<i>b</b>c").spans, [
      { t: "bold", c: [{ t: "text", v: "a" }, { t: "italic", c: [{ t: "text", v: "b" }] }] },
      { t: "text", v: "c" },
    ]);
    assert.deepEqual(html("<ul><li>x<li>y</ul>").spans, [
      { t: "li", c: [{ t: "text", v: "x" }] },
      { t: "li", c: [{ t: "text", v: "y" }] },
    ]);
    assert.deepEqual(html("a</b>b").spans, [{ t: "text", v: "ab" }]);
  });

  it("attribute quoting variants (single, double, unquoted) for href", () => {
    for (const a of ['href="https://x.test/?a=1&amp;b=2"', "href='https://x.test/?a=1&amp;b=2'", "href=https://x.test/?a=1&amp;b=2", 'class="c>d" HREF = "https://x.test/?a=1&amp;b=2"']) {
      const r = html(`<a ${a}>e</a>`);
      assert.deepEqual(r.spans, [{ t: "link", href: "https://x.test/?a=1&b=2", c: [{ t: "text", v: "e" }] }], a);
    }
  });

  it("entities decoded (&amp; &lt; &#x1F600;)", () => {
    const r = html("a &amp; b &lt;i&gt; &#x1F600;");
    assert.equal(r.plain, "a & b <i> \u{1F600}");
    assert.deepEqual(r.spans, [{ t: "text", v: "a & b <i> \u{1F600}" }]);
  });

  it("block elements separate with a single br", () => {
    assert.equal(html("<p>a</p>\n<p>b</p>").plain, "a\nb");
  });

  it("reply fallback is stripped only for replies, and only its own shape", () => {
    const quote = fromMatrixContent({ body: "> a famous quote" });
    assert.equal(quote.plain, "> a famous quote");
    const kept = fromMatrixContent({ body: "> <@a:b> quoted\n\nhi" });
    assert.equal(kept.plain, "> <@a:b> quoted\n\nhi");
    const reply = (body: string) =>
      fromMatrixContent({ body, "m.relates_to": { "m.in_reply_to": { event_id: "$e" } } }).plain;
    assert.equal(reply("> <@a:b> one\n> two\n\nhi\n\n> not stripped"), "hi\n\n> not stripped");
    assert.equal(reply("> just a quote, no fallback shape"), "> just a quote, no fallback shape");
  });

  it("hrefs are emitted normalized (parser-differential safe)", () => {
    const r = html('<a href="https://good.test\\@evil.test">x</a>');
    assert.deepEqual(r.spans, [{ t: "link", href: "https://good.test/@evil.test", c: [{ t: "text", v: "x" }] }]);
    assert.deepEqual(html('<a href="https://X.test:443/a b">x</a>').spans, [{ t: "text", v: "x" }]);
  });

  it("markdown-lite emphasis is linear on adversarial input", () => {
    const shapes = [
      "*a ".repeat(21_000),
      "_a ".repeat(21_000),
      "~a ".repeat(21_000),
      "`a ".repeat(21_000),
      "*a\n".repeat(2000) + "a* ".repeat(19_000),
      "*_~".repeat(21_000),
    ];
    for (const s of shapes) {
      const { value, cpuMs } = cpuOf(() => fromMarkdownLite(s));
      assert.ok(value.plain.length > 0);
      assert.ok(cpuMs < 250, `${s.slice(0, 6)} took ${cpuMs} ms of CPU`);
    }
  });
});
