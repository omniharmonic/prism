/**
 * H3 — the owner passthrough's read coalescing (`coalescedGet`, routes/api.ts).
 *  • A GET in flight ACROSS an owner write must not store its pre-write body after
 *    the cache was cleared, and a read after the write must not join it.
 *  • A single-note GET sent with `Cache-Control: no-cache` / `no-store` (what a
 *    browser sends for `cache: "no-store"`; the client's event-driven re-read) is
 *    never answered from the 5 s cache or a shared in-flight read.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
const OWNER = "owner@test.local";
let realFetch: typeof fetch;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  fv = installFakeVault();
  process.env.TREE_SUBSCRIBE = "0";
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  fv.restore();
  resetTreeForTests();
});

const ownerReq = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", sessionCookie(makeSession(OWNER)));
  if (init.body) headers.set("content-type", "application/json");
  return api.request(path, { ...init, headers });
};
const content = async (r: Response) => ((await r.json()) as { content: string }).content;
const noteReads = (id = "n1") => fv.calls.filter((c) => c.method === "GET" && c.path.endsWith(`/notes/${id}`)).length;

/** Hold the Nth vault GET of the note until released; it returns what the vault held when it STARTED. */
function holdNoteRead(nth: number): { release: () => void; started: Promise<void> } {
  const inner = globalThis.fetch;
  let count = 0;
  let release = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((r) => (markStarted = r));
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.method ?? "GET").toUpperCase() === "GET" && url.pathname.endsWith("/notes/n1") && ++count === nth) {
      const res = await inner(input, init); // the vault answers with the PRE-write body…
      markStarted();
      await gate; // …and the answer is slow to arrive
      return res;
    }
    return inner(input, init);
  }) as typeof fetch;
  return { release, started };
}

test("a read in flight across an owner write is not cached, and a read after the write does not join it", async () => {
  fv.put({ id: "n1", path: "n1", content: "before", tags: [] });
  const held = holdNoteRead(1);
  const slow = ownerReq("/notes/n1");
  await held.started;
  // The owner writes while that read is still in flight.
  const w = await ownerReq("/notes/n1", { method: "PATCH", body: JSON.stringify({ content: "after", force: true }) });
  assert.equal(w.status, 200);
  // A read issued AFTER the write must see the write — not the pending pre-write read.
  assert.equal(await content(await ownerReq("/notes/n1")), "after");
  held.release();
  assert.equal(await content(await slow), "before", "the slow read's own caller gets what it asked for");
  // …but its stale body was not stored: later reads still see the write.
  assert.equal(await content(await ownerReq("/notes/n1")), "after");
  assert.equal(await content(await ownerReq("/notes/n1")), "after");
});

test("no-cache / no-store on a single-note GET bypasses the reuse window; ordinary reads still coalesce", async () => {
  fv.put({ id: "n2", path: "n2", content: "v1", tags: [] });
  assert.equal(await content(await ownerReq("/notes/n2")), "v1");
  assert.equal(await content(await ownerReq("/notes/n2")), "v1");
  assert.equal(noteReads("n2"), 1, "the second read was served from the reuse window");
  // Changed by someone else, straight in the vault (another device, an agent): the gateway saw no write.
  fv.put({ id: "n2", path: "n2", content: "v2", tags: [] });
  assert.equal(await content(await ownerReq("/notes/n2")), "v1", "an ordinary read may be up to the TTL old");
  for (const value of ["no-cache", "no-store", "max-age=0, no-cache"]) {
    assert.equal(await content(await ownerReq("/notes/n2", { headers: { "cache-control": value } })), "v2", value);
  }
  // The fresh answer replaces the cached one for everyone else.
  assert.equal(await content(await ownerReq("/notes/n2")), "v2");
  // Only single-note reads honour it: a list keeps its protection against N copies of an expensive call.
  const lists = () => fv.calls.filter((c) => c.method === "GET" && /\/notes$/.test(c.path)).length;
  await ownerReq("/notes?tag=x");
  const before = lists();
  await ownerReq("/notes?tag=x", { headers: { "cache-control": "no-cache" } });
  assert.equal(lists(), before);
});

// 4A × 4B: "Move to" (POST /notes/:id/blocks/append) writes the target outside the
// owner proxy. The open target page re-reads on the change event; that read — and
// an ordinary one — must see the appended blocks, never the cached pre-append body.
test("a block append drops the owner's cached read of the target", async () => {
  fv.put({ id: "n9", path: "n9", content: "<p>before</p>", tags: [], metadata: { type: "document" } });
  assert.equal(await content(await ownerReq("/notes/n9")), "<p>before</p>"); // now inside the 5 s reuse window
  const append = await ownerReq("/notes/n9/blocks/append", { method: "POST", body: JSON.stringify({ html: "<p>moved</p>", requestId: "req-00000001" }) });
  assert.equal(append.status, 200);
  const after = await content(await ownerReq("/notes/n9"));
  assert.match(after, /before/);
  assert.match(after, /moved/, "an ordinary read after the append is not the cached pre-append body");
});
