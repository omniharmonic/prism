// One display name for a person note (src/person-name.ts): never raw HTML, never markdown syntax.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPersonName, decodeEntities, derivePersonName, headingText, personName, prettyPathName, PERSON_NAME_MAX } from "../src/person-name";
import { personName as commsPersonName } from "../src/comms/people";
import { titleOf } from "../src/worker/people";
import { IdentityIndex } from "../src/identity";
import type { Note } from "../src/parachute";

const note = (over: Partial<Note>): Note => ({ id: "p1", content: "", path: null, metadata: null, createdAt: "", updatedAt: null, tags: ["person"], ...over });

test("the owner's case: an HTML displayTitle reads as its first heading", () => {
  const n = note({ path: "vault/people/josie-siegel", displayTitle: "<h1>Josie Siegel</h1><h2>Context</h2><p>Met at the retreat…" });
  assert.equal(personName(n), "Josie Siegel");
  assert.equal(commsPersonName(n), "Josie Siegel", "comms uses the shared derivation");
  assert.equal(titleOf(n), "Josie Siegel", "name matching keys on the clean heading too");
  // A cut-off displayTitle (the vault truncates) still never shows markup.
  assert.equal(personName(note({ displayTitle: "<p class=\"x\">Ann <b>Lee</b></p><p>more" })), "Ann Lee");
  assert.equal(personName(note({ displayTitle: "<h1>Ann Lee</h1><p cla" })), "Ann Lee");
});

test("order: metadata.name → heading → path; metadata.title (a job title here) is never a name", () => {
  assert.deepEqual(derivePersonName(note({ metadata: { title: "CEO", name: "Ann Lee" }, content: "# Heading" })), { name: "Ann Lee", source: "name" });
  assert.deepEqual(derivePersonName(note({ metadata: { title: "Founder" }, content: "# Ann Lee" })), { name: "Ann Lee", source: "heading" });
  assert.deepEqual(derivePersonName(note({ metadata: { title: "CEO" }, path: "vault/people/ann-lee" })), { name: "Ann Lee", source: "path" });
  assert.deepEqual(derivePersonName(note({ metadata: { name: "  " }, content: "intro\n\n## Ann **Lee**\n" })), { name: "Ann Lee", source: "heading" });
  assert.deepEqual(derivePersonName(note({ path: "vault/people/josie-siegel-2.md" })), { name: "Josie Siegel", source: "path" });
  assert.deepEqual(derivePersonName(note({ path: "vault/people/Ann van Dijk" })), { name: "Ann van Dijk", source: "path" });
  assert.deepEqual(derivePersonName(note({})), { name: "", source: "none" });
});

test("markdown and entities are stripped/decoded; HTML in a field is cleaned", () => {
  assert.equal(personName(note({ metadata: { name: "<h1>Josie Siegel</h1>" } })), "Josie Siegel");
  assert.equal(personName(note({ metadata: { name: "Zoë &amp; Co &#8212; Fran&ccedil;ois &#x1F600;" } })), "Zoë & Co — François 😀");
  assert.equal(personName(note({ content: "# [[vault/people/Ann Lee|Ann Lee]]" })), "Ann Lee");
  assert.equal(personName(note({ content: "# [Ann](https://x.test) `Lee`" })), "Ann Lee");
  assert.equal(personName(note({ content: "<h2>Bo &lt;3</h2>" })), "Bo <3");
  assert.equal(decodeEntities("&bogus; &#0; &#xD800;"), "&bogus;  ");
  assert.equal(headingText("<p>no heading here</p>"), null, "an HTML body without a heading is not a name source");
  assert.equal(headingText("plain first line"), null);
  assert.equal(headingText("plain first line", true), "plain first line");
});

test("empty, whitespace-only and markup-only values fall through; long names are capped", () => {
  assert.equal(personName(note({ metadata: { name: "&nbsp;" }, displayTitle: "<h1> </h1>", path: "vault/people/Ann" })), "Ann");
  assert.equal(personName(note({ metadata: { name: 42 as unknown as string }, path: "vault/people/Ann" })), "Ann");
  const long = personName(note({ metadata: { name: "Ann ".repeat(80) } }));
  assert.ok(Array.from(long).length <= PERSON_NAME_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(prettyPathName(""), null);
  assert.equal(personName(note({ metadata: { name: "Ann‮Lee\u0000" } })), "Ann Lee");
});

test("name matching no longer keys on raw markup", () => {
  const idx = new IdentityIndex([note({ id: "p_j", path: "vault/people/x1", displayTitle: "<h1>Josie Siegel</h1><h2>Context</h2>" })]);
  assert.deepEqual(idx.named("Josie Siegel").map((n) => n.id), ["p_j"]);
});

test("the report classifies without exposing names; the repair fills metadata.name only from a real heading or the path", () => {
  const html = assessPersonName(note({ displayTitle: "<h1>Josie Siegel</h1><p>…", path: "vault/people/x" }));
  assert.deepEqual(html.problems.sort(), ["markup-in-display", "no-name-field"]);
  assert.equal(html.repairName, null, "the vault's displayTitle is never a repair source (re-review N1)");
  assert.equal(assessPersonName(note({ content: "<h1>Josie Siegel</h1><h2>Context</h2><p>Met at…</p>", path: "vault/people/x" })).repairName, "Josie Siegel");
  assert.equal(assessPersonName(note({ content: "# Ana O’Brien\n\nnotes" })).repairName, "Ana O'Brien", "curly apostrophe normalised");
  assert.equal(assessPersonName(note({ path: "vault/people/josie-siegel" })).repairName, "Josie Siegel", "a person-shaped path basename");
  const fieldMarkup = assessPersonName(note({ metadata: { name: "<h1>Ann</h1>" } }));
  assert.deepEqual(fieldMarkup.problems, ["markup-in-field"]);
  assert.equal(fieldMarkup.repairName, null, "an existing name is never rewritten");
  assert.deepEqual(assessPersonName(note({ metadata: { name: "Ann Lee", title: "CEO" } })), { problems: [], repairName: null });
  // The reviewer's probes: prose, a paragraph, section headings, job titles, businesses, numbers, single words.
  for (const [content, path] of [
    ["Met at ETHDenver, works on Gitcoin grants", "vault/people/x1"],
    ["<p>Notes from our call about the grant</p>", "vault/people/x2"],
    ["## Context\n\ntext", "vault/people/x3"],
    ["# CEO", "vault/people/x4"],
    ["# Joe’s Pizza", "vault/people/x5"],
    ["# Mike Plumber", "vault/people/x6"],
    ["# +1 555 000 1111", "vault/people/x7"],
    ["# Notes from our call", "vault/people/x8"],
    ["# Met at the conference. Works on grants", "vault/people/x9"],
    ["notes only", "vault/people/jsiegel"],
  ] as const) {
    assert.equal(assessPersonName(note({ content, path })).repairName, null, content);
  }
  assert.deepEqual(assessPersonName(note({})).problems.sort(), ["no-name-at-all", "no-name-field"]);
});

test("decorations and exact-name keys", async () => {
  const { stripDecorations, exactNameKey } = await import("../src/person-name");
  assert.equal(stripDecorations("Robin Cook 🛡️"), "Robin Cook");
  assert.equal(stripDecorations("Razvan- ZER8🧠"), "Razvan- ZER8");
  assert.equal(stripDecorations("★ Ana Lima ★"), "Ana Lima");
  assert.equal(stripDecorations("Ben O."), "Ben O.");
  assert.equal(exactNameKey("JOSÉ  Ruiz!"), exactNameKey("José Ruiz"));
  assert.equal(exactNameKey("Josie Siegel 🌿"), "josie siegel");
  assert.notEqual(exactNameKey("Josie Siegel"), exactNameKey("Josie Siegal"));
});
