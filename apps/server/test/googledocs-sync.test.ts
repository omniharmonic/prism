/**
 * Google Docs sync (Phase 3) — the create-vs-update branch + title derivation,
 * with a fake gog client. The live gog round-trip is scripts/verify-googledocs-sync.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleDocsClient, pushNoteToGoogleDoc } from "../src/worker/googledocs";

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    createDoc: async (title: string) => {
      calls.push(`create:${title}`);
      return "doc-123";
    },
    writeDoc: async (id: string, content: string) => {
      calls.push(`write:${id}:${content.slice(0, 12)}`);
    },
  };
}

test("first sync creates a doc (title = note path leaf, extension stripped) then writes", async () => {
  const c = fakeClient();
  const res = await pushNoteToGoogleDoc(c, { path: "vault/docs/My Plan.md", content: "# hi\n\nbody" });
  assert.equal(res.created, true);
  assert.equal(res.docId, "doc-123");
  assert.deepEqual(c.calls, ["create:My Plan", "write:doc-123:# hi\n\nbody"]);
});

test("subsequent sync updates the existing doc (no create)", async () => {
  const c = fakeClient();
  const res = await pushNoteToGoogleDoc(c, { path: "vault/docs/x", content: "new content" }, "existing-doc");
  assert.equal(res.created, false);
  assert.equal(res.docId, "existing-doc");
  assert.deepEqual(c.calls, ["write:existing-doc:new content"]);
});

test("missing path falls back to Untitled", async () => {
  const c = fakeClient();
  await pushNoteToGoogleDoc(c, { path: null, content: "x" });
  assert.ok(c.calls[0]!.startsWith("create:Untitled"));
});

test("edited HTML is exported as Markdown on both create and update", async () => {
  const writes: string[] = [];
  const client = { createDoc: async () => "doc", writeDoc: async (_id: string, content: string) => { writes.push(content); } };
  const html = '<h1>Plan</h1><p><strong>Bold</strong> and <em>italic</em> <a href="https://example.com">link</a></p><ul><li>Item</li></ul><table><tr><th>Name</th></tr><tr><td>Ada</td></tr></table>';
  await pushNoteToGoogleDoc(client, { content: html });
  await pushNoteToGoogleDoc(client, { content: html }, "doc");
  assert.equal(writes[0], writes[1]);
  assert.match(writes[0]!, /^# Plan/);
  assert.match(writes[0]!, /\*\*Bold\*\*/);
  assert.match(writes[0]!, /_italic_/);
  assert.match(writes[0]!, /\[link\]\(https:\/\/example.com\)/);
  assert.match(writes[0]!, /- +Item/);
  assert.match(writes[0]!, /\| Name \|\n\| --- \|\n\| Ada \|/);
  assert.doesNotMatch(writes[0]!, /<h1>|<strong>|<table>/);
});

test("gog receives Markdown rendering mode and the complete body over stdin", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "prism-gdocs-"));
  try {
    const capture = join(dir, "capture.json");
    const bin = join(dir, "gog");
    await writeFile(bin, `#!/usr/bin/env node
let body = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), body })));
`, { mode: 0o700 });
    const body = "---\ntitle: Plan\n---\n# Heading\n\n**Bold**";
    await new GoogleDocsClient("test@example.com", bin).writeDoc("doc-123", body);
    const actual = JSON.parse(await readFile(capture, "utf8"));
    assert.deepEqual(actual.args, ["docs", "write", "doc-123", "--file", "-", "--replace", "--markdown", "--account", "test@example.com"]);
    assert.equal(actual.body, body);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("large HTML uses the worker with identical table export formatting", async () => {
  const { configureConversion, stopConversionWorkers } = await import("../src/convert/service");
  const writes: string[] = [];
  const client = { createDoc: async () => "doc", writeDoc: async (_id: string, body: string) => { writes.push(body); } };
  const note = { content: '<h2>Title</h2><p><strong>bold</strong></p><table><tr><th>Name</th><th>Role</th></tr><tr><td>Ada</td><td>Engineer</td></tr><tr><td>Grace</td><td>Admiral</td></tr></table>' };
  await pushNoteToGoogleDoc(client, note);
  const undo = configureConversion({ inlineMaxChars: 0 });
  try {
    await pushNoteToGoogleDoc(client, note, "doc");
    assert.equal(writes[0], writes[1]);
    assert.match(writes[1]!, /\| Name \| Role \|\n\| --- \| --- \|\n\| Ada \| Engineer \|\n\| Grace \| Admiral \|/);
  } finally { undo(); await stopConversionWorkers(); }
});

test("Markdown beginning with an autolink remains Markdown on first and subsequent pushes", async () => {
  const writes: string[] = [];
  const client = { createDoc: async () => "doc", writeDoc: async (_id: string, body: string) => { writes.push(body); } };
  for (const content of ["<https://example.com>\n\n# Heading\n\n**Bold**", "<person@example.com>\n\n- item"]) {
    await pushNoteToGoogleDoc(client, { content });
    await pushNoteToGoogleDoc(client, { content }, "doc");
    assert.deepEqual(writes.splice(0), [content, content]);
  }
});

test("unconvertible HTML does not create or overwrite a remote document", async () => {
  const { configureConversion } = await import("../src/convert/service");
  const undo = configureConversion({ maxChars: 10 });
  const c = fakeClient();
  try {
    await assert.rejects(pushNoteToGoogleDoc(c, { content: "<p>Too much content</p>" }), /conversion_too_large/);
    await assert.rejects(pushNoteToGoogleDoc(c, { content: "<p>Too much content</p>" }, "existing-doc"), /conversion_too_large/);
    assert.deepEqual(c.calls, []);
  } finally { undo(); }
});
