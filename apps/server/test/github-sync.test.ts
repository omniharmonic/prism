/**
 * GitHub sync adapter (Phase 3) — the pure serialize/path/frontmatter functions.
 * Live push+pull round-trip is in scripts/verify-github-sync.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeNote, repoPathFor, parseFrontmatter } from "../src/worker/github";
import type { Note } from "../src/parachute";

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  content: "# Title\n\nbody text",
  path: "vault/projects/hello",
  metadata: { title: "Hello" },
  tags: ["note", "project"],
  createdAt: "",
  updatedAt: "",
  ...over,
});

test("serializeNote emits YAML frontmatter (title/tags/vault_path + metadata) then body", () => {
  const md = serializeNote(note());
  assert.match(md, /^---\n/);
  assert.match(md, /title: Hello/);
  assert.match(md, /tags:\n {2}- note\n {2}- project/);
  assert.match(md, /vault_path: vault\/projects\/hello/);
  assert.match(md, /---\n\n# Title\n\nbody text$/);
});

test("serializeNote with no metadata/tags is just the body", () => {
  const md = serializeNote(note({ metadata: null, tags: [], path: null }));
  assert.equal(md, "# Title\n\nbody text");
});

test("repoPathFor strips the vault prefix and ensures the extension", () => {
  const cfg = { owner: "o", repo: "r", branch: "main", vaultPath: "vault/projects", fileExtension: ".md" };
  assert.equal(repoPathFor(note({ path: "vault/projects/hello" }), cfg), "hello.md");
  assert.equal(repoPathFor(note({ path: "vault/projects/sub/deep" }), cfg), "sub/deep.md");
  assert.equal(repoPathFor(note({ path: "vault/projects/keep.txt" }), cfg), "keep.txt"); // existing ext kept
});

test("parseFrontmatter extracts title/tags/vault_path + strips the block", () => {
  const { title, tags, vaultPath, body } = parseFrontmatter("---\ntitle: My Doc\ntags:\n  - a\n  - b\nvault_path: vault/x/y\n---\n\nthe body");
  assert.equal(title, "My Doc");
  assert.deepEqual(tags, ["a", "b"]);
  assert.equal(vaultPath, "vault/x/y");
  assert.equal(body, "the body");
});

test("parseFrontmatter with no frontmatter returns the whole text as body", () => {
  const { title, body } = parseFrontmatter("# just markdown\n\nno fm");
  assert.equal(title, undefined);
  assert.equal(body, "# just markdown\n\nno fm");
});
