/**
 * WP6.3 — collab-safe MCP tools, against a REAL in-process Hocuspocus server
 * (the module singleton, attached to a throwaway HTTP server) with real
 * HocuspocusProvider "human" clients over WebSockets, and the MCP endpoint driven
 * in-process. Pins:
 *
 *  - prism_update_note on a LIVE doc merges through Yjs: a concurrent (unsaved)
 *    human edit and the agent's edit BOTH survive — document, code, spreadsheet
 *    (cell-level, no row doubling) and canvas (per-element upsert, version bump);
 *  - if_updated_at on a live doc: stale → conflict; no safe merge base → conflict
 *    {live, retry}; the direct connection is closed afterwards;
 *  - a metadata-only write to a live doc does not let the reconciler revert
 *    unsaved human typing;
 *  - comments add/reply/resolve round trip, visible to an editor-shaped client
 *    (comments Y.Map + `comment` marks); suggestions carry the actor attribution
 *    and land in the durable review queue;
 *  - sheet_read / sheet_update (live: cell-level beside a concurrent cell edit;
 *    not live: CSV through the gateway with if_updated_at);
 *  - the permission matrix (viewer / commenter / suggester / editor, private
 *    notes) and PARITY of collabAccess with the socket's resolveLevel;
 *  - a create path conflict reads "a note already exists at <path>".
 */
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { addGrant, addVaultEntry, grantsForCapability, removeGrant, upsertGrant, ensureUser, grantsForUser, suggestionsForNote, setUserProfile } from "../src/db";
import { signCapability, verifyCapability } from "../src/auth/capability";
import { issuePat } from "../src/auth/pat";
import { attachCollab, collabSchema, hocuspocus, revalidateLiveAccess, reconcileLoadedDocs, resetReconcileState, resolveLevel, yDocToHtml } from "../src/collab";
import { collabAccess } from "../src/mcp/tool-collab";
import { workspaceRole } from "../src/roles";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const EDITOR = "editor@test.local";
const SUGGESTER = "suggester@test.local";
const COMMENTER = "commenter@test.local";
const VIEWER = "viewer@test.local";
const OTHER = "someone-else@test.local";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let server: Server;
let wsUrl: string;
let ip: string;
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];
const savedDebounce = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };

const T0 = "2026-02-01T00:00:00.000Z";
const SCENE = (els: unknown[]) => JSON.stringify({ type: "excalidraw", elements: els, appState: {} });

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  // Human edits must stay UNSAVED for the duration of a test (the default 2 s
  // store debounce would race the assertions). MCP writes still store at once:
  // DirectConnection.disconnect() stores immediately.
  hocuspocus.configuration.debounce = 60_000;
  hocuspocus.configuration.maxDebounce = 120_000;
  for (const e of [EDITOR, SUGGESTER, COMMENTER, VIEWER, OTHER]) ensureUser(e);
  setUserProfile(EDITOR, { name: "Ed Itor" });
  grant(EDITOR, "tag", "garden", ["view", "comment", "suggest", "edit", "create"]);
  grant(SUGGESTER, "tag", "garden", ["view", "comment", "suggest"]);
  grant(COMMENTER, "tag", "garden", ["view", "comment"]);
  grant(VIEWER, "tag", "garden", ["view"]);
  // Give the weaker accounts a write cap elsewhere, so the write tools are LISTED
  // for them and the per-note decision is what gets tested.
  for (const e of [COMMENTER, VIEWER]) grant(e, "tag", "elsewhere", ["view", "suggest", "edit"]);
  grant(SUGGESTER, "tag", "elsewhere", ["view", "edit"]);

  fv.put({ id: "d1", tags: ["garden"], content: "<p>alpha</p><p>beta</p>", updatedAt: T0 });
  fv.put({ id: "code1", tags: ["garden"], path: "garden/tool.ts", content: "const a = 1;\nconst b = 2;\n", updatedAt: T0 });
  fv.put({ id: "sh1", tags: ["garden"], path: "garden/data.csv", content: "a,b,c\n1,2,3", updatedAt: T0 });
  fv.put({
    id: "cv1",
    tags: ["garden"],
    content: SCENE([
      { id: "e1", type: "rectangle", x: 0, y: 0, version: 1 },
      { id: "e2", type: "ellipse", x: 10, y: 10, version: 1 },
    ]),
    updatedAt: T0,
  });
  fv.put({ id: "priv", tags: ["garden"], content: "<p>private words</p>", metadata: { prism_creator: OTHER, prism_visibility: "private" }, updatedAt: T0 });

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
  hocuspocus.closeConnections();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
  hocuspocus.configuration.debounce = savedDebounce.debounce;
  hocuspocus.configuration.maxDebounce = savedDebounce.maxDebounce;
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
});

function grant(email: string, type: "tag" | "note", resource: string, caps: string[]) {
  addGrant({ subject_type: "user", subject: email, resource_type: type, resource, level: "view", caps: caps as never, created_by: "test", vault_id: "primary" });
}

// ── MCP client plumbing (same shape as mcp-tools.test.ts) ───────────────────
const pat = (email: string) => issuePat({ email, vaultId: "primary", scope: "write" }).token;
async function connectMcp(email: string): Promise<Client> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip, "x-forwarded-for": ip, authorization: `Bearer ${pat(email)}` };
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
type Out = { ok: true; data: any } | { ok: false; error: string; message?: string; detail?: any };
async function call(cl: Client, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  try {
    const r: any = await cl.callTool({ name, arguments: args });
    if (r.isError) {
      const sc = r.structuredContent;
      return sc && typeof sc.error === "string" ? { ok: false, error: sc.error, message: sc.message, detail: sc.detail } : { ok: false, error: "protocol", message: JSON.stringify(r.content) };
    }
    return { ok: true, data: r.structuredContent };
  } catch (e) {
    return { ok: false, error: "protocol", message: String((e as Error).message) };
  }
}
const must = (o: Out): any => {
  assert.ok(o.ok, `expected success, got ${JSON.stringify(o)}`);
  return (o as { data: any }).data;
};
const refused = (o: Out, code: string) => {
  assert.ok(!o.ok, `expected ${code}, got success ${JSON.stringify(o)}`);
  assert.equal((o as { error: string }).error, code, JSON.stringify(o));
};

// ── human client plumbing (a CollabEditor-shaped Yjs peer) ──────────────────
async function human(name: string, token = makeCapability("tag", "garden", "edit")): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name,
    token,
    document: doc,
    awareness: null, // see comment-level.test.ts: avoids a leaked Awareness interval
    // @ts-expect-error WebSocketPolyfill is accepted at runtime
    WebSocketPolyfill: WebSocket,
  });
  providers.push(provider);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync timeout")), 5000);
    provider.on("synced", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return doc;
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const serverDoc = (name: string) => hocuspocus.documents.get(name) as (Y.Doc & { getConnectionsCount(): number }) | undefined;

/** The human types at the end of the Nth paragraph (TipTap's XmlText inside a paragraph element). */
function typeInParagraph(doc: Y.Doc, n: number, text: string) {
  const p = doc.getXmlFragment("default").get(n) as Y.XmlElement;
  const t = p.get(0) as Y.XmlText;
  t.insert(t.length, text);
}

// ── document ────────────────────────────────────────────────────────────────

test("document: an unsaved human edit and a concurrent MCP update_note BOTH survive (three-way merge via Yjs)", { timeout: 20000 }, async () => {
  const hd = await human("d1");
  const ed = await connectMcp(EDITOR);
  const read = must(await call(ed, "prism_get_note", { id: "d1" }));
  assert.deepEqual(read.collab, { kind: "document", live: true });

  typeInParagraph(hd, 0, " HUMAN"); // after the agent's read, never stored (debounce is long)
  await settle();
  assert.match(yDocToHtml(serverDoc("d1")!), /alpha HUMAN/, "server has the human edit");
  assert.equal(fv.notes.get("d1")!.content, "<p>alpha</p><p>beta</p>", "…but it is unsaved");

  const r = must(await call(ed, "prism_update_note", { id: "d1", content: "<p>alpha</p><p>beta AGENT</p>", if_updated_at: read.updatedAt }));
  assert.deepEqual(r.collab, { live: true, changed: true });
  const vault = fv.notes.get("d1")!.content;
  assert.match(vault, /alpha HUMAN/, "the human's unsaved edit survived the agent's write");
  assert.match(vault, /beta AGENT/, "the agent's edit landed");
  assert.equal(r.updatedAt, fv.notes.get("d1")!.updatedAt, "returns the post-merge updatedAt");

  await settle();
  const humanHtml = yDocToHtml(hd);
  assert.match(humanHtml, /alpha HUMAN/);
  assert.match(humanHtml, /beta AGENT/, "the human's editor received the agent's edit live");
  assert.equal(serverDoc("d1")!.getConnectionsCount(), 1, "the MCP direct connection was closed (only the human remains)");
});

test("document: markdown content is merged too, and a no-op write reports changed=false", { timeout: 20000 }, async () => {
  await human("d1");
  const ed = await connectMcp(EDITOR);
  const t = must(await call(ed, "prism_get_note", { id: "d1" })).updatedAt;
  const r = must(await call(ed, "prism_update_note", { id: "d1", content: "alpha\n\n**beta**", if_updated_at: t }));
  assert.equal(r.collab.changed, true);
  assert.match(fv.notes.get("d1")!.content, /<strong>beta<\/strong>/);
  const t2 = fv.notes.get("d1")!.updatedAt!;
  const again = must(await call(ed, "prism_update_note", { id: "d1", content: "alpha\n\n**beta**", if_updated_at: t2 }));
  assert.equal(again.collab.changed, false);
});

test("live if_updated_at: stale → conflict (doc untouched); no safe merge base → conflict {live, retry}", { timeout: 20000 }, async () => {
  await human("d1");
  const ed = await connectMcp(EDITOR);
  const stale = await call(ed, "prism_update_note", { id: "d1", content: "<p>x</p>", if_updated_at: "2025-01-01T00:00:00.000Z" });
  refused(stale, "conflict");
  assert.deepEqual(stale.ok ? null : stale.detail, { id: "d1", updatedAt: T0 });
  assert.match(yDocToHtml(serverDoc("d1")!), /alpha/);
  assert.equal(fv.notes.get("d1")!.content, "<p>alpha</p><p>beta</p>");

  // An external vault write the live doc has not absorbed yet: the agent read the
  // NEW version, but the live doc's persisted base is still the old one.
  const n = fv.notes.get("d1")!;
  n.content = "<p>alpha</p><p>beta</p><p>external</p>";
  n.updatedAt = "2026-03-01T00:00:00.000Z";
  const noBase = await call(ed, "prism_update_note", { id: "d1", content: "<p>mine</p>", if_updated_at: n.updatedAt });
  refused(noBase, "conflict");
  assert.deepEqual(noBase.ok ? null : noBase.detail, { live: true, retry: true });
  assert.equal(serverDoc("d1")!.getConnectionsCount(), 1, "closed even on refusal");

  // Once the reconciler folds it in (and the fold is stored), the retry succeeds.
  await reconcileLoadedDocs(hocuspocus as never);
  hocuspocus.flushPendingStores();
  await settle();
  const cur = fv.notes.get("d1")!.updatedAt!;
  must(await call(ed, "prism_update_note", { id: "d1", content: "<p>alpha</p><p>beta</p><p>external</p><p>mine</p>", if_updated_at: cur }));
  assert.match(fv.notes.get("d1")!.content, /external.*mine/s);
});

test("metadata-only write to a live doc does not let the reconciler revert unsaved human typing", { timeout: 20000 }, async () => {
  const hd = await human("d1");
  const ed = await connectMcp(EDITOR);
  typeInParagraph(hd, 1, " TYPING");
  await settle();
  must(await call(ed, "prism_update_note", { id: "d1", metadata: { reviewed: true }, if_updated_at: T0 }));
  await reconcileLoadedDocs(hocuspocus as never);
  await settle();
  assert.match(yDocToHtml(serverDoc("d1")!), /beta TYPING/, "the fold was skipped — the vault copy carried no new content");
  assert.match(yDocToHtml(hd), /beta TYPING/);
});

test("not live: update_note stays on the REST path and loads no doc", async () => {
  const ed = await connectMcp(EDITOR);
  const r = must(await call(ed, "prism_update_note", { id: "d1", content: "<p>rest</p>", if_updated_at: T0 }));
  assert.equal(r.collab, undefined);
  assert.equal(fv.notes.get("d1")!.content, "<p>rest</p>");
  assert.equal(hocuspocus.documents.has("d1"), false);
});

// ── code ────────────────────────────────────────────────────────────────────

test("code: minimal Y.Text diff — the human's unsaved line and the agent's change both survive", { timeout: 20000 }, async () => {
  const hc = await human("code1");
  const ed = await connectMcp(EDITOR);
  const read = must(await call(ed, "prism_get_note", { id: "code1" }));
  assert.equal(read.collab.kind, "code");
  hc.getText("codemirror").insert(0, "// human\n");
  await settle();
  must(await call(ed, "prism_update_note", { id: "code1", content: "const a = 1;\nconst b = 42;\n", if_updated_at: read.updatedAt }));
  assert.equal(fv.notes.get("code1")!.content, "// human\nconst a = 1;\nconst b = 42;\n");
  await settle();
  assert.equal(hc.getText("codemirror").toString(), "// human\nconst a = 1;\nconst b = 42;\n");
});

// ── spreadsheet ─────────────────────────────────────────────────────────────

const csvOf = (d: Y.Doc) =>
  d
    .getArray<Y.Array<string>>("rows")
    .toArray()
    .map((r) => r.toArray().join(","))
    .join("\n");

test("sheet_update on a live sheet is cell-level: a concurrent human cell edit is intact", { timeout: 20000 }, async () => {
  const hs = await human("sh1");
  const ed = await connectMcp(EDITOR);
  // Human edits A1 exactly as CollabSpreadsheet.setCell does (unsaved).
  const row0 = hs.getArray<Y.Array<string>>("rows").get(0);
  hs.transact(() => {
    row0.delete(0, 1);
    row0.insert(0, ["HUMAN"]);
  });
  await settle();
  const r = must(await call(ed, "prism_sheet_update", { id: "sh1", range: "B2", values: [["AGENT"]] }));
  assert.equal(r.live, true);
  assert.equal(r.cellsChanged, 1);
  assert.equal(fv.notes.get("sh1")!.content, "HUMAN,b,c\n1,AGENT,3");
  await settle();
  assert.equal(csvOf(hs), "HUMAN,b,c\n1,AGENT,3");

  // Growing the sheet pads new rows/cols; a rectangle must match values' shape.
  must(await call(ed, "prism_sheet_update", { id: "sh1", range: "D3", values: [["x", "y"]] }));
  assert.equal(fv.notes.get("sh1")!.content, "HUMAN,b,c\n1,AGENT,3\n,,,x,y");
  refused(await call(ed, "prism_sheet_update", { id: "sh1", range: "A1:B2", values: [["1"]] }), "invalid_request");
  refused(await call(ed, "prism_sheet_update", { id: "sh1", range: "A1", values: [["a,b"]] }), "invalid_request");
  refused(await call(ed, "prism_sheet_update", { id: "sh1", range: "ZZZZ1", values: [["a"]] }), "invalid_request");

  const read = must(await call(ed, "prism_sheet_read", { id: "sh1", range: "A1:B2" }));
  assert.deepEqual(read.values, [["HUMAN", "b"], ["1", "AGENT"]]);
  assert.equal(read.live, true);
});

test("update_note content on a live sheet diffs cell by cell (no row doubling, human cell kept)", { timeout: 20000 }, async () => {
  const hs = await human("sh1");
  const ed = await connectMcp(EDITOR);
  const t = must(await call(ed, "prism_get_note", { id: "sh1" })).updatedAt;
  const row0 = hs.getArray<Y.Array<string>>("rows").get(0);
  hs.transact(() => {
    row0.delete(2, 1);
    row0.insert(2, ["C-HUMAN"]);
  });
  await settle();
  must(await call(ed, "prism_update_note", { id: "sh1", content: "a,b,c\n1,2,3\n4,5,6", if_updated_at: t }));
  assert.equal(fv.notes.get("sh1")!.content, "a,b,C-HUMAN\n1,2,3\n4,5,6");
  await settle();
  assert.equal(csvOf(hs), "a,b,C-HUMAN\n1,2,3\n4,5,6");
});

test("sheet tools when NOT live: read the saved CSV; write through the gateway with if_updated_at", async () => {
  const ed = await connectMcp(EDITOR);
  const all = must(await call(ed, "prism_sheet_read", { id: "sh1" }));
  assert.deepEqual(all.values, [["a", "b", "c"], ["1", "2", "3"]]);
  assert.equal(all.range, "A1:C2");
  assert.equal(all.live, false);
  refused(await call(ed, "prism_sheet_update", { id: "sh1", range: "A1", values: [["z"]], if_updated_at: "2025-01-01T00:00:00.000Z" }), "conflict");
  const r = must(await call(ed, "prism_sheet_update", { id: "sh1", range: "C2", values: [["9"]], if_updated_at: T0 }));
  assert.equal(r.live, false);
  assert.equal(fv.notes.get("sh1")!.content, "a,b,c\n1,2,9");
  const patch = fv.calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/notes/sh1")).pop()!;
  assert.equal((patch.body as any).if_updated_at, T0, "the CSV write carries the concurrency token");
  assert.equal(hocuspocus.documents.has("sh1"), false);
  refused(await call(ed, "prism_sheet_read", { id: "d1" }), "invalid_request");
});

// ── canvas ──────────────────────────────────────────────────────────────────

test("canvas: per-element upsert by id — changed elements bumped, a concurrent human element edit kept, removed ids dropped", { timeout: 20000 }, async () => {
  const hcv = await human("cv1");
  const ed = await connectMcp(EDITOR);
  const read = must(await call(ed, "prism_get_note", { id: "cv1" }));
  assert.equal(read.collab.kind, "canvas");
  // The human moves e2 (unsaved) after the agent's read.
  hcv.getMap("elements").set("e2", { id: "e2", type: "ellipse", x: 99, y: 99, version: 5 });
  await settle();
  // The agent moves e1, leaves e2 as it read it, adds e3.
  const content = SCENE([
    { id: "e1", type: "rectangle", x: 50, y: 0, version: 1 },
    { id: "e2", type: "ellipse", x: 10, y: 10, version: 1 },
    { id: "e3", type: "diamond", x: 5, y: 5, version: 1 },
  ]);
  must(await call(ed, "prism_update_note", { id: "cv1", content, if_updated_at: read.updatedAt }));
  const els = new Map((JSON.parse(fv.notes.get("cv1")!.content).elements as any[]).map((e) => [e.id, e]));
  assert.equal(els.get("e1").x, 50);
  assert.ok(els.get("e1").version > 1, "changed element's version bumped past the stored one");
  assert.equal(els.get("e2").x, 99, "the human's concurrent move of an element the agent did not change survived");
  assert.ok(els.has("e3"));
  refused(await call(ed, "prism_update_note", { id: "cv1", content: "<p>not a scene</p>", if_updated_at: fv.notes.get("cv1")!.updatedAt }), "invalid_request");
  assert.equal(JSON.parse(fv.notes.get("cv1")!.content).elements.length, 3, "a non-scene body never wipes the canvas");
});

// ── comments + suggestions ──────────────────────────────────────────────────

function commentMarks(doc: Y.Doc): Array<{ text: string; id: string; resolved: boolean }> {
  const pm = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("default"), collabSchema());
  const out: Array<{ text: string; id: string; resolved: boolean }> = [];
  pm.descendants((n) => {
    for (const m of n.marks) if (m.type.name === "comment") out.push({ text: n.text ?? "", id: String(m.attrs.id), resolved: !!m.attrs.resolved });
  });
  return out;
}

test("comments: add (anchored) → reply → resolve round trip, visible to an editor-shaped client; doc unloads after", { timeout: 20000 }, async () => {
  const ed = await connectMcp(EDITOR);
  const added = must(await call(ed, "prism_add_comment", { id: "d1", quote: "eta", text: "Is this right?" }));
  assert.equal(added.reply, false);
  const tid = added.thread_id as string;
  assert.equal(hocuspocus.documents.has("d1"), false, "not live before → unloaded after (connection closed)");
  assert.match(fv.notes.get("d1")!.content, new RegExp(`data-comment-id="${tid}"`), "the anchor mark was persisted");

  must(await call(ed, "prism_add_comment", { id: "d1", thread_id: tid, text: "Following up." }));
  let list = must(await call(ed, "prism_list_comments", { id: "d1" }));
  assert.equal(list.count, 1);
  assert.equal(list.threads[0].quote, "eta");
  assert.equal(list.threads[0].anchored, true);
  assert.deepEqual(
    list.threads[0].comments.map((c: any) => [c.author, c.text, c.agent]),
    [
      ["Ed Itor (agent)", "Is this right?", true],
      ["Ed Itor (agent)", "Following up.", true],
    ],
  );

  // A human opens the doc: they see the thread (comments Y.Map) and the anchor mark.
  const hd = await human("d1");
  const th = hd.getMap<Y.Map<unknown>>("comments").get(tid)!;
  assert.equal(th.get("resolved"), false);
  assert.equal((th.get("comments") as Y.Array<unknown>).length, 2);
  assert.deepEqual(commentMarks(hd), [{ text: "eta", id: tid, resolved: false }]);

  // Resolve while live: the flag AND the mark's resolved attr reach the human.
  must(await call(ed, "prism_resolve_comment", { id: "d1", thread_id: tid }));
  await settle();
  assert.equal(th.get("resolved"), true);
  assert.deepEqual(commentMarks(hd), [{ text: "eta", id: tid, resolved: true }]);
  assert.equal(must(await call(ed, "prism_list_comments", { id: "d1" })).count, 0, "resolved threads hidden by default");
  list = must(await call(ed, "prism_list_comments", { id: "d1", include_resolved: true }));
  assert.equal(list.threads[0].resolved, true);
  refused(await call(ed, "prism_add_comment", { id: "d1", thread_id: tid, text: "late" }), "invalid_request");
  must(await call(ed, "prism_resolve_comment", { id: "d1", thread_id: tid, resolved: false }));

  refused(await call(ed, "prism_add_comment", { id: "d1", quote: "not in the doc", text: "x" }), "invalid_request");
  refused(await call(ed, "prism_add_comment", { id: "d1", text: "neither" }), "invalid_request");
  refused(await call(ed, "prism_resolve_comment", { id: "d1", thread_id: "nope" }), "not_found");
  refused(await call(ed, "prism_add_comment", { id: "sh1", quote: "a", text: "x" }), "invalid_request");
});

test("suggest_edit: deletion + insertion marks attributed to the actor, captured in the review queue", { timeout: 20000 }, async () => {
  const hd = await human("d1");
  const sg = await connectMcp(SUGGESTER);
  const proposed = must(await call(sg, "prism_suggest_edit", { id: "d1", find: "beta", replace: "gamma" }));
  assert.match(proposed.suggestion_id, /^[a-f0-9-]{36}$/);
  await settle();
  const pm = yXmlFragmentToProseMirrorRootNode(hd.getXmlFragment("default"), collabSchema());
  const marks: Array<[string, string, string]> = [];
  pm.descendants((n) => {
    for (const m of n.marks) if (m.type.name === "insertion" || m.type.name === "deletion") marks.push([m.type.name, n.text ?? "", String(m.attrs.user)]);
  });
  assert.deepEqual(marks, [
    ["deletion", "beta", "Member (agent)"],
    ["insertion", "gamma", "Member (agent)"],
  ]);
  const html = fv.notes.get("d1")!.content;
  assert.equal((html.match(new RegExp(`data-suggestion-id="${proposed.suggestion_id}"`, "g")) ?? []).length, 2);
  assert.match(html, /data-actor-id="suggester@test.local"/);
  assert.match(html, /data-suggestion="delete"[^>]*data-user="Member \(agent\)"/);
  const queued = suggestionsForNote("d1").filter((s) => s.status === "pending");
  assert.deepEqual(queued.map((s) => s.author), ["Member (agent)"], "the owner's review queue has it");
  refused(await call(sg, "prism_suggest_edit", { id: "d1", find: "absent", replace: "x" }), "invalid_request");
});

test("suggest_edit refuses repeated quotes and overlapping pending changes without changing the document", { timeout: 20000 }, async () => {
  fv.put({ id: "d1", tags: ["garden"], content: "<p>beta beta</p><p>beta</p>", updatedAt: T0 });
  const hd = await human("d1");
  const sg = await connectMcp(SUGGESTER);
  const before = yDocToHtml(hd);
  refused(await call(sg, "prism_suggest_edit", { id: "d1", find: "beta", replace: "wrong passage" }), "conflict");
  await settle();
  assert.equal(yDocToHtml(hd), before);
  must(await call(sg, "prism_suggest_edit", { id: "d1", find: "beta beta", replace: "one passage" }));
  await settle();
  const suggested = yDocToHtml(hd);
  refused(await call(sg, "prism_suggest_edit", { id: "d1", find: "beta beta", replace: "overwrite earlier proposal" }), "conflict");
  refused(await call(sg, "prism_suggest_edit", { id: "d1", find: "one passage", replace: "edit pending insertion" }), "conflict");
  await settle();
  assert.equal(yDocToHtml(hd), suggested);
});

// ── permissions ─────────────────────────────────────────────────────────────

test("permission matrix: viewer / commenter / suggester / editor; private note invisible", { timeout: 20000 }, async () => {
  await human("d1"); // live, so update_note takes the Yjs path
  const v = await connectMcp(VIEWER);
  const c = await connectMcp(COMMENTER);
  const s = await connectMcp(SUGGESTER);
  const e = await connectMcp(EDITOR);

  // view: read yes, every write no
  must(await call(v, "prism_list_comments", { id: "d1" }));
  must(await call(v, "prism_sheet_read", { id: "sh1" }));
  for (const [tool, args] of [
    ["prism_add_comment", { id: "d1", quote: "alpha", text: "x" }],
    ["prism_suggest_edit", { id: "d1", find: "alpha", replace: "x" }],
    ["prism_sheet_update", { id: "sh1", range: "A1", values: [["x"]] }],
    ["prism_update_note", { id: "d1", content: "<p>x</p>", if_updated_at: T0 }],
  ] as const) refused(await call(v, tool, args), "forbidden");

  // comment level: may NOT comment (same rule as the editor/socket — comments need suggest)
  const cc = await call(c, "prism_add_comment", { id: "d1", quote: "alpha", text: "x" });
  refused(cc, "forbidden");
  assert.match(String(!cc.ok && cc.message), /suggest/);
  refused(await call(c, "prism_suggest_edit", { id: "d1", find: "alpha", replace: "x" }), "forbidden");

  // suggest level: comment, resolve, suggest — but not edit content or cells
  const t = must(await call(s, "prism_add_comment", { id: "d1", quote: "alpha", text: "hi" })).thread_id;
  must(await call(s, "prism_resolve_comment", { id: "d1", thread_id: t }));
  must(await call(s, "prism_suggest_edit", { id: "d1", find: "alpha", replace: "ALPHA" }));
  refused(await call(s, "prism_update_note", { id: "d1", content: "<p>x</p>", if_updated_at: fv.notes.get("d1")!.updatedAt }), "forbidden");
  refused(await call(s, "prism_sheet_update", { id: "sh1", range: "A1", values: [["x"]] }), "forbidden");

  // editor: everything
  must(await call(e, "prism_sheet_update", { id: "sh1", range: "A1", values: [["x"]] }));

  // another user's private note: invisible to every Yjs tool (the gateway's view gate answers first)
  for (const [tool, args] of [
    ["prism_list_comments", { id: "priv" }],
    ["prism_add_comment", { id: "priv", quote: "private", text: "x" }],
    ["prism_suggest_edit", { id: "priv", find: "private", replace: "x" }],
  ] as const) refused(await call(e, tool, args), "not_found");
  assert.equal(hocuspocus.documents.has("priv"), false, "a refused call never opens the doc");
  refused(await call(e, "prism_list_comments", { id: "missing" }), "not_found");
});

test("collabAccess is in parity with the collab socket's resolveLevel", async () => {
  grant("capsuser@test.local", "tag", "garden", ["view", "suggest", "edit"]); // governance-compiled shape
  grant("dropbox@test.local", "tag", "garden", ["create"]); // no view
  grant(EDITOR, "note", "priv", ["view", "comment"]); // explicit share of a private note
  const users = [OWNER, EDITOR, SUGGESTER, COMMENTER, VIEWER, OTHER, "capsuser@test.local", "dropbox@test.local", "nobody@test.local"];
  for (const u of users) ensureUser(u);
  let checked = 0;
  for (const email of users) {
    const actor = { email, role: workspaceRole(email, "primary"), grants: grantsForUser(email, "primary") };
    const cookie = sessionCookie(makeSession(email));
    for (const id of ["d1", "priv", "sh1"]) {
      const note = fv.notes.get(id)!;
      const socket = await resolveLevel(id, "session", cookie);
      const mine = collabAccess(actor, { id, tags: note.tags, metadata: note.metadata }).level;
      assert.equal(mine, socket, `${email} on ${id}`);
      checked++;
    }
  }
  assert.equal(checked, users.length * 3);
});

// ── error mapping ───────────────────────────────────────────────────────────

test("create: a vault path conflict reads 'a note already exists at <path>' (member and owner paths)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if ((init?.method ?? "GET").toUpperCase() === "POST" && new URL(url).pathname.endsWith("/api/notes")) {
      return new Response(JSON.stringify({ error_type: "path_conflict", error: "path_conflict", path: "garden/taken", message: "exists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    for (const who of [EDITOR, OWNER]) {
      const cl = await connectMcp(who);
      const r = await call(cl, "prism_create_note", { content: "x", path: "garden/taken", tags: ["garden"] });
      refused(r, "conflict");
      assert.equal(!r.ok && r.message, 'a note already exists at "garden/taken" — choose a different path', who);
      assert.deepEqual(!r.ok && r.detail, { reason: "path_conflict", path: "garden/taken" });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("revoking a share disconnects an idle live reader before the mutation returns", { timeout: 10000 }, async () => {
  const token = makeCapability("note", "d1", "edit");
  const client = await human("d1", token);
  const live = hocuspocus.documents.get("d1")!;
  const old = live.getConnections()[0]!;
  const [grant] = grantsForCapability(verifyCapability(token)!.id);
  removeGrant(grant!.id);
  assert.equal(live.hasConnection(old), false, "removed synchronously before another broadcast");
  typeInParagraph(client, 0, " REVOKED_WRITE");
  await settle();
  assert.doesNotMatch(yDocToHtml(live), /REVOKED_WRITE/);
  assert.equal(await resolveLevel("d1", token, null), null);
});

test("downgrading a live link forces reauthentication and new connections are read-only", { timeout: 10000 }, async () => {
  const token = makeCapability("note", "d1", "edit");
  await human("d1", token);
  const live = hocuspocus.documents.get("d1")!;
  const old = live.getConnections()[0]!;
  const [grant] = grantsForCapability(verifyCapability(token)!.id);
  upsertGrant({ ...grant!, level: "view", caps: null });
  assert.equal(live.hasConnection(old), false);
  const reader = await human("d1", token);
  assert.ok(live.getConnections().every(c => c.readOnly));
  typeInParagraph(reader, 0, " READ_ONLY_WRITE");
  await settle();
  assert.doesNotMatch(yDocToHtml(live), /READ_ONLY_WRITE/);
});

test("a grant change leaves live documents in another vault connected", { timeout: 10000 }, async () => {
  addVaultEntry({ id: "team-b", label: "B", url: "http://vault.test", vault: "team-b", token: "t" });
  fv.putIn("team-b", { id: "d1", content: "<p>secondary</p>", tags: [] });
  const id = "secondary-cap", exp = Date.now() + 60000;
  addGrant({ vault_id: "team-b", subject_type: "link", subject: id, resource_type: "note", resource: "d1", level: "edit", created_by: OWNER });
  await human("team-b::d1", signCapability({ id, exp }));
  const live = hocuspocus.documents.get("team-b::d1")!;
  const connection = live.getConnections()[0]!;
  const token = makeCapability("note", "d1", "edit");
  const [grant] = grantsForCapability(verifyCapability(token)!.id);
  removeGrant(grant!.id);
  assert.ok(live.hasConnection(connection));
});

test("expired links are removed from the idle feed by live revalidation", { timeout: 10000 }, async () => {
  const claims = verifyCapability(makeCapability("note", "d1", "view"))!;
  const token = signCapability({ ...claims, exp: Date.now() + 300 });
  await human("d1", token);
  const live = hocuspocus.documents.get("d1")!;
  const connection = live.getConnections()[0]!;
  await settle(350);
  await revalidateLiveAccess();
  assert.equal(live.hasConnection(connection), false);
});

test("external privacy changes are checked before an incoming live edit", { timeout: 10000 }, async () => {
  const client = await human("d1", makeCapability("tag", "garden", "edit"));
  const live = hocuspocus.documents.get("d1")!;
  const connection = live.getConnections()[0]!;
  fv.notes.get("d1")!.metadata = { prism_visibility: "private", prism_creator: OTHER };
  typeInParagraph(client, 0, " PRIVATE_WRITE");
  await settle();
  assert.equal(live.hasConnection(connection), false);
  assert.doesNotMatch(yDocToHtml(live), /PRIVATE_WRITE/);
});

test("revocation during an awaited live authorization cannot admit the queued update", { timeout: 10000 }, async () => {
  const token = makeCapability("note", "d1", "edit");
  const client = await human("d1", token);
  const live = hocuspocus.documents.get("d1")!;
  const fetchBefore = globalThis.fetch;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  globalThis.fetch = async (...args) => {
    if (String(args[0]).includes("/notes/d1")) { entered(); await gate; }
    return fetchBefore(...args);
  };
  try {
    typeInParagraph(client, 0, " RACING_WRITE");
    await waiting;
    removeGrant(grantsForCapability(verifyCapability(token)!.id)[0]!.id);
    release();
    await settle();
    assert.doesNotMatch(yDocToHtml(live), /RACING_WRITE/);
  } finally { release(); globalThis.fetch = fetchBefore; }
});
