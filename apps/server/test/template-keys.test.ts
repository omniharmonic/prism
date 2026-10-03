/**
 * NP-TX-01 "Save as template" — the pure half (packages/core lib/pages).
 * What a template may carry from the page it was saved from, and what a copy of a
 * LIVE page's editor state leaves behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INGEST_KEYS, INGEST_SOURCES } from "../src/ingest-keys";
import { IDENTITY_KEYS } from "../src/identity-keys";
import { TEMPLATE_INGEST_KEYS, TEMPLATE_TAG, TEMPLATES_FOLDER, templateKeepsKey, templateSource, templateCopy, freePagePath } from "@prism/core/pages";
import { withoutReviewState } from "../../../packages/core/src/lib/pages/liveContent";

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

test("templateSource: body, properties, icon, cover and tags; tagged `template`; a free name", () => {
  const page = {
    content: "<p>Body</p>",
    tags: ["project", "prism-trashed", "agent-skill", "governance-role", "message-thread", "template"],
    metadata: { title: "Old", icon: "🚀", cover: "gradient:dawn", status: "active", prism_creator: "a@b.c", prism_visibility: "private", prism_locked: true, prism_type: "document", source_id: "cu-1", source: "clickup", sync: [{ adapter: "notion" }] },
  };
  const t = templateSource(page, "Launch / plan", TEMPLATES_FOLDER, ["Templates/Launch - plan", "templates/launch - plan 2", null]);
  assert.equal(t.path, "Templates/Launch - plan 3");
  assert.deepEqual(t.tags, ["project", TEMPLATE_TAG]);
  assert.deepEqual(t.metadata, { icon: "🚀", cover: "gradient:dawn", status: "active", prism_type: "document", title: "Launch - plan 3" });
  assert.equal(t.content, "<p>Body</p>");
  // A page made from it drops `template` again and keeps the properties.
  const made = templateCopy(t, "New", "vault/Projects");
  assert.deepEqual(made.tags, ["project"]);
  assert.equal(made.metadata.status, "active");
  assert.equal(made.path, "vault/Projects/New");
  assert.deepEqual(freePagePath("", "A", []), { path: "A", name: "A" });
});

test("a copy of a live page leaves review state behind", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [
        { type: "text", text: "kept " },
        { type: "text", text: "suggested addition", marks: [{ type: "insertion", attrs: { id: "s1" } }] },
        { type: "text", text: "suggested removal", marks: [{ type: "deletion", attrs: { id: "s2" } }, { type: "bold" }] },
        { type: "text", text: " commented", marks: [{ type: "comment", attrs: { id: "c1" } }] },
        { type: "mention", attrs: { kind: "page", id: "x" }, marks: [{ type: "insertion", attrs: { id: "s3" } }] },
      ] },
    ],
  };
  assert.deepEqual(withoutReviewState(doc), {
    type: "doc",
    content: [
      { type: "paragraph", content: [
        { type: "text", text: "kept " },
        { type: "text", text: "suggested removal", marks: [{ type: "bold" }] },
        { type: "text", text: " commented" },
      ] },
    ],
  });
});
