/**
 * Server-side suggested-edit transforms (G2b): the pure PM-JSON functions in
 * isolation, then the HTML wrappers through the real shared TipTap schema
 * (collab.ts), pinning the exact accept/reject semantics:
 *   accept: insertion → keep text (mark stripped); deletion → text removed.
 *   reject: insertion → text removed;              deletion → keep text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionAuthors, hasSuggestions, resolveSuggestions, summarizeSuggestions, type PmNode } from "../src/suggestions";
import { suggestionAuthorsInHtml, resolveSuggestionsInHtml } from "../src/collab";
import { extractMentions } from "@prism/core/mentions";

const t = (text: string, marks?: PmNode["marks"]): PmNode => ({ type: "text", text, ...(marks ? { marks } : {}) });
const ins = (user: string) => ({ type: "insertion", attrs: { user, color: "#0f0" } });
const del = (user: string) => ({ type: "deletion", attrs: { user, color: "#f00" } });
const doc = (...content: PmNode[]): PmNode => ({ type: "doc", content: [{ type: "paragraph", content }] });

test("suggestionAuthors collects distinct users; hasSuggestions filters by author", () => {
  const d = doc(t("keep "), t("added", [ins("alice")]), t(" gone", [del("bob")]));
  assert.deepEqual(suggestionAuthors(d).sort(), ["alice", "bob"]);
  assert.equal(hasSuggestions(d, "alice"), true);
  assert.equal(hasSuggestions(d, "carol"), false);
  assert.equal(hasSuggestions(doc(t("plain"))), false);
});

test("accept: insertion kept unmarked, deletion removed — only for the author", () => {
  const d = doc(t("base "), t("new", [ins("alice")]), t(" old", [del("alice")]), t(" other", [ins("bob")]));
  const out = resolveSuggestions(d, "alice", "accept");
  const para = out.content![0]!;
  const texts = (para.content ?? []).map((n) => n.text);
  assert.deepEqual(texts, ["base ", "new", " other"]); // alice's deletion gone
  assert.equal(para.content![1]!.marks, undefined); // alice's insertion unmarked
  assert.ok(para.content![2]!.marks?.some((m) => m.type === "insertion")); // bob's untouched
});

test("reject: insertion removed, deletion kept unmarked", () => {
  const d = doc(t("base "), t("new", [ins("alice")]), t(" old", [del("alice")]));
  const out = resolveSuggestions(d, "alice", "reject");
  const texts = (out.content![0]!.content ?? []).map((n) => n.text);
  assert.deepEqual(texts, ["base ", " old"]);
  assert.equal(out.content![0]!.content![1]!.marks, undefined);
});

test("author=null resolves every author at once", () => {
  const d = doc(t("a", [ins("alice")]), t("b", [del("bob")]));
  const out = resolveSuggestions(d, null, "accept");
  const texts = (out.content![0]!.content ?? []).map((n) => n.text);
  assert.deepEqual(texts, ["a"]);
});

test("non-suggestion marks survive the resolve", () => {
  const d = doc(t("bold new", [{ type: "bold" }, ins("alice")]));
  const out = resolveSuggestions(d, "alice", "accept");
  assert.deepEqual(out.content![0]!.content![0]!.marks, [{ type: "bold" }]);
});

test("summarizeSuggestions counts per author", () => {
  const d = doc(t("abcd", [ins("alice")]), t("xy", [del("alice")]));
  assert.match(summarizeSuggestions(d, "alice"), /alice.*\+4 chars.*−2 chars/);
});

// ── through the real shared schema (HTML wrappers) ────────────────────────────

const SUGGESTED_HTML =
  `<p>hello <span data-suggestion="insert" data-user="Suggester" style="color:#22c55e;">brave </span>world` +
  `<span data-suggestion="delete" data-user="Suggester" style="color:#ef4444;"> cruel</span></p>`;

test("HTML wrapper: authors detected through the schema round-trip", () => {
  assert.deepEqual(suggestionAuthorsInHtml(SUGGESTED_HTML), ["Suggester"]);
  assert.deepEqual(suggestionAuthorsInHtml("<p>plain</p>"), []);
});

test("HTML wrapper: accept keeps the insertion, drops the deletion, strips spans", () => {
  const out = resolveSuggestionsInHtml(SUGGESTED_HTML, "Suggester", "accept");
  assert.ok(out.includes("brave"), "insertion text kept");
  assert.ok(!out.includes("cruel"), "deletion text removed");
  assert.ok(!out.includes("data-suggestion"), "no marks remain");
});

test("HTML wrapper: reject drops the insertion, keeps the deletion text", () => {
  const out = resolveSuggestionsInHtml(SUGGESTED_HTML, "Suggester", "reject");
  assert.ok(!out.includes("brave"), "insertion text removed");
  assert.ok(out.includes("cruel"), "deletion text kept");
  assert.ok(!out.includes("data-suggestion"));
});

test("HTML wrapper: a no-op for content without the author's marks", () => {
  assert.equal(resolveSuggestionsInHtml("<p>plain</p>", "anyone", "accept"), "<p>plain</p>");
});

// ── suggested paragraph breaks / line breaks (node attributes, not marks) ─────
// Made in the live editor while Suggesting (packages/core editor/suggestionNodes): the review
// of a STORED page must resolve them exactly as the editor's Accept all / Reject all does.

const INS = (text: string) => `<span data-suggestion="insert" data-user="Suggester" style="color:#22c55e;">${text}</span>`;
const BREAK = (kind: "insert" | "delete", by = "Suggester") => `data-suggestion-node="${kind}" data-suggestion-by="${by}"`;
const SPLIT_HTML = `<p>one</p><p ${BREAK("insert")}>${INS("new words")}</p><p ${BREAK("insert")}>two</p><p>end</p>`;

test("suggested breaks: the author is found even when the suggestion holds no text at all", () => {
  assert.deepEqual(suggestionAuthorsInHtml(`<p>one</p><p ${BREAK("insert")}>two</p>`), ["Suggester"]);
  assert.deepEqual(suggestionAuthorsInHtml(`<p>one<br ${BREAK("delete", "Ann")}>two</p>`), ["Ann"]);
});

test("suggested breaks: reject removes a new paragraph whole and joins a split paragraph again", () => {
  assert.equal(resolveSuggestionsInHtml(SPLIT_HTML, "Suggester", "reject"), "<p>onetwo</p><p>end</p>");
});

test("suggested breaks: accept keeps the new blocks and leaves nothing pending", () => {
  assert.equal(resolveSuggestionsInHtml(SPLIT_HTML, "Suggester", "accept"), "<p>one</p><p>new words</p><p>two</p><p>end</p>");
});

test("suggested breaks: only the named author's are resolved", () => {
  const html = `<p>one</p><p ${BREAK("insert", "Ann")}>two</p><p ${BREAK("insert", "Bo")}>three</p>`;
  assert.equal(resolveSuggestionsInHtml(html, "Ann", "reject"), `<p>onetwo</p><p ${BREAK("insert", "Bo")}>three</p>`);
  assert.equal(resolveSuggestionsInHtml(html, "Cy", "reject"), html);
});

test("suggested breaks: a suggested join is made on accept and dropped on reject", () => {
  const html = `<p>one</p><p ${BREAK("delete")}>two</p>`;
  assert.equal(resolveSuggestionsInHtml(html, null, "accept"), "<p>onetwo</p>");
  assert.equal(resolveSuggestionsInHtml(html, null, "reject"), "<p>one</p><p>two</p>");
});

test("suggested breaks: a line break — inserted or suggested for removal", () => {
  const added = `<p>one<br ${BREAK("insert")}>two</p>`;
  assert.equal(resolveSuggestionsInHtml(added, null, "accept"), "<p>one<br>two</p>");
  assert.equal(resolveSuggestionsInHtml(added, null, "reject"), "<p>onetwo</p>");
  const removed = `<p>one<br ${BREAK("delete")}>two</p>`;
  assert.equal(resolveSuggestionsInHtml(removed, null, "accept"), "<p>onetwo</p>");
  assert.equal(resolveSuggestionsInHtml(removed, null, "reject"), "<p>one<br>two</p>");
});

test("suggested breaks: a suggested list item, heading and table go whole on reject; a heading split at its start stays a heading", () => {
  const list = `<ul><li><p>alpha</p></li><li><p ${BREAK("insert")}>${INS("new item")}</p></li></ul><p>end</p>`;
  assert.equal(resolveSuggestionsInHtml(list, null, "reject"), "<ul><li><p>alpha</p></li></ul><p>end</p>");
  const heading = `<p>one</p><h2 ${BREAK("insert")}>${INS("Next steps")}</h2>`;
  assert.equal(resolveSuggestionsInHtml(heading, null, "reject"), "<p>one</p>");
  assert.equal(resolveSuggestionsInHtml(heading, null, "accept"), "<p>one</p><h2>Next steps</h2>");
  const cell = `<td colspan="1" rowspan="1"><p ${BREAK("insert")}></p></td>`;
  const table = `<p>one</p><table><tbody><tr>${cell}${cell}</tr></tbody></table><p>end</p>`;
  assert.equal(resolveSuggestionsInHtml(table, null, "reject"), "<p>one</p><p>end</p>");
  assert.ok(resolveSuggestionsInHtml(table, null, "accept").includes("<table"));
  assert.equal(resolveSuggestionsInHtml(`<p></p><h2 ${BREAK("insert")}>Title</h2>`, null, "reject"), "<h2>Title</h2>");
});

test("suggested breaks: the attributes survive the stored-HTML round trip unchanged", () => {
  const html = `<p>one</p><p ${BREAK("insert")}>two<br ${BREAK("delete", "Ann")}>three</p>`;
  assert.equal(resolveSuggestionsInHtml(html, "Nobody", "accept"), html);
  assert.equal(resolveSuggestionsInHtml(`${html}<p>${INS("x")}</p>`, "Nobody", "accept"), `${html}<p>${INS("x")}</p>`);
});

// ── a suggested CHIP (mention / date) ─────────────────────────────────────────
const CHIP = (uid: string, extra = "") => `<span data-type="mention" class="prism-mention" data-kind="person" data-id="people/ada" data-label="Ada" data-mention-uid="${uid}"${extra ? ` ${extra}` : ""}>@Ada</span>`;

test("suggested chip: accept keeps it (plain), reject removes it; a chip suggested for removal the other way round", () => {
  const added = `<p>hi ${CHIP("u1", BREAK("insert"))} there</p>`;
  assert.equal(resolveSuggestionsInHtml(added, "Suggester", "accept"), `<p>hi ${CHIP("u1")} there</p>`);
  assert.equal(resolveSuggestionsInHtml(added, "Suggester", "reject"), "<p>hi  there</p>");
  const removed = `<p>hi ${CHIP("u1", BREAK("delete"))} there</p>`;
  assert.equal(resolveSuggestionsInHtml(removed, null, "accept"), "<p>hi  there</p>");
  assert.equal(resolveSuggestionsInHtml(removed, null, "reject"), `<p>hi ${CHIP("u1")} there</p>`);
  assert.deepEqual(suggestionAuthorsInHtml(added), ["Suggester"]);
});

test("suggested chip: the mention hook does not see a chip that is only suggested — it is a mention once accepted (so nobody is notified for a suggestion)", () => {
  const added = `<p>hi ${CHIP("u1", BREAK("insert"))} and ${CHIP("u2")}</p>`;
  assert.deepEqual(extractMentions(added).map((m) => m.uid), ["u2"]);
  // Accepted: now it is there, and new to the diff the server notifies from.
  assert.deepEqual(extractMentions(resolveSuggestionsInHtml(added, null, "accept")).map((m) => m.uid), ["u1", "u2"]);
  assert.deepEqual(extractMentions(resolveSuggestionsInHtml(added, null, "reject")).map((m) => m.uid), ["u2"]);
  // A chip suggested for REMOVAL is still a mention until the removal is accepted.
  assert.deepEqual(extractMentions(`<p>${CHIP("u3", BREAK("delete"))}</p>`).map((m) => m.uid), ["u3"]);
});

test("suggestions inside code resolve like any text: accept gives the new code, reject the old", () => {
  const html = `<p>Run <code>npm </code><span data-suggestion="delete" data-user="Suggester"><code>install</code></span><span data-suggestion="insert" data-user="Suggester"><code>ci</code></span></p><pre><code>a = <span data-suggestion="delete" data-user="Suggester">1</span><span data-suggestion="insert" data-user="Suggester">2</span>;</code></pre>`;
  assert.equal(resolveSuggestionsInHtml(html, "Suggester", "accept"), "<p>Run <code>npm ci</code></p><pre><code>a = 2;</code></pre>");
  assert.equal(resolveSuggestionsInHtml(html, "Suggester", "reject"), "<p>Run <code>npm install</code></p><pre><code>a = 1;</code></pre>");
});
