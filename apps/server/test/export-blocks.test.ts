/**
 * Slice L · NP-ED-24 — the Markdown export keeps the blocks plain turndown loses
 * (transfer/export-markdown.ts): to-do state, table structure, an image's caption and a
 * bookmark card's description; and what it writes reads back as the same blocks where
 * Markdown can say them (to-dos, tables). One run goes through the real export route
 * (the conversion runs in the worker); the shapes are pinned on the converter itself.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { readZipDirectory, readZipEntry } from "@prism/core/import-export";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetJobsForTests } from "../src/transfer/jobs";
import { stopExportWorker } from "../src/transfer/export";
import { stopImportWorker } from "../src/transfer/import";
import { stopConversionWorkers } from "../src/convert/service";
import { newExportTurndown } from "../src/transfer/export-markdown";
import { contentToDocJsonSync } from "../src/convert/core";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

after(async () => { await stopImportWorker(); await stopExportWorker(); await stopConversionWorkers(); });

const OWNER = "owner@test.local";
const TODO = '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done task</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Open task</p><ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Nested done</p></div></li></ul></div></li></ul>';
const TABLE = '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Head A</p></th><th colspan="1" rowspan="1"><p>Head B</p></th></tr><tr><td colspan="1" rowspan="1" data-cell-color="blue"><p>Cell A</p></td><td colspan="1" rowspan="1"><p>Cell | B</p><p>second line</p></td></tr><tr><td colspan="2" rowspan="1"><p>Merged</p></td></tr></tbody></table>';
const IMAGE = '<img src="/api/attachments/a_rtimage0000000000000000" alt="Field photo" data-align="center" data-caption="The caption *here*">';
const BOOKMARK = '<div data-url="https://example.test/a (b)" data-title="Card title" data-description="Card description" data-site="example.test" data-type="bookmark"><a href="https://example.test/a (b)" rel="noopener noreferrer">Card title</a></div>';
const PAGE = `<h2>Blocks</h2>${TODO}${TABLE}${IMAGE}${BOOKMARK}<p>After.</p>`;

const md = (html: string) => newExportTurndown().turndown(html);
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };
const find = (node: Json, type: string, out: Json[] = []): Json[] => {
  if (node.type === type) out.push(node);
  for (const child of node.content ?? []) find(child, type, out);
  return out;
};
const textOf = (node: Json): string => (node.text ?? "") + (node.content ?? []).map(textOf).join("");

test("to-do items keep their checked / open state, nested ones stay nested", () => {
  const out = md(TODO);
  assert.match(out, /^- \[x\] Done task$/m);
  assert.match(out, /^- \[ \] Open task$/m);
  // Nested under its item (the shared list-item rule indents by the marker's width).
  assert.match(out, /^ {2}- \[x\] Nested done$/m);
});

test("a table is a GFM table: header row, delimiter row, padded rows, escaped pipes, line breaks as <br>", () => {
  const lines = md(TABLE).trim().split("\n");
  assert.deepEqual(lines, [
    "| Head A | Head B |",
    "| --- | --- |",
    "| Cell A | Cell \\| B<br>second line |",
    "| Merged |  |",
  ]);
});

test("an image keeps its caption, as a line of its own under the image", () => {
  const out = md(IMAGE);
  assert.match(out, /^!\[Field photo\]\(\/api\/attachments\/a_rtimage0000000000000000\)$/m);
  assert.match(out, /^\*The caption \\\*here\\\*\*$/m);
  // An image without a caption is the plain image, as before.
  assert.equal(md('<img src="/x.png" alt="Plain">').trim(), "![Plain](/x.png)");
});

test("a bookmark card keeps its title, address and description", () => {
  assert.equal(md(BOOKMARK).trim(), "[Card title](https://example.test/a%20%28b%29) — Card description");
  // Not an http(s) address: never a link target we made up — the card's own fallback text.
  assert.doesNotMatch(md('<div data-url="javascript:alert(1)" data-title="X" data-description="D" data-type="bookmark">X</div>'), /\]\(javascript:/);
});

test("the round trip: the exported Markdown reads back as the same table and the same to-dos", () => {
  const doc = contentToDocJsonSync(md(PAGE)) as Json;
  const table = find(doc, "table");
  assert.equal(table.length, 1);
  const rows = find(table[0]!, "tableRow");
  assert.equal(rows.length, 3);
  assert.deepEqual(find(rows[0]!, "tableHeader").map(textOf), ["Head A", "Head B"]);
  assert.equal(find(rows[1]!, "tableCell").map(textOf)[0], "Cell A");
  // Exporting twice gives the same Markdown (stable).
  assert.equal(md(PAGE), md(PAGE));
  // The words of the to-dos, the caption and the card survive as text.
  const words = textOf(doc);
  for (const w of ["Done task", "Open task", "Nested done", "The caption *here*", "Card title", "Card description", "After."]) assert.ok(words.includes(w), w);
  // The to-dos read back as to-do blocks with their state (main's `taskListsInHtml` reader), nested under their item.
  const items = find(doc, "taskItem");
  assert.deepEqual(items.map((i) => [textOf((i.content ?? [])[0] ?? { type: "paragraph" }), i.attrs?.checked]), [["Done task", true], ["Open task", false], ["Nested done", true]]);
  assert.equal(find(items[1]!, "taskItem").length, 2, "the nested item is inside the open one");
});

test("text in a cell or a caption cannot become markup", () => {
  const out = md('<table><tbody><tr><td><p>&lt;script&gt;x&lt;/script&gt;</p></td></tr></tbody></table><img src="/a.png" alt="a" data-caption="&lt;b&gt;c">');
  assert.doesNotMatch(out, /(^|[^\\])<(script|b)/m, out);
});

test("large tables convert in linear time", () => {
  const row = `<tr>${"<td><p>cell</p></td>".repeat(20)}</tr>`;
  const big = `<table><tbody>${row.repeat(1500)}</tbody></table>`;
  const t0 = Date.now();
  const out = md(big);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(out.trim().split("\n").length, 1501);
});

test("L-1: a table of many rows costs time in proportion to its rows (the row list is read once per table)", () => {
  const time = (rows: number) => {
    const html = `<table><tbody>${"<tr><td><p>c</p></td></tr>".repeat(rows)}</tbody></table>`;
    const t0 = process.hrtime.bigint();
    const out = md(html);
    assert.equal(out.trim().split("\n").length, rows + 1);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time(500); // warm up
  const small = Math.min(time(2000), time(2000));
  const large = Math.min(time(16000), time(16000));
  // 8× the rows: linear is ~8×; the old per-row rebuild of the row list was ~64×.
  assert.ok(large < small * 24 + 200, `2,000 rows ${small.toFixed(0)} ms, 16,000 rows ${large.toFixed(0)} ms`);
});

// ── through the export route (the worker) ────────────────────────────────────
let fv: FakeVault;
beforeEach(() => {
  process.env.EXPORT_PACE_MS = "0";
  resetDb();
  resetTreeForTests();
  resetJobsForTests();
  fv = installFakeVault();
  fv.put({ id: "blocks", path: "vault/Wiki/Blocks", tags: ["page"], content: PAGE, metadata: {} });
});
afterEach(() => { resetJobsForTests(); fv.restore(); });

test("POST /api/export (Markdown) writes the to-do state, the table, the caption and the card description", async () => {
  const cookie = sessionCookie(makeSession(OWNER));
  const start = await api.request("/export", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ scope: "page", noteId: "blocks", format: "markdown", subpages: false, attachments: false }) });
  assert.equal(start.status, 202, await start.clone().text());
  const { jobId } = (await start.json()) as { jobId: string };
  for (let i = 0; ; i++) {
    const job = (await (await api.request(`/export/${jobId}`, { headers: { cookie } })).json()) as { state: string };
    if (job.state !== "queued" && job.state !== "running") { assert.equal(job.state, "done", JSON.stringify(job)); break; }
    assert.ok(i < 2000, "export did not finish");
    await new Promise((r) => setTimeout(r, 5));
  }
  const zip = new Uint8Array(await (await api.request(`/export/${jobId}/download`, { headers: { cookie } })).arrayBuffer());
  const entries = readZipDirectory(zip, { maxEntries: 100, maxEntryBytes: 5_000_000, maxTotalBytes: 10_000_000 });
  const files = new Map(entries.map((e) => [e.name, Buffer.from(readZipEntry(zip, e, (x, max) => inflateRawSync(x, { maxOutputLength: Math.max(max, 1) }))).toString("utf8")]));
  assert.deepEqual((JSON.parse(files.get("_export.json") ?? "{}") as { plainText?: string[] }).plainText ?? [], []);
  const file = files.get("Blocks.md");
  assert.ok(file, [...files.keys()].join(", "));
  assert.match(file, /^- \[x\] Done task$/m);
  assert.match(file, /^- \[ \] Open task$/m);
  assert.match(file, /^\| Head A \| Head B \|$/m);
  assert.match(file, /^\| --- \| --- \|$/m);
  assert.match(file, /^\| Cell A \| Cell \\\| B<br>second line \|$/m);
  assert.match(file, /^\*The caption \\\*here\\\*\*$/m);
  assert.match(file, /^\[Card title\]\(https:\/\/example\.test\/a%20%28b%29\) — Card description$/m);
});
