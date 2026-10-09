/**
 * The editor-schema handshake (C1). y-prosemirror DELETES every node/mark its
 * schema cannot represent, so a client built before the current document schema
 * must never hold a writable document — nor save one over REST.
 *
 *  - the schema's node/mark/attribute names are pinned to COLLAB_SCHEMA_VERSION:
 *    changing them without a bump fails here;
 *  - a REAL Hocuspocus server refuses a document socket with no / an older
 *    `schema` param (reason `update_required: …`), accepts the current one, and
 *    leaves code/sheet/canvas sockets and direct (MCP-style) connections alone;
 *  - REST content writes without `X-Prism-Editor-Schema` are refused (409
 *    `editor_update_required`) only when the stored note holds v2 content, on the
 *    owner passthrough and the non-owner route alike; metadata writes, plain notes,
 *    current clients and in-process MCP dispatches pass.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { getSchema } from "@tiptap/core";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { collabExtensions, COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { attachCollab, hocuspocus, resetReconcileState, UPDATE_REQUIRED_REASON, clientSchemaVersion } from "../src/collab";
import { createApp } from "../src/app";
import { api } from "../src/routes/api";
import { dispatchAsActor } from "../src/mcp/dispatch";
import { ensureUser, grantsForUser } from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

// ── 1. The schema is pinned to its version ───────────────────────────────────

/** Bump COLLAB_SCHEMA_VERSION and update this snapshot TOGETHER. */
const SCHEMA_V6 = {
  nodes: {
    attachment: ["kind", "mimeType", "name", "size", "src"], blockquote: ["blockColor"], bookmark: ["description", "favicon", "image", "siteName", "title", "url"], bulletList: ["blockColor"], callout: ["blockColor", "emoji"], childPage: ["pageId"], codeBlock: ["language", "suggestion", "suggestionBy"], column: ["width"], columns: [], databaseView: ["noteId", "viewId"], doc: [], embed: ["height", "url"], hardBreak: ["suggestion", "suggestionBy"], heading: ["blockColor", "level", "suggestion", "suggestionBy"], horizontalRule: [], image: ["align", "alt", "caption", "height", "src", "title", "width"], listItem: [], mention: ["date", "id", "kind", "label", "reminder", "suggestion", "suggestionBy", "uid"], orderedList: ["blockColor", "start", "type"], paragraph: ["blockColor", "suggestion", "suggestionBy"], table: [], tableCell: ["align", "cellColor", "colspan", "colwidth", "rowspan"], tableHeader: ["align", "cellColor", "colspan", "colwidth", "rowspan"], tableOfContents: [], tableRow: [], taskItem: ["checked"], taskList: ["blockColor"], text: [], toggle: ["blockColor", "level"], toggleSummary: ["suggestion", "suggestionBy"],
  },
  marks: {
    bold: [], code: [], comment: ["id", "resolved"], deletion: ["actorId", "color", "suggestionId", "turnId", "user"], highlight: ["color"], insertion: ["actorId", "color", "suggestionId", "turnId", "user"], italic: [], link: ["class", "href", "rel", "target", "title"], strike: [], textColor: ["color"], underline: [],
  },
};

test("the document schema's node, mark and attribute names match COLLAB_SCHEMA_VERSION", () => {
  const schema = getSchema(collabExtensions());
  const names = (spec: Record<string, { attrs?: Record<string, unknown> | null }>) =>
    Object.fromEntries(Object.keys(spec).sort().map((k) => [k, Object.keys(spec[k]!.attrs ?? {}).sort()]));
  const actual = {
    nodes: names(Object.fromEntries(Object.entries(schema.nodes).map(([k, v]) => [k, v.spec]))),
    marks: names(Object.fromEntries(Object.entries(schema.marks).map(([k, v]) => [k, v.spec]))),
  };
  assert.equal(COLLAB_SCHEMA_VERSION, 6, "bump the snapshot above together with the version");
  assert.deepEqual(actual, SCHEMA_V6, "a node/mark/attribute changed: bump COLLAB_SCHEMA_VERSION (packages/core/src/editor/collabSchema.ts) and update SCHEMA_V6");
});

test("every text block and every inline atom of the schema (line break, chip) can carry a suggestion record", () => {
  // editor/suggestionNodes lists the types by name: a new text block type must be added there,
  // or a paragraph break in front of it could not be suggested (Enter would stay untracked); an
  // inline atom without them would be put in / taken out as a plain edit while Suggesting.
  const schema = getSchema(collabExtensions());
  const missing = Object.values(schema.nodes).filter((type) => (type.isTextblock || (type.isInline && !type.isText)) && !("suggestion" in (type.spec.attrs ?? {}))).map((type) => type.name);
  assert.deepEqual(missing, []);
});

test("schema params parse strictly", () => {
  assert.equal(clientSchemaVersion(new URLSearchParams("schema=2")), 2);
  for (const bad of ["", "schema=", "schema=two", "schema=2.5", "schema=-1", "schema=1e3"]) assert.equal(clientSchemaVersion(new URLSearchParams(bad)), 0, bad);
});

// ── 2. The live socket ───────────────────────────────────────────────────────

const EDITOR = "editor@test.local";
let fv: FakeVault;
let server: Server;
let base: string;
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  server = createServer();
  server.on("connection", (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  attachCollab(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  ensureUser(EDITOR);
  grantUser(EDITOR, "tag", "team", "edit");
});

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  hocuspocus.closeConnections();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
});

/** Connect; resolves "synced" or the authentication-failure reason. */
function open(name: string, query: string, token = issueDeviceToken(EDITOR, "test", "prism-native").token): Promise<{ outcome: string; provider: HocuspocusProvider; doc: Y.Doc }> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${base}${query}`, name, token, document: doc, awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime (node has no global WebSocket)
    WebSocketPolyfill: WebSocket,
  });
  providers.push(provider);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no outcome")), 5000);
    provider.on("synced", () => { clearTimeout(t); resolve({ outcome: "synced", provider, doc }); });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => { clearTimeout(t); resolve({ outcome: reason, provider, doc }); });
  });
}

const V2 = '<div data-type="callout" data-emoji="💡"><p>keep me</p></div><p>plain</p>';

test("a document socket without the current schema is refused with update_required; the current one syncs", async () => {
  fv.put({ id: "d1", content: V2, tags: ["team"] });
  const missing = await open("d1", "");
  assert.equal(missing.outcome, UPDATE_REQUIRED_REASON);
  assert.match(missing.outcome, /^update_required: Prism was updated\. Reload or update the app to keep editing\.$/);
  const old = await open("d1", "?schema=1");
  assert.equal(old.outcome, UPDATE_REQUIRED_REASON);
  const junk = await open("d1", "?schema=latest");
  assert.equal(junk.outcome, UPDATE_REQUIRED_REASON);
  const current = await open("d1", `?schema=${COLLAB_SCHEMA_VERSION}`);
  assert.equal(current.outcome, "synced");
  assert.equal(current.provider.authorizedScope, "read-write");
  // The refused clients never received the document.
  assert.equal(missing.doc.getXmlFragment("default").length, 0);
});

test("refusal is not an oracle: an unauthorized client gets the ordinary denial", async () => {
  fv.put({ id: "d2", content: V2, tags: ["private"] });
  const stranger = await open("d2", "");
  assert.equal(stranger.outcome, "permission-denied");
});

test("code, spreadsheet and canvas sockets stay ungated", async () => {
  fv.put({ id: "c1", path: "scripts/tool.py", content: "print(1)", tags: ["team"] });
  fv.put({ id: "s1", path: "data/table.csv", content: "a,b\n1,2", tags: ["team"] });
  fv.put({ id: "k1", path: "boards/sketch", content: JSON.stringify({ elements: [] }), tags: ["team", "canvas"], metadata: { prism_type: "canvas" } });
  for (const id of ["c1", "s1", "k1"]) assert.equal((await open(id, "")).outcome, "synced", id);
});

test("direct connections (MCP tools, human commands) are not gated", async () => {
  fv.put({ id: "d3", content: V2, tags: ["team"] });
  const direct = await hocuspocus.openDirectConnection("d3", {});
  await direct.transact((doc) => { doc.getMap("probe").set("ok", true); });
  await direct.disconnect();
});

// ── 3. REST content writes ───────────────────────────────────────────────────

const OWNER = "owner@test.local";
const patch = (id: string, body: unknown, headers: Record<string, string> = {}, who = OWNER) =>
  api.request(`/notes/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { cookie: sessionCookie(makeSession(who)), ...headers } });

test("owner passthrough: a stale content write over v2 content is refused; current clients and metadata pass", async () => {
  fv.put({ id: "r1", content: V2, tags: [] });
  const stale = await patch("r1", { content: "<p>plain</p>" });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "editor_update_required", message: "Prism was updated. Reload or update the app to keep editing." });
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0, "nothing reached the vault");
  const older = await patch("r1", { content: "<p>plain</p>" }, { "X-Prism-Editor-Schema": "1" });
  assert.equal(older.status, 409);
  const meta = await patch("r1", { metadata: { icon: "🌱" } });
  assert.equal(meta.status, 200);
  const current = await patch("r1", { content: `${V2}<p>more</p>` }, { "X-Prism-Editor-Schema": String(COLLAB_SCHEMA_VERSION) });
  assert.equal(current.status, 200);
});

test("plain notes (and notes with only tables/images) accept writes from any caller", async () => {
  fv.put({ id: "r2", content: "<p>hello</p><table><tbody><tr><td><p>x</p></td></tr></tbody></table><img src=\"/a.png\">", tags: [] });
  assert.equal((await patch("r2", { content: "# Markdown" })).status, 200);
});

test("every v2, v3 and v4 marker counts", async () => {
  const markers = ['<div data-prism-database="db1" data-view="v1"></div>', '<div data-type="attachment" data-src="/api/attachments/a_1" data-kind="pdf"><a href="/api/attachments/a_1">r.pdf</a></div>', '<div data-type="embed" data-url="https://youtu.be/dQw4w9WgXcQ"></div>', '<div data-type="bookmark" data-url="https://example.com"></div>', '<div data-type="toc"></div>', '<img src="/a.png" data-align="center">', '<img src="/a.png" data-caption="c">', '<details data-type="toggle"><summary>s</summary><p>b</p></details>', '<div data-type="columns"><div data-type="column"><p>a</p></div><div data-type="column"><p>b</p></div></div>', '<p data-block-color="red">c</p>', '<p><span data-text-color="blue">t</span></p>', "<details><summary>x</summary></details>"];
  for (const [i, html] of markers.entries()) {
    fv.put({ id: `m${i}`, content: html, tags: [] });
    assert.equal((await patch(`m${i}`, { content: "<p>x</p>" })).status, 409, html);
  }
});

test("the non-owner route is gated the same way", async () => {
  ensureUser(EDITOR);
  grantUser(EDITOR, "tag", "team", "edit");
  fv.put({ id: "r3", content: V2, tags: ["team"] });
  assert.equal((await patch("r3", { content: "<p>x</p>" }, {}, EDITOR)).status, 409);
  assert.equal((await patch("r3", { content: `${V2}<p>y</p>` }, { "X-Prism-Editor-Schema": String(COLLAB_SCHEMA_VERSION) }, EDITOR)).status, 200);
  // A v2 client is stale since v3 (files/embeds/bookmarks/TOC/image captions).
  assert.equal((await patch("r3", { content: "<p>x</p>" }, { "X-Prism-Editor-Schema": "2" }, EDITOR)).status, 409);
});

test("v3: a stored mention chip refuses a v2 editor's content write", async () => {
  fv.put({ id: "m3", content: '<p>Hi <span data-type="mention" data-kind="person" data-id="p1" data-label="Ada">@Ada</span></p>', tags: [] });
  assert.equal((await patch("m3", { content: "<p>Hi @Ada</p>" }, { "X-Prism-Editor-Schema": "2" })).status, 409);
  assert.equal((await patch("m3", { content: "<p>Hi again</p>" }, { "X-Prism-Editor-Schema": String(COLLAB_SCHEMA_VERSION) })).status, 200);
  // v4: a v3 (mention-era) editor is stale over media/database blocks.
  fv.put({ id: "m4", content: '<div data-type="attachment" data-src="/api/attachments/a_1" data-kind="file"><a href="/api/attachments/a_1">f</a></div>', tags: [] });
  assert.equal((await patch("m4", { content: "<p>x</p>" }, { "X-Prism-Editor-Schema": "3" })).status, 409);
});

test("v5: child-page rows, toggle headings, column widths and cell colours refuse a v4 editor's content write", async () => {
  const markers = [
    '<div data-type="child-page" data-page-id="p1"></div>',
    '<details data-type="toggle" data-heading-level="2"><summary>s</summary><p>b</p></details>',
    '<div data-type="columns" data-count="2"><div data-type="column" data-col-width="1.5" style="flex-grow: 1.5"><p>a</p></div><div data-type="column"><p>b</p></div></div>',
    '<table><tbody><tr><td data-cell-color="blue"><p>x</p></td></tr></tbody></table>',
  ];
  for (const [i, html] of markers.entries()) {
    fv.put({ id: `v5-${i}`, content: html, tags: [] });
    assert.equal((await patch(`v5-${i}`, { content: "<p>x</p>" }, { "X-Prism-Editor-Schema": "4" })).status, 409, html);
    assert.equal((await patch(`v5-${i}`, { content: `${html}<p>y</p>` }, { "X-Prism-Editor-Schema": String(COLLAB_SCHEMA_VERSION) })).status, 200, html);
  }
});

test("L1: markers are read the way an HTML parser reads them — quotes, case and spacing do not hide one; plain look-alikes pass", async () => {
  const { needsEditorUpdate } = await import("../src/routes/api");
  for (const html of [
    "<div data-type='callout'><p>x</p></div>",
    '<DIV DATA-TYPE="Callout"><p>x</p></DIV>',
    '<div data-type = "toggle"><p>x</p></div>',
    "<div data-type=child-page data-page-id=p1></div>",
    "<p data-block-color = 'red'>x</p>",
    "<td DATA-CELL-COLOR=blue><p>x</p></td>",
    "<details\n><summary>s</summary></details>",
    "<DETAILS><summary>s</summary></DETAILS>",
    "<div data-prism-database\t=\t'db1'></div>",
    // v6: a suggested paragraph break / line break (an older editor would save the page without it).
    '<p>a</p><p data-suggestion-node="insert" data-suggestion-by="Ann">b</p>',
    '<p>a<br data-suggestion-node="delete" data-suggestion-by="Ann">b</p>',
    '<details data-type="toggle" data-heading-level = "2"><summary>s</summary></details>',
  ]) assert.equal(needsEditorUpdate(html), true, html);
  for (const html of ["<p>hello</p>", '<div data-type="other"><p>x</p></div>', "<p>the word data-type and data-block-color in prose</p>", "<p>&lt;detailsx&gt;</p>", "# Markdown with data-type=\"callout\" in text", "<detailsx>", '<p data-typeface="callout">x</p>']) {
    assert.equal(needsEditorUpdate(html), false, html);
  }
  // Linear on a pathological body.
  const t = performance.now();
  needsEditorUpdate("<p>" + "data-type ".repeat(200_000) + "</p>" + "<details".repeat(100_000));
  assert.ok(performance.now() - t < 500);
});

test("in-process MCP dispatches (agents) are exempt", async () => {
  ensureUser(EDITOR);
  grantUser(EDITOR, "tag", "team", "edit");
  fv.put({ id: "r4", content: V2, tags: ["team"] });
  const actor = { kind: "user" as const, email: EDITOR, role: "guest" as const, vaultId: "primary", grants: grantsForUser(EDITOR, "primary") };
  const res = await dispatchAsActor(createApp(), { actor, via: "pat" as const, credentialId: "pat_test", readOnly: false }, "/api/notes/r4", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Agent wrote **markdown**" }),
  });
  assert.equal(res.status, 200);
});

// ── 4. Opening a document never rewrites it ─────────────────────────────────

test("opening a live document with un-normalised block HTML writes nothing until someone edits", async () => {
  const stored = '<div data-type="columns"><div data-type="column"><p>a</p></div><div data-type="column"><p>b</p></div></div><details open><summary>s</summary><p>t</p></details>';
  fv.put({ id: "n1", content: stored, tags: ["team"] });
  const reader = await open("n1", `?schema=${COLLAB_SCHEMA_VERSION}`);
  assert.equal(reader.outcome, "synced");
  await new Promise((r) => setTimeout(r, 300));
  reader.provider.destroy();
  await new Promise((r) => setTimeout(r, 200));
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0, "no vault write (and so no history version) from merely opening");
  assert.equal(fv.notes.get("n1")!.content, stored);
});
