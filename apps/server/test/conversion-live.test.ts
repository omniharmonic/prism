/**
 * Content that cannot be converted in budget, end to end: real Hocuspocus over a
 * real WebSocket, the human command endpoint and the Prism MCP.
 *
 *  - Opening such a note stalls nothing (a timer keeps firing) and is refused
 *    `too_complex`: no live document exists, NOTHING reaches the client's Y.Doc
 *    (so nothing can be persisted in a browser and poison a later open), and the
 *    stored note is byte-for-byte unchanged whatever a command or an agent tries.
 *  - Once the note is fixed, the very same client document opens it live.
 *  - A live document whose note becomes unconvertible is closed, never stored
 *    over the note, and comes back when the note is fixed.
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
  hocuspocus,
  isDocBlocked,
  isDocLive,
  reconcileLoadedDocs,
  resetConversionState,
  resetReconcileState,
  yDocToHtml,
} from "../src/collab";
import { configureConversion, forgetConversionFailures, stopConversionWorkers } from "../src/convert/service";
import { probed } from "./probe";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const EDITOR = "editor@test.local";
const SUGGESTER = "suggester@test.local";
const T0 = "2026-02-01T00:00:00.000Z";
const T1 = "2026-02-02T00:00:00.000Z";
const BOMB = "*a ".repeat(6000); // 18 KB the Markdown parser needs seconds for
const QUOTE_BOMB = "> ".repeat(5000) + "x"; // refused by the pre-check (the parser overflows its stack on it)
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
  resetConversionState();
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
/** The event loop's worst stall while `fn` runs — in this thread's CPU time (`./probe`), not on the wall clock. */
async function lagDuring<T>(fn: () => Promise<T>): Promise<{ value: T; maxLagMs: number }> {
  const r = await probed(fn);
  if ("error" in r && r.error !== undefined) throw r.error;
  return { value: r.value as T, maxLagMs: r.maxLagMs };
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

const tooComplex = (t: Tab) => t.refused.some((r) => r.startsWith("too_complex"));

for (const [id, body] of [
  ["bomb", BOMB],
  ["deep", DEEP_HTML],
] as const) {
  test(`live open of "${id}": refused too_complex, the server stays responsive, NOTHING reaches the client document or any store`, { timeout: 90_000 }, async () => {
    const { value: tab, maxLagMs } = await lagDuring(async () => {
      const t = open(id, editToken());
      await until("the socket is refused too_complex", () => tooComplex(t), 30_000);
      return t;
    });
    assert.ok(maxLagMs < LOOP_BUDGET_MS, `event loop stalled ${maxLagMs.toFixed(0)} ms while the note was opened`);
    await settle(300);
    // No live document, and not one Yjs item in the client's: nothing a browser
    // could persist locally (IndexedDB) and bring back later.
    assert.equal(hocuspocus.documents.has(id), false);
    assert.equal(tab.doc.store.clients.size, 0, "the client's Y.Doc is empty");
    assert.equal(tab.synced(), false);
    assert.equal(isDocLive("primary", id), false);
    assert.equal(getDocState(id), null, "no CRDT snapshot");
    assert.deepEqual(vaultWrites(), []);
    assert.equal(fv.notes.get(id)!.content, body, "byte-for-byte the stored note");
    close(tab);
  });
}

test("an unconvertible note takes no commands and no agent writes; once it is fixed the SAME client document opens it live", { timeout: 90_000 }, async () => {
  const tab = open("bomb", editToken());
  await until("refused", () => tooComplex(tab), 30_000);
  const kept = tab.doc; // what the browser would have kept (and persisted) of this attempt
  close(tab);

  // The human command endpoint (a suggest-level person's only way to change a page).
  const res = await app.request("/api/collab/bomb/commands", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-forwarded-for": ip, cookie: sessionCookie(makeSession(SUGGESTER)) },
    body: JSON.stringify({ requestId: randomUUID(), createdAt: Date.now(), revision: "0".repeat(64), kind: "suggest", from: 1, to: 1, quote: "", text: "x" }),
  });
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: string }).error, "document_too_large");

  // The Prism MCP: comments / suggestions are refused; reads give the stored note.
  const ed = await connectMcp(EDITOR);
  const comment = await call(ed, "prism_add_comment", { id: "bomb", quote: "a", text: "hello" });
  assert.equal(comment.ok, false);
  assert.equal((comment as { error: string }).error, "invalid_request");
  const got = await call(ed, "prism_get_note", { id: "bomb" });
  assert.equal(got.ok && got.data.collab.live, false);
  assert.equal(got.ok && got.data.content, BOMB);
  assert.deepEqual(vaultWrites(), []);
  assert.equal(fv.notes.get("bomb")!.content, BOMB);
  assert.equal(hocuspocus.documents.has("bomb"), false);

  // The plain REST path works on such a note (the stored content is intact): an agent — or the
  // client's plain-text editor — FIXES it with an ordinary compare-and-set write.
  const fixed = await call(ed, "prism_update_note", { id: "bomb", content: "now *fine*", if_updated_at: T0 });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(fv.notes.get("bomb")!.content, "now *fine*");

  // The same client document (same Y.Doc, as after a reload from its local store) opens it live.
  const again = open("bomb", editToken(), kept);
  await until("a writable, synced socket", () => again.synced() && again.provider.authorizedScope === "read-write", 30_000);
  assert.deepEqual(again.refused, [], "never refused, never told to reload");
  assert.equal(yDocToHtml(live("bomb")!), "<p>now <em>fine</em></p>");
  await until("the client holds the document", () => yDocToHtml(again.doc) === "<p>now <em>fine</em></p>");
  // And it can edit: the change reaches the server document and the note.
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("typed after the fix")]);
  again.doc.getXmlFragment("default").insert(1, [para]);
  await until("the edit is stored", () => fv.notes.get("bomb")!.content === "<p>now <em>fine</em></p><p>typed after the fix</p>");
  await ed.close();
});

test("a LIVE document whose note becomes unconvertible is closed (never stored over the note) and comes back when the note is fixed", { timeout: 90_000 }, async () => {
  const tab = open("ok", editToken());
  await until("live", () => tab.synced() && isDocLive("primary", "ok"));
  // Unsaved typing in the live document…
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("unsaved typing")]);
  tab.doc.getXmlFragment("default").insert(2, [para]);
  await until("the server document has it", () => /unsaved typing/.test(yDocToHtml(live("ok")!)));
  // …while the note is replaced, elsewhere, by something no parser can take.
  fv.put({ id: "ok", tags: ["garden"], content: QUOTE_BOMB, updatedAt: T1 });
  const writesBefore = vaultWrites().length;
  await reconcileLoadedDocs(hocuspocus as never);
  assert.equal(isDocBlocked("ok"), true);
  assert.equal(isDocLive("primary", "ok"), false);
  await until("the tab is refused too_complex", () => tooComplex(tab), 30_000);
  await until("the document unloads", () => !hocuspocus.documents.has("ok"));
  assert.equal(vaultWrites().length, writesBefore, "the unload did not write the live state over the note");
  assert.equal(fv.notes.get("ok")!.content, QUOTE_BOMB, "the external edit is intact");
  assert.equal(isDocBlocked("ok"), false, "the flag goes with the document");

  // Fixed: the same tab (it still holds the old document) reconnects and converges on the new note.
  fv.put({ id: "ok", tags: ["garden"], content: "<p>rewritten</p>", updatedAt: "2026-02-03T00:00:00.000Z" });
  const kept = tab.doc; // as after a reload: the browser's local copy of the OLD document
  close(tab);
  const back = open("ok", editToken(), kept);
  await until("live again", () => back.synced() && back.provider.authorizedScope === "read-write", 30_000);
  // The note's new content AND the typing that never reached the vault: merged three-way against the snapshot's true base.
  const merged = "<p>rewritten</p><p>unsaved typing</p>";
  await until("converged", () => yDocToHtml(back.doc) === merged && yDocToHtml(live("ok")!) === merged, 20_000).catch((e) => {
    throw new Error(`${(e as Error).message}: client ${yDocToHtml(back.doc)} | server ${yDocToHtml(live("ok")!)}`);
  });
  assert.deepEqual(back.refused, []);
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
  assert.equal(isDocBlocked("ok"), false);
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
