/**
 * POST /api/notes/:id/blocks/append — the editor's "Move to another page".
 *
 *  H2  a target that is OPEN LIVE keeps its unsaved typing: the blocks are
 *      appended through the live Y.Doc, not written over the vault copy;
 *  M5  a Markdown-bodied target stays Markdown (a code block with blank lines
 *      survives);
 *  L8  a repeated request id appends once; the same id with another body → 422;
 *      auth, CSRF, caps (unviewable == missing), system / locked / trashed, size.
 */
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { api } from "../src/routes/api";
import { addGrant, ensureUser } from "../src/db";
import { attachCollab, hocuspocus, isDocLive, resetReconcileState, reconcileLoadedDocs, yDocToHtml } from "../src/collab";
import { appendToBody } from "../src/routes/blocks";
import { stopConversionWorkers } from "../src/convert/service";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

// A live conversion thread keeps a test process from exiting: stop it when the file is done.
after(async () => {
  await stopConversionWorkers();
});

const EDITOR = "editor@test.local";
const VIEWER = "viewer@test.local";
const T0 = "2026-02-01T00:00:00.000Z";
const BLOCK = "<blockquote><p>Echo quote</p></blockquote>";
const J = { "content-type": "application/json" };

let fv: FakeVault;
let server: Server;
let wsUrl: string;
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];
const saved = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };

const grant = (email: string, resource: string, caps: string[]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: "tag", resource, level: "view", caps: caps as never, created_by: "test", vault_id: "primary" });
const append = (id: string, body: unknown, who = EDITOR, headers: Record<string, string> = {}) =>
  api.request(`/notes/${id}/blocks/append`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { cookie: sessionCookie(makeSession(who)), ...J, ...headers } });
const rid = (n: number) => `req-${String(n).padStart(8, "0")}`;

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  hocuspocus.configuration.debounce = 60_000; // human edits stay UNSAVED during a test
  hocuspocus.configuration.maxDebounce = 120_000;
  for (const e of [EDITOR, VIEWER]) ensureUser(e);
  grant(EDITOR, "garden", ["view", "comment", "suggest", "edit", "create"]);
  grant(VIEWER, "garden", ["view"]);
  fv.put({ id: "t1", tags: ["garden"], content: "<p>alpha</p><p>beta</p>", updatedAt: T0 });
  fv.put({ id: "md1", tags: ["garden"], content: "# Title\n\nSome *markdown* text.\n", updatedAt: T0 });
  server = createServer();
  server.on("connection", (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  attachCollab(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab?schema=${COLLAB_SCHEMA_VERSION}`;
});

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  hocuspocus.closeConnections();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
  hocuspocus.configuration.debounce = saved.debounce;
  hocuspocus.configuration.maxDebounce = saved.maxDebounce;
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
});

async function human(name: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: wsUrl, name, token: makeCapability("tag", "garden", "edit"), document: doc, awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime
    WebSocketPolyfill: WebSocket,
  });
  providers.push(provider);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync timeout")), 5000);
    provider.on("synced", () => { clearTimeout(t); resolve(); });
  });
  return doc;
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
function typeInParagraph(doc: Y.Doc, n: number, text: string) {
  const p = doc.getXmlFragment("default").get(n) as Y.XmlElement;
  const t = p.get(0) as Y.XmlText;
  t.insert(t.length, text);
}

test("H2: a target that is open live keeps its unsaved typing — the block is appended through the live document", { timeout: 20000 }, async () => {
  const hd = await human("t1");
  assert.ok(isDocLive("primary", "t1"));
  typeInParagraph(hd, 0, " UNSAVED-HUMAN");
  await settle();
  assert.equal(fv.notes.get("t1")!.content, "<p>alpha</p><p>beta</p>", "the human's typing is not in the vault yet");
  const res = await append("t1", { html: BLOCK, requestId: rid(1) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, live: true });
  await settle();
  // The human's own document has both: their typing and the moved block, at the end.
  assert.equal(yDocToHtml(hd), `<p>alpha UNSAVED-HUMAN</p><p>beta</p>${BLOCK}`);
  // …and the reconciler has nothing stale to fold back over it.
  await reconcileLoadedDocs(hocuspocus as never);
  await settle();
  assert.equal(yDocToHtml(hd), `<p>alpha UNSAVED-HUMAN</p><p>beta</p>${BLOCK}`);
  assert.equal(fv.notes.get("t1")!.content, `<p>alpha UNSAVED-HUMAN</p><p>beta</p>${BLOCK}`, "the store wrote the merged document");
  // More typing after the append still lands (no clock gap, nothing was replaced).
  typeInParagraph(hd, 1, " more");
  await settle();
  assert.match(yDocToHtml(hocuspocus.documents.get("t1") as unknown as Y.Doc), /<p>beta more<\/p>/);
});

test("not live: one compare-and-set append; HTML bodies get HTML, the response is confirmed", async () => {
  const res = await append("t1", { html: BLOCK, requestId: rid(2) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; live: boolean; updatedAt: string };
  assert.equal(body.live, false);
  assert.equal(fv.notes.get("t1")!.content, `<p>alpha</p><p>beta</p>${BLOCK}`);
  const patch = fv.calls.filter((c) => c.method === "PATCH");
  assert.equal(patch.length, 1);
  assert.equal((patch[0]!.body as { if_updated_at?: string }).if_updated_at, T0, "compare-and-set on the revision that was read, never forced");
  assert.equal((patch[0]!.body as { force?: boolean }).force, undefined);
});

test("M5: a Markdown-bodied target stays Markdown — a code block with blank lines survives", async () => {
  const html = '<h2>Moved</h2><pre><code class="language-js">const a = 1;\n\n\nconst b = 2;</code></pre><ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul>';
  assert.equal((await append("md1", { html, requestId: rid(3) })).status, 200);
  const out = fv.notes.get("md1")!.content;
  assert.ok(out.startsWith("# Title\n\nSome *markdown* text.\n\n"), out);
  assert.match(out, /## Moved/);
  assert.match(out, /```js\nconst a = 1;\n\n\nconst b = 2;\n```/);
  assert.doesNotMatch(out, /<pre|<h2|<ul/);
  // Blocks Markdown cannot say stay as HTML blocks (still valid Markdown).
  assert.match(await appendToBody("# T\n", '<div data-type="callout" data-emoji="💡"><p>note</p></div>'), /^# T\n\n<div data-type="callout"/);
});

test("L8: a repeated request id appends once; the same id with another body is refused", async () => {
  const first = await append("t1", { html: BLOCK, requestId: rid(4) });
  assert.equal(first.status, 200);
  const again = await append("t1", { html: BLOCK, requestId: rid(4) });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(fv.notes.get("t1")!.content, `<p>alpha</p><p>beta</p>${BLOCK}`, "appended exactly once");
  assert.equal((await append("t1", { html: "<p>other</p>", requestId: rid(4) })).status, 422);
  // Two concurrent invocations of one request append once.
  const [a, b] = await Promise.all([append("t1", { html: "<p>twice?</p>", requestId: rid(5) }), append("t1", { html: "<p>twice?</p>", requestId: rid(5) })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(fv.notes.get("t1")!.content.match(/twice\?/g)!.length, 1);
});

test("only valid document content is stored; scripts and handlers never reach the page", async () => {
  const res = await append("t1", { html: '<p onclick="x()">safe <img src="javascript:alert(1)"></p><script>alert(1)</script><iframe src="https://evil.example"></iframe>', requestId: rid(6) });
  assert.equal(res.status, 200);
  const out = fv.notes.get("t1")!.content;
  assert.doesNotMatch(out, /script|onclick|javascript:|iframe/i);
  assert.match(out, /<p>safe <\/p>$|<p>safe<\/p>$/);
});

test("auth, CSRF, caps and page state: unviewable == missing; view-only, locked, system and trashed pages are refused", async () => {
  fv.put({ id: "hidden", tags: ["elsewhere"], content: "<p>x</p>", updatedAt: T0 });
  fv.put({ id: "locked", tags: ["garden"], content: "<p>x</p>", metadata: { prism_locked: true }, updatedAt: T0 });
  fv.put({ id: "trashed", tags: ["garden", "prism-trashed"], content: "<p>x</p>", updatedAt: T0 });
  fv.put({ id: "skill", tags: ["garden", "agent-skill"], content: "<p>x</p>", updatedAt: T0 });
  fv.put({ id: "code", tags: ["garden"], path: "garden/tool.ts", content: "const a = 1;", updatedAt: T0 });
  const ok = { html: BLOCK, requestId: rid(7) };
  assert.equal((await api.request("/notes/t1/blocks/append", { method: "POST", body: JSON.stringify(ok), headers: J })).status, 401);
  assert.equal((await append("t1", ok, EDITOR, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await append("t1", ok, EDITOR, { "content-type": "text/plain" })).status, 415);
  assert.equal((await append("hidden", ok)).status, 404);
  assert.equal((await append("nope", ok)).status, 404);
  assert.equal((await append("trashed", ok)).status, 404);
  assert.equal((await append("t1", ok, VIEWER)).status, 403);
  assert.equal((await append("locked", ok)).status, 409);
  assert.equal((await append("skill", ok)).status, 403);
  assert.equal((await append("code", ok)).status, 400);
  for (const bad of [{ html: BLOCK }, { html: BLOCK, requestId: "short" }, { html: "", requestId: rid(8) }, { html: "plain text", requestId: rid(8) }, { html: BLOCK, requestId: rid(8), content: "<p>x</p>" }, { html: BLOCK, requestId: rid(8), if_exists: "replace" }]) {
    assert.equal((await append("t1", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await append("t1", { html: `<p>${"x".repeat(300_000)}</p>`, requestId: rid(9) })).status, 413);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0, "no refused request wrote anything");
  // A path alias the vault would resolve is never acted on.
  fv.put({ id: "aliased", path: "garden/alias", tags: ["garden"], content: "<p>x</p>", updatedAt: T0 });
  assert.equal((await append(encodeURIComponent("garden/alias"), ok)).status, 404);
});

// ── review H4: the conversion service (no parser, no full render on this thread) ──

test("H4: a LIVE page of 3,000 paragraphs takes an append (its size is measured off-thread, never rendered here)", { timeout: 120_000 }, async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `<p>Paragraph ${i} of a long page.</p>`).join("");
  fv.put({ id: "big", tags: ["garden"], content: big, updatedAt: T0 });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: wsUrl, name: "big", token: makeCapability("tag", "garden", "edit"), document: doc, awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime
    WebSocketPolyfill: WebSocket,
  });
  providers.push(provider);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync timeout")), 90_000);
    provider.on("synced", () => { clearTimeout(t); resolve(); });
  });
  assert.ok(isDocLive("primary", "big"));
  typeInParagraph(doc, 0, " UNSAVED-HUMAN");
  await settle();
  const res = await append("big", { html: BLOCK, requestId: rid(40) });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(await res.json(), { ok: true, live: true });
  const live = hocuspocus.documents.get("big")!;
  const frag = live.getXmlFragment("default");
  assert.equal(frag.length, 3001, "one block was added to the live document");
  assert.equal((frag.get(3000) as Y.XmlElement).nodeName, "blockquote");
  assert.match((frag.get(0) as Y.XmlElement).toString(), /UNSAVED-HUMAN/, "unsaved typing is intact");
  // Leave cleanly: the last socket closing stores (rendered in the worker) and then unloads.
  provider.destroy();
  providers.splice(providers.indexOf(provider), 1);
  for (let i = 0; i < 600 && hocuspocus.documents.has("big"); i++) await settle(100);
  assert.equal(hocuspocus.documents.has("big"), false);
  assert.match(fv.notes.get("big")!.content, /UNSAVED-HUMAN[\s\S]*Echo quote/, "typing and the moved block were stored");
});

test("H4: moving MANY blocks (3,000 paragraphs, nesting 60 deep) is converted off-thread — a 200 or a clean refusal, never a 502", { timeout: 120_000 }, async () => {
  const many = Array.from({ length: 3000 }, (_, i) => `<p>b${i}</p>`).join("");
  const res = await append("t1", { html: many, requestId: rid(41) });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((fv.notes.get("t1")!.content.match(/<p>b\d+<\/p>/g) ?? []).length, 3000);
  // A Markdown-bodied target gets them as Markdown — the HTML→Markdown step runs in the worker too.
  const md = await append("md1", { html: many, requestId: rid(42) });
  assert.equal(md.status, 200, JSON.stringify(await md.clone().json()));
  assert.match(fv.notes.get("md1")!.content, /^# Title\n\nSome \*markdown\* text\.\n\nb0\n\nb1\n/);
  const nested = `${"<blockquote>".repeat(60)}<p>deep</p>${"</blockquote>".repeat(60)}`;
  const deep = await append("t1", { html: nested, requestId: rid(43) });
  assert.ok([200, 413].includes(deep.status), `status ${deep.status}`);
});
