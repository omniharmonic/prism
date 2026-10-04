/**
 * NP-TX-01 "Save as template" — the pure half (packages/core lib/pages).
 * What a template may carry from the page it was saved from, and what a copy of a
 * LIVE page's editor state leaves behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INGEST_KEYS, INGEST_SOURCES } from "../src/ingest-keys";
import { IDENTITY_KEYS } from "../src/identity-keys";
import { isTemplateNote, TEMPLATE_INGEST_KEYS, TEMPLATE_TAG, TEMPLATES_FOLDER, TEMPLATE_TAGS_KEY, templateKeepsKey, templateSource, templateCopy, duplicateCopy, freePagePath } from "@prism/core/pages";
import { cleanCopyBody } from "../../../packages/core/src/lib/pages/copyBody";

test("the client's ingest-key list is the server's", () => {
  assert.deepEqual([...TEMPLATE_INGEST_KEYS].sort(), [...INGEST_KEYS].sort());
});

test("a template never carries identity, access, state, governance or ingest keys", () => {
  for (const k of IDENTITY_KEYS) assert.equal(templateKeepsKey(k, "x"), false, k);
  for (const k of INGEST_KEYS) assert.equal(templateKeepsKey(k, "x"), false, k);
  for (const k of ["prism_visibility", "prism_locked", "prism_order", "prism_trashed_at", "prism_trashed_root", "prism_last_change", "prism_client_op", "prism_template_props", "gov_sig", "_caps", "_review", "sync", "title", "__proto__", "constructor"]) {
    assert.equal(templateKeepsKey(k, "x"), false, k);
  }
  for (const v of INGEST_SOURCES) assert.equal(templateKeepsKey("source", v), false, v);
  assert.equal(templateKeepsKey("source", "Book"), true, "an ordinary source value is a property");
  for (const k of ["status", "icon", "cover", "coverY", "type", "content_font", "due", "prism_type", "prism_page_style", "prism_database"]) assert.equal(templateKeepsKey(k, "x"), true, k);
});

const chip = (uid: string, extra = "") => `<span data-type="mention" class="prism-mention" data-kind="person" data-id="p-ada" data-label="Ada"${extra} data-mention-uid="${uid}">@Ada</span>`;

test("B1: a template is PRIVATE to its saver, carries only the `template` tag, and remembers the source tags", () => {
  const page = {
    content: "<p>Body</p>",
    tags: ["project", "published-tag", "prism-trashed", "agent-skill", "governance-role", "message-thread", "template"],
    metadata: { title: "Old", icon: "🚀", cover: "gradient:dawn", status: "active", prism_creator: "a@b.c", prism_visibility: "private", prism_locked: true, prism_type: "document", source_id: "cu-1", source: "clickup", sync: [{ adapter: "notion" }] },
  };
  const t = templateSource(page, "Launch / plan", TEMPLATES_FOLDER, ["Templates/Launch - plan", "templates/launch - plan 2", null], { creator: "saver@example.test" });
  assert.equal(t.path, "Templates/Launch - plan 3");
  assert.deepEqual(t.tags, [TEMPLATE_TAG], "no source tag: a template is in nobody's shared or published tag");
  assert.deepEqual(t.metadata, {
    icon: "🚀", cover: "gradient:dawn", status: "active", prism_type: "document", title: "Launch - plan 3",
    [TEMPLATE_TAGS_KEY]: ["project", "published-tag"],
    prism_visibility: "private",
    prism_creator: "saver@example.test",
  });
  // Without a known saver (the member route stamps the creator itself) it is still private.
  const member = templateSource(page, "X", TEMPLATES_FOLDER, []);
  assert.equal(member.metadata.prism_visibility, "private");
  assert.equal("prism_creator" in member.metadata, false);
  assert.deepEqual(freePagePath("", "A", []), { path: "A", name: "A" });
});

test("B1: Use re-applies the remembered tags; the new page is not private, not the saver's, and holds no template bookkeeping", () => {
  const t = templateSource({ content: "<p>Body</p>", tags: ["project", "task"], metadata: { status: "active" } }, "T", TEMPLATES_FOLDER, [], { creator: "saver@example.test" });
  const made = templateCopy(t, "New", "vault/Projects");
  assert.deepEqual(made.tags, ["project", "task"]);
  assert.deepEqual(made.metadata, { status: "active", title: "New" });
  assert.equal(made.path, "vault/Projects/New");
  // A hand-made template (tag `template` beside its own tags, the older convention) still works.
  assert.deepEqual(templateCopy({ content: "x", tags: ["template", "meeting"], metadata: { status: "draft" } }, "M", "").tags, ["meeting"]);
  // Remembered tags are data from a note: only strings, canonical, never a system tag.
  const odd = templateCopy({ content: "x", tags: ["template"], metadata: { [TEMPLATE_TAGS_KEY]: ["#ok", 7, "agent-skill", "prism-trashed", "template", " ", "governance-role", "ok"] } }, "O", "");
  assert.deepEqual(odd.tags, ["ok"]);
});

test("B1(5): a duplicate of a PRIVATE page stays private, with the duplicator as creator", () => {
  const priv = { content: "<p>x</p>", path: "vault/Drafts/Secret", tags: ["project"], metadata: { prism_visibility: "private", prism_creator: "author@example.test", status: "draft" } };
  const copy = duplicateCopy(priv, [], { creator: "dup@example.test" });
  assert.equal(copy.metadata.prism_visibility, "private");
  assert.equal(copy.metadata.prism_creator, "dup@example.test");
  assert.equal(copy.path, "vault/Drafts/Secret (copy)");
  // Unknown duplicator (no account read): still private (the member route stamps the creator).
  const anon = duplicateCopy(priv, []);
  assert.equal(anon.metadata.prism_visibility, "private");
  assert.equal("prism_creator" in anon.metadata, false);
  // A workspace page's duplicate is unchanged: no visibility, no creator.
  const open = duplicateCopy({ content: "x", path: "A", tags: [], metadata: { status: "s" } }, [], { creator: "dup@example.test" });
  assert.equal("prism_visibility" in open.metadata, false);
  assert.equal("prism_creator" in open.metadata, false);
});

test("copies get fresh mention uids and no reminders (2), no sub-page rows (3), no review state (4)", () => {
  const body =
    `<p>Hi ${chip("u-original", ' data-reminder="2026-10-09T09:00:00Z"')} and ${chip("u-two")}</p>` +
    `<div data-type="child-page" data-page-id="abc123"></div>` +
    `<p>kept <span data-suggestion="insert" data-user="Bo" data-color="#22c55e" style="color:#22c55e">added <strong>bold</strong></span>` +
    `<span data-suggestion="delete" data-user="Bo" style="color:#ef4444"><strong>removed?</strong></span>` +
    `<span data-comment-id="c1" data-resolved="false" style="background: rgba(234,179,8,0.22)"> commented</span> end</p>`;
  let n = 0;
  const out = cleanCopyBody(body, () => `fresh${++n}`);
  assert.equal(out,
    `<p>Hi ${chip("fresh1")} and ${chip("fresh2")}</p>` +
    `<p>kept <strong>removed?</strong> commented end</p>`);
  // Markdown / plain text is left alone, and so is text that only looks like a tag.
  assert.equal(cleanCopyBody("# Title\n\na < b and 2 > 1"), "# Title\n\na < b and 2 > 1");
  // Attribute forms an HTML parser accepts: any case, single / no quotes, spaces around `=`.
  assert.equal(cleanCopyBody(`<p>a<SPAN Data-Suggestion = 'insert'>x</SPAN><span data-comment-id=c2>y</span></p>`), "<p>ay</p>");
  assert.equal(cleanCopyBody(`<p><DIV data-type = child-page data-page-id="x"><div>nested</div></DIV>z</p>`), "<p>z</p>");
  // Both templateSource (Save), templateCopy (Use) and duplicateCopy run it.
  const saved = templateSource({ content: body, tags: [], metadata: {} }, "T", "Templates", []);
  assert.ok(!saved.content.includes("u-original") && !saved.content.includes("data-reminder") && !saved.content.includes("child-page") && !saved.content.includes("data-suggestion"));
  const used = templateCopy({ content: `<p>${chip("u-template")}</p>`, tags: ["template"], metadata: {} }, "N", "");
  assert.ok(!used.content.includes("u-template") && used.content.includes("data-mention-uid="));
  const dup = duplicateCopy({ content: `<p>${chip("u-page", ' data-reminder="2026-10-09"')}</p><div data-type="child-page" data-page-id="k"></div>`, path: "A", tags: [], metadata: {} }, []);
  assert.ok(!dup.content.includes("u-page") && !dup.content.includes("data-reminder") && !dup.content.includes("child-page"));
});

test("cleanCopyBody is linear: hostile bodies finish at once", () => {
  for (const body of ["<p>" + "<span ".repeat(200_000), "<p>" + "<span data-suggestion=\"insert\">".repeat(60_000), "<p>" + "</span>".repeat(200_000), "<" .repeat(400_000), "<p " + "a=\"".repeat(150_000)]) {
    const t = Date.now();
    cleanCopyBody(body);
    assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
  }
});

// ── Review round 3 (blocker client half, 5, 6) ───────────────────────────────
test("remembered tags never include ingest tags; isTemplateNote is the one predicate", () => {
  const t = templateSource({ content: "<p>x</p>", tags: ["project", "task", "meeting", "email", "person", "clickup"], metadata: {} }, "T", TEMPLATES_FOLDER, []);
  assert.deepEqual(t.metadata[TEMPLATE_TAGS_KEY], ["project"]);
  assert.deepEqual(templateCopy({ content: "x", tags: ["template", "meeting", "notes"], metadata: { [TEMPLATE_TAGS_KEY]: ["task", "ok"] } }, "N", "").tags, ["ok", "notes"]);
  assert.equal(isTemplateNote({ tags: ["a", "template"] }), true);
  assert.equal(isTemplateNote({ tags: ["a"] }), false);
  assert.equal(isTemplateNote({ tags: null }), false);
});

test("5: only DOCUMENT bodies are cleaned — a code / spreadsheet / canvas / website note is copied byte for byte", () => {
  const markup = `<p>x</p><div data-type="child-page" data-page-id="k"></div><span data-suggestion="insert">y</span><span data-type="mention" data-mention-uid="u1" data-reminder="r">@a</span>`;
  for (const note of [
    { content: markup, path: "src/widget.html", tags: ["code"], metadata: { type: "code" } },
    { content: markup, path: "data/table.csv", tags: [], metadata: { prism_type: "spreadsheet" } },
    { content: markup, path: "art/board", tags: [], metadata: { prism_type: "canvas" } },
    { content: markup, path: "site/index", tags: [], metadata: { type: "website" } },
  ]) {
    assert.equal(duplicateCopy(note, []).content, markup, note.path);
    assert.equal(templateSource(note, "T", TEMPLATES_FOLDER, []).content, markup, note.path);
    assert.equal(templateCopy({ ...note, tags: [...note.tags, "template"] }, "N", "").content, markup, note.path);
  }
  // A document is still cleaned.
  assert.ok(!duplicateCopy({ content: markup, path: "Docs/A", tags: ["page"], metadata: { type: "document" } }, []).content.includes("child-page"));
});
