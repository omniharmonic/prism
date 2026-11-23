/**
 * Second independent review of the conversion change — every way a live
 * document's typing could still be lost silently, against the real Hocuspocus
 * server (direct connections, WebSocket tabs, the sweep, the gateway, the MCP).
 *
 *  H1  An unsaved snapshot was wiped at the next load after ANY metadata-only
 *      vault write (the "what this snapshot is built on" hash was memory-only).
 *      A page that can never be saved as it is (too large to render, refused by
 *      the vault) is recorded, not retried, and the people on it are told.
 *  H2  `prism_update_note` on a live document merged against a base that already
 *      held unsaved human typing — and deleted it.
 *  H3  A store whose acknowledgement was lost (the vault applied it, the server
 *      saw an error) was folded back over newer typing as an "external edit".
 *  M1  The fold inside a store replaced the document wholesale.
 *  M2  A store whose read of the note failed wrote without a version check.
 *  M3  Five rows that can never be written starved the sweep.
 *  M4  REST writers of a note's body treated a note with a pending unsaved
 *      snapshot as "not live".
 *
 * Written against what existed before the fix (optional exports are looked up at
 * run time), so the file can be run against the previous commit.
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
import { addGrant, createSuggestion, ensureUser, getDocState, isCollabUnsaved, markCollabUnsaved } from "../src/db";
import { issuePat } from "../src/auth/pat";
import * as collab from "../src/collab";
import { attachCollab, hocuspocus, loadDocumentState, reconcileLoadedDocs, resetConversionState, resetReconcileState, storeDocumentState, sweepUnsavedDocuments, yDocToDocJson, yDocToHtml } from "../src/collab";
import { configureConversion, forgetConversionFailures, stopConversionWorkers } from "../src/convert/service";
import { getSourceHealth } from "../src/worker/health";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const EDITOR = "editor@test.local";
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
  for (const e of [OWNER, EDITOR]) ensureUser(e);
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

// ── H1 ──────────────────────────────────────────────────────────────────────

test("H1: a metadata-only vault write after a store that did not reach the vault — the next load keeps the typing and writes it", { timeout: 60_000 }, async () => {
  fv.put({ id: "h1", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h1", new Y.Doc());
  type(doc, "typed before the failure");
  await intercept(isPatch("h1"), fail(500), () => storeDocumentState("h1", doc));
  assert.doesNotMatch(vaultContent("h1"), /typed before/, "nothing was written");
  assert.equal(isCollabUnsaved("h1", "primary"), true);

  // The tab is gone. Somebody sets a property on the page: the note's version moves, its body does not.
  vaultWrite("h1", LATER(1), { metadata: { icon: "🌱" } });

  const reopened = await loadDocumentState("h1", new Y.Doc());
  assert.match(text(reopened), /typed before the failure/, "the unsaved typing is restored — the content-stale vault body is NOT folded over it");
  assert.equal(isCollabUnsaved("h1", "primary"), true, "…and it is still recorded as waiting to be written");
  await storeDocumentState("h1", reopened);
  assert.match(vaultContent("h1"), /start[\s\S]*typed before the failure/);
  assert.equal(fv.notes.get("h1")!.metadata?.icon, "🌱", "the property is kept");
  assert.equal(isCollabUnsaved("h1", "primary"), false);
});

test("H1 (real server): a failed store at unload, a metadata write, then the sweep — the typing reaches the vault", { timeout: 60_000 }, async () => {
  fv.put({ id: "h1s", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  await typeAndLeave("h1s", "typed, then the tab closed", (leave) => intercept(isPatch("h1s"), fail(500), leave));
  assert.doesNotMatch(vaultContent("h1s"), /typed, then/);
  assert.equal(isCollabUnsaved("h1s", "primary"), true);
  vaultWrite("h1s", LATER(1), { metadata: { status: "review" } });

  await sweepUnsavedDocuments(5);
  await until("the document unloads again", () => !hocuspocus.documents.has("h1s"));
  assert.match(vaultContent("h1s"), /typed, then the tab closed/, "the sweep wrote the snapshot");
  assert.equal(isCollabUnsaved("h1s", "primary"), false);
  assert.equal(fv.notes.get("h1s")!.metadata?.status, "review");
});

test("H1: a write the vault can never accept (413) is recorded as permanent, not retried — and the typing still survives a metadata write and a reload", { timeout: 60_000 }, async () => {
  fv.put({ id: "h1p", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h1p", new Y.Doc());
  type(doc, "too much for the vault");
  await intercept(isPatch("h1p"), async () => new Response(JSON.stringify({ error: "history_overflow" }), { status: 413, headers: J }), () => storeDocumentState("h1p", doc));
  const row = unsavedRow("h1p");
  assert.ok(row, "recorded");
  assert.equal(row!.permanent, 1, "…as something retrying cannot fix");
  assert.equal(row!.reason, "vault 413");
  const due = (dbm as unknown as { dueCollabUnsaved?: (limit: number, at: number) => unknown[] }).dueCollabUnsaved!(10, Date.now() + 365 * 86_400_000);
  assert.deepEqual(due, [], "the sweep never retries it");

  vaultWrite("h1p", LATER(1), { metadata: { icon: "x" } });
  const reopened = await loadDocumentState("h1p", new Y.Doc());
  assert.match(text(reopened), /too much for the vault/, "the state is kept in the server's document store and opens with the page");
  assert.equal(unsavedRow("h1p")?.permanent, 1, "still recorded");
  // Once the vault takes it, the record goes.
  await storeDocumentState("h1p", reopened);
  assert.match(vaultContent("h1p"), /too much for the vault/);
  assert.equal(unsavedRow("h1p"), null);
});

test("H1: the people on a page that cannot be saved are TOLD (now, and whoever connects later) — and told when it saves again", { timeout: 90_000 }, async () => {
  fv.put({ id: "told", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const tab = open("told");
  await until("synced", () => tab.synced());
  // From now on nothing can be rendered for the vault (the page is "too large").
  const restoreLimits = configureConversion({ inlineMaxNodes: 0, maxNodes: 1 });
  restore.push(restoreLimits);
  type(tab.doc, "typed into a page that is too large");
  const unsavedMsg = (t: Tab) => t.messages.filter((m) => m.type === "prism:unsaved");
  await until("the tab is told its changes are not in the stored page", () => unsavedMsg(tab).some((m) => m.state === "unsaved"), 30_000);
  assert.equal(unsavedMsg(tab).at(-1)!.reason, "too_many_nodes");
  assert.doesNotMatch(vaultContent("told"), /too large/);
  assert.match(text(live("told")!), /too large/, "the document stays live");

  const second = open("told");
  await until("a tab that connects later is told at once", () => unsavedMsg(second).some((m) => m.state === "unsaved"), 30_000);

  restoreLimits();
  type(tab.doc, "and shorter again");
  await until("both tabs are told it is saved", () => unsavedMsg(tab).at(-1)?.state === "saved" && unsavedMsg(second).at(-1)?.state === "saved", 30_000);
  assert.match(vaultContent("told"), /too large[\s\S]*shorter again/);
  close(tab);
  close(second);
});

// ── H2 ──────────────────────────────────────────────────────────────────────

test("H2: an agent's prism_update_note while the live document holds typing the vault lacks — merged against the TRUE base, the typing survives", { timeout: 90_000 }, async () => {
  fv.put({ id: "h2", tags: ["garden"], content: "<p>alpha</p><p>beta</p>", updatedAt: T0 });
  const tab = open("h2");
  await until("synced", () => tab.synced());
  const agent = await connectMcp(EDITOR);
  let out: Out | undefined;
  // Every store of the page fails for now: the human's typing is saved in the snapshot, not in the vault.
  await intercept(isPatch("h2"), fail(500), async () => {
    type(tab.doc, "HUMAN TYPING");
    await until("a store was attempted and did not land", () => live("h2") !== undefined && /HUMAN TYPING/.test(text(live("h2")!)) && isCollabUnsaved("h2", "primary"), 30_000);
    assert.doesNotMatch(vaultContent("h2"), /HUMAN TYPING/);
    // The agent read the note at T0 and rewrites the first paragraph.
    out = await call(agent, "prism_update_note", { id: "h2", content: "<p>alpha, by the agent</p><p>beta</p>", if_updated_at: T0 });
    assert.match(text(live("h2")!), /HUMAN TYPING/, "the agent's merge did not delete what the human typed");
  });
  assert.equal(out!.ok, true, `the merge has a true base to work from: ${JSON.stringify(out)}`);
  assert.match(text(live("h2")!), /alpha, by the agent/);
  await until("both reach the vault", () => /alpha, by the agent/.test(vaultContent("h2")) && /HUMAN TYPING/.test(vaultContent("h2")), 30_000);
  await until("the tab has both", () => /alpha, by the agent/.test(text(tab.doc)) && /HUMAN TYPING/.test(text(tab.doc)));
  close(tab);
});

// ── H3 ──────────────────────────────────────────────────────────────────────

test("H3: a store whose acknowledgement is lost — the vault's copy is recognised as OURS, never folded over newer typing", { timeout: 60_000 }, async () => {
  fv.put({ id: "h3", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h3", new Y.Doc());
  type(doc, "edit one");
  // The vault applies the write; the server sees a gateway timeout.
  await intercept(
    isPatch("h3"),
    async (pass) => {
      await pass();
      return new Response("gateway timeout", { status: 504 });
    },
    () => storeDocumentState("h3", doc),
  );
  assert.match(vaultContent("h3"), /edit one/, "the write DID land");
  type(doc, "edit two");
  await reconcileLoadedDocs({ documents: new Map([["h3", doc]]) });
  assert.match(text(doc), /edit two/, "the reconciler did not fold our own write over what was typed after it");
  assert.match(text(doc), /edit one/);

  const writes = patches("h3").length;
  await storeDocumentState("h3", doc);
  assert.match(vaultContent("h3"), /edit one[\s\S]*edit two/);
  assert.equal(patches("h3").length, writes + 1);
  assert.equal(isCollabUnsaved("h3", "primary"), false);
  assert.equal(getDocState("h3")!.sourceUpdatedAt, Date.parse(fv.notes.get("h3")!.updatedAt!));
});

test("H3: lost acknowledgement, then the document unloads (or the server restarts) — the next load restores the snapshot unharmed, with one copy of everything", { timeout: 60_000 }, async () => {
  fv.put({ id: "h3r", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("h3r", new Y.Doc());
  type(doc, "edit one");
  await intercept(
    isPatch("h3r"),
    async (pass) => {
      await pass();
      return new Response("gateway timeout", { status: 504 });
    },
    () => storeDocumentState("h3r", doc),
  );
  type(doc, "edit two");
  // A second store that reaches nothing at all, then the document is gone.
  await intercept(isPatch("h3r"), fail(500), () => storeDocumentState("h3r", doc));
  resetReconcileState(); // a restart: nothing in memory
  const reopened = await loadDocumentState("h3r", new Y.Doc());
  assert.equal(yDocToHtml(reopened), "<p>start</p><p>edit one</p><p>edit two</p>");
  await storeDocumentState("h3r", reopened);
  assert.equal(vaultContent("h3r"), "<p>start</p><p>edit one</p><p>edit two</p>");
  assert.equal(isCollabUnsaved("h3r", "primary"), false);
});

// ── M1 ──────────────────────────────────────────────────────────────────────

test("M1: an external edit landing between a store's read and its write is MERGED with what was typed — neither side is dropped", { timeout: 60_000 }, async () => {
  fv.put({ id: "m1", tags: ["garden"], content: "<p>first paragraph</p><p>second paragraph</p>", updatedAt: T0 });
  const doc = await loadDocumentState("m1", new Y.Doc());
  type(doc, "a paragraph typed live");
  let landed = false;
  await intercept(
    isPatch("m1"),
    async (pass) => {
      if (!landed) {
        landed = true;
        vaultWrite("m1", "2026-03-05T00:00:00.000Z", { content: "<p>first paragraph, edited elsewhere</p><p>second paragraph</p>" });
      }
      return pass();
    },
    () => storeDocumentState("m1", doc),
  );
  assert.equal(landed, true);
  assert.equal(vaultContent("m1"), "<p>first paragraph, edited elsewhere</p><p>second paragraph</p><p>a paragraph typed live</p>");
  assert.equal(yDocToHtml(doc), vaultContent("m1"));
  assert.equal(isCollabUnsaved("m1", "primary"), false);
});

// ── M2 ──────────────────────────────────────────────────────────────────────

test("M2: a store that cannot READ the note (whose version it knows) writes nothing — never an unconditioned overwrite", { timeout: 60_000 }, async () => {
  fv.put({ id: "m2", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("m2", new Y.Doc());
  type(doc, "typed live");
  // Someone else edits the note; the store's read of it then fails (a vault hiccup).
  vaultWrite("m2", "2026-03-05T00:00:00.000Z", { content: "<p>start</p><p>EXTERNAL EDIT</p>" });
  await intercept(isGet("m2"), fail(503), () => storeDocumentState("m2", doc));
  assert.deepEqual(patches("m2"), [], "no write was sent");
  assert.match(vaultContent("m2"), /EXTERNAL EDIT/, "the edit the store could not see is intact");
  assert.equal(isCollabUnsaved("m2", "primary"), true, "the typing waits for a store that can read the note");
  // The next store reads it, merges, and writes both.
  await storeDocumentState("m2", doc);
  assert.match(vaultContent("m2"), /EXTERNAL EDIT/);
  assert.match(vaultContent("m2"), /typed live/);
});

// ── M3 ──────────────────────────────────────────────────────────────────────

test("M3: rows that can never be written do not starve the sweep — a deleted note's row is dropped, the others get their turn", { timeout: 90_000 }, async () => {
  for (let i = 0; i < 5; i++) markCollabUnsaved(`gone${i}`, "primary", `gone${i}`);
  await new Promise((r) => setTimeout(r, 15));
  fv.put({ id: "m3", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  await typeAndLeave("m3", "waiting behind five dead rows", (leave) => intercept(isPatch("m3"), fail(500), leave));
  assert.equal(isCollabUnsaved("m3", "primary"), true);

  for (let i = 0; i < 3 && isCollabUnsaved("m3", "primary"); i++) {
    await sweepUnsavedDocuments(5);
    await until("documents unload", () => hocuspocus.documents.size === 0);
  }
  assert.match(vaultContent("m3"), /waiting behind five dead rows/, "the real note was written within three sweeps");
  for (let i = 0; i < 5; i++) assert.equal(isCollabUnsaved(`gone${i}`, "primary"), false, "a deleted note's row is dropped");
});

// ── M4 ──────────────────────────────────────────────────────────────────────

test("M4: a REST write of the body is refused (409 live) while the note's live changes cannot reach the vault — and goes ahead once they have", { timeout: 90_000 }, async () => {
  fv.put({ id: "m4", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  // The page's live changes cannot reach the vault for now (every store of them fails).
  const storeOfTyping = (method: string, path: string, body: string) => isPatch("m4")(method, path) && body.includes("typed in the live editor");
  await intercept(storeOfTyping, fail(500), async () => {
    await typeAndLeave("m4", "typed in the live editor");
    assert.doesNotMatch(vaultContent("m4"), /typed in the live editor/);
    assert.equal(isCollabUnsaved("m4", "primary"), true);

    // The plain editor / an agent / an import, working from the STORED body (version T0):
    const stale = await app.request("/api/notes/m4", { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify({ content: "<p>start</p><p>written over REST</p>", if_updated_at: T0 }) });
    assert.equal(stale.status, 409, "refused: the stored body is not what the page holds");
    assert.deepEqual({ ...((await stale.json()) as Record<string, unknown>), detail: undefined }, { error: "conflict", live: true, retry: true, detail: undefined });
    assert.equal(vaultContent("m4"), "<p>start</p>", "nothing was written over the note");
    // A version restore is a body write too.
    const restored = await app.request("/api/notes/m4/restore", { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ version_ix: 0, if_updated_at: T0 }) });
    assert.equal(restored.status, 409);
    // A metadata-only write is not a body write: it goes through.
    const meta = await app.request("/api/notes/m4", { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify({ metadata: { icon: "x" } }) });
    assert.equal(meta.status, 200);
    assert.equal(isCollabUnsaved("m4", "primary"), true);
  });

  // The vault takes the page again: the same request first lets the live changes reach it,
  // and is then judged against the note as it really is (its version is stale now).
  const again = await app.request("/api/notes/m4", { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify({ content: "<p>start</p><p>written over REST</p>", if_updated_at: T0 }) });
  assert.match(vaultContent("m4"), /typed in the live editor/, "the live changes were written first");
  assert.equal(again.status, 409, "…so the stale REST write is an ordinary version conflict");
  assert.doesNotMatch(vaultContent("m4"), /written over REST/);
  assert.equal(isCollabUnsaved("m4", "primary"), false);
});

test("M4: a block moved onto a page whose live changes have not reached the vault goes THROUGH the document — nothing typed is written over", { timeout: 90_000 }, async () => {
  fv.put({ id: "m4b", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  await typeAndLeave("m4b", "typed, not saved yet", (leave) => intercept(isPatch("m4b"), fail(500), leave));
  assert.equal(isCollabUnsaved("m4b", "primary"), true);
  const res = await app.request("/api/notes/m4b/blocks/append", {
    method: "POST",
    headers: { cookie: sessionCookie(makeSession(EDITOR)), ...J, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ html: "<blockquote><p>a moved block</p></blockquote>", requestId: "req-00000001" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  await until("the document unloads", () => !hocuspocus.documents.has("m4b"));
  assert.match(vaultContent("m4b"), /typed, not saved yet/, "the unsaved typing reached the vault with the block");
  assert.match(vaultContent("m4b"), /a moved block/);
  const reopened = await loadDocumentState("m4b", new Y.Doc());
  assert.match(text(reopened), /typed, not saved yet/);
  assert.match(text(reopened), /a moved block/);
});

test("M4: accepting a suggestion from the review queue is compare-and-set, and waits while the page's live changes are unsaved", { timeout: 90_000 }, async () => {
  const SUGGESTED = '<p>keep <span data-suggestion="insert" data-suggestion-id="s1" data-user="Ann" data-actor-id="h_1">added</span> tail</p>';
  const row = (id: string, note: string) => createSuggestion({ id, space_note_key: null, note_id: note, author: "Ann", author_kind: "user", summary: null, payload: "" });
  const accept = async (id: string) => app.request(`/acl/suggestions/${id}/accept`, { method: "POST", headers: ownerHeaders() });

  // (a) the note changes between the route's read and its write: refused, never overwritten.
  fv.put({ id: "q1", tags: ["garden"], content: SUGGESTED, updatedAt: T0 });
  row("sg1", "q1");
  let landed = false;
  const res = await intercept(
    isPatch("q1"),
    async (pass) => {
      if (!landed) {
        landed = true;
        vaultWrite("q1", "2026-03-05T00:00:00.000Z", { content: SUGGESTED + "<p>EXTERNAL EDIT</p>" });
      }
      return pass();
    },
    () => accept("sg1"),
  );
  assert.equal(landed, true);
  assert.equal(res.status, 409);
  assert.match(vaultContent("q1"), /EXTERNAL EDIT/, "the edit made in between is intact");
  assert.equal((await accept("sg1")).status, 200, "the retry applies it to the current note");
  assert.equal(vaultContent("q1"), "<p>keep added tail</p><p>EXTERNAL EDIT</p>");

  // (b) the page holds live changes the vault lacks: the stored body is not resolved over.
  fv.put({ id: "q2", tags: ["garden"], content: SUGGESTED, updatedAt: T0 });
  row("sg2", "q2");
  const storeOfTyping = (method: string, path: string, body: string) => isPatch("q2")(method, path) && body.includes("typed live");
  await intercept(storeOfTyping, fail(500), async () => {
    await typeAndLeave("q2", "typed live");
    const waiting = await accept("sg2");
    assert.equal(waiting.status, 409);
    assert.equal(((await waiting.json()) as { live?: boolean }).live, true);
    assert.equal(vaultContent("q2"), SUGGESTED);
  });
  assert.equal((await accept("sg2")).status, 200);
  assert.match(vaultContent("q2"), /keep added tail/);
  assert.match(vaultContent("q2"), /typed live/, "the live changes were written before the suggestion was resolved");
});

// ── health ──────────────────────────────────────────────────────────────────

test("M3: pages whose changes have not reached the vault are reported in the worker health (and a page that cannot be saved at all is failing)", { timeout: 60_000 }, async () => {
  const collabSource = async () => (await getSourceHealth({ list: (async () => []) as never })).find((s) => s.name === "collab");
  assert.equal(await collabSource(), undefined, "nothing to report while everything is saved");
  fv.put({ id: "hl", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("hl", new Y.Doc());
  type(doc, "x");
  await intercept(isPatch("hl"), fail(413), () => storeDocumentState("hl", doc));
  const source = await collabSource();
  assert.ok(source, "reported");
  assert.equal(source!.status, "failing");
  assert.deepEqual({ unsaved: (source!.detail as Record<string, unknown>).unsaved, permanent: (source!.detail as Record<string, unknown>).permanent }, { unsaved: 1, permanent: 1 });
});

void collab;
