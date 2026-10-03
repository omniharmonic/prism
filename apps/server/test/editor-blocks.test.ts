/**
 * Block editor nodes (callout, toggle, columns, table, image, block + text
 * colours) survive the server's HTML ⇄ Yjs persistence through the SHARED
 * schema (`@prism/core/editor-schema`). Every case is round-tripped twice: the
 * first pass may normalise the input, the second must be byte-stable — that is
 * what a stored note sees when a live session re-persists it.
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

test("callout keeps its emoji and nested blocks", () => {
  const out = stable('<div data-type="callout" data-emoji="⚠️"><p>Mind the <strong>gap</strong></p><ul><li><p>one</p></li></ul></div>');
  assert.match(out, /<div data-emoji="⚠️" data-type="callout">/);
  assert.match(out, /<strong>gap<\/strong>/);
  assert.match(out, /<ul><li><p>one<\/p><\/li><\/ul><\/div>/);
});

test("callout without an emoji gets the default and an empty callout stays a block", () => {
  const out = stable('<div data-type="callout"><p>Note</p></div>');
  assert.match(out, /data-emoji="💡"/);
});

test("toggle keeps its summary and body; open/closed is view state and never stored", () => {
  const fromOpen = stable('<details data-type="toggle" open><summary>Read <em>more</em></summary><p>Hidden body</p><p>Second</p></details>');
  assert.match(fromOpen, /<details data-type="toggle"><summary>Read <em>more<\/em><\/summary><p>Hidden body<\/p><p>Second<\/p><\/details>/);
  const closed = stable('<details data-type="toggle"><summary>Closed</summary><p>Body</p></details>');
  assert.equal(closed, '<details data-type="toggle"><summary>Closed</summary><p>Body</p></details>');
});

test("a plain <details> from elsewhere becomes a toggle instead of losing its body", () => {
  const out = stable("<details><summary>Q</summary><p>A</p></details>");
  assert.match(out, /<details data-type="toggle"><summary>Q<\/summary><p>A<\/p><\/details>/);
});

test("two- and three-column layouts keep every column's content", () => {
  const two = stable('<div data-type="columns"><div data-type="column"><p>Left</p></div><div data-type="column"><h2>Right</h2></div></div>');
  assert.match(two, /<div data-type="columns" data-count="2"><div data-type="column"><p>Left<\/p><\/div><div data-type="column"><h2>Right<\/h2><\/div><\/div>/);
  const three = stable('<div data-type="columns"><div data-type="column"><p>A</p></div><div data-type="column"><p>B</p></div><div data-type="column"><p>C</p></div></div>');
  assert.match(three, /data-count="3"/);
  assert.equal((three.match(/data-type="column"/g) ?? []).length, 3);
});

test("tables keep header cells, body cells and inline formatting", () => {
  const out = stable("<table><tbody><tr><th><p>Name</p></th><th><p>Role</p></th></tr><tr><td><p>Ada</p></td><td><p><strong>Lead</strong></p></td></tr></tbody></table>");
  assert.match(out, /<table/);
  assert.equal((out.match(/<th /g) ?? out.match(/<th>/g) ?? []).length, 2);
  assert.match(out, /<td[^>]*><p>Ada<\/p><\/td>/);
  assert.match(out, /<strong>Lead<\/strong>/);
});

test("images keep src, alt and title", () => {
  const out = stable('<p>Before</p><img src="https://example.test/a.png" alt="A chart" title="Q3"><p>After</p>');
  assert.match(out, /<img src="https:\/\/example.test\/a.png" alt="A chart" title="Q3">/);
});

test("block colours survive on paragraphs, headings, lists, quotes, callouts and toggles; unknown values are dropped", () => {
  const out = stable(
    '<p data-block-color="blue">Blue</p><h2 data-block-color="red_background">Bg</h2>' +
    '<ul data-block-color="green"><li><p>g</p></li></ul><blockquote data-block-color="gray"><p>q</p></blockquote>' +
    '<div data-type="callout" data-block-color="yellow_background"><p>c</p></div>' +
    '<details data-type="toggle" data-block-color="blue_background"><summary>t</summary><p>b</p></details>' +
    '<p data-block-color="javascript:alert(1)">bad</p>',
  );
  for (const v of ["blue", "red_background", "green", "gray", "yellow_background", "blue_background"]) {
    assert.match(out, new RegExp(`data-block-color="${v}"`), v);
  }
  assert.doesNotMatch(out, /javascript/);
});

test("inline text colour and background highlight survive; unknown text colours are dropped", () => {
  const out = stable('<p><span data-text-color="red">red</span> and <mark data-color="var(--prism-color-yellow-bg)" style="background-color: var(--prism-color-yellow-bg); color: inherit">hi</mark> <span data-text-color="evil">x</span></p>');
  assert.match(out, /<span data-text-color="red">red<\/span>/);
  assert.match(out, /<mark data-color="var\(--prism-color-yellow-bg\)"/);
  assert.doesNotMatch(out, /evil/);
});

test("nested new blocks (a table and a toggle inside a column inside a callout) round-trip", () => {
  const out = stable(
    '<div data-type="callout" data-emoji="💡"><div data-type="columns"><div data-type="column">' +
    '<details data-type="toggle"><summary>S</summary><p>x</p></details></div>' +
    '<div data-type="column"><table><tbody><tr><td><p>c</p></td></tr></tbody></table></div></div></div>',
  );
  assert.match(out, /data-type="callout"[\s\S]*data-type="columns"[\s\S]*data-type="toggle"[\s\S]*<table/);
});

test("existing content (headings, lists, tasks, code, links, highlights) is unchanged by the schema addition", () => {
  const html = '<h1>T</h1><p>a <a target="_blank" rel="noopener noreferrer nofollow" href="https://x.test">l</a> <mark>m</mark></p><ol><li><p>1</p></li></ol>' +
    '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li></ul>' +
    "<pre><code>x = 1</code></pre><hr>";
  const out = stable(html);
  assert.match(out, /<h1>T<\/h1>/);
  assert.match(out, /data-checked="true"/);
  assert.match(out, /<pre><code>x = 1<\/code><\/pre>/);
  assert.match(out, /<hr>/);
});
