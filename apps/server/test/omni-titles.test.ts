/**
 * Readable Omni titles (src/omni/titles.ts): metadata title → first H1 → readable path leaf,
 * used by Today (tasks + agenda) and on nudge upsert. `leafTitle` in @prism/core is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstHeading, humanizeLeaf, looksLikeSlug, omniTitle, plainText, readableNudgeText } from "../src/omni/titles";
import { leafTitle } from "@prism/core/pages";

test("titles: metadata title, then the first H1, then the path leaf in words", () => {
  assert.equal(omniTitle({ id: "n1", path: "tasks/app-2-app-2-defined", metadata: { title: "  Ship the app  " } }), "Ship the app");
  assert.equal(omniTitle({ id: "n1", path: "tasks/app-2-app-2-defined", metadata: {}, content: "---\ntitle: x\n---\nIntro\n\n# **App 2** is [defined](x)\n\n# Second" }), "App 2 is defined");
  assert.equal(omniTitle({ id: "n1", path: "tasks/app-2-app-2-defined", metadata: {} }), "App 2 app 2 defined");
  assert.equal(omniTitle({ id: "n1", path: "vault/notes/call_dana.md" }), "Call dana");
  assert.equal(omniTitle({ id: "n1", path: null }), "n1");
  assert.equal(omniTitle({ id: "p", path: "projects/opencivics/PROJECT", metadata: {} }), "Opencivics", "container notes keep their folder name");
  // Prism's own leafTitle is unchanged.
  assert.equal(leafTitle("tasks/app-2-app-2-defined", {}), "app-2-app-2-defined");
});

test("titles: headings inside code fences and level-2 headings are not titles", () => {
  assert.equal(firstHeading("```\n# not a title\n```\n## Sub\n# Real"), "Real");
  assert.equal(firstHeading("no heading here"), null);
  assert.equal(firstHeading(null), null);
});

test("titles: slug detection and leaf humanizing", () => {
  for (const slug of ["call-dana", "app_2", "vault/messages/x", "notes.md", ""]) assert.equal(looksLikeSlug(slug), true, slug);
  for (const name of ["Call Dana", "Q3", "Re: budget-review"]) assert.equal(looksLikeSlug(name), false, name);
  assert.equal(humanizeLeaf("a/b/release--notes__v2"), "Release notes v2");
});

test("titles: plain text drops markdown but keeps the words", () => {
  assert.equal(plainText("# Heading\n\n- [ ] **Bold** item with [a link](https://x)\n> quoted\n```js\ncode()\n```\nend"), "Heading Bold item with a link quoted end");
  assert.equal(Array.from(plainText("word ".repeat(400), 100)).length, 100);
});

test("nudge text: a slug or path title becomes the metadata title, else the H1, else readable words", async () => {
  const none = async () => null;
  const body = async () => "# Budget review with Alice\n\nDetails";
  assert.deepEqual(await readableNudgeText({ title: "Good title", summary: "Plain words" }, { id: "s", path: "x/y" }, none), { title: "Good title", summary: "Plain words" });
  assert.equal((await readableNudgeText({ title: "budget-review", summary: "x" }, { id: "s", path: "vault/emails/budget-review", title: "Budget review" }, none)).title, "Budget review");
  assert.equal((await readableNudgeText({ title: "vault/emails/budget-review.md", summary: "x" }, { id: "s", path: "vault/emails/budget-review" }, body)).title, "Budget review with Alice");
  assert.equal((await readableNudgeText({ title: "budget-review", summary: "x" }, { id: "s", path: "vault/emails/budget-review" }, none)).title, "Budget review");
  // The source's file name, even without a hyphen, is not a title.
  assert.equal((await readableNudgeText({ title: "Standup", summary: "x" }, { id: "s", path: "meetings/standup" }, body)).title, "Budget review with Alice");
  // A raw preview: the heading line that repeats the title is dropped; the rest is plain text.
  const r = await readableNudgeText({ title: "app-2-defined", summary: "# App 2 defined\n\n**Status:** waiting on [Dana](x)\n- reply by Friday" }, { id: "s", path: "tasks/app-2-defined" }, async () => "# App 2 defined");
  assert.deepEqual(r, { title: "App 2 defined", summary: "Status: waiting on Dana reply by Friday" });
  // A summary that is itself a slug falls back to the title.
  assert.equal((await readableNudgeText({ title: "Q3 plan", summary: "q3-plan" }, { id: "s", path: "x/q3" }, none)).summary, "Q3 plan");
});
