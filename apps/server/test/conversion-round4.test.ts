/**
 * Third independent review of the conversion change (round 4). Each test was
 * run against the code WITHOUT its fix first and failed there.
 *
 *  C1  Stored HTML still converted on the main thread, super-linearly: the node
 *      count saw only `<` + letter, and HTML had no inline byte cap.
 *  H1  A lost acknowledgement + an external edit on top of our landed write was
 *      merged against the stale base → content duplicated.
 *  M1  The gateway's unsaved-state middleware loaded + stored for a viewer.
 *  M2  A permanently unsaveable page answered `retry: true` forever; no way out.
 *  M3  A store saved an older snapshot over a row the reconciler had moved on.
 *  M4  Worker respawns unbounded; retry interval flat; 2 GB heap ceiling.
 *  L1  The "replaced" notice was repeated to every later socket.
 *  L2  A snapshot loaded while the note was unreadable was never written.
 *  L6  A block move answered 503 after appending; the retry appended again.
 *  L7  Transient unsaved state still read "Saved" (server half; the copy is
 *      checked by apps/web/scripts/verify-sync-state.ts).
 */
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import * as dbm from "../src/db";
import { addGrant, ensureUser, getDocState, isCollabUnsaved, saveDocAhead } from "../src/db";
import { issuePat } from "../src/auth/pat";
import * as collab from "../src/collab";
import { attachCollab, hocuspocus, loadDocumentState, reconcileLoadedDocs, resetConversionState, resetReconcileState, storeDocumentState, sweepUnsavedDocuments, yDocToDocJson, yDocToHtml } from "../src/collab";
import * as service from "../src/convert/service";
import { ConversionError, configureConversion, contentToSeed, conversionStats, forgetConversionFailures, isCheapContent, stopConversionWorkers } from "../src/convert/service";
import * as precheck from "../src/convert/precheck";
import { vaultClient } from "../src/parachute";
import { db } from "../src/db";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const EDITOR = "editor@test.local";
const VIEWER = "viewer@test.local";
const T0 = "2026-02-01T00:00:00.000Z";
/** Later than anything the fake vault stamps on a write (June 2026). */
const LATER = (n: number) => `2026-12-0${n}T00:00:00.000Z`;
const J = { "content-type": "application/json" };

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let server: Server;
let wsUrl: string;
let ip: string;
let restore: Array<() => void> = [];
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];
const clientSockets = new Set<WebSocket>();
class TrackedWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    clientSockets.add(this);
  }
}
const saved = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  resetConversionState();
  forgetConversionFailures();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  hocuspocus.configuration.debounce = 100;
  hocuspocus.configuration.maxDebounce = 300;
  for (const e of [OWNER, EDITOR, VIEWER]) ensureUser(e);
  addGrant({ subject_type: "user", subject: VIEWER, resource_type: "tag", resource: "garden", level: "view", caps: ["view"] as never, created_by: "test", vault_id: "primary" });
  addGrant({ subject_type: "user", subject: EDITOR, resource_type: "tag", resource: "garden", level: "view", caps: ["view", "comment", "suggest", "edit", "create"] as never, created_by: "test", vault_id: "primary" });
  server = createServer();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  attachCollab(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab?schema=${COLLAB_SCHEMA_VERSION}`;
});

afterEach(async () => {
  for (const r of restore.splice(0).reverse()) r();
  for (const p of providers.splice(0)) p.destroy();
  for (const s of clientSockets) s.terminate();
  clientSockets.clear();
  hocuspocus.closeConnections();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
  hocuspocus.configuration.debounce = saved.debounce;
  hocuspocus.configuration.maxDebounce = saved.maxDebounce;
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  resetConversionState();
  fv.restore();
});
after(async () => {
  await stopConversionWorkers();
});

// ── plumbing ────────────────────────────────────────────────────────────────

const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const text = (doc: Y.Doc) => JSON.stringify(yDocToDocJson(doc));
function type(doc: Y.Doc, words: string): void {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(words)]);
  const frag = doc.getXmlFragment("default");
  frag.insert(frag.length, [p]);
}
const live = (name: string) => hocuspocus.documents.get(name) as Y.Doc | undefined;
const vaultContent = (id: string) => fv.notes.get(id)!.content;
const patches = (id: string) => fv.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/notes/${id}`));
/** Somebody else writes the note: same body + a property (metadata only), or a new body. */
function vaultWrite(id: string, at: string, change: { content?: string; metadata?: Record<string, unknown> }): void {
  const n = fv.notes.get(id)!;
  fv.put({ ...n, content: change.content ?? n.content, metadata: { ...(n.metadata ?? {}), ...(change.metadata ?? {}) }, updatedAt: at });
}
type Unsaved = { reason: string | null; permanent: number; attempts: number } | null;
const unsavedRow = (id: string): Unsaved => (dbm as unknown as { getCollabUnsaved?: (n: string, v: string) => Unsaved }).getCollabUnsaved?.(id, "primary") ?? null;

/** Run `during` while vault requests matching `match` are intercepted by `on` (which may pass them through). */
async function intercept<T>(match: (method: string, path: string, body: string) => boolean, on: (pass: () => Promise<Response>) => Promise<Response>, during: () => Promise<T>): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (match(method, url.pathname, typeof init?.body === "string" ? init.body : "")) return on(() => inner(input, init));
    return inner(input, init);
  }) as typeof fetch;
  try {
    return await during();
  } finally {
    globalThis.fetch = inner;
  }
}
const isPatch = (id: string) => (method: string, path: string) => method === "PATCH" && path.endsWith(`/notes/${id}`);
const isGet = (id: string) => (method: string, path: string) => method === "GET" && path.endsWith(`/notes/${id}`);
const fail = (status: number) => async () => new Response(JSON.stringify({ error: "boom" }), { status, headers: J });

/** A person opens the page (server side), types, and leaves; the store on leaving runs under `during`. */
async function typeAndLeave(id: string, words: string, leaving: (leave: () => Promise<void>) => Promise<void> = (leave) => leave()): Promise<void> {
  const conn = await hocuspocus.openDirectConnection(id, {});
  await conn.transact((doc) => type(doc as unknown as Y.Doc, words));
  await leaving(() => conn.disconnect());
  await until(`${id} unloads`, () => !hocuspocus.documents.has(id));
}

interface Tab {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  messages: Array<Record<string, unknown>>;
  synced: () => boolean;
}
function open(name: string, doc = new Y.Doc()): Tab {
  let synced = false;
  const messages: Array<Record<string, unknown>> = [];
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name,
    token: makeCapability("tag", "garden", "edit"),
    document: doc,
    awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime
    WebSocketPolyfill: TrackedWebSocket,
    onSynced: () => void (synced = true),
    onStateless: ({ payload }: { payload: string }) => {
      try {
        messages.push(JSON.parse(payload));
      } catch {
        /* not ours */
      }
    },
  });
  providers.push(provider);
  return { doc, provider, messages, synced: () => synced };
}
const close = (tab: Tab) => {
  tab.provider.destroy();
  providers.splice(providers.indexOf(tab.provider), 1);
};

async function connectMcp(email: string): Promise<Client> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip, "x-forwarded-for": ip, authorization: `Bearer ${issuePat({ email, vaultId: "primary", scope: "write" }).token}` };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const body = req.method === "POST" ? await req.text() : undefined;
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}
type Out = { ok: true; data: any } | { ok: false; error: string; message?: string };
async function call(cl: Client, name: string, args: Record<string, unknown>): Promise<Out> {
  const r: any = await cl.callTool({ name, arguments: args });
  if (r.isError) return { ok: false, error: r.structuredContent?.error ?? "protocol", message: r.structuredContent?.message };
  return { ok: true, data: r.structuredContent ?? JSON.parse(r.content[0].text) };
}
const ownerHeaders = () => ({ cookie: sessionCookie(makeSession(OWNER)), ...J, "x-prism-editor-schema": String(COLLAB_SCHEMA_VERSION), "sec-fetch-site": "same-origin" });


/** Run `fn` while a 10 ms timer measures the longest gap between its ticks (the event loop's worst stall). */
async function probed<T>(fn: () => Promise<T> | T): Promise<{ value?: T; error?: unknown; maxLagMs: number; ms: number }> {
  let last = performance.now();
  let maxLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  const start = performance.now();
  try {
    const value = await fn();
    return { value, maxLagMs: Math.max(maxLagMs, performance.now() - last - 10), ms: performance.now() - start };
  } catch (error) {
    return { error, maxLagMs: Math.max(maxLagMs, performance.now() - last - 10), ms: performance.now() - start };
  } finally {
    clearInterval(timer);
  }
}
const typeInto = (doc: Y.Doc, words: string): void => {
  const p = doc.getXmlFragment("default").get(0) as Y.XmlElement;
  const t = p.get(0) as Y.XmlText;
  t.insert(t.length, words);
};
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
/** Someone else writes the body through the vault (so the vault records what it replaced, like the real one). */
async function externalEdit(id: string, change: (content: string) => string): Promise<void> {
  const n = fv.notes.get(id)!;
  await vaultClient("primary").updateNote(id, { content: change(n.content), ifUpdatedAt: n.updatedAt! });
}
const lostAck = async (pass: () => Promise<Response>) => {
  await pass();
  return new Response("gateway timeout", { status: 504 });
};
const covers = (state: Uint8Array, base: Uint8Array): boolean => {
  const have = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state));
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(base))) if ((have.get(client) ?? 0) < clock) return false;
  return true;
};

// ── C1 ──────────────────────────────────────────────────────────────────────

const LOOP_BUDGET_MS = 200;
/** Every shape happy-dom turns into a pile of nodes (or chews on) that `<` + letter never counted. */
const SHAPES: Array<[string, (bytes: number) => string]> = [
  ["lone >", (n) => "<p>" + ">".repeat(n)],
  ["comments", (n) => "<p>" + "<!--a-->".repeat(n / 8)],
  ["self-closing tails />", (n) => "<p>" + "/>".repeat(n / 2)],
  ["comment ends -->", (n) => "<p>" + "-->".repeat(n / 3)],
  ["declarations <!x>", (n) => "<p>" + "<!x>".repeat(n / 4)],
  ["processing instructions <?x?>", (n) => "<p>" + "<?x?>".repeat(n / 5)],
  ["end tags", (n) => "<p>" + "</b>".repeat(n / 4)],
  ["unclosed tags", (n) => "<p>" + "<b ".repeat(n / 3)],
  ["stray <", (n) => "<p>" + "< ".repeat(n / 2)],
  ["entities", (n) => "<p>" + "&amp;".repeat(n / 5)],
  ["attributes", (n) => "<p " + "a=1 ".repeat(n / 4) + ">x</p>"],
  ["nested inline", (n) => "<p>" + "<b>".repeat(n / 7) + "x" + "</b>".repeat(n / 7)],
];

test("C1: the pre-check counts every piece the DOM parser makes — none of the uncounted shapes is 'cheap', and stored HTML has an inline byte cap", () => {
  const nodes = (precheck as unknown as { htmlNodeCount?: (html: string) => number }).htmlNodeCount;
  assert.ok(nodes, "htmlNodeCount exists");
  assert.ok(nodes!("<p>" + ">".repeat(1000)) >= 1000, "a lone > is a piece");
  assert.ok(nodes!("<!--a-->".repeat(1000)) >= 1000, "a comment is a piece");
  assert.ok(nodes!("</b>".repeat(1000)) >= 1000, "an end tag is a piece");
  assert.ok(nodes!("<?x?>".repeat(1000)) >= 1000 && nodes!("<!x>".repeat(1000)) >= 1000);
  for (const [label, make] of SHAPES) assert.equal(isCheapContent(make(100_000), false), false, `${label}: 100 KB must not convert on the main thread`);
  // Megabytes of text in two nodes used to be inline "by node count": no longer.
  assert.equal(isCheapContent(`<p>${"word ".repeat(20_000)}</p>`, false), false, "100 KB of stored HTML goes to the worker whatever it looks like");
  assert.equal(isCheapContent("<p>hello <strong>there</strong></p>", false), true);
});

test("C1: 100 KB of each shape — the event loop keeps turning (max lag, not duration)", { timeout: 240_000 }, async () => {
  restore.push(configureConversion({ timeoutMs: 1500, timeoutPerMbMs: 0, timeoutMaxMs: 1500, failureTtlMs: 0, ...({ breakerFailures: 0 } as object) }));
  await contentToSeed("<p>warm</p>"); // module + JIT warm-up is not what is measured
  for (const [label, make] of SHAPES) {
    const r = await probed(() => contentToSeed(make(100_000)));
    assert.ok(r.error === undefined || r.error instanceof ConversionError, `${label}: ${String(r.error)}`);
    assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `${label}: the event loop stalled ${r.maxLagMs.toFixed(0)} ms`);
  }
});

test("C1: whatever still converts inline is small — the largest 'cheap' input of every shape takes milliseconds", { timeout: 120_000 }, async () => {
  await contentToSeed("<p>warm</p>");
  for (const [label, make] of SHAPES) {
    // The largest input of this shape the pre-check still calls cheap (bisect on size).
    let lo = 8;
    let hi = 100_000;
    while (hi - lo > 64) {
      const mid = (lo + hi) >> 1;
      if (isCheapContent(make(mid), false)) lo = mid;
      else hi = mid;
    }
    const input = make(lo);
    assert.ok(input.length <= 24_100, `${label}: inline input is ${input.length} bytes`);
    const before = conversionStats.inline;
    const r = await probed(() => contentToSeed(input));
    assert.equal(conversionStats.inline, before + 1, `${label}: converted inline`);
    assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `${label}: ${input.length} bytes inline stalled the loop ${r.maxLagMs.toFixed(0)} ms`);
  }
});

test("C1: opening a live page whose stored HTML is 100 KB of lone > does not stall the server", { timeout: 120_000 }, async () => {
  fv.put({ id: "c1", tags: ["garden"], content: "<p>" + ">".repeat(100_000), updatedAt: T0 });
  await contentToSeed("<p>warm</p>");
  const r = await probed(() => loadDocumentState("c1", new Y.Doc()));
  assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `the event loop stalled ${r.maxLagMs.toFixed(0)} ms`);
});

// ── M4 ──────────────────────────────────────────────────────────────────────

test("M4: the worker heap ceiling is modest by default, and what is parsed at all follows it", () => {
  const cfg = service.convertCfg as unknown as Record<string, number>;
  assert.ok(cfg.heapMb! <= 512, `CONVERT_HEAP_MB defaults to ${cfg.heapMb}`);
  assert.ok(cfg.maxInputNodes! <= cfg.heapMb! * 100, "a body that could not be parsed inside the heap is refused up front");
  assert.ok(cfg.breakerFailures! > 0, "the circuit breaker is on by default");
});

test("M4: consecutive killed workers open a circuit breaker — no more respawns until a cool-down, then one trial", { timeout: 120_000 }, async () => {
  await stopConversionWorkers();
  restore.push(configureConversion({ threads: 1, timeoutMs: 250, timeoutPerMbMs: 0, timeoutMaxMs: 250, failureTtlMs: 0, ...({ breakerFailures: 3, breakerCooldownMs: 1200, breakerCooldownMaxMs: 5000 } as object) }));
  const bomb = (i: number) => "*a ".repeat(6000) + i; // marked is quadratic: seconds in the worker
  const reasons: string[] = [];
  for (let i = 0; i < 3; i++) reasons.push(await service.markdownToHtml(bomb(i)).then(() => "ok", (e) => (e as ConversionError).reason));
  assert.deepEqual(reasons, ["timeout", "timeout", "timeout"]);
  const spawned = conversionStats.worker;
  const start = performance.now();
  const fourth = await service.markdownToHtml(bomb(3)).then(() => "ok", (e) => (e as ConversionError).reason);
  assert.equal(fourth, "busy", "answered busy — says nothing about the input, callers retry later");
  assert.ok(performance.now() - start < 100, "at once");
  assert.equal(conversionStats.worker, spawned, "no thread was spawned for it");
  // After the cool-down ONE task is let through; a success closes the breaker.
  await new Promise((r) => setTimeout(r, 1300));
  restore.push(configureConversion({ timeoutMs: 20_000, timeoutMaxMs: 20_000, inlineMaxChars: 0, inlineMaxNodes: 0 }));
  assert.equal(await service.markdownToHtml("ok *then*"), "<p>ok <em>then</em></p>\n");
  assert.equal(await service.markdownToHtml("and again"), "<p>and again</p>\n");
  await stopConversionWorkers();
});

test("M4: a store that keeps failing is retried less and less often — capped, never every minute forever", () => {
  const delay = (collab as unknown as { storeRetryDelayMs?: (attempts: number, reason: string) => number }).storeRetryDelayMs;
  assert.ok(delay, "storeRetryDelayMs exists");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 30].map((n) => delay!(n, "timeout") / 1000), [3, 10, 30, 60, 120, 240, 480, 960, 1800, 1800, 1800]);
  assert.deepEqual([4, 5, 6, 7, 8, 30].map((n) => delay!(n, "vault 503") / 1000), [60, 120, 240, 300, 300, 300]);
});

// ── H1 ──────────────────────────────────────────────────────────────────────

for (const history of [true, false]) {
  const how = history ? "the note's history shows our write landed" : "no history: the base is the candidate the vault's copy differs least from";
  test(`H1: lost acknowledgement, then an external edit ON TOP of our landed write — merged against the write, nothing duplicated (${how})`, { timeout: 60_000 }, async () => {
    fv.historySupported = history;
    fv.put({ id: "h1", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
    const doc = await loadDocumentState("h1", new Y.Doc());
    type(doc, "edit one");
    await intercept(isPatch("h1"), lostAck, () => storeDocumentState("h1", doc));
    assert.equal(vaultContent("h1"), "<p>start</p><p>edit one</p>", "the write DID land");
    // Before any tick recognises that copy as ours, someone edits the note on top of it.
    await externalEdit("h1", (c) => c + "<p>EXTERNAL</p>");
    type(doc, "edit two");
    await reconcileLoadedDocs({ documents: new Map([["h1", doc]]) });
    // (EXTERNAL and "edit two" were both appended after "edit one": either order is a correct merge.)
    const once = (html: string) => ["start", "edit one", "EXTERNAL", "edit two"].map((w) => count(html, `<p>${w}</p>`));
    assert.deepEqual(once(yDocToHtml(doc)), [1, 1, 1, 1], yDocToHtml(doc));
    assert.equal(yDocToHtml(doc).length, "<p>start</p><p>edit one</p><p>EXTERNAL</p><p>edit two</p>".length, "…and nothing else");
    await storeDocumentState("h1", doc);
    assert.deepEqual(once(vaultContent("h1")), [1, 1, 1, 1], vaultContent("h1"));
    assert.equal(isCollabUnsaved("h1", "primary"), false);
  });

  test(`H1: the same inside ONE paragraph — characters typed before the lost acknowledgement are not doubled (${how})`, { timeout: 60_000 }, async () => {
    fv.historySupported = history;
    fv.put({ id: "h1p", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
    const doc = await loadDocumentState("h1p", new Y.Doc());
    typeInto(doc, " edit one");
    await intercept(isPatch("h1p"), lostAck, () => storeDocumentState("h1p", doc));
    assert.equal(vaultContent("h1p"), "<p>start edit one</p>");
    await externalEdit("h1p", (c) => c.replace("</p>", " EXTERNAL</p>"));
    // The same at the next LOAD (a restart: nothing in memory) and in the store's own guard.
    resetReconcileState();
    const reopened = await loadDocumentState("h1p", new Y.Doc());
    assert.equal(yDocToHtml(reopened), "<p>start edit one EXTERNAL</p>");
    await storeDocumentState("h1p", reopened);
    assert.equal(vaultContent("h1p"), "<p>start edit one EXTERNAL</p>");
  });

  test(`H1: a write that did NOT land, then an external edit — merged against the old base, the unsent typing survives exactly once (${how})`, { timeout: 60_000 }, async () => {
    fv.historySupported = history;
    fv.put({ id: "h1n", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
    const doc = await loadDocumentState("h1n", new Y.Doc());
    type(doc, "edit one");
    await intercept(isPatch("h1n"), fail(500), () => storeDocumentState("h1n", doc));
    assert.equal(vaultContent("h1n"), "<p>start</p>");
    await externalEdit("h1n", (c) => c + "<p>EXTERNAL</p>");
    await storeDocumentState("h1n", doc); // the store's own guard meets the external edit
    const html = vaultContent("h1n");
    assert.equal(count(html, "edit one"), 1, html);
    assert.equal(count(html, "EXTERNAL"), 1, html);
    assert.equal(count(html, "start"), 1, html);
  });
}

// ── M1 ──────────────────────────────────────────────────────────────────────

const header = (email: string) => ({ cookie: sessionCookie(makeSession(email)), ...J, "x-prism-editor-schema": String(COLLAB_SCHEMA_VERSION), "sec-fetch-site": "same-origin" });
/** A page whose live typing could not reach the vault (every store of it fails while `during` runs). */
async function withUnsaved(id: string, status: number, during: (attempts: () => number) => Promise<void>): Promise<void> {
  fv.put({ id, tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  let attempts = 0;
  const storeOfTyping = (method: string, path: string, body: string) => isPatch(id)(method, path) && body.includes("typed in the live editor");
  await intercept(storeOfTyping, async () => (attempts++, new Response(JSON.stringify({ error: "boom" }), { status, headers: J })), async () => {
    await typeAndLeave(id, "typed in the live editor");
    assert.equal(isCollabUnsaved(id, "primary"), true);
    await during(() => attempts);
  });
}

test("M1: a VIEWER's body write to a page with unsaved live changes loads and stores nothing — it gets the route's own refusal", { timeout: 60_000 }, async () => {
  await withUnsaved("m1", 500, async (attempts) => {
    const before = attempts();
    const gets = fv.calls.length;
    const res = await app.request("/api/notes/m1", { method: "PATCH", headers: header(VIEWER), body: JSON.stringify({ content: "<p>mine</p>", if_updated_at: T0 }) });
    assert.equal(res.status, 403, "the route's own answer for someone without edit");
    assert.equal(attempts(), before, "no store was set off on a viewer's behalf");
    assert.equal(hocuspocus.documents.has("m1"), false, "no document was loaded");
    assert.ok(fv.calls.length - gets <= 3, "only the reads that decide access");
    const restored = await app.request("/api/notes/m1/restore", { method: "POST", headers: header(VIEWER), body: JSON.stringify({ version_ix: 0, if_updated_at: T0 }) });
    assert.notEqual(restored.status, 409);
    assert.equal(attempts(), before);
    // An editor's write does give the snapshot its chance (and is refused while it cannot land).
    const editor = await app.request("/api/notes/m1", { method: "PATCH", headers: header(EDITOR), body: JSON.stringify({ content: "<p>mine</p>", if_updated_at: T0 }) });
    assert.equal(editor.status, 409);
    assert.equal(attempts(), before + 1);
  });
});

test("M1: settling is rate-limited per actor — past the limit the answer is the 409 with no further load + store", { timeout: 60_000 }, async () => {
  const was = process.env.UNSAVED_SETTLES_PER_MINUTE;
  process.env.UNSAVED_SETTLES_PER_MINUTE = "2";
  restore.push(() => void (process.env.UNSAVED_SETTLES_PER_MINUTE = was));
  ensureUser("limited@test.local");
  addGrant({ subject_type: "user", subject: "limited@test.local", resource_type: "tag", resource: "garden", level: "view", caps: ["view", "edit"] as never, created_by: "test", vault_id: "primary" });
  await withUnsaved("m1r", 500, async (attempts) => {
    const before = attempts();
    const write = () => app.request("/api/notes/m1r", { method: "PATCH", headers: header("limited@test.local"), body: JSON.stringify({ content: "<p>mine</p>", if_updated_at: T0 }) });
    assert.equal((await write()).status, 409);
    assert.equal((await write()).status, 409);
    assert.equal(attempts(), before + 2);
    const third = await write();
    assert.equal(third.status, 409);
    assert.ok(Number(third.headers.get("retry-after")) > 0, "says when to come back");
    assert.equal(attempts(), before + 2, "the third request set off no load + store");
  });
});

// ── M2 ──────────────────────────────────────────────────────────────────────

test("M2: a page that can NEVER be saved answers a NON-retry error (REST, restore, MCP) — and the owner can discard its unsaved changes", { timeout: 90_000 }, async () => {
  const agent = await connectMcp(OWNER);
  await withUnsaved("m2", 413, async () => {
    assert.equal(unsavedRow("m2")?.permanent, 1);
    const res = await app.request("/api/notes/m2", { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify({ content: "<p>rest</p>", if_updated_at: T0 }) });
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, "unsaved_permanent");
    assert.equal(body.retry, false, "not 'try again in a moment'");
    assert.equal(body.reason, "vault 413");
    const restored = await app.request("/api/notes/m2/restore", { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ version_ix: 0, if_updated_at: T0 }) });
    assert.equal(((await restored.json()) as Record<string, unknown>).error, "unsaved_permanent");

    const updated = await call(agent, "prism_update_note", { id: "m2", content: "<p>agent</p>", if_updated_at: T0 });
    assert.equal(updated.ok, false, JSON.stringify(updated));
    assert.match((updated as { message?: string }).message ?? "", /not retry|will not help/i, "the agent is told waiting will not help");
    assert.doesNotMatch((updated as { message?: string }).message ?? "", /wait a few seconds/);
    const restoredByAgent = await call(agent, "prism_restore_version", { id: "m2", version_ix: 0, if_updated_at: T0 });
    assert.match((restoredByAgent as { message?: string }).message ?? "", /not retry|will not help/i);
  });
  assert.equal(vaultContent("m2"), "<p>start</p>");

  // The way out: owner only, CSRF-guarded, explicit, audited.
  const discard = (headers: Record<string, string>, body: unknown = { confirm: true }) => app.request("/api/admin/collab/unsaved/m2/discard", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await discard(header(EDITOR))).status, 403, "not for an editor");
  assert.equal((await discard({ ...ownerHeaders(), "content-type": "text/plain" })).status, 415, "CSRF: JSON only");
  assert.equal((await discard({ ...ownerHeaders(), "sec-fetch-site": "cross-site" })).status, 403, "CSRF: same origin only");
  assert.equal((await discard(ownerHeaders(), {})).status, 400, "an explicit confirm");
  assert.equal(unsavedRow("m2")?.permanent, 1, "nothing was discarded by the refused requests");
  const listed = (await (await app.request("/api/admin/collab/unsaved", { headers: ownerHeaders() })).json()) as { rows: Array<{ noteId: string; permanent: boolean }> };
  assert.deepEqual(listed.rows.map((r) => [r.noteId, r.permanent]), [["m2", true]]);
  const ok = await discard(ownerHeaders());
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(unsavedRow("m2"), null);
  assert.equal(getDocState("m2")!.ahead, false, "the snapshot is the stored page again (kept, not deleted: same Yjs history)");
  const reopened = await loadDocumentState("m2", new Y.Doc());
  assert.equal(yDocToHtml(reopened), "<p>start</p>");
  const audit = db.prepare("SELECT action, status, target FROM action_audit WHERE action = 'admin.collab-discard-unsaved' AND status = 'ok'").all() as Array<{ target: string }>;
  assert.equal(audit.length, 1);
  assert.doesNotMatch(audit[0]!.target, /m2|start|typed/, "counts only");
  // …and the page takes body writes again.
  const now = await app.request("/api/notes/m2", { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify({ content: "<p>rest</p>", if_updated_at: T0 }) });
  assert.equal(now.status, 200);
  assert.equal(vaultContent("m2"), "<p>rest</p>");
  assert.equal((await discard(ownerHeaders())).status, 404, "nothing left to discard");
});

// ── M3 ──────────────────────────────────────────────────────────────────────

test("M3: a store whose render was overtaken by a fold never saves its older snapshot over the row — every write is sent from a consistent row", { timeout: 120_000 }, async () => {
  // Big enough that the store's render runs in the worker (awaited), small external body (folded at once).
  fv.put({ id: "m3", tags: ["garden"], content: "<p>x</p>".repeat(3200), updatedAt: T0 });
  const doc = await loadDocumentState("m3", new Y.Doc());
  type(doc, "typed");
  await stopConversionWorkers(); // the store's render waits for a thread: plenty of time for the fold
  const consistent: boolean[] = [];
  const direct = (dbm as unknown as { saveDocAttempt: (...a: unknown[]) => unknown }).saveDocAttempt;
  await intercept(
    isPatch("m3"),
    async (pass) => {
      const row = getDocState("m3")!;
      consistent.push(!row.base || covers(row.state, row.base));
      return pass();
    },
    async () => {
      const worker = conversionStats.worker;
      const storing = storeDocumentState("m3", doc);
      await until("the store is rendering", () => conversionStats.worker > worker);
      vaultWrite("m3", LATER(1), { content: "<p>EXTERNAL</p>" });
      await reconcileLoadedDocs({ documents: new Map([["m3", doc]]) });
      assert.equal(getDocState("m3")!.sourceUpdatedAt, Date.parse(LATER(1)), "the fold moved the row to the external version");
      await storing;
    },
  );
  assert.ok(consistent.length >= 1, "the store wrote");
  assert.deepEqual(consistent.filter((c) => !c), [], "no write was sent from a row whose state lacks its own base");
  assert.match(vaultContent("m3"), /EXTERNAL/);
  assert.match(vaultContent("m3"), /typed/);
  const row = getDocState("m3")!;
  assert.equal(row.ahead, false);
  // The row-level rule itself: a snapshot taken at another version is refused.
  assert.equal(direct("m3", Y.encodeStateAsUpdate(new Y.Doc()), "h", "primary", 1), false);
  assert.deepEqual(getDocState("m3")!.attempts, [], "nothing was recorded for the refused snapshot");
});

// ── L1 ──────────────────────────────────────────────────────────────────────

test("L1: the 'changes made elsewhere replaced part of this page' notice goes to whoever opens the page NOW — not to every later socket", { timeout: 60_000 }, async () => {
  const tuning = (collab as unknown as { collabTuning?: { noticeTtlMs: number } }).collabTuning ?? { noticeTtlMs: 0 };
  const ttl = tuning.noticeTtlMs;
  tuning.noticeTtlMs = 400;
  restore.push(() => void (tuning.noticeTtlMs = ttl));
  // A snapshot that is ahead of a base nobody kept (a row from before bases existed) + an external edit.
  fv.put({ id: "l1", tags: ["garden"], content: "<p>written elsewhere</p>", updatedAt: T0 });
  const old = new Y.Doc();
  type(old, "never saved");
  saveDocAhead("l1", Y.encodeStateAsUpdate(old), "primary");
  const notices = (tab: Tab) => tab.messages.filter((m) => m.type === "prism:notice").length;
  const first = open("l1");
  await until("first tab synced", () => first.synced());
  await until("the first tab is told", () => notices(first) === 1);
  await new Promise((r) => setTimeout(r, 600));
  const second = open("l1");
  await until("second tab synced", () => second.synced());
  await until("the second tab got its state message", () => second.messages.some((m) => m.type === "prism:unsaved"));
  assert.equal(notices(second), 0, "someone who joins later is not told about a replacement they never saw");
  close(first);
  close(second);
});

// ── L2 ──────────────────────────────────────────────────────────────────────

test("L2: a snapshot loaded while the note could not be READ is still written once the vault answers — without anyone typing", { timeout: 60_000 }, async () => {
  fv.put({ id: "l2", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  await intercept(isPatch("l2"), fail(500), () => typeAndLeave("l2", "kept while the vault was down"));
  assert.equal(isCollabUnsaved("l2", "primary"), true);
  // The page is opened while the vault cannot be read at all…
  const conn = await intercept(isGet("l2"), fail(500), () => hocuspocus.openDirectConnection("l2", {}));
  assert.match(text(live("l2")!), /kept while the vault was down/, "the snapshot opened");
  // …and stays open, idle. The vault is back: the page must reach it on its own.
  await until("the unsaved changes reach the vault", () => /kept while the vault was down/.test(vaultContent("l2")), 12_000);
  assert.equal(isCollabUnsaved("l2", "primary"), false);
  await conn.disconnect();
});

// ── L6 ──────────────────────────────────────────────────────────────────────

test("L6: a block move answered 503 `not_confirmed` AFTER the blocks entered the live document — the retry does not append a second copy", { timeout: 60_000 }, async () => {
  fv.put({ id: "l6", tags: ["garden"], content: "<p>alpha</p>", updatedAt: T0 });
  const BLOCK = "<blockquote><p>Echo quote</p></blockquote>";
  const move = () => app.request("/api/notes/l6/blocks/append", { method: "POST", headers: header(EDITOR), body: JSON.stringify({ html: BLOCK, requestId: "req-00000001" }) });
  // The page is open (someone is on it), and the note "disappears" for the store that follows the append.
  const holder = await hocuspocus.openDirectConnection("l6", {});
  const first = await intercept(isPatch("l6"), fail(404), async () => move());
  assert.equal(first.status, 503, await first.clone().text());
  assert.equal(((await first.json()) as Record<string, unknown>).error, "not_confirmed");
  assert.equal(count(text(live("l6")!), "Echo quote"), 1, "the blocks DID enter the live document");
  // The client does what it was told: the same request again.
  const second = await move();
  assert.equal(count(text(live("l6")!), "Echo quote"), 1, "not appended a second time");
  assert.equal(second.status, 200, await second.clone().text());
  await holder.disconnect();
  await until("l6 unloads", () => !hocuspocus.documents.has("l6"));
  assert.equal(count(vaultContent("l6"), "Echo quote"), 1, vaultContent("l6"));
  const third = await move();
  assert.equal(third.status, 200);
  assert.equal(count(vaultContent("l6"), "Echo quote"), 1);
});

// ── L7 (server half) ────────────────────────────────────────────────────────

test("L7: a tab on a page whose changes are NOT in the vault yet is told so (pending, not saved) — and told when they are", { timeout: 60_000 }, async () => {
  fv.put({ id: "l7", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  let tab: Tab | undefined;
  await intercept(isPatch("l7"), fail(503), async () => {
    await typeAndLeave("l7", "not in the vault yet");
    tab = open("l7");
    await until("synced", () => tab!.synced());
    await until("the tab is told the page is not saved yet", () => tab!.messages.some((m) => m.type === "prism:unsaved" && m.state === "pending"));
    assert.equal(tab!.messages.some((m) => m.type === "prism:unsaved" && m.state === "unsaved"), false, "not the permanent 'cannot be saved' state");
  });
  await until("…and told once it is", () => tab!.messages.at(-1)?.type === "prism:unsaved" && tab!.messages.at(-1)?.state === "saved", 15_000);
  assert.match(vaultContent("l7"), /not in the vault yet/);
  close(tab!);
});
