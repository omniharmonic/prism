/**
 * The Markdown reader makes to-do lists of GFM task items (PARITY-GAPS §a.1, slice N).
 *
 *   `- [x] done` / `- [ ] open` used to open as a plain bulleted list: the words stayed,
 *   the checked state was lost, and the first save of the live document wrote it back
 *   that way. Now a list whose EVERY item is a task item is the editor's to-do list
 *   (`ul[data-type=taskList] > li[data-type=taskItem][data-checked]`), nested lists are
 *   judged on their own items, and a mixed list keeps its markers as text.
 *
 * The rule is one pure function (`@prism/core/task-lists`), applied to marked's output in
 * `convert/core.ts` (worker AND inline lane — both checked here), in the web shell's
 * Markdown path and in the editor's Markdown paste. It is linear; time-bounded below.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { collabExtensions, COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { taskListsInHtml } from "@prism/core/task-lists";
import * as core from "../src/convert/core";
import { conversionStats, isCheapContent, markdownToHtml, contentToDocJson, stopConversionWorkers } from "../src/convert/service";

const CORE_TIPTAP = "../../../packages/core/src/lib/tiptap/";
const { markdownToPasteHtml, sliceToMarkdown } = (await import(`${CORE_TIPTAP}markdownClipboard`)) as {
  markdownToPasteHtml: (text: string) => string;
  sliceToMarkdown: (slice: unknown) => string;
};

after(async () => { await stopConversionWorkers(); });

interface Node { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string }
const text = (n: Node): string => (n.text ?? "") + (n.content ?? []).map(text).join("");
/** A list as `[type, [checked?, own text, nested lists…]…]` — what a reader sees. */
const shape = (n: Node): unknown => [n.type, ...(n.content ?? []).map((item) => [
  ...(item.type === "taskItem" ? [item.attrs?.checked === true] : []),
  (item.content ?? []).filter((c) => c.type === "paragraph").map(text).join(" / "),
  ...(item.content ?? []).filter((c) => c.type.endsWith("List")).map(shape),
])];
const lists = (doc: Node) => (doc.content ?? []).filter((n) => n.type.endsWith("List")).map(shape);
const read = (md: string) => lists(core.contentToDocJsonSync(md) as Node);

test("a list of task items opens as a to-do list with its checked state", () => {
  assert.deepEqual(read("- [x] Book the venue\n- [ ] Send invitations\n- [X] Print **badges**\n"), [
    ["taskList", [true, "Book the venue"], [false, "Send invitations"], [true, "Print badges"]],
  ]);
  // Loose items (blank lines between them) and other bullet characters.
  assert.deepEqual(read("* [ ] one\n\n* [x] two\n\n  second paragraph\n"), [["taskList", [false, "one"], [true, "two / second paragraph"]]]);
  // A numbered list of tasks is a to-do list too (the pasted-checkbox rule: ul and ol).
  assert.deepEqual(read("1. [x] first\n2. [ ] second\n"), [["taskList", [true, "first"], [false, "second"]]]);
  // Inline formatting inside an item survives.
  const html = core.markdownToHtmlSync("- [x] see [the docs](https://example.test) and `code`\n");
  assert.match(html, /<ul data-type="taskList">\s*<li data-type="taskItem" data-checked="true">see <a href="https:\/\/example\.test">the docs<\/a> and <code>code<\/code><\/li>/);
  assert.equal(html.includes("<input"), false);
});

test("nested task lists; each list is judged on its own items", () => {
  assert.deepEqual(read("- [ ] parent\n  - [x] child done\n  - [ ] child open\n- [x] sibling\n"), [
    ["taskList", [false, "parent", ["taskList", [true, "child done"], [false, "child open"]]], [true, "sibling"]],
  ]);
  // Plain bullets under a task, and tasks under a plain bullet.
  assert.deepEqual(read("- [x] task\n  - note one\n  - note two\n"), [["taskList", [true, "task", ["bulletList", ["note one"], ["note two"]]]]]);
  assert.deepEqual(read("- heading\n  - [ ] a\n  - [x] b\n- other\n"), [["bulletList", ["heading", ["taskList", [false, "a"], [true, "b"]]], ["other"]]]);
});

test("a mixed list stays a list and keeps its markers as text; nothing is lost", () => {
  assert.deepEqual(read("- [x] done\n- just a note\n- [ ] open\n"), [["bulletList", ["[x] done"], ["just a note"], ["[ ] open"]]]);
  assert.deepEqual(read("1. [ ] first\n2. plain\n"), [["orderedList", ["[ ] first"], ["plain"]]]);
  // Not task items at all: brackets in the middle, no space after the box, an escaped box.
  assert.deepEqual(read("- see [x] here\n- [x]no space\n- \\[x\\] escaped\n"), [["bulletList", ["see [x] here"], ["[x]no space"], ["[x] escaped"]]]);
});

test("the pure rewrite: other HTML is left exactly as it was", () => {
  for (const same of [
    "",
    "<p>no lists</p>",
    "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n",
    "<p>the word checkbox</p><ul><li>a</li></ul>",
    // A stored Prism to-do list (the editor's own HTML, e.g. a block appended to a Markdown page).
    '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li></ul>',
    // Code is escaped by the Markdown parser: nothing in it is a tag.
    "<pre><code>&lt;ul&gt;&lt;li&gt;&lt;input type=&quot;checkbox&quot;&gt; x&lt;/li&gt;&lt;/ul&gt;\n</code></pre>",
    // A text field is not a checkbox; a checkbox later in the item is not a marker.
    '<ul><li><input type="text"> a</li></ul>',
    '<ul><li>a <input type="checkbox"></li></ul>',
    // Unbalanced input is not guessed at.
    '<li><input type="checkbox"> stray</li>',
    '<ul><li><input type="checkbox"> never closed',
  ]) assert.equal(taskListsInHtml(same), same, same);
  assert.equal(
    taskListsInHtml('<UL class="x"><LI><INPUT TYPE=checkbox CHECKED> a</LI><li><input disabled type=\'checkbox\'>b</li></UL>'),
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">a</LI><li data-type="taskItem" data-checked="false">b</li></ul>',
  );
});

test("round trip: a to-do list → Markdown → the reader → the same to-do list", () => {
  const schema = getSchema(collabExtensions());
  const stored = '<ul data-type="taskList">'
    + '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>RT done task</p></div></li>'
    + '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>RT open task</p>'
    + '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>RT nested</p></div></li></ul>'
    + "</div></li></ul>";
  const before = core.htmlToDocJsonSync(stored) as Node;
  const expected = [["taskList", [true, "RT done task"], [false, "RT open task", ["taskList", [true, "RT nested"]]]]];
  assert.deepEqual(lists(before), expected);
  // The editor's Markdown writer (copy as Markdown; the export writes the same GFM items).
  const md = sliceToMarkdown(schema.nodeFromJSON(before).slice(0));
  assert.match(md, /^- \[x\] RT done task\n- \[ \] RT open task\n {2}- \[x\] RT nested$/m);
  const after = core.contentToDocJsonSync(md) as Node;
  assert.deepEqual(lists(after), expected);
  // …and what a live document stores for it is the editor's to-do HTML, checked state included.
  const html = core.docJsonToHtmlSync(after);
  assert.equal((html.match(/data-type="taskItem"/g) ?? []).length, 3);
  assert.equal((html.match(/data-checked="true"/g) ?? []).length, 2);
  // A second pass through Markdown changes nothing.
  assert.equal(sliceToMarkdown(schema.nodeFromJSON(after).slice(0)), md);
  assert.equal(COLLAB_SCHEMA_VERSION, 5);
});

test("both conversion lanes read task items: inline for a small note, the worker for a long one", async () => {
  const small = "- [x] a\n- [ ] b\n";
  assert.equal(isCheapContent(small, true), true);
  const inline = conversionStats.inline;
  assert.match(await markdownToHtml(small), /data-type="taskList"[\s\S]*data-checked="true"[\s\S]*data-checked="false"/);
  assert.equal(conversionStats.inline, inline + 1);

  const long = Array.from({ length: 400 }, (_, i) => `- [${i % 3 ? " " : "x"}] task ${i}`).join("\n") + "\n";
  assert.equal(isCheapContent(long, true), false);
  const offThread = conversionStats.worker;
  const html = await markdownToHtml(long);
  assert.equal(conversionStats.worker, offThread + 1);
  assert.equal((html.match(/data-type="taskItem"/g) ?? []).length, 400);
  assert.equal((html.match(/data-checked="true"/g) ?? []).length, 134);
  assert.equal(html.includes("<input"), false);
  const doc = (await contentToDocJson(long)) as Node;
  assert.equal(doc.content?.[0]?.type, "taskList");
  assert.equal(doc.content?.[0]?.content?.length, 400);
});

test("the paste path follows the same rule", () => {
  assert.match(markdownToPasteHtml("- [x] Done\n- [ ] Later"), /<ul data-type="taskList">\s*<li data-type="taskItem" data-checked="true">Done<\/li>\s*<li data-type="taskItem" data-checked="false">Later<\/li>\s*<\/ul>/);
  const mixed = markdownToPasteHtml("- [x] Done\n- note");
  assert.equal(mixed.includes("taskList"), false);
  assert.match(mixed, /<li>\[x\] Done<\/li>/);
});

test("the rewrite is linear: pathological HTML is decided quickly and never grows the output", () => {
  const cases: Array<[string, string]> = [
    ["unclosed <li", "checkbox " + "<li ".repeat(120_000)],
    ["unclosed <input", "<ul>" + '<li><input type="checkbox" '.repeat(40_000)],
    ["lists never closed", "checkbox " + "<ul><li>".repeat(60_000)],
    ["closers only", "checkbox " + "</ul></li>".repeat(60_000)],
    ["deep nesting", "<ul><li><input type=checkbox> a".repeat(20_000) + "</li></ul>".repeat(20_000)],
    ["one long quoted attribute", '<ul><li><input type="checkbox" title="' + "<".repeat(400_000) + '"> a</li></ul>'],
    ["a wide flat list", "<ul>" + '<li><input type="checkbox"> a</li>'.repeat(40_000) + "</ul>"],
    ["lone angle brackets", "checkbox " + "<".repeat(300_000)],
  ];
  for (const [name, html] of cases) {
    const t = performance.now();
    const out = taskListsInHtml(html);
    const ms = performance.now() - t;
    assert.ok(ms < 400, `${name}: ${Math.round(ms)} ms`);
    assert.ok(out.length <= html.length * 3 + 64, `${name}: output grew`);
  }
  // The parser's own output for a long task list (the realistic large case).
  const md = Array.from({ length: 5000 }, (_, i) => `- [${i % 2 ? "x" : " "}] item ${i}`).join("\n");
  const parsed = taskListsInHtml("<ul>\n" + md.split("\n").map((l) => `<li><input ${l[3] === "x" ? 'checked="" ' : ""}disabled="" type="checkbox"> ${l.slice(6)}</li>\n`).join("") + "</ul>\n");
  assert.equal((parsed.match(/data-type="taskItem"/g) ?? []).length, 5000);
});
