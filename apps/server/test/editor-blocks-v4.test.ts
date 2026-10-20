/**
 * Schema v4 blocks (wave 2B) through the server's HTML ⇄ Yjs persistence:
 * attachment, embed, bookmark, table of contents, inline database, image
 * align/caption — and the two security-review regressions:
 *   H1  an attachment's `data-src` is own-attachment or https only (never an
 *       arbitrary same-origin path, never javascript:), and a block that fails
 *       keeps its fallback link instead of becoming a live block;
 *   H2  images with relative / protocol-relative / cid: / blob: sources SURVIVE
 *       (only javascript:/vbscript:/data: are refused).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { contentToYUpdate, yDocToHtml } from "../src/collab";

const roundTrip = (html: string): string => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, contentToYUpdate(html));
  return yDocToHtml(doc);
};
const stable = (html: string): string => {
  const once = roundTrip(html);
  assert.equal(roundTrip(once), once, "second round-trip must be byte-stable");
  return once;
};

test("inline database block: stored shape is byte-stable; invalid ids are never a block", () => {
  assert.equal(stable('<div data-prism-database="db_1-A" data-view="v1abc"></div>'), '<div data-prism-database="db_1-A" data-view="v1abc"></div>');
  assert.equal(stable('<div data-prism-database="db1"></div>'), '<div data-prism-database="db1"></div>');
  // An over-long / path-like view id is dropped; the block survives on its note id.
  assert.equal(stable('<div data-prism-database="db1" data-view="../x"></div>'), '<div data-prism-database="db1"></div>');
  for (const bad of ["vault/tasks/db", "a b", "../../etc", "x".repeat(129), ""]) {
    assert.doesNotMatch(roundTrip(`<p>k</p><div data-prism-database="${bad}"></div>`), /data-prism-database/, bad);
  }
});

test("attachment: own-attachment and https sources survive with every attribute", () => {
  const own = stable('<div data-type="attachment" data-kind="pdf" data-src="/api/attachments/a_AbC-123_x" data-name="Q3 report.pdf" data-size="20481" data-mime="application/pdf"><a href="/api/attachments/a_AbC-123_x">Q3 report.pdf</a></div>');
  for (const part of ['data-type="attachment"', 'data-kind="pdf"', 'data-src="/api/attachments/a_AbC-123_x"', 'data-name="Q3 report.pdf"', 'data-size="20481"', 'data-mime="application/pdf"', ">Q3 report.pdf</a>"]) assert.ok(own.includes(part), part);
  const https = stable('<div data-type="attachment" data-kind="file" data-src="https://files.example.org/a.zip" data-name="a.zip"><a href="https://files.example.org/a.zip">a.zip</a></div>');
  assert.match(https, /data-src="https:\/\/files\.example\.org\/a\.zip"/);
});

test("H1: an attachment pointing at any other same-origin path, http or a script URL is NOT a block — its link text survives", () => {
  for (const src of ["/auth/logout", "/api/notes/secret", "/e2e-fixtures/x.pdf", "//evil.example/x.pdf", "http://plain.example/x.pdf", "javascript:alert(1)", "data:text/html,<script>1</script>"]) {
    const out = roundTrip(`<div data-type="attachment" data-kind="pdf" data-src="${src}" data-name="x.pdf"><a href="${src.startsWith("javascript") || src.startsWith("data") ? "https://safe.example/" : src}">x.pdf</a></div>`);
    assert.doesNotMatch(out, /data-type="attachment"/, src);
    assert.match(out, /x\.pdf/, `${src}: the fallback text is kept`);
    assert.doesNotMatch(out, /javascript:|data:text/, src);
  }
});

test("H2: images with relative, protocol-relative, cid: and blob: sources survive; dangerous schemes do not", () => {
  for (const src of ["images/diagram.png", "./a b.png", "../assets/x.jpg", "/img/logo.png", "//cdn.example.org/x.png", "cid:part1.06090408@example.org", "blob:https://app.example/7f0c", "https://example.org/a.png", "/api/attachments/a_1"]) {
    const out = stable(`<p>before</p><img src="${src}" alt="A"><p>after</p>`);
    assert.ok(out.includes(`src="${src}"`), `kept: ${src} → ${out}`);
  }
  for (const src of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "vbscript:x", "data:image/svg+xml,<svg onload=alert(1)>", "data:image/png;base64,AAAA"]) {
    const out = roundTrip(`<p>before</p><img src="${src}" alt="A"><p>after</p>`);
    assert.doesNotMatch(out, /<img/, src);
    assert.match(out, /before/);
    assert.match(out, /after/);
  }
});

test("image align + caption + width round-trip", () => {
  const out = stable('<img src="/api/attachments/a_1" alt="Map" width="320" data-align="left" data-caption="River &amp; lake">');
  for (const part of ['width="320"', 'data-align="left"', 'data-caption="River &amp; lake"']) assert.ok(out.includes(part), part);
  assert.doesNotMatch(stable('<img src="/a.png" data-align="sideways">'), /data-align/);
});

test("embed stores only the pasted URL; bookmark keeps only server-produced preview images", () => {
  const embed = stable('<div data-type="embed" data-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" data-height="400"><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">x</a></div>');
  assert.match(embed, /data-url="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/);
  assert.match(embed, /data-height="400"/);
  assert.doesNotMatch(embed, /<iframe/);
  assert.doesNotMatch(roundTrip('<div data-type="embed" data-url="javascript:alert(1)"></div>'), /data-type="embed"/);
  const proxied = "/api/media/proxy?u=https%3A%2F%2Fexample.org%2Fog.png";
  const bm = stable(`<div data-type="bookmark" data-url="https://example.org/a" data-title="T" data-description="D" data-site="S" data-image="${proxied}" data-favicon="${proxied}"><a href="https://example.org/a">T</a></div>`);
  assert.ok(bm.includes(`data-image="${proxied}"`) && bm.includes(`data-favicon="${proxied}"`));
  // A raw third-party image URL (or any other path) is dropped from a bookmark; the card stays.
  const raw = stable('<div data-type="bookmark" data-url="https://example.org/a" data-title="T" data-image="https://tracker.example/p.gif" data-favicon="/auth/logout"><a href="https://example.org/a">T</a></div>');
  assert.match(raw, /data-type="bookmark"/);
  assert.doesNotMatch(raw, /data-image|data-favicon/);
});

test("table of contents marker and highlighted code keep their stored shape", () => {
  assert.equal(stable('<div data-type="toc"></div><h2>A</h2>'), '<div data-type="toc"></div><h2>A</h2>');
  assert.equal(stable('<pre><code class="language-python">print(1)\n  x = 2</code></pre>'), '<pre><code class="language-python">print(1)\n  x = 2</code></pre>');
});
