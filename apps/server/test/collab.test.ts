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
  noteKind,
  codeToYUpdate,
  yDocToCode,
  csvToYUpdate,
  yDocToCsv,
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

// ----------------------------------------------------- type-aware (code) kind

test("noteKind detects code by tag, prism_type, and extension; documents otherwise", () => {
  assert.equal(noteKind({ path: null, tags: ["code"], metadata: null }), "code");
  assert.equal(noteKind({ path: null, tags: null, metadata: { prism_type: "code" } }), "code");
  assert.equal(noteKind({ path: "src/foo.py", tags: null, metadata: null }), "code");
  assert.equal(noteKind({ path: "notes/readme.md", tags: null, metadata: null }), "document");
  assert.equal(noteKind({ path: null, tags: ["meeting"], metadata: null }), "document");
});

test("code round-trips EXACTLY as plain text (no HTML mangling — corruption guard)", () => {
  // The text that broke the document path would be HTML-escaped/wrapped; code must not.
  const src = "def f(x):\n    return x < 1 && x > 0  # <not html>\n\n\tnested";
  const doc = new Y.Doc();
  Y.applyUpdate(doc, codeToYUpdate(src));
  assert.equal(yDocToCode(doc), src);
});

test("loadDocumentState seeds a code note as raw text, and storeDocumentState writes raw text back", async () => {
  const src = "const a = 1;\nconsole.log(a > 0 ? '<ok>' : '<no>');";
  fv.put({ id: "code1", content: src, tags: ["code"], path: "x.ts" });

  const doc = await loadDocumentState("code1", new Y.Doc());
  assert.equal(yDocToCode(doc), src, "seeded as exact raw text");
  // It must NOT have been seeded into the document XML fragment.
  assert.equal(doc.getXmlFragment("default").length, 0);

  // Edit the code and persist.
  doc.getText("codemirror").insert(doc.getText("codemirror").length, "\n// added");
  await storeDocumentState("code1", doc);
  const written = fv.notes.get("code1")!.content;
  assert.equal(written, src + "\n// added", "vault got raw text, not HTML");
  assert.doesNotMatch(written, /<p>|<pre>|&lt;/, "no HTML wrapping/escaping");
});

// ------------------------------------------------ type-aware (spreadsheet) kind

test("noteKind detects spreadsheet by tag, prism_type, and .csv extension", () => {
  assert.equal(noteKind({ path: null, tags: ["spreadsheet"], metadata: null }), "spreadsheet");
  assert.equal(noteKind({ path: null, tags: null, metadata: { prism_type: "spreadsheet" } }), "spreadsheet");
  assert.equal(noteKind({ path: "data/budget.csv", tags: null, metadata: null }), "spreadsheet");
});

test("CSV round-trips through the Y.Array<Y.Array> cell model", () => {
  const csv = "name,score\nAda,99\nGrace,100";
  const doc = new Y.Doc();
  Y.applyUpdate(doc, csvToYUpdate(csv));
  assert.equal(yDocToCsv(doc), csv);
});

test("loadDocumentState seeds a spreadsheet into rows, and a cell edit persists back as CSV", async () => {
  const csv = "a,b,c\n1,2,3";
  fv.put({ id: "sheet1", content: csv, tags: ["spreadsheet"], path: "t.csv" });

  const doc = await loadDocumentState("sheet1", new Y.Doc());
  assert.equal(yDocToCsv(doc), csv, "seeded as exact CSV");
  assert.equal(doc.getXmlFragment("default").length, 0, "not seeded as a document");
  assert.equal(doc.getArray("rows").length, 2, "two rows in the cell model");

  // Edit cell (1,1): 2 → 20 (delete+insert at index, the CRDT cell update).
  const rows = doc.getArray<Y.Array<string>>("rows");
  const row1 = rows.get(1);
  row1.delete(1, 1);
  row1.insert(1, ["20"]);
  await storeDocumentState("sheet1", doc);

  assert.equal(fv.notes.get("sheet1")!.content, "a,b,c\n1,20,3", "vault got updated CSV");
});
