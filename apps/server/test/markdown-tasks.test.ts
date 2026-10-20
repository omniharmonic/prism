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
// Timed in CPU time of this thread (./probe), never on the wall clock: the figure is the work, not the machine's load.
import { threadCpuMs } from "./probe";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { collabExtensions, COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { taskListsInHtml } from "@prism/core/task-lists";
import * as core from "../src/convert/core";
import { conversionStats, isCheapContent, markdownToHtml, htmlToMarkdown, blocksHtmlToMarkdown, contentToDocJson, stopConversionWorkers } from "../src/convert/service";

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
  assert.equal(COLLAB_SCHEMA_VERSION, 6);
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
    const t = threadCpuMs();
    const out = taskListsInHtml(html);
    const ms = threadCpuMs() - t;
    assert.ok(ms < 400, `${name}: ${Math.round(ms)} ms`);
    assert.ok(out.length <= html.length * 3 + 64, `${name}: output grew`);
  }
  // The parser's own output for a long task list (the realistic large case).
  const md = Array.from({ length: 5000 }, (_, i) => `- [${i % 2 ? "x" : " "}] item ${i}`).join("\n");
  const parsed = taskListsInHtml("<ul>\n" + md.split("\n").map((l) => `<li><input ${l[3] === "x" ? 'checked="" ' : ""}disabled="" type="checkbox"> ${l.slice(6)}</li>\n`).join("") + "</ul>\n");
  assert.equal((parsed.match(/data-type="taskItem"/g) ?? []).length, 5000);
});

// ── review round: the scanner reads HTML like a parser; the writers keep the marker ──

test("review 1: nothing inside another tag's attribute, a comment or a raw-text element is read as markup", () => {
  for (const same of [
    // A quoted attribute value that LOOKS like a task list: rewriting it would end the attribute early.
    '<a title="<ul><li><input type=checkbox></li></ul><img src=x onerror=alert(1)>">x</a>',
    "<a title='<ul><li><input type=checkbox> a</li></ul>'>x</a>",
    '<img alt="<ul><li><input type=checkbox>a</li></ul>" src="x">',
    '<p data-x="<ul><li><input type=checkbox>a</li></ul>"></p>',
    // Raw-text elements: their content is text, whatever it looks like.
    '<textarea><ul><li><input type="checkbox"> a</li></ul></textarea>',
    '<script>var s = "<ul><li><input type=checkbox> a</li></ul>";</script>',
    '<style>/* <ul><li><input type="checkbox"> a</li></ul> */</style>',
    '<title><ul><li><input type="checkbox"> a</li></ul></title>',
    // Comments, CDATA, declarations.
    '<!-- <ul><li><input type="checkbox"> a</li></ul> -->',
    '<![CDATA[<ul><li><input type="checkbox"> a</li></ul>]]>',
    // Unterminated: the rest of the text is inside the tag / comment.
    '<ul><li><input type="checkbox"> a</li><!-- </ul>',
    '<a title="<ul><li><input type=checkbox> a</li></ul>',
  ]) assert.equal(taskListsInHtml(same), same, same);
  // A closing tag inside a comment does not end the real list: it stays a MIXED list.
  assert.equal(
    taskListsInHtml('<ul><li><input type="checkbox"> a</li><!-- </ul> --><li>plain</li></ul>'),
    "<ul><li>[ ] a</li><!-- </ul> --><li>plain</li></ul>",
  );
  // …and a real list AFTER such text is still read.
  assert.equal(
    taskListsInHtml('<a title="<ul>">x</a><ul><li><input type="checkbox" checked> a</li></ul>'),
    '<a title="<ul>">x</a><ul data-type="taskList"><li data-type="taskItem" data-checked="true">a</li></ul>',
  );
  assert.equal(
    taskListsInHtml('<textarea></ul></textarea><ul><li title="a > b"><input type="checkbox"> a</li></ul>'),
    '<textarea></ul></textarea><ul data-type="taskList"><li data-type="taskItem" data-checked="false">a</li></ul>',
  );
  // The early exit reads the word in any case.
  assert.equal(taskListsInHtml("<ul><li><INPUT TYPE=CHECKBOX CHECKED> a</li></ul>"), '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">a</li></ul>');
});

test("review 1: hostile HTML is still decided in linear time", () => {
  const cases: Array<[string, string]> = [
    ["unterminated attribute values", 'checkbox <ul><li><input type="checkbox"> a</li></ul>' + '<a title="'.repeat(60_000)],
    ["unterminated attribute, single quotes", "checkbox " + "<a title='x".repeat(60_000)],
    ["unterminated comments", "checkbox " + "<!-- <ul>".repeat(60_000)],
    ["closed comments", "checkbox " + "<!-- <ul> -->".repeat(60_000)],
    ["unclosed textareas", "checkbox " + "<textarea><ul>".repeat(40_000)],
    ["closed raw text", "checkbox " + "<script><ul></script>".repeat(30_000)],
    ["many attributes", "checkbox <ul><li " + 'a="b" '.repeat(80_000) + '><input type="checkbox"> a</li></ul>'],
    ["tags of other names", "checkbox " + "<b><i><span class='x'>".repeat(40_000)],
    ["slash runs", "checkbox <ul" + "/".repeat(300_000)],
    ["equals runs", "checkbox <li " + "=".repeat(300_000)],
  ];
  for (const [name, html] of cases) {
    const t = threadCpuMs();
    const out = taskListsInHtml(html);
    const ms = threadCpuMs() - t;
    assert.ok(ms < 400, `${name}: ${Math.round(ms)} ms`);
    assert.ok(out.length <= html.length * 3 + 64, `${name}: output grew`);
  }
});

const STORED_TODOS = '<ul data-type="taskList">'
  + '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>RT done task</p></div></li>'
  + '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>RT open <strong>task</strong></p>'
  + '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>RT nested</p></div></li></ul>'
  + "</div></li></ul>";
const TODOS_SHAPE = [["taskList", [true, "RT done task"], [false, "RT open task", ["taskList", [true, "RT nested"]]]]];

test("review 2: every Markdown writer keeps the marker — the MCP resource and Move to write `- [x]` / `- [ ]`", async () => {
  for (const [name, write] of [["htmlToMarkdownSync", core.htmlToMarkdownSync], ["blocksHtmlToMarkdownSync", core.blocksHtmlToMarkdownSync]] as const) {
    const md = write(STORED_TODOS);
    assert.match(md, /^[-*] \[x\] RT done task$/m, `${name}:\n${md}`);
    assert.match(md, /^[-*] \[ \] RT open \*\*task\*\*$/m, `${name}:\n${md}`);
    assert.match(md, /^ +[-*] \[x\] RT nested$/m, `${name}:\n${md}`);
    assert.equal(md.includes("\\["), false, `${name}: no escaped marker\n${md}`);
    // …and the reader makes the same to-do list of it.
    assert.deepEqual(lists(core.contentToDocJsonSync(md) as Node), TODOS_SHAPE, `${name}:\n${md}`);
  }
  // The service lanes the MCP note resource (`prism://note/{id}`) and the block move call.
  const viaResource = await htmlToMarkdown(STORED_TODOS);
  assert.deepEqual(lists((await contentToDocJson(viaResource)) as Node), TODOS_SHAPE);
  const viaMove = await blocksHtmlToMarkdown(STORED_TODOS);
  assert.deepEqual(lists((await contentToDocJson(viaMove)) as Node), TODOS_SHAPE);
  // A numbered to-do list and a to-do with two paragraphs.
  const two = core.htmlToMarkdownSync('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>first</p><p>second</p></div></li><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>after</p></div></li></ul>');
  assert.deepEqual(lists(core.contentToDocJsonSync(two) as Node), [["taskList", [false, "first / second"], [true, "after"]]]);
});

test("review 2: a mixed list is stable across saves — its markers are written unescaped and read back as text", () => {
  const md = "- [x] done\n- just a note\n- [ ] open\n";
  const shape = [["bulletList", ["[x] done"], ["just a note"], ["[ ] open"]]];
  const first = core.contentToDocJsonSync(md) as Node;
  assert.deepEqual(lists(first), shape);
  const saved = core.htmlToMarkdownSync(core.docJsonToHtmlSync(first));
  assert.equal(saved.includes("\\["), false, saved);
  assert.match(saved, /^[-*]\s+\[x\] done$/m);
  assert.match(saved, /^[-*]\s+\[ \] open$/m);
  const second = core.contentToDocJsonSync(saved) as Node;
  assert.deepEqual(lists(second), shape);
  assert.equal(core.htmlToMarkdownSync(core.docJsonToHtmlSync(second)), saved);
  // Brackets that are not a leading marker stay escaped text.
  const other = core.htmlToMarkdownSync("<ul><li>see [x] here</li><li>[link] text</li><li>[x]tight</li></ul>");
  assert.deepEqual(lists(core.contentToDocJsonSync(other) as Node), [["bulletList", ["see [x] here"], ["[link] text"], ["[x]tight"]]]);
});
