/**
 * A live document is never seeded or stored under a GUESSED kind.
 *
 * "Creating a new canvas crashed, then loaded" (2026-10): the first socket for a
 * brand-new canvas could reach `loadDocumentState` while the vault could not
 * answer the note's read (slow / busy right after the create). The load then fell
 * back to kind "document" — the client bound an empty `Y.Map` while the server held
 * an XML fragment, and a store would render the canvas as HTML (`<p></p>`): the
 * corruption CLAUDE.md warns about. Now an unknown kind refuses the load as `busy`
 * (the client retries) and a store with no known kind keeps the state for later.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { loadDocumentState, storeDocumentState, sceneToYUpdate, BUSY_REASON, resetReconcileState } from "../src/collab";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

let fv: FakeVault;
let failReads = new Map<string, number>();
let fakeFetch: typeof fetch;
beforeEach(() => {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  failReads = new Map();
  fakeFetch = globalThis.fetch;
  // The vault answers 500 to the next N reads of a note (writes and other notes untouched).
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const id = url.pathname.match(/\/notes\/([^/]+)$/)?.[1];
    if (method === "GET" && id && (failReads.get(id) ?? 0) > 0) {
      failReads.set(id, failReads.get(id)! - 1);
      return new Response(JSON.stringify({ error: "busy" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return fakeFetch(input as never, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = fakeFetch;
  fv.restore();
});

/** What NewContentMenu creates for "Canvas": a near-empty body, the kind in metadata only. */
const newCanvas = (id: string) => fv.put({ id, path: `vault/Boards/${id}`, content: " ", tags: [], metadata: { type: "canvas", title: "Untitled canvas" } });

test("a new canvas whose first read fails is refused `busy` — never seeded as a text document", async () => {
  newCanvas("canvas-new-1");
  failReads.set("canvas-new-1", 1);
  const first = new Y.Doc();
  await assert.rejects(() => loadDocumentState("canvas-new-1", first), (e: Error) => e.message === BUSY_REASON);
  assert.equal(first.getXmlFragment("default").length, 0, "nothing seeded into the refused document");
  assert.equal(first.getMap("elements").size, 0);

  // The client's retry: the read answers now, and the kind comes from the note (nothing cached by the failure).
  const doc = await loadDocumentState("canvas-new-1", new Y.Doc());
  assert.equal(doc.getXmlFragment("default").length, 0, "not a document");
  doc.getMap("elements").set("r1", { id: "r1", type: "rectangle", x: 10, version: 1 });
  await storeDocumentState("canvas-new-1", doc);
  const written = fv.notes.get("canvas-new-1")!.content;
  assert.ok(!written.includes("<p"), `stored as a scene, not HTML: ${written.slice(0, 80)}`);
  assert.equal(JSON.parse(written).elements[0].id, "r1");
});

test("a document whose kind is already known still opens from its snapshot while the vault cannot be read", async () => {
  newCanvas("canvas-known");
  const doc = await loadDocumentState("canvas-known", new Y.Doc()); // learns (and caches) the kind
  doc.getMap("elements").set("r1", { id: "r1", type: "rectangle", x: 1, version: 1 });
  await storeDocumentState("canvas-known", doc);
  failReads.set("canvas-known", 1);
  const again = await loadDocumentState("canvas-known", new Y.Doc());
  assert.equal(again.getMap("elements").size, 1, "the stored canvas opens; no refusal for a known kind");
});

test("a store that cannot learn the kind writes nothing (no HTML over a scene)", async () => {
  const scene = JSON.stringify({ elements: [{ id: "keep", type: "rectangle", x: 0, version: 1 }], appState: {} });
  fv.put({ id: "canvas-unknown", path: "vault/Boards/unknown", content: scene, tags: [], metadata: { type: "canvas" } });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, sceneToYUpdate(scene));
  failReads.set("canvas-unknown", 5);
  const before = fv.notes.get("canvas-unknown")!.content;
  await storeDocumentState("canvas-unknown", doc); // no load ran in this process: the kind is unknown
  assert.equal(fv.notes.get("canvas-unknown")!.content, before, "the note is untouched");
  failReads.clear();
});

test("a note the vault definitely does not have (404) still opens as an empty document — nothing to corrupt", async () => {
  const doc = await loadDocumentState("never-existed", new Y.Doc());
  assert.equal(doc.getXmlFragment("default").length, 0);
  assert.equal(doc.getMap("elements").size, 0);
});
