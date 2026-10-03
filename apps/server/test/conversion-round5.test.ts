/**
 * Fourth independent review of the conversion change (round 5). Each test was
 * run against the code WITHOUT its fix first and failed there.
 *
 *  C-1  A few KB of Markdown TABLE became a million cells on the main thread (the
 *       pre-check never counted `|`); other multiplicative / uncounted shapes;
 *       `docJsonToHtml` rendered any amount of text inline.
 *  H-1  The shared circuit breaker let one member's timeouts deny conversion to
 *       everyone.
 *  H-2  Store failures spilled from the reserved thread onto the open lane's.
 *  M-1  `prism_update_note` settled (load + store) without edit / the bucket.
 *  M-2  `settleUnsaved` loaded + stored a PERMANENT row on every body write.
 *  M-3/4 An uncertain merge base could double in-paragraph typing or delete
 *       unlanded typing; `code` had no guard.
 *  M-5  Discard: only permanent rows (or force), a notice, serialised with stores.
 *  M-6  History lookups had no timeout and blocked the reconciler's other documents.
 *  Lows the admin list's LIMIT ran before the vault filter.
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


// ── C-1 ─────────────────────────────────────────────────────────────────────

const LOOP_BUDGET_MS = 200;
/** `marked` pads every body row to the header's width: ~4C + 2R characters, C × R cells. */
const table = (cols: number, rows: number, pipe = "|") => pipe + ("a" + pipe).repeat(cols) + "\n|" + "-|".repeat(cols) + "\n" + "x\n".repeat(rows);
const lines = (n: number, line: (i: number) => string): string => {
  let out = "";
  for (let i = 0; out.length < n; i++) out += line(i);
  return out;
};
/** Markdown shapes that are multiplicative, recursive or simply not what the old counters counted. `n` = bytes aimed for. */
const MD_SHAPES: Array<[string, (n: number) => string]> = [
  ["table (C × R cells)", (n) => table(Math.ceil(n / 6), Math.ceil(n / 6))],
  ["table, no leading pipe", (n) => "a|".repeat(n / 6) + "\n" + "-|".repeat(n / 6) + "\n" + "x\n".repeat(n / 6)],
  ["table, escaped-backslash pipes", (n) => "|" + "a\\\\|".repeat(n / 10) + "\n|" + "-|".repeat(n / 10) + "\n" + "x\n".repeat(n / 6)],
  ["table, wide rows", (n) => lines(n, () => "|a|b|c|d|\n").replace("\n", "\n|-|-|-|-|\n")],
  ["table inside a blockquote", (n) => "> |" + "a|".repeat(n / 8) + "\n> |" + "-|".repeat(n / 8) + "\n" + "> x\n".repeat(n / 16)],
  ["raw HTML block of lone >", (n) => "<div>\n" + ">".repeat(n)],
  ["raw HTML block of &", (n) => "<div>\n" + "&".repeat(n)],
  ["raw HTML block of entities", (n) => "<div>\n" + "&amp;".repeat(n / 5)],
  ["raw HTML, boolean attributes", (n) => "<div " + "a ".repeat(n / 2) + ">x</div>"],
  ["raw HTML, attributes", (n) => "<div " + "a=1 ".repeat(n / 4) + ">x</div>"],
  ["raw HTML comment tails", (n) => "<div>\n" + "-->".repeat(n / 3)],
  ["< flood", (n) => "<".repeat(n)],
  ["a < b", (n) => "a < b ".repeat(n / 6)],
  ["unclosed tags", (n) => "<a ".repeat(n / 3)],
  ["nested lists on one line", (n) => "- ".repeat(n / 2) + "x"],
  ["nested ordered lists on one line", (n) => "1. ".repeat(n / 3) + "x"],
  ["nested mixed containers on one line", (n) => "> - 1. ".repeat(n / 7) + "x"],
  ["nested blockquotes on one line", (n) => "> ".repeat(n / 2) + "x"],
  ["nested lists by indentation", (n) => lines(n, (i) => "  ".repeat(i) + "- x\n")],
  ["nested emphasis", (n) => "*_".repeat(n / 4) + "x" + "_*".repeat(n / 4)],
  ["one long * run", (n) => "a " + "*".repeat(n) + " b"],
  ["one long _ run", (n) => "a" + "_".repeat(n) + "b"],
  ["one long ~ run", (n) => "a " + "~".repeat(n) + " b"],
  ["unmatched emphasis", (n) => "*a ".repeat(n / 3)],
  ["link reference definitions", (n) => lines(n / 2, (i) => `[r${i}]: http://x.test/${i}\n`) + "\n" + lines(n / 2, (i) => `[r${i}] `)],
  ["one long backtick run", (n) => "a " + "`".repeat(n) + " b"],
  ["unmatched backticks", (n) => "`a ".repeat(n / 3)],
  ["backtick runs of growing length", (n) => lines(n, (i) => "`".repeat((i % 40) + 1) + "a ")],
  ["[ flood", (n) => "[".repeat(n)],
  ["] flood", (n) => "]".repeat(n)],
  ["footnote-like [^1]", (n) => "[^1]".repeat(n / 4)],
  ["empty links []", (n) => "[]".repeat(n / 2)],
  ["image openers ![", (n) => "![".repeat(n / 2)],
  ["link openers [a](", (n) => "[a](".repeat(n / 4)],
  ["( flood after a link", (n) => "[a](" + "(".repeat(n)],
  ["delimiter soup on one line", (n) => "*_~`[]()!<>&|\\".repeat(n / 14)],
  ["hard-wrapped delimiters, one line", (n) => "**a**_b_~~c~~`d`".repeat(n / 16)],
  ["bare autolinks", (n) => "www.a.b ".repeat(n / 8)],
  ["scheme autolinks", (n) => "http://a.b ".repeat(n / 11)],
  ["e-mail autolinks", (n) => "a@b.cd ".repeat(n / 7)],
  ["backslashes", (n) => "\\".repeat(n)],
  ["# flood", (n) => "#".repeat(n)],
  ["trailing blanks", (n) => "a" + " ".repeat(n) + "\nb"],
  ["blank lines of spaces", (n) => lines(n, () => "    \n")],
  ["tabs", (n) => "\t".repeat(n) + "x"],
  ["setext underlines", (n) => "a\n===\n".repeat(n / 6)],
];
/** Stored-HTML shapes the round-4 counter did not know. */
const HTML_SHAPES: Array<[string, (n: number) => string]> = [
  ["boolean attributes", (n) => "<p " + "a ".repeat(n / 2) + ">x</p>"],
  ["quoted attributes", (n) => "<p " + 'a="1" '.repeat(n / 6) + ">x</p>"],
  ["one attribute, = flood", (n) => "<p a" + "=".repeat(n) + ">x</p>"],
  ["table cells", (n) => "<table><tbody><tr>" + "<td><p>x</p></td>".repeat(n / 17) + "</tr></tbody></table>"],
];

test("C-1: a Markdown table's CELLS are counted (columns × rows), not its bytes — 6 KB of it is neither cheap nor attempted", async () => {
  const bomb = table(1000, 1000);
  assert.ok(bomb.length < 6200, `${bomb.length} bytes`);
  assert.ok(precheck.complexityOf(bomb, true).nodes >= 1_000_000, `counted ${precheck.complexityOf(bomb, true).nodes} nodes`);
  assert.equal(isCheapContent(bomb, true), false, "never on the main thread");
  assert.equal(service.conversionRefusal(bomb, true), "too_many_nodes", "refused up front, by name");
  // A few hundred bytes are already thousands of cells.
  assert.equal(isCheapContent(table(60, 60), true), false, `${table(60, 60).length} bytes = 3,600 cells`);
  // …in every spelling of a table.
  assert.equal(isCheapContent("a|".repeat(60) + "\n" + "-|".repeat(60) + "\n" + "x\n".repeat(60), true), false, "no leading pipe");
  assert.equal(isCheapContent("|" + "a\\\\|".repeat(60) + "\n|" + "-|".repeat(60) + "\n" + "x\n".repeat(60), true), false, "\\\\| is a cell boundary");
  assert.equal(isCheapContent("> |" + "a|".repeat(60) + "\n> |" + "-|".repeat(60) + "\n" + "> x\n".repeat(60), true), false, "inside a blockquote");
  // An ordinary table, and pipes that are no table (no delimiter row), stay cheap.
  assert.equal(isCheapContent("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n", true), true);
  assert.equal(isCheapContent("x | y\n".repeat(100), true), true, "pipes in prose are text");
  assert.ok(precheck.complexityOf("x | y\n".repeat(20_000), true).nodes < 25_000, "…however long the block (a chat log is not a table)");
  // The worker path refuses it too: nothing is spawned, nothing converted.
  const before = { ...conversionStats };
  await assert.rejects(contentToSeed(bomb), (e) => e instanceof ConversionError && e.reason === "too_many_nodes");
  await assert.rejects(service.markdownToHtml(bomb), (e) => e instanceof ConversionError && e.reason === "too_many_nodes");
  assert.equal(conversionStats.worker, before.worker, "not handed to a worker");
  assert.equal(conversionStats.inline, before.inline, "not converted inline");
  // …and a table inside the worker's budget goes to the worker, not the event loop.
  assert.equal(service.conversionRefusal(table(150, 150), true), null);
});

/** Shapes that are only bulk (blanks): harmless at any size the byte cap admits — measured below, not refused. */
const INERT = new Set(["trailing blanks", "blank lines of spaces", "tabs"]);

test("C-1: none of the audited Markdown / HTML shapes is 'cheap' at 12 KB, 24 KB or 100 KB", () => {
  const cheapOnes: string[] = [];
  for (const size of [12_000, 24_000, 100_000]) {
    for (const [label, make] of MD_SHAPES) if (!(INERT.has(label) && size < 100_000) && isCheapContent(make(size).slice(0, size), true)) cheapOnes.push(`Markdown, ${label}, ${size} B`);
    for (const [label, make] of HTML_SHAPES) if (isCheapContent(make(size), false)) cheapOnes.push(`HTML, ${label}, ${size} B`);
  }
  assert.deepEqual(cheapOnes, [], "these would convert on the main thread");
  // What people actually write stays inline.
  assert.equal(isCheapContent("# Title\n\nSome *prose* with a [link](http://x.test) and `code`.\n\n- one\n- two\n  - nested\n\n> quoted\n\n1. first\n2. second\n", true), true);
  assert.equal(isCheapContent("----------------------------------------------------------------------------------------------------\n\ntext\n", true), true, "a long rule is not nesting");
  assert.equal(isCheapContent('<p class="x" data-a="1">hello <strong>there</strong></p>', false), true);
});

test("C-1: whatever still converts inline is small — the LARGEST 'cheap' input of every audited shape keeps the event loop turning", { timeout: 300_000 }, async () => {
  await contentToSeed("<p>warm</p>"); // module + JIT warm-up is not what is measured
  await contentToSeed("warm *up*");
  const worst: Array<[string, number, number]> = [];
  for (const [kind, shapes, markdown] of [["Markdown", MD_SHAPES, true], ["HTML", HTML_SHAPES, false]] as const) {
    for (const [label, make] of shapes) {
      // The largest input of this shape the pre-check still calls cheap (bisect on size).
      let lo = 8;
      let hi = 100_000;
      if (!isCheapContent(make(lo), markdown)) continue; // not inline at any size
      while (hi - lo > 32) {
        const mid = (lo + hi) >> 1;
        if (isCheapContent(make(mid), markdown)) lo = mid;
        else hi = mid;
      }
      const input = make(lo);
      assert.ok(input.length <= 24_100, `${kind}, ${label}: inline input is ${input.length} bytes`);
      const before = conversionStats.inline;
      const r = await probed(() => contentToSeed(input));
      assert.ok(r.error === undefined || r.error instanceof ConversionError, `${kind}, ${label}: ${String(r.error)}`);
      assert.equal(conversionStats.inline, before + 1, `${kind}, ${label}: converted inline`);
      worst.push([`${kind}, ${label} (${input.length} B)`, Math.round(r.maxLagMs), Math.round(r.ms)]);
      assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `${kind}, ${label}: ${input.length} bytes inline stalled the loop ${r.maxLagMs.toFixed(0)} ms`);
    }
  }
  worst.sort((a, b) => b[1] - a[1]);
  console.log("C-1 inline worst cases (lag ms, total ms):", JSON.stringify(worst.slice(0, 8)));
});

test("C-1: opening a note whose body is the 6 KB table answers at once — no live document, no stall", { timeout: 60_000 }, async () => {
  fv.put({ id: "c1t", tags: ["garden"], content: table(1000, 1000), updatedAt: T0 });
  assert.equal(isCheapContent(table(1000, 1000), true), false); // (guards the line below on a build without the fix)
  const r = await probed(() => loadDocumentState("c1t", new Y.Doc()));
  assert.ok(r.error instanceof collab.DocumentTooComplexError, String(r.error));
  assert.ok(r.maxLagMs < LOOP_BUDGET_MS, `the event loop stalled ${r.maxLagMs.toFixed(0)} ms`);
  assert.equal(getDocState("c1t"), null, "nothing derived from the body was stored");
});

test("C-1: rendering a document is inline only when it is SMALL — megabytes of text in one paragraph (or one attribute) go to the worker", { timeout: 120_000 }, async () => {
  const para = (text: string, marks?: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text, ...(marks ? { marks } : {}) }] }] });
  const weigh = precheck.docJsonWeight;
  assert.ok(weigh(para("x", [{ type: "link", attrs: { href: "h".repeat(50_000) } }])).chars >= 50_000, "attribute strings are part of a document's size");
  for (const [label, doc] of [
    ["100 KB of text in one paragraph", para("word ".repeat(20_000))],
    ["a 100 KB link target", para("x", [{ type: "link", attrs: { href: "http://x.test/" + "a".repeat(100_000) } }])],
  ] as const) {
    assert.throws(() => service.docJsonToHtmlBounded(doc), (e) => e instanceof ConversionError && e.reason === "too_large", `${label}: the synchronous form refuses it`);
    const before = { ...conversionStats };
    const html = await service.docJsonToHtml(doc);
    assert.equal(conversionStats.inline, before.inline, `${label}: not rendered on the main thread`);
    assert.equal(conversionStats.worker, before.worker + 1, `${label}: rendered in the worker`);
    assert.ok(html.startsWith("<p>") && html.length > 100_000);
  }
  const before = conversionStats.inline;
  assert.equal(await service.docJsonToHtml(para("small")), "<p>small</p>");
  assert.equal(conversionStats.inline, before + 1);
});

// ── H-1 / H-2 ───────────────────────────────────────────────────────────────

const reasonOf = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e) => (e instanceof ConversionError ? e.reason : `threw ${String(e)}`));
/** Ordinary content that is not "tiny": converted in the worker. */
const prose = (tag: string) => `${tag} ` + "word ".repeat(6000);
/** A document whose render goes to the worker (text beyond the inline byte cap). */
const bigDoc = (tag: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${tag} ` + "word ".repeat(6000) }] }] });
type Extra = Partial<service.ConvertConfig> & Record<string, number>;

test("H-1: one member's timeouts never deny conversion to anyone else — the shared breaker counts only DEAD workers; timeouts cool down that actor alone", { timeout: 120_000 }, async () => {
  await stopConversionWorkers();
  restore.push(configureConversion({ timeoutMs: 250, timeoutPerMbMs: 0, timeoutMaxMs: 250, failureTtlMs: 0, breakerFailures: 3, breakerCooldownMs: 30_000, actorBreakerFailures: 3, actorCooldownMs: 1500, actorCooldownMaxMs: 6000 } as Extra));
  const bomb = (i: number) => "*a ".repeat(6000) + i; // marked is quadratic: seconds in the worker — distinct content each time
  const mallory = { actor: "user:mallory" };
  const opened = conversionStats.breakerOpened;
  const reasons: string[] = [];
  for (let i = 0; i < 4; i++) reasons.push(await reasonOf(service.markdownToHtml(bomb(i), mallory)));
  assert.deepEqual(reasons, ["timeout", "timeout", "timeout", "busy"], "three timeouts, then this actor is told to come back later");
  // Everybody else converts as if nothing had happened.
  restore.push(configureConversion({ timeoutMs: 20_000, timeoutMaxMs: 20_000 }));
  assert.match(await service.markdownToHtml(prose("alice"), { actor: "user:alice" }), /^<p>alice word/, "another member's open");
  assert.match(await service.markdownToHtml(prose("server")), /^<p>server word/, "a server-side conversion (no actor)");
  assert.equal(await reasonOf(service.docJsonToHtml(bigDoc("store"), { lane: "store" })), "ok", "a store");
  assert.equal(conversionStats.breakerOpened, opened, "the shared breaker never opened");
  // The actor itself is refused without a thread being used — even for good content — until the cool-down is over.
  const used = conversionStats.worker;
  assert.equal(await reasonOf(service.markdownToHtml(prose("mallory"), mallory)), "busy");
  assert.equal(conversionStats.worker, used, "no worker was handed the penalised actor's task");
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(await reasonOf(service.markdownToHtml(prose("mallory again"), mallory)), "ok", "one trial after the cool-down; a success ends the penalty");
  assert.equal(await reasonOf(service.markdownToHtml(prose("mallory once more"), mallory)), "ok");
  await stopConversionWorkers();
});

test("H-1: tasks already queued when the breaker opens are answered busy — they neither respawn a thread nor double the cool-down", { timeout: 120_000 }, async () => {
  await stopConversionWorkers();
  // A 4 MB heap ceiling: the thread dies while it loads (out of memory) — `worker_failed`, the breaker's business.
  restore.push(configureConversion({ threads: 1, heapMb: 4, failureTtlMs: 0, breakerFailures: 2, breakerCooldownMs: 1500, breakerCooldownMaxMs: 60_000 } as Extra));
  restore.push(() => void stopConversionWorkers());
  const opened = conversionStats.breakerOpened;
  const all = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => reasonOf(service.markdownToHtml(prose(`q${i}`)))));
  assert.deepEqual(all, ["failed", "failed", "busy", "busy", "busy", "busy"], "two dead workers open the breaker; what was queued behind them is not run");
  assert.equal(conversionStats.breakerOpened - opened, 1, "opened ONCE — the queued tasks did not each double the cool-down");
  // The cool-down is still the first one (1.5 s): after it exactly one trial is let through.
  const used = conversionStats.worker;
  assert.equal(await reasonOf(service.markdownToHtml(prose("early"))), "busy");
  assert.equal(conversionStats.worker, used);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(await reasonOf(service.markdownToHtml(prose("trial"))), "failed", "the trial ran (and the thread is still dead)");
  assert.equal(conversionStats.worker, used + 1);
  assert.equal(conversionStats.breakerOpened - opened, 2, "a failed TRIAL re-opens it");
});

test("H-2: stores stay on their reserved thread — a store lane that keeps dying never trips the thread opens use; a store answered busy is retried without loss", { timeout: 120_000 }, async () => {
  await stopConversionWorkers();
  restore.push(configureConversion({ threads: 2, heapMb: 4, failureTtlMs: 0, breakerFailures: 2, breakerCooldownMs: 60_000, breakerCooldownMaxMs: 60_000 } as Extra));
  restore.push(() => void stopConversionWorkers());
  const tuning = collab.collabTuning as { noticeTtlMs: number; busyWaitMs?: number };
  const waitWas = tuning.busyWaitMs;
  tuning.busyWaitMs = 20;
  restore.push(() => void (tuning.busyWaitMs = waitWas));
  const store = (tag: string) => reasonOf(service.docJsonToHtml(bigDoc(tag), { lane: "store" }));
  assert.deepEqual([await store("a"), await store("b")], ["failed", "failed"], "the store thread dies twice: its breaker opens");
  const used = conversionStats.worker;
  assert.deepEqual([await store("c"), await store("d"), await store("e")], ["busy", "busy", "busy"], "further stores wait — they do NOT move to the other thread");
  assert.equal(conversionStats.worker, used, "no thread was used for them");
  // The thread that serves opens was never touched by stores: an open is still ATTEMPTED (not refused by a breaker).
  const refused = conversionStats.breakerRefused;
  assert.equal(await reasonOf(service.markdownToHtml(prose("open"))), "failed", "attempted (this test's threads cannot come up at all)");
  assert.equal(conversionStats.breakerRefused, refused, "not refused by a breaker");
  assert.equal(conversionStats.worker, used + 1);

  // A live page stored while its lane answers busy: nothing reaches the vault, nothing is lost, and it is written later.
  fv.put({ id: "h2", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h2", new Y.Doc());
  type(doc, "typed while the store lane was down " + "word ".repeat(6000));
  await storeDocumentState("h2", doc);
  assert.equal(vaultContent("h2"), "<p>start</p>");
  assert.equal(unsavedRow("h2")?.permanent, 0, "recorded as not saved YET (retried), not as unsaveable");
  assert.equal(unsavedRow("h2")?.reason, "busy");
  assert.equal(getDocState("h2")!.ahead, true, "the typing is in the server's document store");
  // The lane heals (a deploy with a sane heap; the breaker's cool-down is over).
  await stopConversionWorkers();
  restore.push(configureConversion({ heapMb: 512 }));
  await storeDocumentState("h2", doc);
  assert.match(vaultContent("h2"), /typed while the store lane was down/);
  assert.equal(unsavedRow("h2"), null);
  assert.equal(getDocState("h2")!.ahead, false);
});

// ── M-1 / M-2 / lows ────────────────────────────────────────────────────────

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

test("M-1: prism_update_note sets off a load + store only for someone who may EDIT this note, and within the per-actor settle bucket", { timeout: 90_000 }, async () => {
  const was = process.env.UNSAVED_SETTLES_PER_MINUTE;
  process.env.UNSAVED_SETTLES_PER_MINUTE = "2";
  restore.push(() => void (process.env.UNSAVED_SETTLES_PER_MINUTE = was));
  // Passes the tool's "edit somewhere" gate and may VIEW the page — but cannot edit it.
  const HALF = "half@test.local";
  ensureUser(HALF);
  addGrant({ subject_type: "user", subject: HALF, resource_type: "tag", resource: "garden", level: "view", caps: ["view"] as never, created_by: "test", vault_id: "primary" });
  addGrant({ subject_type: "user", subject: HALF, resource_type: "tag", resource: "elsewhere", level: "edit", caps: ["view", "edit"] as never, created_by: "test", vault_id: "primary" });
  const viewer = await connectMcp(HALF);
  const editor = await connectMcp(EDITOR);
  await withUnsaved("m1", 500, async (attempts) => {
    const before = attempts();
    const refused = await call(viewer, "prism_update_note", { id: "m1", content: "<p>mine</p>", if_updated_at: T0 });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(attempts(), before, "no store was set off for someone who cannot edit this note");
    assert.equal(hocuspocus.documents.has("m1"), false, "no document was loaded");
    assert.doesNotMatch(JSON.stringify(refused), /live|saved/i, "…and nothing about the page's unsaved state is said to them");
    // An editor's write gives the snapshot its chance — twice (the bucket), then no more.
    for (let i = 0; i < 2; i++) {
      // (Merged into the live document, which is given its chance to be written — and still cannot be.)
      await call(editor, "prism_update_note", { id: "m1", content: `<p>start</p><p>typed in the live editor</p><p>mine ${i}</p>`, if_updated_at: T0 });
      await until("m1 unloads", () => !hocuspocus.documents.has("m1"));
    }
    const spent = attempts();
    assert.ok(spent > before, "the editor's calls did try to save the page");
    const third = await call(editor, "prism_update_note", { id: "m1", content: "<p>mine</p>", if_updated_at: T0 });
    assert.equal(third.ok, false);
    assert.equal((third as { error: string }).error, "conflict");
    assert.match((third as { message?: string }).message ?? "", /still being saved|try again|wait/i);
    assert.equal(attempts(), spent, "past the bucket: answered without another load + store");
    assert.equal(hocuspocus.documents.has("m1"), false, "past the bucket: nothing loaded");
    // One bucket for REST and MCP: the editor's REST write is past it too.
    const rest = await app.request("/api/notes/m1", { method: "PATCH", headers: header(EDITOR), body: JSON.stringify({ content: "<p>mine</p>", if_updated_at: T0 }) });
    assert.equal(rest.status, 409);
    assert.ok(Number(rest.headers.get("retry-after")) > 0);
    assert.equal(attempts(), spent);
  });
});

test("M-2: a body write to a page that can NEVER be saved is answered `permanent` at once — nothing is loaded, read or stored", { timeout: 60_000 }, async () => {
  await withUnsaved("m2", 413, async (attempts) => {
    assert.equal(unsavedRow("m2")?.permanent, 1);
    await until("m2 unloads", () => !hocuspocus.documents.has("m2"));
    const before = attempts();
    const calls = fv.calls.length;
    assert.equal(await collab.settleUnsaved("primary", "m2"), "permanent");
    assert.equal(fv.calls.length, calls, "no vault call");
    assert.equal(attempts(), before, "no store");
    assert.equal(hocuspocus.documents.has("m2"), false, "no load");
    const res = await app.request("/api/notes/m2", { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify({ content: "<p>rest</p>", if_updated_at: T0 }) });
    assert.equal(((await res.json()) as Record<string, unknown>).error, "unsaved_permanent");
    assert.equal(attempts(), before);
  });
});

test("low: the owner's unsaved list filters by vault BEFORE its row limit", async () => {
  const mark = dbm.markCollabUnsaved;
  for (let i = 0; i < 230; i++) mark(`other-${i}`, "elsewhere", `elsewhere/other-${i}`, "busy", false);
  await new Promise((r) => setTimeout(r, 5));
  mark("mine", "primary", "mine", "busy", false);
  const listed = (await (await app.request("/api/admin/collab/unsaved", { headers: ownerHeaders() })).json()) as { rows: Array<{ noteId: string }> };
  assert.deepEqual(listed.rows.map((r) => r.noteId), ["mine"]);
});

// ── M-5 ─────────────────────────────────────────────────────────────────────

const discardRoute = (id: string, body: unknown) => app.request(`/api/admin/collab/unsaved/${id}/discard`, { method: "POST", headers: ownerHeaders(), body: JSON.stringify(body) });
type Discard = (vaultId: string, noteId: string, opts?: { force?: boolean }) => Promise<{ discarded: boolean; reason: string | null }>;
const discard = collab.discardUnsavedChanges as unknown as Discard;

test("M-5: discarding is for pages that can NEVER be saved — one that is still being retried needs an explicit force", { timeout: 60_000 }, async () => {
  await withUnsaved("m5a", 503, async () => {
    assert.equal(unsavedRow("m5a")?.permanent, 0, "a retried row: the server is still trying to save it");
    const refused = await discardRoute("m5a", { confirm: true });
    assert.equal(refused.status, 409, await refused.clone().text());
    assert.equal(((await refused.json()) as Record<string, unknown>).error, "not_permanent");
    assert.ok(unsavedRow("m5a"), "nothing was discarded");
    assert.match(text(await loadDocumentState("m5a", new Y.Doc())), /typed in the live editor/, "the typing is still there");
    assert.equal((await discardRoute("m5a", { confirm: true, force: "yes" })).status, 409, "force must be exactly true");
    const forced = await discardRoute("m5a", { confirm: true, force: true });
    assert.equal(forced.status, 200, await forced.clone().text());
    assert.equal(unsavedRow("m5a"), null);
  });
  assert.equal(vaultContent("m5a"), "<p>start</p>");
});

test("M-5: everyone on the page is TOLD when its unsaved changes are discarded", { timeout: 60_000 }, async () => {
  fv.put({ id: "m5b", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const tab = open("m5b");
  await until("synced", () => tab.synced());
  await intercept(isPatch("m5b"), fail(413), async () => {
    type(tab.doc, "too much to save");
    await until("the page is recorded as unsaveable", () => unsavedRow("m5b")?.permanent === 1);
    const ok = await discardRoute("m5b", { confirm: true });
    assert.equal(ok.status, 200, await ok.clone().text());
  });
  await until("the tab is told its text was discarded", () => tab.messages.some((m) => m.type === "prism:notice" && m.code === "unsaved-discarded"));
  await until("…and shows the stored page", () => !/too much to save/.test(text(tab.doc)));
  assert.match(text(tab.doc), /start/);
  assert.equal(tab.messages.filter((m) => m.type === "prism:unsaved").at(-1)?.state, "saved");
  close(tab);
});

test("M-5: a discard waits for the document's store — a store that snapshotted before it can never write the discarded text afterwards", { timeout: 120_000 }, async () => {
  fv.put({ id: "m5c", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const holder = await hocuspocus.openDirectConnection("m5c", {});
  // Typing whose render goes to the worker (beyond the inline byte cap); its first store cannot reach the vault.
  const conn = await hocuspocus.openDirectConnection("m5c", {});
  await conn.transact((doc) => type(doc as unknown as Y.Doc, "typed and held " + "word ".repeat(6000)));
  await intercept(isPatch("m5c"), fail(503), () => conn.disconnect());
  assert.equal(unsavedRow("m5c")?.permanent, 0);
  // The next store is under way — rendering, in a thread that still has to start — when the owner discards.
  await stopConversionWorkers();
  const rendering = conversionStats.worker;
  const storing = collab.flushLiveDoc("primary", "m5c");
  await until("the store is rendering", () => conversionStats.worker > rendering);
  const result = await discard("primary", "m5c", { force: true });
  const answered = fv.calls.length;
  await storing;
  await until("the store has finished", () => !(live("m5c") as unknown as { saveMutex: { isLocked(): boolean } }).saveMutex.isLocked(), 30_000);
  await new Promise((r) => setTimeout(r, 400)); // (…and whatever store the discard itself set off)
  const writtenAfter = fv.calls.slice(answered).filter((c) => c.method === "PATCH" && JSON.stringify((c as { body?: unknown }).body ?? "").includes("typed and held")).length;
  assert.equal(writtenAfter, 0, "after the discard was answered, a store that had snapshotted before it wrote the discarded text to the vault");
  // Serialised: the store finished FIRST (the text is saved — there was nothing left to discard).
  assert.deepEqual([result.discarded, result.reason], [false, "none"]);
  assert.match(vaultContent("m5c"), /typed and held/);
  assert.match(text(live("m5c")!), /typed and held/, "the live document and the stored page agree");
  assert.equal(unsavedRow("m5c"), null);
  await holder.disconnect();
});

// ── M-6 ─────────────────────────────────────────────────────────────────────

type Tuning = { noticeTtlMs: number; busyWaitMs?: number; historyCallMs?: number; historyDeadlineMs?: number };
function tune(patch: Partial<Tuning>): void {
  const tuning = collab.collabTuning as Tuning;
  const was = { ...tuning };
  Object.assign(tuning, patch);
  restore.push(() => void Object.assign(tuning, was));
}
/** While `during` runs, every read of `id`'s history takes `ms` (a hung vault) — unless the caller gives up first (its abort signal is honoured). */
async function slowHistory<T>(id: string, ms: number, during: () => Promise<T>): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.includes(`/notes/${id}/versions`)) return inner(input, init);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(inner(input, init)), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason ?? new Error("aborted"));
      });
    });
  }) as typeof fetch;
  try {
    return await during();
  } finally {
    globalThis.fetch = inner;
  }
}
/** A page whose typing was written to the vault with the acknowledgement LOST, then edited there by someone else. */
async function lostAckThenExternal(id: string, external: (content: string) => string): Promise<Y.Doc> {
  fv.put({ id, tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState(id, new Y.Doc());
  type(doc, "edit one");
  await intercept(isPatch(id), lostAck, () => storeDocumentState(id, doc));
  assert.equal(vaultContent(id), "<p>start</p><p>edit one</p>", "the write DID land");
  await externalEdit(id, external);
  return doc;
}
const eachOnce = (html: string, words: string[]) => words.map((w) => count(html, w));

test("M-6: a history lookup that hangs cannot hold a page's load — it gives up at its deadline, and the merge is decided without it", { timeout: 60_000 }, async () => {
  tune({ historyCallMs: 300, historyDeadlineMs: 700 });
  await lostAckThenExternal("m6", (c) => c + "<p>EXTERNAL</p>");
  resetReconcileState(); // a restart: nothing in memory
  const started = performance.now();
  const reopened = await slowHistory("m6", 5000, () => loadDocumentState("m6", new Y.Doc()));
  const took = performance.now() - started;
  assert.ok(took < 2500, `the load waited ${took.toFixed(0)} ms on the note's history`);
  assert.deepEqual(eachOnce(yDocToHtml(reopened), ["start", "edit one", "EXTERNAL"]), [1, 1, 1], yDocToHtml(reopened));
});

test("M-6: the reconciler does not make other documents wait for one document's history lookup", { timeout: 60_000 }, async () => {
  tune({ historyCallMs: 4000, historyDeadlineMs: 6000 });
  const slow = await lostAckThenExternal("m6a", (c) => c + "<p>EXTERNAL A</p>");
  fv.put({ id: "m6b", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const plain = await loadDocumentState("m6b", new Y.Doc());
  vaultWrite("m6b", LATER(1), { content: "<p>start</p><p>EXTERNAL B</p>" });
  await slowHistory("m6a", 2500, async () => {
    const tick = reconcileLoadedDocs({ documents: new Map([["m6a", slow], ["m6b", plain]]) });
    await until("the other document absorbed its external edit", () => /EXTERNAL B/.test(text(plain)), 1500);
    assert.doesNotMatch(text(slow), /EXTERNAL A/, "(the slow one is still waiting for its history)");
    await tick;
  });
  assert.deepEqual(eachOnce(yDocToHtml(slow), ["start", "edit one", "EXTERNAL A"]), [1, 1, 1], yDocToHtml(slow));
});
