/**
 * Stored HTML that carries suggested edits must re-seed to the SAME document.
 * A suggestion renders with `text-decoration:underline|line-through` (so a plain
 * HTML reader sees it), and the underline / strike marks parse exactly that style:
 * every HTML → Yjs seed used to add a real <u>/<s> under the suggestion, so the
 * stored body changed on each load and "accept" left struck-through text behind.
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

const INS = '<span data-suggestion="insert" data-user="Ada" data-color="#22c55e" data-suggestion-id="s1" style="color:#22c55e;text-decoration:underline;text-decoration-color:#22c55e;">added</span>';
const DEL = '<span data-suggestion="delete" data-user="Ada" data-color="#ef4444" data-suggestion-id="s1" style="color:#ef4444;text-decoration:line-through;text-decoration-color:#ef4444;">removed</span>';

test("suggestion marks round-trip without gaining underline / strike marks", () => {
  const html = `<p>Keep ${DEL}${INS} this.</p>`;
  const once = roundTrip(html);
  assert.doesNotMatch(once, /<s>|<u>|<\/s>|<\/u>/, once);
  assert.match(once, /data-suggestion="delete"[^>]*>removed<\/span>/);
  assert.match(once, /data-suggestion="insert"[^>]*>added<\/span>/);
  assert.match(once, /data-user="Ada"/);
  assert.equal(roundTrip(once), once, "byte-stable from the first store on");
  assert.equal(roundTrip(roundTrip(once)), once);
});

test("real strike and underline are kept — next to a suggestion and on their own", () => {
  const html = `<p><s>struck</s> and <u>under</u> and ${INS} and <span style="text-decoration: line-through">styled strike</span></p>`;
  const out = roundTrip(html);
  assert.match(out, /<s>struck<\/s>/);
  assert.match(out, /<u>under<\/u>/);
  assert.match(out, /<s>styled strike<\/s>/);
  assert.equal(roundTrip(out), out);
  // A struck word INSIDE a suggested insertion written with tags keeps its mark.
  const nested = roundTrip(`<p>${INS.replace(">added<", "><s>added</s><")}</p>`);
  assert.match(nested, /<s>/);
  assert.equal(roundTrip(nested), nested);
});

test("a suggestion INSIDE code — inline code and a fenced code block — survives store → load, byte-stable", () => {
  const html = `<p>Run <code>npm </code>${DEL.replace(">removed<", "><code>install</code><")}${INS.replace(">added<", "><code>ci</code><")} now.</p><pre><code>const a = ${DEL.replace("removed", "1;")}${INS.replace("added", "2;")}\nnext();</code></pre>`;
  const once = roundTrip(html);
  assert.match(once, /data-suggestion="delete"[^>]*><code>install<\/code><\/span>/, once);
  assert.match(once, /data-suggestion="insert"[^>]*><code>ci<\/code><\/span>/, once);
  assert.match(once, /<pre><code>const a = <span data-suggestion="delete"[^>]*>1;<\/span><span data-suggestion="insert"[^>]*>2;<\/span>\nnext\(\);<\/code><\/pre>/, once);
  assert.doesNotMatch(once, /<s>|<u>/, once);
  assert.equal(roundTrip(once), once);
});
