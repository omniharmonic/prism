/**
 * Independent review of the conversion change (H1, H2) — stores that end
 * WITHOUT a vault write must never cost anyone their typing.
 *
 *  H1  A store that wrote nothing (failed vault write, busy converter, a note
 *      that kept changing) used to null the snapshot's source version; the
 *      reconciler then took the server's own OLDER vault copy for an external
 *      edit and folded it over newer typing. And the vault write was a blind
 *      overwrite: an external edit landing between the store's read and its
 *      write was lost.
 *  H2  A metadata-only write (a property, an icon, a backlink) landing while a
 *      large document rendered made the store drop itself, with nothing to retry
 *      it: the tab closed and the typing was gone at the next load.
 *
 * These use only what existed before the fix, so they can be run against it.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import * as collab from "../src/collab";
import { loadDocumentState, reconcileLoadedDocs, resetReconcileState, storeDocumentState, yDocToDocJson } from "../src/collab";
import { configureConversion, forgetConversionFailures, markdownToHtml, stopConversionWorkers } from "../src/convert/service";
import { getDocState } from "../src/db";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

let fv: FakeVault;
let restore: Array<() => void> = [];
beforeEach(() => {
  resetDb();
  resetReconcileState();
  (collab as unknown as Record<string, (() => void) | undefined>).resetConversionState?.();
  (collab as unknown as Record<string, (() => void) | undefined>).resetDegradedState?.();
  forgetConversionFailures();
  fv = installFakeVault();
});
afterEach(() => {
  for (const r of restore.splice(0).reverse()) r();
  fv.restore();
});
after(async () => {
  await stopConversionWorkers();
});

const T0 = "2026-03-01T00:00:00.000Z";
const text = (doc: Y.Doc) => JSON.stringify(yDocToDocJson(doc));
function type(doc: Y.Doc, words: string): void {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(words)]);
  const frag = doc.getXmlFragment("default");
  frag.insert(frag.length, [p]);
}
/** Run `during` while requests matching `match` are intercepted by `on` (which may answer itself). */
async function intercept<T>(match: (method: string, path: string) => boolean, on: (pass: () => Promise<Response>) => Promise<Response>, during: () => Promise<T>): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (match(method, url.pathname)) return on(() => inner(input, init));
    return inner(input, init);
  }) as typeof fetch;
  try {
    return await during();
  } finally {
    globalThis.fetch = inner;
  }
}
const isPatch = (id: string) => (method: string, path: string) => method === "PATCH" && path.endsWith(`/notes/${id}`);

test("H1: a store whose vault write FAILS does not let the reconciler fold the server's own older copy over newer typing", { timeout: 60_000 }, async () => {
  fv.put({ id: "h1", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h1", new Y.Doc());
  type(doc, "edit one");
  await storeDocumentState("h1", doc);
  assert.match(fv.notes.get("h1")!.content, /edit one/, "edit 1 is stored");
  const sourceAfterFirst = getDocState("h1")!.sourceUpdatedAt;
  assert.ok(sourceAfterFirst);

  type(doc, "edit two");
  // Edit 2's store reaches no vault (the write fails).
  await intercept(isPatch("h1"), async () => new Response("vault error", { status: 500 }), () => storeDocumentState("h1", doc));
  assert.doesNotMatch(fv.notes.get("h1")!.content, /edit two/, "nothing was written");
  assert.equal(getDocState("h1")!.sourceUpdatedAt, sourceAfterFirst, "the snapshot keeps the vault version it is based on — never null");

  // The 2 s reconciler runs: the vault still holds edit 1 (our OWN earlier write), which is not news.
  await reconcileLoadedDocs({ documents: new Map([["h1", doc]]) });
  assert.match(text(doc), /edit two/, "the live document still holds edit 2");
  assert.match(text(doc), /edit one/);

  // The tab closes before any retry: the next load restores the typing, and it is written then.
  const reopened = await loadDocumentState("h1", new Y.Doc());
  assert.match(text(reopened), /edit two/, "edit 2 survives a reload");
  await storeDocumentState("h1", reopened);
  assert.match(fv.notes.get("h1")!.content, /edit one[\s\S]*edit two/);
});

test("H1: our own successful store advances the reconcile mark — the next tick never re-folds what we just wrote", { timeout: 60_000 }, async () => {
  fv.put({ id: "h1b", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h1b", new Y.Doc());
  type(doc, "edit one");
  await storeDocumentState("h1b", doc);
  type(doc, "typed right after the store"); // not stored yet
  const reads = fv.calls.length;
  await reconcileLoadedDocs({ documents: new Map([["h1b", doc]]) });
  assert.match(text(doc), /typed right after the store/);
  // Even with the snapshot row gone (it is only one of the two marks), our write is known as ours.
  const { db } = await import("../src/db");
  db.prepare("UPDATE collab_docs SET source_updated_at = NULL WHERE name = 'h1b'").run();
  await reconcileLoadedDocs({ documents: new Map([["h1b", doc]]) });
  assert.match(text(doc), /typed right after the store/, "our own write is never folded back as an external edit");
  assert.ok(fv.calls.length > reads);
});

test("H1: the store's vault write is compare-and-set — an external edit between its read and its write is folded in, never overwritten", { timeout: 60_000 }, async () => {
  fv.put({ id: "h1c", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h1c", new Y.Doc());
  type(doc, "typed live");
  let landed = false;
  await intercept(
    isPatch("h1c"),
    async (pass) => {
      if (!landed) {
        landed = true; // someone else writes the note AFTER this store read it, BEFORE its write arrives
        fv.put({ ...fv.notes.get("h1c")!, content: "<p>start</p><p>EXTERNAL EDIT</p>", updatedAt: "2026-03-05T00:00:00.000Z" });
      }
      return pass();
    },
    () => storeDocumentState("h1c", doc),
  );
  assert.equal(landed, true);
  assert.match(fv.notes.get("h1c")!.content, /EXTERNAL EDIT/, "the external edit was not overwritten");
  assert.match(text(doc), /EXTERNAL EDIT/, "…and is now in the live document");
  // The store ends consistent: what the vault holds is what the snapshot is based on.
  assert.equal(getDocState("h1c")!.sourceUpdatedAt, Date.parse(fv.notes.get("h1c")!.updatedAt!));
});

test("H2: a metadata-only write landing while a large document renders does not drop the store — the typing is saved", { timeout: 120_000 }, async () => {
  fv.put({ id: "h2", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h2", new Y.Doc());
  type(doc, "typed before the property changed");
  // The render takes a while: every render goes to ONE worker thread that is busy first.
  await stopConversionWorkers();
  restore.push(configureConversion({ inlineMaxNodes: 0, threads: 1, timeoutMs: 700, timeoutPerMbMs: 0, timeoutMaxMs: 700 }));
  const hog = markdownToHtml("*a ".repeat(6000)).catch(() => null); // ~700 ms, then killed
  // …and a property is set on the page meanwhile (content untouched, version moved).
  const meta = setTimeout(() => {
    const n = fv.notes.get("h2")!;
    fv.put({ ...n, metadata: { ...(n.metadata ?? {}), icon: "🌱" }, updatedAt: new Date(Date.parse(n.updatedAt!) + 60_000).toISOString() });
  }, 150);
  await storeDocumentState("h2", doc);
  clearTimeout(meta);
  await hog;
  assert.equal(fv.notes.get("h2")!.metadata?.icon, "🌱", "the property write really landed during the store");
  assert.match(fv.notes.get("h2")!.content, /typed before the property changed/, "the store was retried in place and wrote the typing");
  assert.ok(getDocState("h2")!.sourceUpdatedAt, "the snapshot has a source version");
  // And if the tab closes now, nothing is lost at the next load.
  const reopened = await loadDocumentState("h2", new Y.Doc());
  assert.match(text(reopened), /typed before the property changed/);
});

test("H2: a metadata-only write between stores is not an external edit — the reconciler leaves unsaved typing alone", { timeout: 60_000 }, async () => {
  fv.put({ id: "h2b", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h2b", new Y.Doc());
  type(doc, "unsaved typing");
  const n = fv.notes.get("h2b")!;
  fv.put({ ...n, metadata: { icon: "🌱" }, updatedAt: "2026-03-05T00:00:00.000Z" }); // nobody called markReconciled
  await reconcileLoadedDocs({ documents: new Map([["h2b", doc]]) });
  assert.match(text(doc), /unsaved typing/);
  await storeDocumentState("h2b", doc);
  assert.match(fv.notes.get("h2b")!.content, /unsaved typing/);
  assert.equal(fv.notes.get("h2b")!.metadata?.icon, "🌱");
});
