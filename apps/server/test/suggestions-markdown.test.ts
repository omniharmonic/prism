/**
 * Suggesting inside CODE on a page whose stored body is MARKDOWN (a fenced block and inline
 * code): the live path end to end at the document layer — Markdown → the shared Yjs document →
 * a suggested deletion + insertion inside the fence and inside the inline code (the marks the
 * Suggesting editor writes) → the HTML a store writes → loaded again.
 *
 *  - the suggestions and the fence (its language) survive store → load, byte-stable;
 *  - Accept all gives exactly the page — and the Markdown — of the plain edit; Reject all the original;
 *  - while the suggestions are PENDING, every HTML → Markdown conversion (agent read, "Move to",
 *    export) gives the page without them — never the old and the new text run together;
 *  - a copy of the page (duplicate / template) holds the original; the export's HTML sanitiser
 *    keeps the suggestion markers inside code.
 * (The plain editor — DocumentRenderer, the one a Markdown body opens in outside live
 * collaboration — has no Suggesting mode and no suggestion marks in its schema.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { sanitizeHtml } from "@prism/core/import-export";
import { contentToYUpdate, yDocToHtml, resolveSuggestionsInHtml, collabSchema } from "../src/collab";
import { htmlToMarkdownSync, blocksHtmlToMarkdownSync, docJsonToHtmlSync, rejectPendingSuggestionsSync } from "../src/convert/core";
import { newExportTurndown } from "../src/transfer/export-markdown";
import { cleanCopyBody } from "../../../packages/core/src/lib/pages/copyBody";

const MD = "Run `npm install` first.\n\n```js\nconst a = 1;\nnext();\n```\n\nEnd.";
const MD_PLAIN_EDIT = "Run `npm ci` first.\n\n```js\nconst a = 2;\nnext();\n```\n\nEnd.";

const schema = collabSchema();
const find = (doc: PMNode, text: string): number => {
  let at = -1;
  doc.descendants((node, pos) => { if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text); });
  assert.ok(at >= 0, text);
  return at;
};
const open = (content: string) => {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, contentToYUpdate(content));
  return ydoc;
};
const write = (ydoc: Y.Doc, doc: PMNode) => {
  const fragment = ydoc.getXmlFragment("default");
  ydoc.transact(() => updateYFragment(ydoc, fragment, doc, { mapping: new Map(), isOMark: new Map() } as never));
};
const who = { user: "Ann" };

/** The page opened from Markdown, the same page with the two replacements SUGGESTED, and with them made plainly. */
function pages() {
  const seed = open(MD);
  const seedHtml = yDocToHtml(seed);
  const doc = initProseMirrorDoc(seed.getXmlFragment("default"), schema).doc;
  const { insertion, deletion, code } = schema.marks;
  const suggested = new Transform(doc);
  const plain = new Transform(doc);
  // Later positions first, so earlier ones stay valid.
  for (const [old, next, inCode] of [["1", "2", false], ["install", "ci", true]] as const) {
    const at = find(doc, old === "1" ? "1;" : old);
    const base = inCode ? [code!.create()] : [];
    suggested.addMark(at, at + old.length, deletion!.create({ ...who, color: "#ef4444" }));
    suggested.insert(at + old.length, schema.text(next, [...base, insertion!.create({ ...who, color: "#22c55e" })]));
    plain.replaceWith(at, at + old.length, schema.text(next, base));
  }
  const live = open(MD);
  write(live, suggested.doc);
  return { seedHtml, stored: yDocToHtml(live), plainHtml: docJsonToHtmlSync(plain.doc.toJSON()) };
}

test("Markdown page, fenced block: a suggestion inside the fence and inside inline code survives store → load with the fence intact", () => {
  const { seedHtml, stored } = pages();
  assert.match(seedHtml, /<pre><code class="language-js">const a = 1;\nnext\(\);\n<\/code><\/pre>/);
  assert.match(stored, /<pre><code class="language-js">const a = <span data-suggestion="delete"[^>]*>1<\/span><span data-suggestion="insert"[^>]*>2<\/span>;\nnext\(\);\n<\/code><\/pre>/, stored);
  assert.match(stored, /<code>npm <\/code><span data-suggestion="delete"[^>]*><code>install<\/code><\/span><span data-suggestion="insert"[^>]*><code>ci<\/code><\/span>/, stored);
  const loaded = yDocToHtml(open(stored));
  assert.equal(loaded, stored, "byte-stable from the first store on");
  assert.equal(yDocToHtml(open(loaded)), stored);
});

test("Markdown page, fenced block: Accept all gives exactly the plain edit's page and Markdown; Reject all the original", () => {
  const { seedHtml, stored, plainHtml } = pages();
  const accepted = resolveSuggestionsInHtml(stored, null, "accept");
  assert.equal(accepted, plainHtml);
  assert.equal(htmlToMarkdownSync(accepted), MD_PLAIN_EDIT);
  const rejected = resolveSuggestionsInHtml(stored, "Ann", "reject");
  assert.equal(rejected, seedHtml);
  assert.equal(htmlToMarkdownSync(rejected), MD);
});

test("Markdown page, fenced block: while suggestions are pending, Markdown out of the page is the page WITHOUT them — agent read, Move-to blocks and export alike", () => {
  const { seedHtml, stored } = pages();
  assert.equal(rejectPendingSuggestionsSync(stored), seedHtml);
  assert.equal(htmlToMarkdownSync(stored), MD); // it was "const a = 12;" and "`npm ``install``ci`"
  assert.equal(blocksHtmlToMarkdownSync(stored), MD);
  assert.equal(newExportTurndown().turndown(rejectPendingSuggestionsSync(stored)), newExportTurndown().turndown(seedHtml));
  assert.ok(!newExportTurndown().turndown(rejectPendingSuggestionsSync(stored)).includes("12"));
  // A page with no suggestion is not parsed at all (the same string comes back).
  assert.equal(rejectPendingSuggestionsSync(seedHtml), seedHtml);
  // Suggested structure and chips are left out the same way.
  const structure = '<p>one</p><p data-suggestion-node="insert" data-suggestion-by="Ann">two<br data-suggestion-node="insert" data-suggestion-by="Ann">three</p>';
  assert.equal(htmlToMarkdownSync(structure), "onetwothree");
});

test("Markdown page, fenced block: a copy holds the original; the export sanitiser keeps the suggestion markers inside code", () => {
  const { seedHtml, stored } = pages();
  assert.equal(cleanCopyBody(stored, () => "u"), seedHtml);
  const safe = sanitizeHtml(stored);
  assert.match(safe, /<pre><code class="language-js">const a = <span data-suggestion="delete"[^>]*>1<\/span><span data-suggestion="insert"[^>]*>2<\/span>;/, safe);
  assert.match(safe, /<span data-suggestion="insert"[^>]*><code>ci<\/code><\/span>/, safe);
});
