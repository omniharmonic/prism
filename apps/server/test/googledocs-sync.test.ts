/**
 * Google Docs sync (Phase 3) — the create-vs-update branch + title derivation,
 * with a fake gog client. The live gog round-trip is scripts/verify-googledocs-sync.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushNoteToGoogleDoc } from "../src/worker/googledocs";

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
