/**
 * Real-time collab logic, tested through the extracted hook functions (no live
 * WebSocket needed):
 *   - authorizeConnection: the connection-time ACL — reject below view, mark
 *     view/comment read-only, allow suggest+ to write.
 *   - the CRDT seed/serialize round-trip (HTML ⇄ Yjs is loss-free for text).
 *   - loadDocumentState: prefer persisted CRDT state, but let an external
 *     Parachute edit win (re-seed) when the vault is newer than our snapshot.
 *   - storeDocumentState: write HTML back to the vault AND persist the Yjs
 *     binary, surviving a vault-write failure.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  authorizeConnection,
  contentToYUpdate,
  yDocToHtml,
  loadDocumentState,
  storeDocumentState,
} from "../src/collab";
import { getDocState, saveDocState } from "../src/db";
import {
  installFakeVault,
  resetDb,
  makeSession,
  sessionCookie,
  makeCapability,
  type FakeVault,
} from "./helpers";

const OWNER = "owner@test.local";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const docFrom = (content: string): Y.Doc => {
  const d = new Y.Doc();
  Y.applyUpdate(d, contentToYUpdate(content));
  return d;
};

// --------------------------------------------------------- connection ACL

test("a connection with no access is rejected (throws Forbidden)", async () => {
  fv.put({ id: "n1", content: "secret", tags: ["private"] });
  const cc = { readOnly: false };
  await assert.rejects(
    () => authorizeConnection("n1", makeCapability("tag", "other", "view"), null, cc),
    /Forbidden/,
  );
});

test("a view capability connects read-only", async () => {
  fv.put({ id: "n1", content: "x", tags: ["team"] });
  const cc = { readOnly: false };
  const level = await authorizeConnection("n1", makeCapability("tag", "team", "view"), null, cc);
  assert.equal(level, "view");
  assert.equal(cc.readOnly, true);
});

test("a comment-level connection is still read-only (below suggest)", async () => {
  fv.put({ id: "n1", content: "x", tags: ["team"] });
  const cc = { readOnly: false };
  await authorizeConnection("n1", makeCapability("tag", "team", "comment"), null, cc);
  assert.equal(cc.readOnly, true);
});

test("a suggest-level connection may write (not read-only)", async () => {
  fv.put({ id: "n1", content: "x", tags: ["team"] });
  const cc = { readOnly: false };
  const level = await authorizeConnection("n1", makeCapability("tag", "team", "suggest"), null, cc);
  assert.equal(level, "suggest");
  assert.equal(cc.readOnly, false);
});

test("the owner connects with full ('own') write access via the session cookie", async () => {
  fv.put({ id: "n1", content: "x", tags: [] });
  const cc = { readOnly: false };
  const cookie = sessionCookie(makeSession(OWNER));
  const level = await authorizeConnection("n1", "session", cookie, cc);
  assert.equal(level, "own");
  assert.equal(cc.readOnly, false);
});

// ------------------------------------------------------------ CRDT round-trip

test("markdown seeds a Y.Doc whose serialized HTML preserves the text", () => {
  const doc = docFrom("Hello **world**");
  const html = yDocToHtml(doc);
  assert.match(html, /Hello/);
  assert.match(html, /world/);
  assert.match(html, /<strong>/); // bold survived the round-trip
});

// ----------------------------------------------------------- loadDocumentState

test("loadDocumentState seeds an empty doc from the vault when nothing is stored", async () => {
  fv.put({ id: "n1", content: "seeded from vault", tags: [] });
  const doc = await loadDocumentState("n1", new Y.Doc());
  assert.match(yDocToHtml(doc), /seeded from vault/);
});

test("loadDocumentState prefers persisted CRDT state when it is current", async () => {
  // Stored snapshot is NEWER than the vault note → keep the live CRDT state.
  saveDocState("n1", contentToYUpdate("live crdt text"), Date.parse("2026-05-01T00:00:00.000Z"));
  fv.put({ id: "n1", content: "stale vault text", tags: [], updatedAt: "2020-01-01T00:00:00.000Z" });
  const doc = await loadDocumentState("n1", new Y.Doc());
  const html = yDocToHtml(doc);
  assert.match(html, /live crdt text/);
  assert.doesNotMatch(html, /stale vault text/);
});

test("loadDocumentState re-seeds when Parachute was edited externally (external edit wins)", async () => {
  // Stored snapshot is OLDER than the vault note → the external edit wins.
  saveDocState("n1", contentToYUpdate("old crdt text"), 1000);
  fv.put({ id: "n1", content: "fresh external edit", tags: [], updatedAt: "2026-05-02T00:00:00.000Z" });
  const doc = await loadDocumentState("n1", new Y.Doc());
  const html = yDocToHtml(doc);
  assert.match(html, /fresh external edit/);
  assert.doesNotMatch(html, /old crdt text/);
});

// ---------------------------------------------------------- storeDocumentState

test("storeDocumentState writes HTML to the vault AND persists the Yjs binary", async () => {
  fv.put({ id: "doc1", content: "before", tags: [] });
  await storeDocumentState("doc1", docFrom("persisted content"));

  // Vault received the rendered HTML...
  assert.match(fv.notes.get("doc1")!.content, /persisted content/);
  // ...and the CRDT binary was saved with the vault's resulting updatedAt.
  const saved = getDocState("doc1");
  assert.ok(saved);
  assert.ok(saved!.state.length > 0);
  assert.ok(saved!.sourceUpdatedAt && saved!.sourceUpdatedAt > 0);
});

test("storeDocumentState still persists CRDT state if the vault write fails", async () => {
  // No such note in the vault → PATCH 404 → updateNote throws → caught.
  await storeDocumentState("ghost-note", docFrom("orphaned edit"));
  const saved = getDocState("ghost-note");
  assert.ok(saved, "CRDT state must still be persisted");
  assert.equal(saved!.sourceUpdatedAt, null); // no vault timestamp, since the write failed
});
