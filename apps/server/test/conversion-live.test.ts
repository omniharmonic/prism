/**
 * Content that cannot be converted in budget, end to end: real Hocuspocus over a
 * real WebSocket, the human command endpoint and the Prism MCP.
 *
 *  - Opening such a note stalls nothing (a timer keeps firing), shows its text
 *    read-only, and leaves the stored note byte-for-byte unchanged — whatever the
 *    client, a command or an agent then tries.
 *  - A tab still holding the plain-text copy after the note was fixed can never
 *    merge it into the healthy document (it is told to reload).
 *  - The MCP note resource converts in the worker, with the raw body as fallback.
 */
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { addGrant, ensureUser, getDocState } from "../src/db";
import { issuePat } from "../src/auth/pat";
import {
  attachCollab,
  carriesDegradedSeed,
  degradedDocJson,
  hocuspocus,
  isDocDegraded,
  isDocLive,
  reconcileLoadedDocs,
  resetDegradedState,
  resetReconcileState,
  yDocToDocJson,
  yDocToHtml,
} from "../src/collab";
import { configureConversion, forgetConversionFailures, stopConversionWorkers } from "../src/convert/service";
import * as core from "../src/convert/core";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const EDITOR = "editor@test.local";
const SUGGESTER = "suggester@test.local";
const T0 = "2026-02-01T00:00:00.000Z";
const T1 = "2026-02-02T00:00:00.000Z";
const BOMB = "*a ".repeat(6000); // 18 KB the Markdown parser needs seconds for
const DEEP_HTML = "<div>".repeat(6000) + "deep text" + "</div>".repeat(6000); // 66 KB the DOM walkers overflow on

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let server: Server;
let wsUrl: string;
let ip: string;
let restoreLimits: () => void;
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
  resetDegradedState();
  forgetConversionFailures();
  restoreLimits = configureConversion({ timeoutMs: 400, timeoutPerMbMs: 0, timeoutMaxMs: 400 });
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  hocuspocus.configuration.debounce = 100;
  hocuspocus.configuration.maxDebounce = 300;
  for (const e of [EDITOR, SUGGESTER]) ensureUser(e);
  addGrant({ subject_type: "user", subject: EDITOR, resource_type: "tag", resource: "garden", level: "view", caps: ["view", "comment", "suggest", "edit", "create"] as never, created_by: "test", vault_id: "primary" });
  addGrant({ subject_type: "user", subject: SUGGESTER, resource_type: "tag", resource: "garden", level: "view", caps: ["view", "comment", "suggest"] as never, created_by: "test", vault_id: "primary" });
  fv.put({ id: "bomb", tags: ["garden"], content: BOMB, updatedAt: T0 });
  fv.put({ id: "deep", tags: ["garden"], content: DEEP_HTML, updatedAt: T0 });
  fv.put({ id: "ok", tags: ["garden"], content: "<p>alpha</p><p>beta</p>", updatedAt: T0 });
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
  restoreLimits();
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
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const editToken = () => makeCapability("tag", "garden", "edit");
const vaultWrites = () => fv.calls.filter((c) => c.method !== "GET");
const norm = (json: unknown) => JSON.stringify(core.schema.nodeFromJSON(json).toJSON());
const live = (name: string) => hocuspocus.documents.get(name) as Y.Doc | undefined;
const unloaded = (name: string) => until(`${name} unloads`, () => !hocuspocus.documents.has(name));

interface Tab {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  /** Reasons of refused authentications, in order. */
  refused: string[];
  synced: () => boolean;
}
function open(name: string, token: string, doc = new Y.Doc()): Tab {
  const refused: string[] = [];
  let synced = false;
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name,
    token,
    document: doc,
    awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime
    WebSocketPolyfill: TrackedWebSocket,
    onAuthenticationFailed: ({ reason }: { reason: string }) => void refused.push(reason),
    onSynced: () => void (synced = true),
  });
  // What apps/web CollabDoc does on an "Access changed." close: Hocuspocus closes
  // the DOCUMENT channel, which the provider does not re-open on its own.
  provider.on("close", ({ event }: { event: { reason?: string } }) => {
    if (!event?.reason?.startsWith("Access changed.")) return;
    synced = false;
    provider.authorizedScope = undefined;
    const transport = provider.configuration.websocketProvider;
    const done = () => {
      transport.off("close", done);
      if (providers.includes(provider)) void provider.connect();
    };
    transport.on("close", done);
    provider.disconnect();
  });
  providers.push(provider);
  return { doc, provider, refused, synced: () => synced };
}
const close = (tab: Tab) => {
  tab.provider.destroy();
  providers.splice(providers.indexOf(tab.provider), 1);
};

/** Longest gap between ticks of a 20 ms timer while `fn` runs. */
async function lagDuring<T>(fn: () => Promise<T>): Promise<{ value: T; maxLagMs: number }> {
  let last = performance.now();
  let maxLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 20);
    last = now;
  }, 20);
  try {
    const value = await fn();
    return { value, maxLagMs: Math.max(maxLagMs, performance.now() - last - 20) };
  } finally {
    clearInterval(timer);
  }
}
const LOOP_BUDGET_MS = 1500;

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

// ── tests ───────────────────────────────────────────────────────────────────

for (const [id, body] of [
  ["bomb", BOMB],
  ["deep", DEEP_HTML],
] as const) {
  test(`live open of "${id}": the server stays responsive, the tab is read-only plain text, the note is never rewritten`, { timeout: 90_000 }, async () => {
    const { value: tab, maxLagMs } = await lagDuring(async () => {
      const t = open(id, editToken());
      // First contact loads the document; the server then makes the socket reconnect read-only.
      await until("a read-only, synced socket", () => t.synced() && t.provider.authorizedScope === "readonly", 30_000);
      return t;
    });
    assert.ok(maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${maxLagMs.toFixed(0)} ms while the note was opened`);
    assert.equal(isDocDegraded(id), true);
    assert.equal(isDocLive("primary", id), false, "not a live document for anyone deciding how to write the note");
    assert.equal(carriesDegradedSeed(live(id)!), true);
    await until("the client holds the text", () => norm(yDocToDocJson(tab.doc)) === norm(degradedDocJson(body)));

    // The tab types anyway (a stale or hostile client): the server takes none of it.
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("typed into the plain-text view")]);
    tab.doc.getXmlFragment("default").insert(0, [para]);
    await settle(800); // well past the store debounce
    assert.equal(norm(yDocToDocJson(live(id)!)), norm(degradedDocJson(body)), "the server document did not take the edit");
    assert.deepEqual(vaultWrites(), []);

    // Closing unloads it — still nothing written, no CRDT snapshot of the degraded form.
    close(tab);
    await unloaded(id);
    assert.deepEqual(vaultWrites(), []);
    assert.equal(getDocState(id), null);
    assert.equal(fv.notes.get(id)!.content, body, "byte-for-byte the stored note");
  });
}

test("a degraded document takes no commands and no agent writes; reads fall back to the stored note", { timeout: 90_000 }, async () => {
  const tab = open("bomb", editToken());
  await until("read-only", () => tab.synced() && tab.provider.authorizedScope === "readonly", 30_000);

  // The human command endpoint (a suggest-level person's only way to change a page).
  const res = await app.request("/api/collab/bomb/commands", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-forwarded-for": ip, cookie: sessionCookie(makeSession(SUGGESTER)) },
    body: JSON.stringify({ requestId: randomUUID(), createdAt: Date.now(), revision: "0".repeat(64), kind: "suggest", from: 1, to: 1, quote: "", text: "x" }),
  });
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: string }).error, "document_too_large");

  // The Prism MCP: comments / suggestions are refused, with or without the page open.
  const ed = await connectMcp(EDITOR);
  const comment = await call(ed, "prism_add_comment", { id: "bomb", quote: "a", text: "hello" });
  assert.equal(comment.ok, false);
  assert.equal((comment as { error: string }).error, "invalid_request");
  const got = await call(ed, "prism_get_note", { id: "bomb" });
  assert.equal(got.ok && got.data.collab.live, false);
  assert.equal(got.ok && got.data.content, BOMB, "an agent reads the stored note, never the plain-text view");
  assert.deepEqual(vaultWrites(), []);
  assert.equal(fv.notes.get("bomb")!.content, BOMB);

  // An agent FIXES the note: an ordinary REST write (the degraded document is not "live").
  const fixed = await call(ed, "prism_update_note", { id: "bomb", content: "now *fine*", if_updated_at: T0 });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(fv.notes.get("bomb")!.content, "now *fine*");
  // The reconciler drops the plain-text readers; the page reopens as a normal document.
  await reconcileLoadedDocs(hocuspocus as never);
  close(tab);
  await unloaded("bomb");
  const fresh = open("bomb", editToken());
  await until("a writable, synced socket", () => fresh.synced() && fresh.provider.authorizedScope === "read-write" && !isDocDegraded("bomb"), 30_000);
  assert.equal(yDocToHtml(live("bomb")!), "<p>now <em>fine</em></p>");
  assert.equal(carriesDegradedSeed(live("bomb")!), false);
  await ed.close();
});

test("a tab that kept the plain-text copy cannot merge it into the fixed document: refused at sync, told to reload", { timeout: 90_000 }, async () => {
  const stale = open("bomb", editToken());
  await until("read-only", () => stale.synced() && stale.provider.authorizedScope === "readonly", 30_000);
  await until("the stale tab holds the plain text", () => carriesDegradedSeed(stale.doc));
  const kept = stale.doc; // the browser's Y.Doc outlives its socket
  close(stale);
  await unloaded("bomb");

  // The note is fixed elsewhere; someone opens and edits the healthy document.
  fv.put({ id: "bomb", tags: ["garden"], content: "<p>healthy body</p>", updatedAt: T1 });
  const good = open("bomb", editToken());
  await until("healthy", () => good.synced() && good.provider.authorizedScope === "read-write" && !isDocDegraded("bomb"), 30_000);
  assert.equal(yDocToHtml(live("bomb")!), "<p>healthy body</p>");

  // The stale tab comes back with its old Y.Doc and (now) full edit rights.
  const back = open("bomb", editToken(), kept);
  await until("the stale tab is told to reload", () => back.refused.some((r) => r.startsWith("update_required")), 30_000);
  await settle(600);
  const serverDoc = live("bomb")!;
  assert.equal(carriesDegradedSeed(serverDoc), false, "no plain-text seed item reached the healthy document");
  assert.equal(yDocToHtml(serverDoc), "<p>healthy body</p>");
  close(back);
  close(good);
  await unloaded("bomb");
  assert.equal(fv.notes.get("bomb")!.content, "<p>healthy body</p>", "the note was not rewritten with a duplicated plain-text copy");
});

test("an agent's update with unconvertible content never reaches a live document, and stalls nothing", { timeout: 90_000 }, async () => {
  const tab = open("ok", editToken());
  await until("live", () => tab.synced() && isDocLive("primary", "ok"));
  const ed = await connectMcp(EDITOR);
  const { value: r, maxLagMs } = await lagDuring(() => call(ed, "prism_update_note", { id: "ok", content: BOMB, if_updated_at: T0 }));
  assert.ok(maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${maxLagMs.toFixed(0)} ms`);
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, "invalid_request");
  assert.equal(yDocToHtml(live("ok")!), "<p>alpha</p><p>beta</p>");
  assert.equal(fv.notes.get("ok")!.content, "<p>alpha</p><p>beta</p>");
  assert.equal(isDocDegraded("ok"), false);
  await ed.close();
});

test("prism://note/{id}: converted in the worker; a body it cannot convert comes back raw, with a note — and the loop stays free", { timeout: 90_000 }, async () => {
  const ed = await connectMcp(EDITOR);
  const fine: any = (await ed.readResource({ uri: "prism://note/ok" })).contents[0];
  assert.equal(fine.mimeType, "text/markdown");
  assert.equal(fine.text, "alpha\n\nbeta");

  const { value: res, maxLagMs } = await lagDuring(() => ed.readResource({ uri: "prism://note/deep" }));
  assert.ok(maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${maxLagMs.toFixed(0)} ms`);
  const [body, meta]: any[] = res.contents;
  assert.equal(body.mimeType, "text/html");
  assert.match(body.text, /^<!-- prism: this note's HTML could not be converted to Markdown \((timeout|failed)\)/);
  assert.ok(body.text.endsWith(DEEP_HTML), "the stored body follows, unchanged");
  const m = JSON.parse(meta.text);
  assert.equal(m.contentFormat, "html");
  assert.ok(["timeout", "failed"].includes(m.contentUnconverted));
  assert.deepEqual(vaultWrites(), []);
  await ed.close();
});
