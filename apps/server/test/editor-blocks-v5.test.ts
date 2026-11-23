/**
 * Schema v5 blocks (wave 4A) through the server's HTML ⇄ Yjs persistence:
 * sub-page rows (id only — never a title), toggle headings, 2–5 resizable
 * columns and table cell colours. Old stored HTML must keep its meaning, and a
 * hostile value must degrade to the plain block, never to a live one.
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

test("child page: stores the page id only; a title in the HTML is dropped; invalid ids are never a block", () => {
  assert.equal(stable('<div data-type="child-page" data-page-id="n_Ab-12"></div>'), '<div data-page-id="n_Ab-12" data-type="child-page"></div>');
  // Whatever text or title attribute a writer put there never survives: the reader resolves the title themselves.
  const smuggled = stable('<div data-type="child-page" data-page-id="p1" data-title="Secret plan" title="Secret plan">Secret plan</div>');
  assert.doesNotMatch(smuggled, /Secret/);
  for (const bad of ["vault/people/x", "a b", "../../etc", "x".repeat(129), "", "javascript:alert(1)"]) {
    assert.doesNotMatch(roundTrip(`<p>k</p><div data-type="child-page" data-page-id="${bad}"></div>`), /child-page/, bad);
  }
});

test("toggle headings: level 1–3 round-trips; anything else is a plain toggle; old toggles are unchanged", () => {
  for (const level of [1, 2, 3]) {
    assert.equal(stable(`<details data-type="toggle" data-heading-level="${level}"><summary>Title</summary><p>Body</p></details>`), `<details data-heading-level="${level}" data-type="toggle"><summary>Title</summary><p>Body</p></details>`);
  }
  for (const bad of ["0", "4", "2.5", "x", "-1", "11"]) {
    assert.doesNotMatch(roundTrip(`<details data-type="toggle" data-heading-level="${bad}"><summary>T</summary><p>B</p></details>`), /data-heading-level/, bad);
  }
  assert.equal(stable('<details data-type="toggle"><summary>Old</summary><p>Body</p></details>'), '<details data-type="toggle"><summary>Old</summary><p>Body</p></details>');
});

test("columns: 2–5 survive with widths; a sixth column is never silently dropped from the page; bad widths fall back to equal", () => {
  const col = (text: string, attrs = "") => `<div data-type="column"${attrs}><p>${text}</p></div>`;
  for (const n of [2, 3, 4, 5]) {
    const out = stable(`<div data-type="columns">${Array.from({ length: n }, (_, i) => col(`c${i}`)).join("")}</div>`);
    assert.match(out, new RegExp(`data-count="${n}"`));
    assert.equal((out.match(/data-type="column"/g) ?? []).length, n);
  }
  const six = roundTrip(`<div data-type="columns">${Array.from({ length: 6 }, (_, i) => col(`c${i}`)).join("")}</div>`);
  for (let i = 0; i < 6; i++) assert.match(six, new RegExp(`c${i}`), "every column's text is kept");
  const sized = stable(`<div data-type="columns">${col("a", ' data-col-width="1.5"')}${col("b", ' data-col-width="0.5"')}</div>`);
  assert.match(sized, /data-col-width="1\.5" style="flex-grow: 1\.5;?"/);
  assert.match(sized, /data-col-width="0\.5" style="flex-grow: 0\.5;?"/);
  for (const bad of ["0", "-1", "99", "1e3", "1;position:fixed", "url(x)", "NaN"]) {
    const out = roundTrip(`<div data-type="columns">${col("a", ` data-col-width="${bad}" style="flex-grow: 1; position: fixed"`)}${col("b")}</div>`);
    assert.doesNotMatch(out, /data-col-width|style=/, bad);
  }
  // v2–v4 columns (no widths) are byte-stable.
  const old = `<div data-type="columns" data-count="2">${col("a")}${col("b")}</div>`;
  assert.equal(stable(old), old);
});

test("table cells: a known colour survives on td and th; unknown values are dropped", () => {
  const out = stable('<table><tbody><tr><th data-cell-color="blue"><p>H</p></th><td data-cell-color="red"><p>x</p></td><td data-cell-color="url(evil)"><p>y</p></td></tr></tbody></table>');
  assert.match(out, /<th[^>]*data-cell-color="blue"/);
  assert.match(out, /<td[^>]*data-cell-color="red"/);
  assert.doesNotMatch(out, /evil/);
  const plain = "<table><tbody><tr><td><p>x</p></td></tr></tbody></table>";
  assert.doesNotMatch(roundTrip(plain), /data-cell-color/);
});
