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
import { takeFreshRead } from "../../../packages/core/src/lib/events/freshReads.ts";
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
  // M1 sidebar tree: refreshed only when the server says the viewer's ROW changed (`tree: true`),
  // at once; never for a plain content edit. Fallbacks: an id the tree has never listed, a remove.
  // A hidden tab holds the refresh until it is visible again (one refetch).
  const qc = new QueryClient();
  let t = 1_000;
  const timers: Array<{ fn: () => void; at: number }> = [];
  let treeCalls = 0;
  let visible = true;
  const known = new Set(["k1", "k2"]);
  const inv = createInvalidator({
    invalidate: (f) => { if (f.queryKey?.[1] === "tree") treeCalls++; void qc.invalidateQueries(f as never); },
    inTree: (id) => known.has(id),
    visible: () => visible,
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) { if (timers.includes(x)) { timers.splice(timers.indexOf(x), 1); x.fn(); } }
  };
  inv.handleOpen();
  for (let i = 0; i < 20; i++) { inv.handleEvent({ type: "note", id: i % 2 ? "k1" : "k2", op: "upsert" }); advance(600); }
  assert.equal(treeCalls, 0, "content edits of pages the tree lists never refetch it");
  assert.equal(timers.length, 0, "and nothing is scheduled for later");
  inv.handleEvent({ type: "note", id: "k1", op: "upsert", tree: true });
  advance(600);
  assert.equal(treeCalls, 1, "a flagged event refreshes the tree at once");
  inv.handleEvent({ type: "note", id: "new-page", op: "upsert" });
  advance(600);
  assert.equal(treeCalls, 2, "older server: an id the tree has never listed still refreshes it");
  inv.handleEvent({ type: "note", id: "k1", op: "remove" });
  advance(600);
  assert.equal(treeCalls, 3, "a remove refreshes it");
  // Hidden tab: held; visible again: exactly one refresh for everything that happened.
  visible = false;
  for (const id of ["k1", "k2", "k1"]) { inv.handleEvent({ type: "note", id, op: "upsert", tree: true }); advance(600); }
  assert.equal(treeCalls, 3, "no tree refetch while hidden");
  inv.handleVisible();
  assert.equal(treeCalls, 3, "still hidden: nothing");
  visible = true;
  inv.handleVisible();
  assert.equal(treeCalls, 4, "one catch-up refresh when the tab is visible again");
  inv.handleVisible();
  assert.equal(treeCalls, 4, "and only one");
  // The flag survives parsing; anything else in the frame is dropped.
  assert.deepEqual(parseInvalidationEvent('{"type":"note","id":"a","op":"upsert","tree":true,"path":"x"}'), { type: "note", id: "a", op: "upsert", tree: true }); // unknown keys dropped
  assert.deepEqual(parseInvalidationEvent('{"type":"note","id":"a","op":"upsert","tree":"yes"}'), { type: "note", id: "a", op: "upsert" });
  // Each touched id is marked for ONE fresh re-read.
  inv.handleEvent({ type: "note", id: "fresh-me", op: "upsert" });
  advance(600);
  assert.equal(takeFreshRead("fresh-me"), true);
  assert.equal(takeFreshRead("fresh-me"), false);
  assert.equal(takeFreshRead("never-touched"), false);
  inv.dispose();
}

// --- L-1 (2026-11-08): an agent's burst of 42 edits to ONE open page, ~1 per 5 s ---
// Before: every event refetched every mounted list (multi-MB meeting / agent-dispatch / person
// lists) → dozens of rounds of fetch + parse + IndexedDB write on the main thread. Now: only the
// lists that can hold the page refetch, each at most once per window; the rest are marked stale.
{
  const { QueryObserver } = await import("@tanstack/query-core");
  const qc = new QueryClient();
  let t = 1_000;
  const timers: Array<{ fn: () => void; at: number }> = [];
  const inv = createInvalidator({
    invalidate: (f) => void qc.invalidateQueries(f as never, { cancelRefetch: false }),
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      t = next.at;
      timers.splice(timers.indexOf(next), 1);
      next.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    t = end;
    await new Promise((r) => setTimeout(r, 0));
  };
  const fetches = new Map<string, number>();
  const mount = (name: string, key: readonly unknown[], rows = 10) => {
    fetches.set(name, 0);
    const obs = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async () => { fetches.set(name, (fetches.get(name) ?? 0) + 1); return Array.from({ length: rows }, (_, i) => ({ id: `${name}-${i}` })); },
      staleTime: Infinity,
    });
    obs.subscribe(() => {});
    return obs;
  };
  mount("meetings", queryKeys.vault.notes({ tag: "meeting", limit: 5000 }), 2_000);
  mount("dispatches", queryKeys.vault.notes({ tag: "agent-dispatch", limit: 50000 }), 1_500);
  mount("people", queryKeys.vault.notes({ tag: "person", limit: 50000 }), 1_200);
  mount("docList", queryKeys.vault.notes({ tag: "project" }), 20);
  mount("database", ["vault", "notes", { database: "s", spec: { tags: ["project"] } }], 20);
  mount("folder", queryKeys.vault.notes({ path: "vault/projects/" }), 20);
  mount("everything", queryKeys.vault.notes(), 3_000);
  mount("reverse", ["vault", "notes", { reverse: "s", id: "x", path: "vault/projects/x", specs: [] }], 5);
  mount("rooms", ["matrix", "rooms"], 300);
  mount("agentDispatches", ["agent", "dispatches", "web", true], 50);
  mount("graph", queryKeys.vault.graph(), 1);
  mount("tags", queryKeys.vault.tags(), 1);
  await advance(10);
  const before = new Map(fetches);
  inv.handleOpen();
  for (let i = 0; i < 42; i++) {
    inv.handleEvent(parseInvalidationEvent(JSON.stringify({ type: "note", id: "page-1", op: "upsert", tags: ["project"], paths: ["vault/projects/plan/PROJECT"] }))!);
    await advance(5_000);
  }
  await advance(60_000); // let every trailing refetch run
  const extra = (n: string) => fetches.get(n)! - before.get(n)!;
  for (const n of ["meetings", "dispatches", "people", "reverse", "rooms", "agentDispatches", "tags"]) {
    assert.equal(extra(n), 0, `L-1: ${n} is not refetched for an edit to a page it cannot hold (got ${extra(n)})`);
  }
  assert.ok(qc.getQueryState(queryKeys.vault.notes({ tag: "meeting", limit: 5000 }))!.isInvalidated, "…but it is marked stale");
  for (const n of ["docList", "database", "folder"]) assert.ok(extra(n) >= 1 && extra(n) <= 43, `L-1: ${n} (holds the page) refetches, at most once per 5 s window (got ${extra(n)})`);
  // ~215 s of events: a 30 s window gives at most ~8 refetches of the big unfiltered list and the graph.
  assert.ok(extra("everything") >= 1 && extra("everything") <= 9, `unfiltered list: once per 30 s at most (got ${extra("everything")})`);
  assert.ok(extra("graph") >= 1 && extra("graph") <= 9, `graph: once per 30 s at most (got ${extra("graph")})`);

  // Same burst from an OLDER server (frames without tags): every list matches, but each refetches
  // at most once per window — big lists once per 30 s instead of 42 times.
  for (const k of fetches.keys()) before.set(k, fetches.get(k)!);
  for (let i = 0; i < 42; i++) {
    inv.handleEvent({ type: "note", id: "page-1", op: "upsert" });
    await advance(1_000); // a faster burst
  }
  await advance(60_000);
  assert.ok(extra("meetings") >= 1 && extra("meetings") <= 3, `older server: a 2,000-row list refetches at most once per 30 s (got ${extra("meetings")})`);
  assert.ok(extra("docList") <= 10, `older server: a small list at most once per 5 s (got ${extra("docList")})`);
  inv.dispose();

  // Parsing: shape kept when well-formed, dropped (= older server) when not.
  assert.deepEqual(parseInvalidationEvent('{"type":"note","id":"a","op":"upsert","tags":["x"],"paths":["p/a"]}'), { type: "note", id: "a", op: "upsert", tags: ["x"], paths: ["p/a"] });
  assert.deepEqual(parseInvalidationEvent('{"type":"note","id":"a","op":"upsert","tags":[1]}'), { type: "note", id: "a", op: "upsert" });
  console.log("L-1 burst: lists that cannot hold the page: 0 refetches; holders and big lists rate-limited ✓");
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
