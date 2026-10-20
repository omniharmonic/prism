/**
 * Graceful shutdown (src/shutdown.ts + collab's beginCollabShutdown).
 *
 * No test here measures time: the deadline is a fake timer the test fires itself, a hung
 * store is a vault write that never answers (finishing is the proof), and a second signal is
 * a second call.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { hocuspocus, beginCollabShutdown, resetReconcileState, _resetCollabShutdownForTests } from "../src/collab";
import { createShutdown, shutdownDeadlineMs, type ShutdownDeps, type StoreTracker } from "../src/shutdown";
import { stopConversionWorkers } from "../src/convert/service";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

let fv: FakeVault;
const saved = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };

beforeEach(() => {
  resetDb();
  resetReconcileState();
  _resetCollabShutdownForTests();
  fv = installFakeVault();
  // Edits stay UNSAVED until something stores them explicitly.
  hocuspocus.configuration.debounce = 600_000;
  hocuspocus.configuration.maxDebounce = 1_200_000;
});
afterEach(() => {
  hocuspocus.configuration.debounce = saved.debounce;
  hocuspocus.configuration.maxDebounce = saved.maxDebounce;
  _resetCollabShutdownForTests();
  fv.restore();
});
after(async () => {
  await stopConversionWorkers();
});

/** A fake one-shot timer the test fires by hand. */
function fakeTimer() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    setTimer(fn: () => void, ms: number) {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return { cancel: () => void (t.cancelled = true) };
    },
    fire() {
      for (const t of timers) if (!t.cancelled) t.fn();
    },
  };
}

function harness(over: Partial<ShutdownDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const timer = fakeTimer();
  const deps: ShutdownDeps = {
    stopAccepting: () => void calls.push("stopAccepting"),
    stopBackground: () => void calls.push("stopBackground"),
    storeDocuments: () => {
      calls.push("storeDocuments");
      return { done: Promise.resolve({ stored: 0, failed: [] }), pending: () => [], total: 0 };
    },
    closeClients: () => void calls.push("closeClients"),
    stopConversion: async () => void calls.push("stopConversion"),
    closeDb: () => void calls.push("closeDb"),
    exit: (code) => void exits.push(code),
    log: (l) => void logs.push(l),
    deadlineMs: 8000,
    setTimer: timer.setTimer,
    ...over,
  };
  return { deps, calls, logs, exits, timer, shutdown: createShutdown(deps) };
}

/** A tracker whose stores never finish. */
const hungTracker = (names: string[]): StoreTracker => ({ done: new Promise(() => {}), pending: () => names, total: names.length });

/** Wait (by loop turns, not time) until `cond` holds. */
async function until(cond: () => boolean, turns = 10_000): Promise<void> {
  for (let i = 0; i < turns && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition never became true");
}

function appendParagraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment("default").push([p]);
}

test("SHUTDOWN_DEADLINE_MS: a positive number, else 8000", () => {
  assert.equal(shutdownDeadlineMs({}), 8000);
  assert.equal(shutdownDeadlineMs({ SHUTDOWN_DEADLINE_MS: "2500" }), 2500);
  assert.equal(shutdownDeadlineMs({ SHUTDOWN_DEADLINE_MS: "0" }), 8000);
  assert.equal(shutdownDeadlineMs({ SHUTDOWN_DEADLINE_MS: "soon" }), 8000);
});

test("the orderly path runs every step in order, cancels the deadline and exits 0", async () => {
  const h = harness();
  h.shutdown.onSignal("SIGTERM");
  await h.shutdown.finished;
  assert.deepEqual(h.calls, ["stopAccepting", "stopBackground", "storeDocuments", "closeClients", "stopConversion", "closeDb"]);
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.timer.timers.length, 1);
  assert.equal(h.timer.timers[0]!.ms, 8000);
  assert.ok(h.timer.timers[0]!.cancelled, "the deadline is cancelled once done");
});

test("a step that throws does not stop the others", async () => {
  const h = harness({ closeClients: () => { throw new Error("boom"); } });
  h.shutdown.onSignal("SIGTERM");
  await h.shutdown.finished;
  assert.deepEqual(h.exits, [0]);
  assert.ok(h.logs.some((l) => l.includes("close clients failed: boom")));
});

test("a loaded document with unsaved changes is stored on shutdown", async () => {
  fv.put({ id: "shut-doc", path: "vault/shut-doc", tags: [], content: "<p>before</p>", updatedAt: "2026-02-01T00:00:00.000Z" });
  const conn = await hocuspocus.openDirectConnection("shut-doc", {});
  await conn.transact((doc) => appendParagraph(doc as unknown as Y.Doc, "typed just before the stop"));
  assert.ok(!fv.notes.get("shut-doc")!.content.includes("typed just before the stop"), "not stored yet (debounce)");

  const h = harness({ storeDocuments: () => beginCollabShutdown() });
  h.shutdown.onSignal("SIGTERM");
  await h.shutdown.finished;
  assert.deepEqual(h.exits, [0]);
  const stored = fv.notes.get("shut-doc")!.content;
  assert.ok(stored.includes("before") && stored.includes("typed just before the stop"), `stored: ${stored}`);
  assert.ok(h.logs.some((l) => l.includes("stored 1 document(s)")));

  await conn.disconnect();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
});

test("the deadline bounds a store whose vault write never answers: exit 1, the document named", async () => {
  fv.put({ id: "shut-hung", path: "vault/shut-hung", tags: [], content: "<p>start</p>", updatedAt: "2026-02-01T00:00:00.000Z" });
  const conn = await hocuspocus.openDirectConnection("shut-hung", {});
  await conn.transact((doc) => appendParagraph(doc as unknown as Y.Doc, "never reaches the vault"));

  // The vault answers reads, and never answers a write of this note.
  const inner = globalThis.fetch;
  let writeSeen = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && url.includes("shut-hung")) {
      writeSeen = true;
      return new Promise<Response>(() => {});
    }
    return inner(input as never, init);
  }) as typeof fetch;
  try {
    const h = harness({ storeDocuments: () => beginCollabShutdown() });
    h.shutdown.onSignal("SIGTERM");
    await until(() => writeSeen);
    assert.deepEqual(h.exits, [], "still waiting on the store");
    h.timer.fire(); // the deadline
    assert.deepEqual(h.exits, [1]);
    assert.ok(h.calls.includes("closeDb"), "the database is still closed on the forced path");
    assert.ok(!h.calls.includes("closeClients"), "the orderly steps after the stores did not run");
    assert.ok(h.logs.some((l) => l.includes("deadline") && l.includes("shut-hung")), h.logs.join("\n"));
  } finally {
    globalThis.fetch = inner;
    // The hung store holds the document's save mutex forever, so Hocuspocus will never
    // unload it: release it by hand (its Awareness interval would keep the process alive).
    const doc = hocuspocus.documents.get("shut-hung");
    if (doc) {
      hocuspocus.documents.delete("shut-hung");
      doc.awareness.destroy();
      doc.destroy();
    }
    void conn;
  }
});

test("a second signal exits at once, naming the unfinished stores (exit 1)", () => {
  const h = harness({ storeDocuments: () => hungTracker(["doc-a", "w2::doc-b"]) });
  h.shutdown.onSignal("SIGTERM");
  assert.ok(h.shutdown.started);
  h.shutdown.onSignal("SIGINT");
  assert.deepEqual(h.exits, [1]);
  assert.ok(h.logs.some((l) => l.includes("second signal (SIGINT)") && l.includes("doc-a, w2::doc-b")));
  h.timer.fire(); // a later deadline changes nothing
  h.shutdown.onSignal("SIGTERM");
  assert.deepEqual(h.exits, [1]);
});

test("a second signal with nothing unfinished exits 0", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({ stopConversion: () => gate });
  h.shutdown.onSignal("SIGTERM");
  await until(() => h.calls.includes("closeClients"));
  h.shutdown.onSignal("SIGTERM");
  assert.deepEqual(h.exits, [0]);
  release();
});
