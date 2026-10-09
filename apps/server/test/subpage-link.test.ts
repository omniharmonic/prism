/**
 * NP-PG-15: a page created under a page whose editor is NOT open (the sidebar tree's "+").
 * The client asks `POST /api/notes/:id/blocks/append` to add the sub-page row to the
 * parent's stored body. Proven here, against the real route:
 *
 *  - an HTML parent gets the row and the parent → sub-page link is written (the route is
 *    not under the REST mention hook: it used to append rows and chips without linking);
 *  - a Markdown parent stays Markdown and carries the row as its HTML block;
 *  - a parent that is OPEN LIVE gets the row through the live document (typing survives);
 *  - a row the parent already lists is not added again, whoever asks and with whatever id;
 *  - a locked parent, a view-only member and an unviewable parent are refused, by name.
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
import { attachCollab, hocuspocus, isDocLive, resetReconcileState, yDocToHtml } from "../src/collab";
import { subPageRowsIn } from "../src/routes/blocks";
import { stopConversionWorkers } from "../src/convert/service";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

after(async () => {
  await stopConversionWorkers();
});

const EDITOR = "editor@test.local";
const OTHER = "other@test.local";
const VIEWER = "viewer@test.local";
const T0 = "2026-02-01T00:00:00.000Z";
const J = { "content-type": "application/json" };
const row = (id: string) => `<div data-type="child-page" data-page-id="${id}"></div>`;
/** What the client sends (`subPageLink.ts`): the row, and a request id derived from the sub-page. */
const link = (parent: string, child: string, who = EDITOR) =>
  api.request(`/notes/${parent}/blocks/append`, { method: "POST", body: JSON.stringify({ html: row(child), requestId: `subpage_${child}` }), headers: { cookie: sessionCookie(makeSession(who)), ...J } });

let fv: FakeVault;
let server: Server;
let wsUrl: string;
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];
const saved = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };
const grant = (email: string, caps: string[]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: "tag", resource: "garden", level: "view", caps: caps as never, created_by: "test", vault_id: "primary" });
const until = async <T>(what: string, read: () => T, ok: (v: T) => boolean, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const linksOf = (id: string) => (fv.notes.get(id)!.links ?? []).map((l) => [l.targetId, l.relationship]);
const count = (body: string, id: string) => body.split(`data-page-id="${id}"`).length - 1;

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  hocuspocus.configuration.debounce = 60_000;
  hocuspocus.configuration.maxDebounce = 120_000;
  for (const e of [EDITOR, OTHER, VIEWER]) ensureUser(e);
  grant(EDITOR, ["view", "comment", "suggest", "edit", "create"]);
  grant(OTHER, ["view", "comment", "suggest", "edit", "create"]);
  grant(VIEWER, ["view"]);
  fv.put({ id: "parent", path: "Plan", tags: ["garden"], content: "<p>alpha</p>", updatedAt: T0 });
  fv.put({ id: "parentmd", path: "Notes", tags: ["garden"], content: "# Title\n\nSome *markdown* text.\n", updatedAt: T0 });
  fv.put({ id: "kid", path: "Plan/Untitled", tags: ["garden"], content: "", updatedAt: T0 });
  fv.put({ id: "kid2", path: "Plan/Untitled 2", tags: ["garden"], content: "", updatedAt: T0 });
  fv.put({ id: "locked", path: "Locked", tags: ["garden"], content: "<p>kept</p>", metadata: { prism_locked: true }, updatedAt: T0 });
  fv.put({ id: "secret", path: "Secret", tags: ["elsewhere"], content: "<p>hidden</p>", updatedAt: T0 });
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

test("an HTML parent that is not open gets the row, and the parent links to the sub-page", async () => {
  const res = await link("parent", "kid");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; live: boolean; present?: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.live, false);
  assert.equal(body.present, undefined);
  const stored = fv.notes.get("parent")!.content;
  assert.ok(stored.startsWith("<p>alpha</p>"), "what was there is kept, in front");
  assert.deepEqual([...subPageRowsIn(stored)], ["kid"]);
  // The link is what puts the parent in the sub-page's backlinks and the graph.
  await until("the parent → sub-page link", () => linksOf("parent"), (l) => l.length === 1);
  assert.deepEqual(linksOf("parent"), [["kid", "mentions"]]);
});

test("a Markdown parent stays Markdown and carries the row as its HTML block", async () => {
  const res = await link("parentmd", "kid");
  assert.equal(res.status, 200);
  const stored = fv.notes.get("parentmd")!.content;
  assert.ok(stored.startsWith("# Title\n\nSome *markdown* text."), "the Markdown is untouched");
  assert.ok(!/<p>|<h1>/.test(stored), "not converted to HTML");
  assert.deepEqual([...subPageRowsIn(stored)], ["kid"], "the row is there, as the block the editor parses back");
  await until("the link", () => linksOf("parentmd"), (l) => l.length === 1);
});

test("a row the parent already lists is not added again — the same request, another request id, another member", async () => {
  assert.equal((await link("parent", "kid")).status, 200);
  const once = fv.notes.get("parent")!.content;
  // The same request again (a retry, a second device with the same derived id).
  const replay = await link("parent", "kid");
  assert.equal(replay.status, 200);
  // Another request id (an older client, a hand-made request) and another member.
  const other = await api.request("/notes/parent/blocks/append", { method: "POST", body: JSON.stringify({ html: row("kid"), requestId: "another-request-1" }), headers: { cookie: sessionCookie(makeSession(OTHER)), ...J } });
  assert.equal(other.status, 200);
  assert.deepEqual(await other.json(), { ok: true, live: false, present: true });
  assert.equal(fv.notes.get("parent")!.content, once, "nothing was written");
  assert.equal(count(once, "kid"), 1);
  // Two rows of which one is new: only the new one is added.
  const both = await api.request("/notes/parent/blocks/append", { method: "POST", body: JSON.stringify({ html: row("kid") + row("kid2"), requestId: "another-request-2" }), headers: { cookie: sessionCookie(makeSession(OTHER)), ...J } });
  assert.equal(both.status, 200);
  const after = fv.notes.get("parent")!.content;
  assert.equal(count(after, "kid"), 1);
  assert.equal(count(after, "kid2"), 1);
  // A row in a body written by hand, with the attributes the other way round, counts as listed too.
  fv.put({ id: "hand", path: "Hand", tags: ["garden"], content: `<div data-page-id='kid' data-type='child-page'></div>`, updatedAt: T0 });
  const hand = await link("hand", "kid");
  assert.deepEqual(await hand.json(), { ok: true, live: false, present: true });
});

test("a parent that is open live gets the row through the live document — unsaved typing survives, no second row", { timeout: 300_000 }, async () => {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: wsUrl, name: "parent", token: makeCapability("tag", "garden", "edit"), document: doc, awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime
    WebSocketPolyfill: WebSocket,
  });
  providers.push(provider);
  await new Promise<void>((resolve) => provider.on("synced", () => resolve()));
  assert.ok(isDocLive("primary", "parent"));
  const p = doc.getXmlFragment("default").get(0) as Y.XmlElement;
  (p.get(0) as Y.XmlText).insert(5, " UNSAVED");
  await until("the typing reached the server's document", () => yDocToHtml(hocuspocus.documents.get("parent") as Y.Doc), (h) => h.includes("UNSAVED"));
  const res = await link("parent", "kid");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, live: true });
  const html = await until("the row reached the person's editor", () => yDocToHtml(doc), (h) => h.includes('data-page-id="kid"'));
  assert.ok(html.includes("alpha UNSAVED"), "the typing is still there");
  // Asked again under another id while it is open: the live document already lists it.
  const again = await api.request("/notes/parent/blocks/append", { method: "POST", body: JSON.stringify({ html: row("kid"), requestId: "another-request-3" }), headers: { cookie: sessionCookie(makeSession(OTHER)), ...J } });
  assert.deepEqual(await again.json(), { ok: true, live: true, present: true });
  assert.equal(count(yDocToHtml(hocuspocus.documents.get("parent") as Y.Doc), "kid"), 1);
});

test("refusals name the reason and write nothing: a locked parent, a view-only member, a parent the member cannot see", async () => {
  const locked = await link("locked", "kid");
  assert.equal(locked.status, 409);
  assert.equal(((await locked.json()) as { error: string }).error, "locked");
  assert.equal(fv.notes.get("locked")!.content, "<p>kept</p>");
  const viewer = await link("parent", "kid", VIEWER);
  assert.equal(viewer.status, 403);
  assert.equal(fv.notes.get("parent")!.content, "<p>alpha</p>");
  const unseen = await link("secret", "kid");
  assert.equal(unseen.status, 404, "unviewable == missing");
  assert.equal(fv.notes.get("secret")!.content, "<p>hidden</p>");
  assert.deepEqual(linksOf("parent"), []);
});
