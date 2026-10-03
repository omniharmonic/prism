/**
 * Behavioral check for the invalidation channel client (WP7.2):
 * packages/core/src/lib/events/invalidation.ts against a REAL TanStack QueryClient,
 * plus an end-to-end pass through streamSSE against a loopback SSE server.
 * Run: npm run verify:events -w @prism/web   (node --import tsx scripts/verify-events.ts)
 *
 * Covers: event parsing; 500 ms batching/debounce (N events -> one flush); per-note
 * key + lists (but NOT other notes' per-id keys); resync / overflow -> vault.all;
 * first-open only refreshes data older than the connection attempt, reconnect
 * resyncs; extra derived keys; reconnect after a dropped stream (streamSSE).
 */
import http from "node:http";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/query-core";
import { createInvalidator, parseInvalidationEvent, MAX_IDS } from "../../../packages/core/src/lib/events/invalidation.ts";
import { streamSSE } from "../../../packages/core/src/lib/transport/sse.ts";
import { queryKeys } from "../../../packages/core/src/lib/parachute/queries.ts";

// --- parse ---
assert.deepEqual(parseInvalidationEvent('{"type":"note","id":"a","op":"upsert"}'), { type: "note", id: "a", op: "upsert" });
assert.deepEqual(parseInvalidationEvent('{"type":"resync"}'), { type: "resync" });
for (const bad of ["nope", "{}", '{"type":"note","id":1,"op":"upsert"}', '{"type":"note","id":"a","op":"bogus"}', "{}"]) assert.equal(parseInvalidationEvent(bad), null);

// --- mapping against a real QueryClient ---
function harness(debounceMs = 500) {
  const qc = new QueryClient();
  let t = 1_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let seq = 0;
  let flushes = 0;
  const inv = createInvalidator({
    invalidate: (f) => {
      flushes++;
      void qc.invalidateQueries(f as never, { cancelRefetch: false });
    },
    debounceMs,
    now: () => t,
    setTimer: (fn, ms) => {
      const x = { fn, at: t + ms, id: ++seq };
      timers.push(x);
      return x.id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(x), 1);
      x.fn();
    }
  };
  const seed = (key: readonly unknown[]) => qc.setQueryData(key, "v");
  const stale = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated === true;
  return { qc, inv, advance, seed, stale, calls: () => flushes, pending: () => timers.length, setNow: (n: number) => (t = n) };
}

{
  const h = harness();
  h.inv.handleOpen(); // first open; nothing older than connect-start
  const list = queryKeys.vault.notes({ tag: "message-thread" });
  const keys = {
    a: queryKeys.vault.note("a"),
    aVersions: queryKeys.vault.versions("a"),
    b: queryKeys.vault.note("b"),
    bare: queryKeys.vault.notes(),
    list,
    tags: queryKeys.vault.tags(),
    stats: queryKeys.vault.stats(),
    graph: queryKeys.vault.graph(),
    search: queryKeys.vault.search("x"),
    rooms: ["matrix", "rooms"] as const,
    disp: ["agent", "dispatches", "web", true] as const,
    unrelated: ["services", "status"] as const,
  };
  for (const k of Object.values(keys)) h.seed(k);

  // A burst of 30 events for 3 ids -> ONE scheduled flush, nothing before 500 ms.
  for (let i = 0; i < 30; i++) h.inv.handleEvent({ type: "note", id: ["a", "x", "y"][i % 3]!, op: "upsert" });
  assert.equal(h.pending(), 1, "debounced into a single timer");
  h.advance(499);
  assert.equal(h.stale(keys.a), false, "nothing before the debounce elapses");
  h.advance(2);
  assert.equal(h.pending(), 0);
  for (const k of ["a", "aVersions", "list", "bare", "tags", "stats", "graph", "search", "rooms", "disp"] as const) assert.ok(h.stale(keys[k]), `${k} invalidated`);
  assert.equal(h.stale(keys.b), false, "another note's per-id key is left alone");
  assert.equal(h.stale(keys.unrelated), false, "unrelated keys untouched");
}

{
  // resync and overflow -> vault.all (including other notes' per-id keys)
  const h = harness();
  h.inv.handleOpen();
  h.seed(queryKeys.vault.note("b"));
  h.inv.handleEvent({ type: "resync" });
  h.advance(600);
  assert.ok(h.stale(queryKeys.vault.note("b")), "resync refreshes everything");

  const h2 = harness();
  h2.inv.handleOpen();
  h2.seed(queryKeys.vault.note("zzz"));
  for (let i = 0; i <= MAX_IDS + 1; i++) h2.inv.handleEvent({ type: "note", id: `n${i}`, op: "upsert" });
  h2.advance(600);
  assert.ok(h2.stale(queryKeys.vault.note("zzz")), `> ${MAX_IDS} ids collapses to vault.all`);
}

{
  // first open refreshes only data older than the connection attempt; reconnect resyncs all
  const h = harness();
  h.setNow(500);
  h.seed(queryKeys.vault.tags()); // dataUpdatedAt = real Date.now(), i.e. "new" vs the fake clock
  h.inv.handleOpen();
  assert.equal(h.stale(queryKeys.vault.tags()), false, "fetched after we began listening");
  h.inv.handleOpen(); // reconnect
  h.advance(600);
  assert.ok(h.stale(queryKeys.vault.tags()), "reconnect -> resync");
}

{
  // remove ops and unknown events
  const h = harness();
  h.inv.handleOpen();
  h.seed(queryKeys.vault.note("gone"));
  h.inv.handleEvent({ type: "note", id: "gone", op: "remove" });
  h.inv.handleEvent({ type: "bogus" } as never);
  h.advance(600);
  assert.ok(h.stale(queryKeys.vault.note("gone")));
}

{
  // NP-OF-05 sidebar tree: an id the tree has never listed (a page made elsewhere) or a remove
  // refreshes it at once; edits to known pages refresh it at most once per throttle window.
  const qc = new QueryClient();
  let t = 1_000;
  const timers: Array<{ fn: () => void; at: number }> = [];
  let treeCalls = 0;
  const known = new Set(["k1", "k2"]);
  const inv = createInvalidator({
    invalidate: (f) => { if (f.queryKey?.[1] === "tree") treeCalls++; void qc.invalidateQueries(f as never); },
    inTree: (id) => known.has(id),
    treeThrottleMs: 15_000,
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) { if (timers.includes(x)) { timers.splice(timers.indexOf(x), 1); x.fn(); } }
  };
  inv.handleOpen();
  inv.handleEvent({ type: "note", id: "k1", op: "upsert" });
  advance(600);
  assert.equal(treeCalls, 1, "first edit of a known page refreshes the tree");
  for (let i = 0; i < 5; i++) { inv.handleEvent({ type: "note", id: "k2", op: "upsert" }); advance(600); }
  assert.equal(treeCalls, 1, "further edits inside the window do not refetch the tree");
  inv.handleEvent({ type: "note", id: "new-page", op: "upsert" });
  advance(600);
  assert.equal(treeCalls, 2, "an unknown id refreshes the tree at once");
  inv.handleEvent({ type: "note", id: "k1", op: "remove" });
  advance(600);
  assert.equal(treeCalls, 3, "a remove refreshes the tree at once");
  inv.handleEvent({ type: "note", id: "k1", op: "upsert" });
  advance(600);
  assert.equal(treeCalls, 3);
  advance(15_000);
  assert.equal(treeCalls, 4, "the throttled refresh still lands (a rename made elsewhere)");
  inv.dispose();
}

// --- end to end: SSE server -> streamSSE -> parse -> invalidator, with a dropped stream ---
const frames = [
  ['event: ready\ndata: {}\n\n', 'data: {"type":"note","id":"n1","op":"upsert"}\n\n', ": ping\n\n"],
  ['event: ready\ndata: {}\n\n', 'data: {"type":"resync"}\n\n'],
];
let conn = 0;
const server = http.createServer((_req, res) => {
  const f = frames[Math.min(conn++, frames.length - 1)]!;
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const x of f) res.write(x);
  if (conn === 1) setTimeout(() => res.destroy(), 20);
  else setTimeout(() => res.end(), 20);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
{
  const got: string[] = [];
  let opens = 0;
  const ac = new AbortController();
  await streamSSE(`${base}/api/events`, {
    signal: ac.signal,
    retryMs: 10,
    onOpen: () => {
      opens++;
    },
    onEvent: (m) => {
      const ev = parseInvalidationEvent(m.data);
      if (ev) got.push(ev.type === "note" ? `note:${ev.id}` : ev.type);
      if (opens >= 2 && got.includes("resync")) return "stop";
    },
  });
  assert.deepEqual(got, ["note:n1", "resync"]);
  assert.ok(opens >= 2, "reconnected after the drop (client resyncs on every reopen)");
}
server.close();
console.log("verify-events: OK");
