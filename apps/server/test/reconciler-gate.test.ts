/**
 * NP-PF-09 — the reconciler's read gate.
 *
 * The collab reconciler used to read EVERY loaded document's note from the vault,
 * body included, every tick (2 s) — ~92 vault calls a minute for three idle tabs.
 * With a live tree projection (the vault's subscribe socket) it now reads a note
 * only when the projection reports a revision newer than the one the document
 * absorbed, when the projection lists no such note, when the document has state
 * the vault's copy may settle, or when the safety interval passed.
 *
 * Real Hocuspocus + the fake vault, which records every call: the assertions are
 * on `GET /notes/<id>` counts. "idle … reads nothing" and "real Hocuspocus …"
 * fail on the code before the gate (one read per document per tick).
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { addVaultEntry, getDocState, getVaultRegistry } from "../src/db";
import { collabTuning, docNameFor, hocuspocus, loadDocumentState, markReconciled, reconcileLoadedDocs, resetConversionState, resetReconcileState, startReconciler, storeDocumentState, yDocToHtml } from "../src/collab";
import { forgetConversionFailures, stopConversionWorkers } from "../src/convert/service";
import { ensureTree, resetTreeForTests, setTreeSocketFactory, treeStatus, type TreeSocket } from "../src/tree";
import { vaultClient } from "../src/parachute";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

const T0 = "2026-02-01T00:00:00.000Z";
/** Later than anything the fake vault stamps on a write (June 2026). */
const LATER = (n: number) => `2026-12-0${n}T00:00:00.000Z`;
const J = { "content-type": "application/json" };
const tuning = collabTuning as unknown as { reconcileRereadMs: number; now: () => number };
/** The reconciler's re-read clock, moved by hand (no sleeps: nothing here depends on how long a tick takes). */
let clock = 0;
const advance = (ms: number) => void (clock += ms);

let fv: FakeVault;
let socks: FakeSocket[] = [];
const REREAD = tuning.reconcileRereadMs;

class FakeSocket implements TreeSocket {
  onopen: TreeSocket["onopen"] = null;
  onmessage: TreeSocket["onmessage"] = null;
  onclose: TreeSocket["onclose"] = null;
  onerror: TreeSocket["onerror"] = null;
  sent: string[] = [];
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.onclose?.();
  }
  frame(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetReconcileState();
  resetConversionState();
  forgetConversionFailures();
  fv = installFakeVault();
  socks = [];
  process.env.TREE_SUBSCRIBE = "0";
  tuning.reconcileRereadMs = 60_000;
  clock = 1_000_000;
  tuning.now = () => clock;
});
afterEach(async () => {
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  resetConversionState();
  resetTreeForTests();
  process.env.TREE_SUBSCRIBE = "0";
  tuning.reconcileRereadMs = REREAD;
  tuning.now = () => Date.now();
  fv.restore();
});
after(async () => {
  await stopConversionWorkers();
});

// ── plumbing ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what = "condition", ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end && !cond(); ) await sleep(5);
  assert.ok(cond(), `${what} not reached`);
}
/** What the vault's subscribe socket says about a note: the lean row, no content. */
const lean = (id: string) => {
  const n = fv.notes.get(id)!;
  return { id: n.id, path: n.path, tags: n.tags ?? [], updatedAt: n.updatedAt, metadata: {} };
};
const primary = () => getVaultRegistry().find((v) => v.id === "primary")!;
/** Bring the primary vault's projection up over a fake subscribe socket whose snapshot is the vault's current notes. */
async function liveProjection(): Promise<FakeSocket> {
  setTreeSocketFactory((url) => {
    const s = new FakeSocket(url);
    socks.push(s);
    return s;
  });
  process.env.TREE_SUBSCRIBE = "1";
  const built = ensureTree(primary());
  await waitFor(() => socks.length === 1, "the subscribe socket");
  const s = socks[0]!;
  s.onopen?.();
  s.frame({ type: "snapshot", notes: [...fv.notes.keys()].map(lean), done: true });
  await built;
  return s;
}
/** The vault tells its subscribers a note changed (what a write made ANYWHERE produces). */
const announce = (s: FakeSocket, id: string) => s.frame({ type: "upsert", note: lean(id) });
const reads = (id: string) => fv.calls.filter((c) => c.method === "GET" && c.path.endsWith(`/notes/${id}`)).length;
const tickOnce = (...docs: Array<[string, Y.Doc]>) => reconcileLoadedDocs({ documents: new Map(docs) });
async function ticks(n: number, ...docs: Array<[string, Y.Doc]>) {
  for (let i = 0; i < n; i++) await tickOnce(...docs);
}
/** Somebody else writes the note's body directly in the vault. */
function vaultWrite(id: string, at: string, content: string): void {
  fv.put({ ...fv.notes.get(id)!, content, updatedAt: at });
}
/** Somebody else edits the body THROUGH the vault (stamped by it, after everything it stamped before). */
async function externalEdit(id: string, content: string): Promise<void> {
  await vaultClient("primary").updateNote(id, { content, ifUpdatedAt: fv.notes.get(id)!.updatedAt! });
}
/** What Hocuspocus does a moment after a fold changed the document: store it. The snapshot is in step again. */
async function settle(id: string, doc: Y.Doc): Promise<void> {
  await storeDocumentState(id, doc);
  assert.equal(getDocState(id)!.ahead, false, "the snapshot is in step with the vault again");
}
function type(doc: Y.Doc, words: string): void {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(words)]);
  const frag = doc.getXmlFragment("default");
  frag.insert(frag.length, [p]);
}
async function intercept<T>(match: (method: string, path: string) => boolean, on: () => Promise<Response>, during: () => Promise<T>): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return match(method, url.pathname) ? on() : inner(input, init);
  }) as typeof fetch;
  try {
    return await during();
  } finally {
    globalThis.fetch = inner;
  }
}
const N = 25;

// ── the gate ────────────────────────────────────────────────────────────────

test("idle: with the projection live, loaded documents are not read from the vault at all (it was one read per document per tick)", async () => {
  for (const id of ["a", "b", "c"]) fv.put({ id, tags: [], content: `<p>page ${id}</p>`, updatedAt: T0 });
  await liveProjection();
  const docs: Array<[string, Y.Doc]> = [];
  for (const id of ["a", "b", "c"]) docs.push([id, await loadDocumentState(id, new Y.Doc())]);
  const before = fv.calls.length;
  await ticks(N, ...docs);
  assert.equal(fv.calls.length - before, 0, `${N} idle ticks × 3 documents made ${fv.calls.length - before} vault calls`);
});

test("an external edit announced through the projection is read and folded on the NEXT tick — once; then quiet again", async () => {
  fv.put({ id: "e", tags: [], content: "<p>start</p>", updatedAt: T0 });
  const s = await liveProjection();
  const doc = await loadDocumentState("e", new Y.Doc());
  type(doc, "typed here");
  let r0 = reads("e");
  await externalEdit("e", "<p>start</p><p>EXTERNAL</p>");
  await ticks(3, ["e", doc]);
  assert.equal(reads("e") - r0, 0, "not announced yet: the projection is believed (the safety interval bounds this)");
  announce(s, "e");
  await tickOnce(["e", doc]);
  assert.equal(reads("e") - r0, 1, "the announced change is read on the next tick");
  assert.match(yDocToHtml(doc), /EXTERNAL/, "…and folded in");
  assert.match(yDocToHtml(doc), /typed here/, "…with what was typed meanwhile kept (the three-way merge is unchanged)");
  assert.equal(getDocState("e")!.sourceUpdatedAt, Date.parse(fv.notes.get("e")!.updatedAt!));
  // The merged document is ahead of the vault until its store lands: it keeps being read (state the vault may settle).
  await ticks(3, ["e", doc]);
  assert.equal(reads("e") - r0, 4, "ahead of the vault: read every tick");
  await settle("e", doc);
  assert.match(fv.notes.get("e")!.content, /typed here/);
  r0 = reads("e");
  await ticks(N, ["e", doc]); // our own write's frame has not arrived
  announce(s, "e");
  await ticks(N, ["e", doc]); // …and now it has
  assert.equal(reads("e") - r0, 0, "stored: no further reads");
});

test("a metadata-only write elsewhere costs one read and folds nothing; markReconciled (a write through the gateway) costs none", async () => {
  fv.put({ id: "m", tags: [], content: "<p>body</p>", updatedAt: T0 });
  const s = await liveProjection();
  const doc = await loadDocumentState("m", new Y.Doc());
  type(doc, "unsaved typing");
  const r0 = reads("m");
  // A property set by an ingester: a newer version, the same content.
  fv.put({ ...fv.notes.get("m")!, metadata: { status: "done" }, updatedAt: LATER(1) });
  announce(s, "m");
  await ticks(3, ["m", doc]);
  assert.equal(reads("m") - r0, 1);
  assert.match(yDocToHtml(doc), /unsaved typing/);
  assert.equal(getDocState("m")!.sourceUpdatedAt, Date.parse(LATER(1)), "only the stamp moved");
  // A metadata write Prism made itself: the caller marks it absorbed, the frame arrives, nothing is read.
  fv.put({ ...fv.notes.get("m")!, metadata: { status: "next" }, updatedAt: LATER(2) });
  assert.equal(markReconciled("m", Date.parse(LATER(1)), Date.parse(LATER(2))), true);
  announce(s, "m");
  await ticks(N, ["m", doc]);
  assert.equal(reads("m") - r0, 1, "an absorbed revision is not read again");
  assert.match(yDocToHtml(doc), /unsaved typing/);
});

test("our own store: the projection row is OLDER than what the document absorbed until the frame arrives — neither state causes a read", async () => {
  fv.put({ id: "o", tags: [], content: "<p>start</p>", updatedAt: T0 });
  const s = await liveProjection();
  const doc = await loadDocumentState("o", new Y.Doc());
  type(doc, "mine");
  await storeDocumentState("o", doc);
  assert.match(fv.notes.get("o")!.content, /mine/);
  const r0 = reads("o");
  await ticks(N, ["o", doc]); // the frame for our write has not arrived: row (T0) < absorbed
  announce(s, "o");
  await ticks(N, ["o", doc]); // it has: row == absorbed
  assert.equal(reads("o") - r0, 0);
});

test("projection NOT live → every tick reads, as before: no projection at all, the socket down, a reconnect still loading; a reconnect snapshot with a newer row is folded", async () => {
  fv.put({ id: "n", tags: [], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("n", new Y.Doc());
  let r0 = reads("n");
  await ticks(5, ["n", doc]);
  assert.equal(reads("n") - r0, 5, "no projection (TREE_SUBSCRIBE=0, or nobody asked for the tree yet): read every tick");

  const s = await liveProjection();
  r0 = reads("n");
  await ticks(5, ["n", doc]);
  assert.equal(reads("n") - r0, 0, "live: quiet");

  s.close(); // vault restart: frames are being missed from here on
  await externalEdit("n", "<p>start</p><p>WHILE DOWN</p>");
  r0 = reads("n");
  await tickOnce(["n", doc]);
  assert.equal(reads("n") - r0, 1, "socket down: the reconciler reads again");
  assert.match(yDocToHtml(doc), /WHILE DOWN/, "…so the edit made while the socket was down is folded on the next tick");
  await settle("n", doc);

  // The projection reconnects (the 2 s back-off timer); until its snapshot is complete it is not trusted.
  await waitFor(() => socks.length === 2, "the reconnect", 6000);
  const s2 = socks[1]!;
  s2.onopen?.();
  r0 = reads("n");
  await ticks(3, ["n", doc]);
  assert.equal(reads("n") - r0, 3, "snapshot not complete: still reading every tick");
  await externalEdit("n", "<p>start</p><p>WHILE DOWN</p><p>SNAPSHOT</p>");
  s2.frame({ type: "snapshot", notes: [lean("n")], done: true });
  r0 = reads("n");
  await tickOnce(["n", doc]);
  assert.equal(reads("n") - r0, 1, "the snapshot's newer row is read");
  assert.match(yDocToHtml(doc), /SNAPSHOT/);
  await settle("n", doc);
  r0 = reads("n");
  await ticks(N, ["n", doc]);
  assert.equal(reads("n") - r0, 0, "live again: quiet");
});

test("safety interval: a change whose frame never arrived is still read and folded once the interval passes; knob 0 = no gate", async () => {
  fv.put({ id: "s", tags: [], content: "<p>start</p>", updatedAt: T0 });
  await liveProjection();
  const doc = await loadDocumentState("s", new Y.Doc());
  await externalEdit("s", "<p>start</p><p>MISSED FRAME</p>"); // nobody announces it
  let r0 = reads("s");
  await ticks(5, ["s", doc]);
  assert.equal(reads("s") - r0, 0, "inside the interval the projection is believed");
  assert.doesNotMatch(yDocToHtml(doc), /MISSED FRAME/);
  advance(59_999);
  await tickOnce(["s", doc]);
  assert.equal(reads("s") - r0, 0, "one millisecond short");
  advance(1);
  await tickOnce(["s", doc]);
  assert.equal(reads("s") - r0, 1, "the safety re-read");
  assert.match(yDocToHtml(doc), /MISSED FRAME/);
  await settle("s", doc);
  r0 = reads("s");
  advance(60_000);
  await ticks(5, ["s", doc]);
  assert.equal(reads("s") - r0, 1, "one per interval, not one per tick");
  advance(60_000);
  await ticks(3, ["s", doc]);
  assert.equal(reads("s") - r0, 2);

  tuning.reconcileRereadMs = 0;
  await ticks(4, ["s", doc]);
  assert.equal(reads("s") - r0, 6, "COLLAB_RECONCILE_REREAD_MS=0: every tick reads (the behaviour before the gate)");
});

test("a safety re-read that FAILS (the vault did not answer) does not restart the interval: the next tick reads again", async () => {
  fv.put({ id: "f", tags: [], content: "<p>start</p>", updatedAt: T0 });
  await liveProjection();
  const doc = await loadDocumentState("f", new Y.Doc());
  await externalEdit("f", "<p>start</p><p>MISSED FRAME</p>"); // never announced
  advance(60_000);
  let tried = 0;
  await intercept((m, path) => m === "GET" && path.endsWith("/notes/f"), async () => (tried++, new Response(JSON.stringify({ error: "boom" }), { status: 503, headers: J })), () => tickOnce(["f", doc]));
  assert.equal(tried, 1, "the safety re-read was attempted");
  assert.doesNotMatch(yDocToHtml(doc), /MISSED FRAME/);
  const r0 = reads("f");
  await tickOnce(["f", doc]);
  assert.equal(reads("f") - r0, 1, "the failed read is retried on the next tick, not 60 s later");
  assert.match(yDocToHtml(doc), /MISSED FRAME/);
});

test("a document of ANOTHER vault whose projection was never built is read every tick (the primary's live projection says nothing about it, and none is built for it)", async () => {
  addVaultEntry({ id: "team-b", label: "B", url: "http://vault.test", vault: "team-b", token: "tb" });
  fv.addVault("team-b");
  fv.put({ id: "x", tags: [], content: "<p>primary</p>", updatedAt: T0 });
  fv.putIn("team-b", { id: "x", tags: [], content: "<p>team b</p>", updatedAt: T0 });
  await liveProjection();
  const name = docNameFor("team-b", "x");
  const doc = await loadDocumentState(name, new Y.Doc());
  assert.match(yDocToHtml(doc), /team b/);
  const bReads = () => fv.calls.filter((c) => c.method === "GET" && c.path === "/vault/team-b/api/notes/x").length;
  const r0 = bReads();
  await ticks(6, [name, doc]);
  assert.equal(bReads() - r0, 6);
  assert.equal(socks.length, 1, "no projection (no subscribe socket) was started for it");
  assert.equal(treeStatus("team-b"), null);
});

test("a deleted note (its row leaves the projection) is read every tick, as before — the gate never hides it; a trashed one is read once", async () => {
  fv.put({ id: "d", tags: [], content: "<p>start</p>", updatedAt: T0 });
  fv.put({ id: "t", tags: [], content: "<p>start</p>", updatedAt: T0 });
  const s = await liveProjection();
  const doc = await loadDocumentState("d", new Y.Doc());
  const trashed = await loadDocumentState("t", new Y.Doc());
  fv.notes.delete("d");
  s.frame({ type: "remove", id: "d" });
  fv.put({ ...fv.notes.get("t")!, tags: ["prism-trashed"], updatedAt: LATER(1) });
  announce(s, "t");
  const d0 = reads("d");
  const t0 = reads("t");
  await ticks(6, ["d", doc], ["t", trashed]);
  assert.equal(reads("d") - d0, 6, "no row: the vault is asked (and answers 404) every tick, as it always was");
  assert.equal(reads("t") - t0, 1, "a trash is a tag write: a newer revision, read once");
});

test("a document with an unconfirmed write keeps reading every tick (the vault's copy is what settles it)", { timeout: 60_000 }, async () => {
  fv.historySupported = false;
  fv.put({ id: "p", tags: [], content: "<p>start</p>", updatedAt: T0 });
  await liveProjection();
  const doc = await loadDocumentState("p", new Y.Doc());
  type(doc, "sent");
  // The store's write gets no answer (a 504): recorded as an attempt, snapshot ahead, a retry pending.
  await intercept((m, path) => m === "PATCH" && path.endsWith("/notes/p"), async () => new Response(JSON.stringify({ error: "boom" }), { status: 504, headers: J }), () => storeDocumentState("p", doc));
  assert.equal(getDocState("p")!.attempts.length, 1);
  const r0 = reads("p");
  await ticks(6, ["p", doc]);
  assert.equal(reads("p") - r0, 6, "pending state: read every tick");
  // The write lands after all (no frame needed): the next tick adopts it as ours.
  vaultWrite("p", LATER(1), yDocToHtml(doc));
  await tickOnce(["p", doc]);
  assert.equal(getDocState("p")!.sourceUpdatedAt, Date.parse(LATER(1)), "adopted");
});

test("real Hocuspocus, the reconciler's own timer: an open idle document makes no vault calls; an external edit announced by the vault reaches it within a few ticks", { timeout: 30_000 }, async () => {
  fv.put({ id: "h", tags: [], content: "<p>start</p>", updatedAt: T0 });
  const s = await liveProjection();
  const conn = await hocuspocus.openDirectConnection("h", {});
  const doc = hocuspocus.documents.get("h")!;
  let tickCount = 0;
  const counting = { documents: hocuspocus.documents as unknown as Map<string, Y.Doc> };
  Object.defineProperty(counting, "documents", { get: () => (tickCount++, hocuspocus.documents) });
  const stop = startReconciler(counting as never, 10);
  try {
    const r0 = reads("h");
    await waitFor(() => tickCount >= 20, "20 ticks");
    assert.equal(reads("h") - r0, 0, `${tickCount} idle ticks read the note ${reads("h") - r0} times`);
    await externalEdit("h", "<p>start</p><p>FROM AN AGENT</p>");
    announce(s, "h");
    await waitFor(() => /FROM AN AGENT/.test(yDocToHtml(doc)), "the fold");
    // The fold changed the document, so Hocuspocus stores it (debounced; flushed here): in step again.
    hocuspocus.flushPendingStores();
    await waitFor(() => getDocState("h")!.ahead === false, "the store after the fold");
    await sleep(30);
    const r1 = reads("h");
    const at = tickCount;
    await waitFor(() => tickCount >= at + 20, "20 more ticks");
    assert.equal(reads("h") - r1, 0, "quiet again once the fold is stored");
  } finally {
    stop();
    await conn.disconnect();
  }
});
