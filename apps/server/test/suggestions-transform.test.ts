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
