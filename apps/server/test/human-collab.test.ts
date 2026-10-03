/**
 * Human collaboration commands (POST /api/collab/:id/commands) — the write path
 * of suggest-level people and capability-link guests once their collab socket is
 * read-only. REAL Hocuspocus (the module singleton on a throwaway HTTP server),
 * real HocuspocusProvider clients over WebSockets, the real Hono app, real
 * (in-memory) SQLite and the fixture vault. Pins:
 *
 *  - the browser's revision helper (@prism/core/collab-commands) and the server
 *    agree byte for byte;
 *  - every command kind works for a signed-in user and for a guest, is seen live
 *    by editors, and is attributed to the SERVER-resolved actor (a body that
 *    tries to name an author is refused by the strict schema);
 *  - who may do what (levels, private notes, non-prose kinds, delete-comment);
 *  - revocation / downgrade / vault mismatch between arrival and mutation fail
 *    closed with nothing mutated;
 *  - stale revision, changed quote and overlapping suggestion → 409, no mutation;
 *  - idempotency through REAL persistence: replay after store + unload + reload,
 *    after a reviewer rejected the suggestion, after an external vault edit
 *    reseeded the document, after a crash before the store, and after a failed
 *    vault write — never a second mutation, never a result for a lost change.
 */
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { generateHTML } from "@tiptap/core";
import { collabExtensions } from "@prism/core/editor-schema";
import { canonicalCollabState, humanCollabRevision, humanCollabRevisionInput, HUMAN_COLLAB_LIMITS } from "@prism/core/collab-commands";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { attachCollab, collabSchema, contentToYUpdate, hocuspocus, loadDocumentState, reconcileLoadedDocs, resetReconcileState, yDocToHtml } from "../src/collab";
import { editFragment, findTextRange } from "../src/collab-ops";
import {
  addGrant,
  addVaultEntry,
  db,
  destroySession,
  ensureUser,
  getCollabReceipt,
  getDocState,
  grantsForCapability,
  grantsForUser,
  insertCollabReceipt,
  migrateCollabReceipts,
  pruneCollabReceipts,
  saveDocState,
  removeGrant,
  setUserProfile,
  suggestionsForNote,
  upsertGrant,
} from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { verifyCapability } from "../src/auth/capability";
import Database from "better-sqlite3";
import {
  ACTOR_BODY_BYTES,
  ACTOR_COMMENT_BYTES,
  MAX_AUTHOR_NAME,
  MAX_COMMENTS_BYTES,
  undoLostCommands,
  COMMENTS_PER_THREAD,
  documentActorId,
  executeHumanCommand,
  FUTURE_SKEW_MS,
  humanRevision,
  MAX_DOCUMENT_BYTES,
  PENDING_SUGGESTIONS_PER_ACTOR,
  RECEIPT_RETENTION_MS,
  RECEIPTS_PER_ACTOR,
  RECEIPTS_PER_DOCUMENT,
  THREADS_PER_DOCUMENT,
  type HumanCommandContext,
} from "../src/human-collab";
import { resolveSuggestions, type PmNode } from "../src/suggestions";
import { installFakeVault, makeCapability, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const EDITOR = "editor@test.local";
const SUGGESTER = "suggester@test.local";
const SUGGESTER2 = "second@test.local";
const COMMENTER = "commenter@test.local";
const VIEWER = "viewer@test.local";
const OTHER = "someone-else@test.local";
const BODY = "<p>alpha</p><p>beta</p>";
const T0 = "2026-02-01T00:00:00.000Z";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let server: Server;
let wsUrl: string;
let ip: string;
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];
const savedDebounce = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };
const flag = config as { collabSuggestEnforced: boolean; collabCommandsPerMinute: number };
const schema = collabSchema();

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  flag.collabSuggestEnforced = true;
  flag.collabCommandsPerMinute = 100_000; // the per-actor rate limit has its own test
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  // Raw human edits stay UNSAVED during a test; the command route stores at once.
  hocuspocus.configuration.debounce = 60_000;
  hocuspocus.configuration.maxDebounce = 120_000;
  for (const e of [EDITOR, SUGGESTER, SUGGESTER2, COMMENTER, VIEWER, OTHER]) ensureUser(e);
  setUserProfile(SUGGESTER, { name: "Sue Gester" });
  grant(EDITOR, ["view", "comment", "suggest", "edit", "create"]);
  grant(SUGGESTER, ["view", "comment", "suggest"]);
  grant(SUGGESTER2, ["view", "comment", "suggest"]);
  grant(COMMENTER, ["view", "comment"]);
  grant(VIEWER, ["view"]);
  fv.put({ id: "d1", tags: ["garden"], content: BODY, updatedAt: T0 });
  fv.put({ id: "code1", tags: ["garden"], path: "garden/tool.ts", content: "const a = 1;\n", updatedAt: T0 });
  fv.put({ id: "sh1", tags: ["garden"], path: "garden/data.csv", content: "a,b\n1,2", updatedAt: T0 });
  fv.put({ id: "cv1", tags: ["garden"], content: JSON.stringify({ type: "excalidraw", elements: [{ id: "e1", type: "rectangle" }], appState: {} }), updatedAt: T0 });
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
  connected.length = 0;
  for (const ws of clientSockets) ws.terminate();
  clientSockets.clear();
  hocuspocus.closeConnections();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
  hocuspocus.configuration.debounce = savedDebounce.debounce;
  hocuspocus.configuration.maxDebounce = savedDebounce.maxDebounce;
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
  flag.collabSuggestEnforced = true;
});

function grant(email: string, caps: string[], resource = "garden") {
  addGrant({ subject_type: "user", subject: email, resource_type: "tag", resource, level: "view", caps: caps as never, created_by: "test", vault_id: "primary" });
}

// ── actors ──────────────────────────────────────────────────────────────────
interface Auth {
  headers: Record<string, string>;
  query: string;
  /** Token for this actor's collab socket. */
  socket: string;
  /** The server's receipt identity for this actor. */
  identity: string;
}
function userAuth(email: string): Auth {
  return { headers: { cookie: sessionCookie(makeSession(email)) }, query: "", socket: issueDeviceToken(email, "test", "prism-native").token, identity: `user:${email}` };
}
function guestAuth(level: "view" | "comment" | "suggest" | "edit" = "suggest"): Auth {
  const token = makeCapability("tag", "garden", level);
  return { headers: {}, query: `?t=${encodeURIComponent(token)}`, socket: token, identity: `capability:${verifyCapability(token)!.id}` };
}
const ACTORS: Array<{ label: string; auth: () => Auth; name: string }> = [
  { label: "signed-in user", auth: () => userAuth(SUGGESTER), name: "Sue Gester" },
  { label: "capability-link guest", auth: () => guestAuth(), name: "Guest" },
];

async function post(id: string, body: unknown, auth: Auth | null, headers: Record<string, string> = {}) {
  const res = await app.request(`/api/collab/${encodeURIComponent(id)}/commands${auth?.query ?? ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-forwarded-for": ip, ...(auth?.headers ?? {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  // Every connected client of this note receives the change before the test goes on.
  for (const c of connected) if (c.name === id) await caughtUp(c.doc);
  return { status: res.status, body: json, replayed: res.headers.get("idempotent-replayed") === "true" };
}

// ── clients ─────────────────────────────────────────────────────────────────
/** Client sockets, tracked so teardown can terminate them: a provider that is
 *  mid-reconnect when it is destroyed (every grant write closes live sockets
 *  with 4403) otherwise leaves `ws` waiting 30 s for a close handshake. */
const clientSockets = new Set<WebSocket>();
class TrackedWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    clientSockets.add(this);
  }
}
const clientNames = new WeakMap<Y.Doc, string>();
const connected: Array<{ name: string; doc: Y.Doc }> = [];
async function client(name: string, token: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  clientNames.set(doc, name);
  connected.push({ name, doc });
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name,
    token,
    document: doc,
    awareness: null, // see comment-level.test.ts: avoids a leaked Awareness interval
    // @ts-expect-error WebSocketPolyfill is accepted at runtime
    WebSocketPolyfill: TrackedWebSocket,
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
const editorClient = (name: string) => client(name, makeCapability("tag", "garden", "edit"));
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const live = (name: string) => hocuspocus.documents.get(name) as Y.Doc | undefined;

/** What the editor holds: the ProseMirror doc of a client's Y.Doc. */
const pm = (doc: Y.Doc) => yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("default"), schema);
/** The BROWSER's revision: @prism/core's helper over the client's own state. */
const clientRevision = (doc: Y.Doc) => humanCollabRevision(pm(doc).toJSON(), doc.getMap("comments").toJSON());
/** A client-shaped doc of a note nobody has open (the state a fresh load seeds). */
function offlineDoc(id: string): Y.Doc {
  const d = new Y.Doc();
  const snap = getDocState(id);
  Y.applyUpdate(d, snap ? snap.state : contentToYUpdate(fv.notes.get(id)!.content));
  return d;
}
const select = (doc: Y.Doc, needle: string) => {
  const r = findTextRange(pm(doc), needle);
  assert.ok(r, `"${needle}" is in the document`);
  return { from: r.from, to: r.to, quote: needle };
};
const caretAfter = (doc: Y.Doc, needle: string) => {
  const r = select(doc, needle);
  return { from: r.to, to: r.to, quote: "" };
};
/** Wait until a connected client has caught up with the server's document (what
 *  "connected and synced" means for a real client before it prepares a command). */
async function caughtUp(doc: Y.Doc): Promise<void> {
  const name = clientNames.get(doc);
  for (let i = 0; name && i < 200; i++) {
    const server = live(name);
    if (!server || (await clientRevision(doc)) === humanRevision(server)) return;
    await settle(15);
  }
}
/** Build a command the way a client does: revision from ITS OWN current state. */
async function command<T extends Record<string, unknown>>(doc: Y.Doc, partial: T | (() => T)) {
  await caughtUp(doc);
  const fields = typeof partial === "function" ? partial() : partial;
  return { requestId: randomUUID(), createdAt: Date.now(), revision: await clientRevision(doc), ...fields };
}
const suggestionIds = (html: string) => [...new Set([...html.matchAll(/data-suggestion-id="([^"]+)"/g)].map((m) => m[1]!))];
const vaultHtml = (id: string) => fv.notes.get(id)!.content;
const snapshotHtml = (id: string) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, getDocState(id)!.state);
  return yDocToHtml(d);
};
const receipt = (auth: Auth, requestId: string, id = "d1") => getCollabReceipt("primary", id, auth.identity, requestId);
const receiptCount = () => (db.prepare("SELECT COUNT(*) AS n FROM collab_command_receipts").get() as { n: number }).n;
const writes = () => fv.calls.filter((c) => c.method === "PATCH" || c.method === "POST" || c.method === "DELETE").length;
/** Wait until the document has unloaded (no connections, store finished). */
async function unloaded(name: string) {
  for (let i = 0; i < 40 && live(name); i++) await settle(25);
  assert.equal(live(name), undefined, `${name} unloaded`);
}

// ── revision canonicalisation ───────────────────────────────────────────────

test("canonical JSON is key-order independent, whitespace-free and deterministic", () => {
  assert.equal(canonicalCollabState({ b: 1, a: [{ d: undefined, c: "é\u2028\"" }], n: null }), '{"a":[{"c":"é\u2028\\"","d":null}],"b":1,"n":null}');
  assert.equal(canonicalCollabState({ a: { y: 1, x: 2 } }), canonicalCollabState({ a: { x: 2, y: 1 } }));
  assert.equal(humanCollabRevisionInput({ type: "doc" }, {}), '{"comments":{},"doc":{"type":"doc"}}');
});

test("the browser helper and the server compute the SAME revision (marks, comments, unicode)", { timeout: 20000 }, async () => {
  fv.put({
    id: "rev",
    tags: ["garden"],
    content: '<h2>Tïtle — ✓</h2><p>plain <strong>bold <em>both</em></strong> <a href="https://example.test/x?a=1&amp;b=2">link</a> 日本語 😀</p><ul><li><p>one</p></li><li><p>two</p></li></ul>',
    updatedAt: T0,
  });
  const reader = await client("rev", guestAuth().socket);
  assert.equal(await clientRevision(reader), humanRevision(live("rev")!), "seeded document");
  // Add a comment thread + a suggestion through the endpoint, then compare again.
  const auth = userAuth(SUGGESTER);
  const c = await post("rev", await command(reader, () => ({ kind: "comment", ...select(reader, "bold"), text: "why bold? ✓" })), auth);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  await settle();
  const s = await post("rev", await command(reader, () => ({ kind: "suggest", ...select(reader, "two"), text: "2" })), auth);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  await settle();
  assert.equal(await clientRevision(reader), humanRevision(live("rev")!), "with a thread and suggestion marks");
  assert.match(await clientRevision(reader), /^[a-f0-9]{64}$/);
});

// ── every command kind, for both kinds of actor ─────────────────────────────

for (const actor of ACTORS) {
  test(`[${actor.label}] suggest: insert, delete and replace land as attributed marks, live for editors, and persist`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    const editor = await editorClient("d1");
    const me = await client("d1", auth.socket); // read-only, but live
    const actorId = documentActorId(auth.identity);

    const ins = await post("d1", await command(me, () => ({ kind: "suggest", ...caretAfter(me, "alpha"), text: " plus" })), auth);
    assert.equal(ins.status, 200, JSON.stringify(ins.body));
    assert.equal(ins.replayed, false);
    assert.equal(ins.body.kind, "suggest");
    await settle();
    const rep = await post("d1", await command(me, () => ({ kind: "suggest", ...select(me, "beta"), text: "gamma" })), auth);
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    await settle();

    const html = yDocToHtml(live("d1")!);
    assert.equal(yDocToHtml(editor), html, "the editor sees the command-made suggestions live");
    assert.equal(yDocToHtml(me), html, "…and so does the suggest actor's read-only socket");
    assert.deepEqual(suggestionIds(html).sort(), [ins.body.suggestionId, rep.body.suggestionId].sort());
    assert.match(html, new RegExp(`alpha<span data-suggestion="insert" data-user="${actor.name}"[^>]*data-actor-id="${actorId}"[^>]*> plus</span>`));
    assert.match(html, new RegExp(`<span data-suggestion="delete" data-user="${actor.name}"[^>]*data-actor-id="${actorId}"[^>]*>beta</span><span data-suggestion="insert" data-user="${actor.name}"[^>]*>gamma</span>`));
    assert.equal(vaultHtml("d1"), html, "stored in the vault before the response");
    assert.equal(receipt(auth, ins.body.requestId)!.state, "durable");
    assert.ok(suggestionsForNote("d1").some((s) => s.author === actor.name && s.status === "pending"), "captured into the review queue");

    // A pure deletion (no replacement text) on a fresh document.
    fv.put({ id: "d2", tags: ["garden"], content: "<p>keep remove keep</p>", updatedAt: T0 });
    const me2 = await client("d2", auth.socket);
    const del = await post("d2", await command(me2, () => ({ kind: "suggest", ...select(me2, "remove "), text: "" })), auth);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.match(vaultHtml("d2"), /keep <span data-suggestion="delete"[^>]*>remove <\/span>keep/);
    assert.doesNotMatch(vaultHtml("d2"), /data-suggestion="insert"/);

    // The editor keeps collaborating normally afterwards.
    const p = editor.getXmlFragment("default").get(0) as Y.XmlElement;
    (p.get(0) as Y.XmlText).insert(0, "EDITOR ");
    await settle();
    assert.match(yDocToHtml(live("d1")!), /<p>EDITOR alpha/);
    assert.match(yDocToHtml(me), /<p>EDITOR alpha/);
  });

  test(`[${actor.label}] comment → reply → resolve → reopen → delete, attributed by the server`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    const editor = await editorClient("d1");
    const me = await client("d1", auth.socket);
    const actorId = documentActorId(auth.identity);

    const made = await post("d1", await command(me, () => ({ kind: "comment", ...select(me, "alpha"), text: "  first!  " })), auth);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const threadId = made.body.threadId as string;
    await settle();
    const thread = () => editor.getMap<Y.Map<unknown>>("comments").get(threadId);
    const items = () => (thread()!.get("comments") as Y.Array<any>).toArray();
    assert.ok(thread(), "the editor sees the thread live");
    assert.equal(thread()!.get("quote"), "alpha");
    assert.deepEqual(
      items().map(({ createdAt: _t, ...rest }) => rest),
      [{ id: made.body.commentId, author: actor.name, actorId, color: items()[0].color, text: "first!", agent: false }],
    );
    assert.match(yDocToHtml(editor), new RegExp(`<span data-comment-id="${threadId}" data-resolved="false"[^>]*>alpha</span>`));
    assert.match(vaultHtml("d1"), new RegExp(`data-comment-id="${threadId}"`), "anchor persisted");

    const reply = await post("d1", await command(me, () => ({ kind: "reply", threadId, text: "and a reply" })), auth);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    await settle();
    assert.deepEqual(items().map((i) => [i.text, i.author, i.actorId]), [["first!", actor.name, actorId], ["and a reply", actor.name, actorId]]);
    assert.equal(items()[1].id, reply.body.commentId);

    const resolved = await post("d1", await command(me, () => ({ kind: "resolve", threadId, resolved: true })), auth);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.deepEqual(resolved.body, { requestId: resolved.body.requestId, kind: "resolve", threadId, resolved: true });
    await settle();
    assert.equal(thread()!.get("resolved"), true);
    assert.match(yDocToHtml(editor), new RegExp(`data-comment-id="${threadId}" data-resolved="true"`));

    const reopened = await post("d1", await command(me, () => ({ kind: "resolve", threadId, resolved: false })), auth);
    assert.equal(reopened.status, 200);
    await settle();
    assert.equal(thread()!.get("resolved"), false);

    const deleted = await post("d1", await command(me, () => ({ kind: "delete-comment", threadId })), auth);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    await settle();
    assert.equal(thread(), undefined);
    assert.equal(yDocToHtml(editor), BODY, "the anchor mark is gone too");
    assert.equal(vaultHtml("d1"), BODY);

    const gone = await post("d1", await command(me, () => ({ kind: "reply", threadId, text: "too late" })), auth);
    assert.equal(gone.status, 409);
    assert.equal(gone.body.error, "thread_missing");
  });

  test(`[${actor.label}] a body that tries to name its own author is refused (strict schema); nothing changes`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    const me = await client("d1", auth.socket);
    const before = Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64");
    const good = await command(me, () => ({ kind: "suggest", ...select(me, "alpha"), text: "omega" }));
    for (const extra of [{ author: "Owner" }, { user: "Owner" }, { actorId: "h_someone" }, { color: "#000" }, { name: "Owner" }, { marks: [{ type: "bold" }] }, { level: "own" }, { update: "AAAA" }]) {
      const r = await post("d1", { ...good, ...extra }, auth);
      assert.equal(r.status, 400, `extra key ${Object.keys(extra)[0]} is refused`);
      assert.equal(r.body.error, "invalid_command");
    }
    for (const bad of [{ ...good, requestId: "not-a-uuid" }, { ...good, revision: "abc" }, { ...good, kind: "transform" }, { ...good, from: 1.5 }, { ...good, text: "x".repeat(10_001) }, "{not json", { ...good, kind: "comment", text: "" }]) {
      const r = await post("d1", bad, auth);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_command");
    }
    assert.equal(Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64"), before);
    assert.equal(receiptCount(), 0);
    assert.equal(vaultHtml("d1"), BODY);
    // The clean command works and carries the SERVER's attribution.
    const ok = await post("d1", good, auth);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(vaultHtml("d1"), new RegExp(`data-user="${actor.name}"[^>]*data-actor-id="${documentActorId(auth.identity)}"`));
  });

  test(`[${actor.label}] stale revision, changed quote and overlapping suggestion → 409, nothing mutated`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    const editor = await editorClient("d1");
    const me = await client("d1", auth.socket);

    // Stale: the suggester prepared a change, then an editor typed.
    const prepared = await command(me, () => ({ kind: "suggest", ...select(me, "beta"), text: "gamma" }));
    const p = editor.getXmlFragment("default").get(0) as Y.XmlElement;
    (p.get(0) as Y.XmlText).insert(0, "NEW ");
    await settle();
    const before = Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64");
    const stale = await post("d1", prepared, auth);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "stale_revision");
    assert.match(stale.body.message, /draft is kept/i);
    assert.equal(receipt(auth, prepared.requestId), null, "no receipt for a refused command");

    // Changed quote: current revision, but the range does not hold that text.
    const wrongQuote = await post("d1", await command(me, () => ({ kind: "suggest", ...select(me, "beta"), quote: "bet4", text: "x" })), auth);
    assert.equal(wrongQuote.status, 409);
    assert.equal(wrongQuote.body.error, "quote_changed");
    const shifted = select(me, "beta");
    const offBy = await post("d1", await command(me, () => ({ kind: "comment", from: shifted.from - 1, to: shifted.to - 1, quote: "beta", text: "hm" })), auth);
    assert.equal(offBy.status, 409);
    assert.equal(offBy.body.error, "quote_changed");
    const outside = await post("d1", await command(me, () => ({ kind: "suggest", from: 400, to: 410, quote: "", text: "x" })), auth);
    assert.equal(outside.status, 400);
    assert.equal(Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64"), before, "nothing was mutated by any refusal");

    // Overlap: once a passage carries a suggestion, a second one over, inside or
    // touching it is refused until a reviewer resolves the first.
    const first = await post("d1", await command(me, () => ({ kind: "suggest", ...select(me, "beta"), text: "gamma" })), auth);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await settle();
    const withOne = Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64");
    for (const again of [
      { kind: "suggest", ...select(me, "beta"), text: "delta" },
      { kind: "suggest", ...select(me, "et"), text: "" },
      { kind: "suggest", ...caretAfter(me, "gamma"), text: "!" },
      { kind: "suggest", ...caretAfter(me, "be"), text: "?" },
    ]) {
      const r = await post("d1", await command(me, again), auth);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error, "suggestion_overlap");
    }
    assert.equal(Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64"), withOne);
    assert.equal(suggestionIds(vaultHtml("d1")).length, 1);
  });

  test(`[${actor.label}] the same request replayed returns the identical result and mutates exactly once; a reused id with another body → 409`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    const me = await client("d1", auth.socket);
    const cmd = await command(me, () => ({ kind: "suggest", ...select(me, "alpha"), text: "omega" }));
    const first = await post("d1", cmd, auth);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.replayed, false);
    await settle();
    const state = Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64");
    for (let i = 0; i < 3; i++) {
      const again = await post("d1", cmd, auth);
      assert.equal(again.status, 200);
      assert.equal(again.replayed, true);
      assert.deepEqual(again.body, first.body);
    }
    assert.equal(Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64"), state, "no second mutation");
    assert.deepEqual(suggestionIds(vaultHtml("d1")), [first.body.suggestionId]);
    assert.equal(receiptCount(), 1);

    const other = await post("d1", { ...cmd, text: "something else" }, auth);
    assert.equal(other.status, 409);
    assert.equal(other.body.error, "request_id_reused");
    const otherKind = await post("d1", { requestId: cmd.requestId, createdAt: cmd.createdAt, revision: cmd.revision, kind: "resolve", threadId: "c-x", resolved: true }, auth);
    assert.equal(otherKind.status, 409);
    assert.equal(otherKind.body.error, "request_id_reused");
    assert.equal(Buffer.from(Y.encodeStateAsUpdate(live("d1")!)).toString("base64"), state);
    // The same uuid from a DIFFERENT actor is a different request (never a replay).
    const stranger = userAuth(SUGGESTER2);
    const theirs = await post("d1", { ...cmd, revision: await clientRevision(me) }, stranger);
    assert.equal(theirs.status, 409, "it is evaluated on its own merits (and overlaps the first suggestion)");
    assert.equal(theirs.body.error, "suggestion_overlap");
  });
}

// ── who may use the endpoint ────────────────────────────────────────────────

test("levels: anon 401; view / comment 403; suggest and edit 200; private notes and missing notes are refused", { timeout: 20000 }, async () => {
  const doc = offlineDoc("d1");
  const mk = () => command(doc, () => ({ kind: "comment", ...select(doc, "alpha"), text: "hi" }));
  assert.equal((await post("d1", await mk(), null)).status, 401);
  for (const auth of [userAuth(VIEWER), userAuth(COMMENTER), guestAuth("view"), guestAuth("comment"), userAuth(OTHER)]) {
    const r = await post("d1", await mk(), auth);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
  }
  assert.equal(writes(), 0, "refusals never write to the vault");
  assert.equal(receiptCount(), 0);
  // An expired link is no credential at all.
  const expired = makeCapability("tag", "garden", "suggest", Date.now() - 1000);
  assert.equal((await post("d1", await mk(), { headers: {}, query: `?t=${expired}`, socket: expired, identity: "x" })).status, 401);

  const priv = offlineDoc("priv");
  const onPrivate = await post("priv", await command(priv, () => ({ kind: "comment", ...select(priv, "private"), text: "hi" })), userAuth(SUGGESTER));
  assert.equal(onPrivate.status, 403);
  assert.equal((await post("nope", await mk(), userAuth(SUGGESTER))).status, 404);

  // An editor may use the command path too (their socket is read-write anyway).
  const asEditor = await post("d1", await mk(), userAuth(EDITOR));
  assert.equal(asEditor.status, 200, JSON.stringify(asEditor.body));
  // A signed-in account with NO grant of its own, opening a suggest link: the
  // socket combines both; so does the endpoint — and the account is the author.
  const link = makeCapability("tag", "garden", "suggest");
  const viaLink: Auth = { ...userAuth(OTHER), query: `?t=${encodeURIComponent(link)}` };
  const d = offlineDoc("d1");
  const combined = await post("d1", await command(d, () => ({ kind: "suggest", ...select(d, "beta"), text: "B" })), viaLink);
  assert.equal(combined.status, 200, JSON.stringify(combined.body));
  assert.match(vaultHtml("d1"), new RegExp(`data-user="Member"[^>]*data-actor-id="${documentActorId(`user:${OTHER}`)}"`));
});

test("non-prose kinds are refused with an explanation, and stay read-only for suggest actors", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  for (const [id, kind] of [["code1", "code"], ["sh1", "spreadsheet"], ["cv1", "canvas"]] as const) {
    const r = await post(id, { requestId: randomUUID(), createdAt: Date.now(), revision: "0".repeat(64), kind: "suggest", from: 1, to: 1, quote: "", text: "x" }, auth);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "unsupported_kind");
    assert.equal(r.body.noteKind, kind);
    assert.match(r.body.message, /only for prose documents/);
    assert.equal(live(id), undefined, "the document was not even opened");
  }
  assert.equal(writes(), 0);
});

test("request hygiene: JSON content type required, cross-site refused, oversize body refused, expired createdAt refused", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const doc = offlineDoc("d1");
  const cmd = await command(doc, () => ({ kind: "comment", ...select(doc, "alpha"), text: "hi" }));
  assert.equal((await post("d1", cmd, auth, { "content-type": "text/plain" })).status, 415);
  const cross = await post("d1", cmd, auth, { "sec-fetch-site": "cross-site" });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error, "csrf_refused");
  assert.equal((await post("d1", cmd, auth, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("d1", JSON.stringify({ ...cmd, text: "x" }) + " ".repeat(90_000), auth)).status, 400);
  const old = await post("d1", { ...cmd, createdAt: Date.now() - 25 * 60 * 60 * 1000 }, auth);
  assert.equal(old.status, 409);
  assert.equal(old.body.error, "expired");
  const future = await post("d1", { ...cmd, createdAt: Date.now() + 60 * 60 * 1000 }, auth);
  assert.equal(future.body.error, "expired");
  assert.equal(writes(), 0);
  assert.equal(receiptCount(), 0);
});

test("a refused command on a never-opened Markdown note writes nothing (no HTML conversion on its behalf)", { timeout: 20000 }, async () => {
  fv.put({ id: "md1", tags: ["garden"], content: "# Title\n\nhello *there*", updatedAt: T0 });
  const auth = userAuth(SUGGESTER);
  const r = await post("md1", { requestId: randomUUID(), createdAt: Date.now(), revision: "f".repeat(64), kind: "suggest", from: 1, to: 1, quote: "", text: "x" }, auth);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "stale_revision");
  await unloaded("md1");
  assert.equal(writes(), 0);
  assert.equal(vaultHtml("md1"), "# Title\n\nhello *there*");
});

test("delete-comment: a suggest actor may delete only a thread that is entirely its own; editors may delete any; resolve is open to all commenters", { timeout: 20000 }, async () => {
  const a = userAuth(SUGGESTER);
  const b = userAuth(SUGGESTER2);
  const guest = guestAuth();
  const editor = await editorClient("d1");
  const view = await client("d1", a.socket);
  const run = async (auth: Auth, partial: () => Record<string, unknown>) => {
    const r = await post("d1", await command(view, partial), auth);
    await caughtUp(view);
    await caughtUp(editor);
    return r;
  };
  const mine = (await run(a, () => ({ kind: "comment", ...select(view, "alpha"), text: "A's thread" }))).body.threadId;
  const theirs = (await run(b, () => ({ kind: "comment", ...select(view, "beta"), text: "B's thread" }))).body.threadId;
  const mixed = (await run(a, () => ({ kind: "comment", ...select(view, "alph"), text: "A starts" }))).body.threadId;
  assert.equal((await run(b, () => ({ kind: "reply", threadId: mixed, text: "B replies" }))).status, 200);
  // A thread written by a raw (edit-level / pre-enforcement) client: no server-stamped actorId.
  editor.transact(() => {
    const t = new Y.Map<unknown>();
    t.set("id", "c-legacy");
    t.set("quote", "x");
    t.set("resolved", false);
    const arr = new Y.Array<unknown>();
    arr.push([{ author: "Sue Gester", color: "#000", text: "typed in the old editor", createdAt: 1 }]);
    t.set("comments", arr);
    editor.getMap("comments").set("c-legacy", t);
  });
  await settle();

  for (const [auth, threadId] of [[a, theirs], [a, mixed], [a, "c-legacy"], [guest, mine], [b, mine]] as const) {
    const r = await run(auth, () => ({ kind: "delete-comment", threadId }));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_author");
  }
  assert.equal(editor.getMap("comments").size, 4, "nothing was deleted");

  // Resolve / reopen: any actor that may comment, on any thread (as in the editor).
  assert.equal((await run(a, () => ({ kind: "resolve", threadId: theirs, resolved: true }))).status, 200);
  assert.equal((await run(guest, () => ({ kind: "resolve", threadId: "c-legacy", resolved: true }))).status, 200);
  assert.equal(editor.getMap<Y.Map<unknown>>("comments").get(theirs)!.get("resolved"), true);

  assert.equal((await run(a, () => ({ kind: "delete-comment", threadId: mine }))).status, 200);
  assert.equal(editor.getMap("comments").has(mine), false);
  // An editor, through the same endpoint, may delete anyone's thread.
  const ed = userAuth(EDITOR);
  for (const threadId of [theirs, mixed, "c-legacy"]) assert.equal((await run(ed, () => ({ kind: "delete-comment", threadId }))).status, 200);
  assert.equal(editor.getMap("comments").size, 0);
  assert.doesNotMatch(yDocToHtml(live("d1")!), /data-comment-id/);
});

// ── access changes while the request is in flight ───────────────────────────

/** Run `fn` right before the Nth vault read of a note (after the previous ones returned). */
function beforeNoteRead(id: string, nth: number, fn: () => void): void {
  const inner = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.method ?? "GET").toUpperCase() === "GET" && url.pathname.endsWith(`/notes/${id}`)) {
      count++;
      if (count === nth) fn();
    }
    return inner(input, init);
  }) as typeof fetch;
}

const RACES: Array<{ label: string; auth: () => Auth; change: (auth: Auth) => void }> = [
  {
    label: "user: grant revoked",
    auth: () => userAuth(SUGGESTER),
    change: () => removeGrant(grantsForUser(SUGGESTER, "primary").find((g) => g.resource === "garden")!.id),
  },
  {
    label: "user: downgraded to comment",
    auth: () => userAuth(SUGGESTER),
    change: () => void upsertGrant({ subject_type: "user", subject: SUGGESTER, resource_type: "tag", resource: "garden", level: "comment", caps: ["view", "comment"], created_by: "test", vault_id: "primary" }),
  },
  {
    label: "user: session ended",
    auth: () => userAuth(SUGGESTER),
    change: (auth) => destroySession(auth.headers.cookie!.split("=")[1]!),
  },
  {
    label: "guest: link revoked",
    auth: () => guestAuth(),
    change: (auth) => removeGrant(grantsForCapability(auth.identity.slice("capability:".length))[0]!.id),
  },
  {
    label: "guest: link downgraded to view",
    auth: () => guestAuth(),
    change: (auth) => void upsertGrant({ subject_type: "link", subject: auth.identity.slice("capability:".length), resource_type: "tag", resource: "garden", level: "view", created_by: "test", vault_id: "primary" }),
  },
];
for (const race of RACES) {
  // With nobody connected the route reads the note 3 times: (1) the first access
  // check, (2) the document load, (3) the fresh read right before the mutation.
  for (const nth of [2, 3]) {
    test(`race [${race.label}] at vault read #${nth}: fails closed with 403, nothing mutated, no receipt`, { timeout: 20000 }, async () => {
      const auth = race.auth();
      const doc = offlineDoc("d1");
      const cmd = await command(doc, () => ({ kind: "suggest", ...select(doc, "alpha"), text: "omega" }));
      let fired = false;
      beforeNoteRead("d1", nth, () => {
        fired = true;
        race.change(auth);
      });
      const r = await post("d1", cmd, auth);
      assert.equal(fired, true, "the change happened after the request's first access check passed");
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "access_changed");
      await unloaded("d1");
      assert.equal(vaultHtml("d1"), BODY);
      assert.equal(snapshotHtml("d1"), BODY);
      assert.equal(writes(), 0);
      assert.equal(receiptCount(), 0);
      // …and it stays refused afterwards.
      const after = await post("d1", cmd, auth);
      assert.ok([401, 403].includes(after.status), `still refused (${after.status})`);
    });
  }
}

test("race: the note becomes private to someone else while the request is in flight → 403, nothing mutated", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const doc = offlineDoc("d1");
  const cmd = await command(doc, () => ({ kind: "suggest", ...select(doc, "alpha"), text: "omega" }));
  beforeNoteRead("d1", 3, () => {
    fv.notes.get("d1")!.metadata = { prism_creator: OTHER, prism_visibility: "private" };
  });
  const r = await post("d1", cmd, auth);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "access_changed");
  assert.equal(vaultHtml("d1"), BODY);
  assert.equal(receiptCount(), 0);
});

test("vault mismatch fails closed: a request bound to another workspace is refused, never applied to this document", { timeout: 20000 }, async () => {
  addVaultEntry({ id: "team-b", label: "B", url: "http://vault.test", vault: "team-b", token: "t" });
  fv.putIn("team-b", { id: "d1", content: "<p>other workspace</p>", tags: ["garden"] });
  const doc = offlineDoc("d1");
  const mk = () => command(doc, () => ({ kind: "suggest", ...select(doc, "alpha"), text: "omega" }));

  // A link belongs to ONE vault: naming another workspace is a mismatch.
  const guest = guestAuth();
  const g = await post("d1", await mk(), guest, { "x-prism-vault": "team-b" });
  assert.equal(g.status, 403);
  assert.equal(g.body.error, "vault_mismatch");
  // An unknown workspace name never silently means "primary".
  const user = userAuth(SUGGESTER);
  const unknown = await post("d1", await mk(), user, { "x-prism-vault": "no-such-vault" });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.error, "vault_mismatch");
  // The account's primary-vault grant confers nothing in the other workspace.
  const elsewhere = await post("d1", await mk(), user, { "x-prism-vault": "team-b" });
  assert.equal(elsewhere.status, 403);
  assert.equal(elsewhere.body.error, "forbidden");
  assert.equal(writes(), 0);
  assert.equal(receiptCount(), 0);
  // The same commands with the right binding work.
  assert.equal((await post("d1", await mk(), guest, { "x-prism-vault": "primary" })).status, 200);
});

// ── receipts through real persistence ───────────────────────────────────────

/** A reviewer's reject of every suggestion, done the way an editor client does it. */
function rejectAll(doc: Y.Doc): void {
  const json = resolveSuggestions(pm(doc).toJSON() as PmNode, null, "reject");
  doc.transact(() => editFragment(doc, () => schema.nodeFromJSON(json)));
}

for (const actor of ACTORS) {
  test(`[${actor.label}] receipt survives store → unload → reload: the replay returns the original result and does not mutate again`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    const doc = offlineDoc("d1");
    const cmd = await command(doc, () => ({ kind: "suggest", ...select(doc, "alpha"), text: "omega" }));
    const first = await post("d1", cmd, auth);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await unloaded("d1"); // nobody has it open: stored, then unloaded
    assert.equal(receipt(auth, cmd.requestId)!.state, "durable");
    const stored = vaultHtml("d1");
    assert.deepEqual(suggestionIds(stored), [first.body.suggestionId]);
    const patches = writes();

    // Lost acknowledgement: the client retries the same request.
    const replay = await post("d1", cmd, auth);
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    assert.equal(writes(), patches, "the replay wrote nothing");

    // Reload the document for real and replay again, at the engine too.
    const editor = await editorClient("d1");
    assert.equal(yDocToHtml(editor), stored, "the reloaded document has exactly the one suggestion");
    const liveReplay = await post("d1", cmd, auth);
    assert.deepEqual(liveReplay.body, first.body);
    const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", docName: "d1", actor: auth.identity, level: "suggest", author: { name: "x", color: "#000", actorId: "x" } };
    assert.deepEqual(executeHumanCommand(live("d1")!, ctx, cmd as never), { result: first.body, replayed: true, state: "durable" });
    assert.deepEqual(suggestionIds(yDocToHtml(live("d1")!)), [first.body.suggestionId]);

    // A reviewer rejects the suggestion; a late retry must NOT bring it back.
    rejectAll(editor);
    await settle();
    assert.equal(yDocToHtml(live("d1")!), BODY);
    const late = await post("d1", cmd, auth);
    assert.equal(late.status, 200);
    assert.equal(late.replayed, true);
    assert.deepEqual(late.body, first.body);
    await settle();
    assert.equal(yDocToHtml(live("d1")!), BODY, "still rejected — not re-applied");
    assert.equal(receiptCount(), 1);
  });

  test(`[${actor.label}] receipt survives an external vault edit that reseeds the document: no duplicate, original result`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    const doc = offlineDoc("d1");
    const cmd = await command(doc, () => ({ kind: "suggest", ...select(doc, "beta"), text: "gamma" }));
    const first = await post("d1", cmd, auth);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await unloaded("d1");
    const withSuggestion = vaultHtml("d1");

    // (a) An external writer edits the stored note, KEEPING the suggestion marks.
    fv.put({ id: "d1", tags: ["garden"], content: withSuggestion.replace("alpha", "alpha EXTERNAL"), updatedAt: "2026-11-01T00:00:00.000Z" });
    let editor = await editorClient("d1"); // load → the newer vault copy is folded in (reseed)
    assert.match(yDocToHtml(live("d1")!), /alpha EXTERNAL/);
    let replay = await post("d1", cmd, auth);
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    assert.deepEqual(suggestionIds(yDocToHtml(live("d1")!)), [first.body.suggestionId], "exactly one — not duplicated");
    assert.equal(yDocToHtml(editor), yDocToHtml(live("d1")!));

    // (b) An external writer replaces the body outright (marks gone). The reseed
    // drops the suggestion; the receipt still answers and nothing is re-applied.
    for (const p of providers.splice(0)) p.destroy();
    connected.length = 0;
    await unloaded("d1");
    fv.put({ id: "d1", tags: ["garden"], content: "<p>rewritten elsewhere</p><p>beta</p>", updatedAt: "2026-12-01T00:00:00.000Z" });
    editor = await editorClient("d1");
    assert.equal(yDocToHtml(live("d1")!), "<p>rewritten elsewhere</p><p>beta</p>");
    replay = await post("d1", cmd, auth);
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", docName: "d1", actor: auth.identity, level: "suggest", author: { name: "x", color: "#000", actorId: "x" } };
    assert.equal(executeHumanCommand(live("d1")!, ctx, cmd as never).replayed, true);
    await settle();
    assert.equal(yDocToHtml(live("d1")!), "<p>rewritten elsewhere</p><p>beta</p>", "the external edit stands; the old command is not applied again");
    assert.equal(yDocToHtml(editor), "<p>rewritten elsewhere</p><p>beta</p>");
    assert.equal(receiptCount(), 1);
  });

  test(`[${actor.label}] crash before the store: the lost change is NOT reported as applied, and the retry applies it exactly once`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    // A server process loads the document (the SAME loadDocumentState the
    // Hocuspocus hook runs), applies the command in memory exactly as the route
    // does — and dies before any store. SQLite survives; the Y.Doc does not.
    const mem = await loadDocumentState("d1", new Y.Doc());
    const cmd = { requestId: randomUUID(), createdAt: Date.now(), revision: humanRevision(mem), kind: "suggest" as const, ...select(mem, "alpha"), text: "omega" };
    const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", docName: "d1", actor: auth.identity, level: "suggest", author: { name: actor.name, color: "#000", actorId: documentActorId(auth.identity) } };
    const applied = executeHumanCommand(mem, ctx, cmd);
    assert.equal(applied.state, "applied");
    assert.equal(applied.replayed, false);
    assert.equal(receipt(auth, cmd.requestId)!.state, "applied", "recorded, but not confirmed");
    assert.equal(suggestionIds(yDocToHtml(mem)).length, 1);
    // While that instance is alive, a retry is recognised and NOT applied again.
    assert.deepEqual(executeHumanCommand(mem, ctx, cmd), { result: applied.result, replayed: true, state: "applied" });
    assert.equal(suggestionIds(yDocToHtml(mem)).length, 1);
    mem.destroy(); // "crash": the in-memory document is gone, nothing was stored
    assert.equal(live("d1"), undefined);
    assert.equal(vaultHtml("d1"), BODY, "the change never reached the vault");
    assert.equal(snapshotHtml("d1"), BODY, "…nor the persisted snapshot");

    // The client never got an answer, so it retries the same request.
    const retry = await post("d1", cmd, auth);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.replayed, false, "applied afresh — the first attempt was lost, and is not claimed");
    assert.notEqual(retry.body.suggestionId, applied.result.suggestionId);
    await unloaded("d1");
    assert.deepEqual(suggestionIds(vaultHtml("d1")), [retry.body.suggestionId], "exactly one suggestion");
    assert.equal(receipt(auth, cmd.requestId)!.state, "durable");
    assert.equal(receiptCount(), 1);
    const again = await post("d1", cmd, auth);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.body, retry.body);
  });

  test(`[${actor.label}] failed vault write: 503 not_confirmed (never a false 200); the retry confirms without applying twice`, { timeout: 20000 }, async () => {
    const auth = actor.auth();
    // Case 1 — someone still has the document open, so it stays in memory.
    const me = await client("d1", auth.socket);
    const cmd = await command(me, () => ({ kind: "suggest", ...select(me, "alpha"), text: "omega" }));
    fv.conflictOnNextWrite = true; // the store's vault write fails once
    const first = await post("d1", cmd, auth);
    assert.equal(first.status, 503, JSON.stringify(first.body));
    assert.equal(first.body.error, "not_confirmed");
    assert.equal(first.body.retry, true);
    assert.equal(vaultHtml("d1"), BODY, "nothing was saved");
    assert.equal(receipt(auth, cmd.requestId)!.state, "applied");
    const inMemory = suggestionIds(yDocToHtml(live("d1")!));
    assert.equal(inMemory.length, 1, "the change is in the live document");
    const retry = await post("d1", cmd, auth);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.replayed, true, "the retry did not apply it a second time");
    assert.deepEqual([retry.body.suggestionId], inMemory);
    assert.deepEqual(suggestionIds(vaultHtml("d1")), inMemory, "exactly one, now saved");
    assert.equal(receipt(auth, cmd.requestId)!.state, "durable");

    // Case 2 — nobody has it open: after the failed store the document unloads
    // and the unsaved change is lost with it.
    fv.put({ id: "d3", tags: ["garden"], content: BODY, updatedAt: T0 });
    const off = offlineDoc("d3");
    const cmd3 = await command(off, () => ({ kind: "suggest", ...select(off, "beta"), text: "gamma" }));
    fv.conflictOnNextWrite = true;
    const lost = await post("d3", cmd3, auth);
    assert.equal(lost.status, 503);
    await unloaded("d3");
    assert.equal(vaultHtml("d3"), BODY);
    const again = await post("d3", cmd3, auth);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.replayed, false, "re-applied: the first attempt did not survive");
    await unloaded("d3");
    assert.deepEqual(suggestionIds(vaultHtml("d3")), [again.body.suggestionId], "exactly one suggestion");
    assert.equal(getCollabReceipt("primary", "d3", auth.identity, cmd3.requestId)!.state, "durable");
  });
}

test("the same request sent twice AT ONCE (a retry racing the original) applies once and both answers agree", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const editor = await editorClient("d1");
  const cmd = await command(editor, () => ({ kind: "suggest", ...select(editor, "alpha"), text: "omega" }));
  const [a, b, c] = await Promise.all([post("d1", cmd, auth), post("d1", cmd, auth), post("d1", cmd, auth)]);
  for (const r of [a, b, c]) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(b.body, a.body);
  assert.deepEqual(c.body, a.body);
  assert.equal([a, b, c].filter((r) => !r.replayed).length, 1, "exactly one of them applied it");
  assert.deepEqual(suggestionIds(vaultHtml("d1")), [a.body.suggestionId]);
  assert.equal(yDocToHtml(editor), vaultHtml("d1"));
  assert.equal(receiptCount(), 1);
  // Two DIFFERENT people racing for the same passage: one wins, the other is told to re-anchor.
  fv.put({ id: "d4", tags: ["garden"], content: BODY, updatedAt: T0 });
  const off = offlineDoc("d4");
  const mine = await command(off, () => ({ kind: "suggest", ...select(off, "beta"), text: "one" }));
  const yours = await command(off, () => ({ kind: "suggest", ...select(off, "beta"), text: "two" }));
  const [x, y] = await Promise.all([post("d4", mine, auth), post("d4", yours, userAuth(SUGGESTER2))]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal([x, y].find((r) => r.status === 409)!.body.error, "stale_revision");
  await unloaded("d4");
  assert.equal(suggestionIds(vaultHtml("d4")).length, 1);
});

test("comment receipts: a replayed comment/reply never duplicates the thread or the reply, across unload + reload", { timeout: 20000 }, async () => {
  const auth = guestAuth();
  const doc = offlineDoc("d1");
  const c = await command(doc, () => ({ kind: "comment", ...select(doc, "alpha"), text: "one" }));
  const made = await post("d1", c, auth);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  await unloaded("d1");
  const r = await command(offlineDoc("d1"), { kind: "reply", threadId: made.body.threadId, text: "two" });
  const replied = await post("d1", r, auth);
  assert.equal(replied.status, 200, JSON.stringify(replied.body));
  await unloaded("d1");
  for (const [cmd, original] of [[c, made], [r, replied], [c, made]] as const) {
    const again = await post("d1", cmd, auth);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.body, original.body);
  }
  const editor = await editorClient("d1");
  const threads = editor.getMap<Y.Map<unknown>>("comments");
  assert.equal(threads.size, 1);
  assert.deepEqual((threads.get(made.body.threadId)!.get("comments") as Y.Array<any>).toArray().map((i) => i.text), ["one", "two"]);
  assert.equal((yDocToHtml(editor).match(/data-comment-id=/g) ?? []).length, 1);
});

test("receipts are bounded per document across all actors (429 past the ceiling) and pruned by age", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const fill = db.transaction(() => {
    for (let i = 0; i < RECEIPTS_PER_DOCUMENT; i++) {
      insertCollabReceipt({ vault_id: "primary", note_id: "d1", doc_name: "d1", actor: `user:filler-${i % 100}`, request_id: `r-${i}`, command_hash: "h", kind: "reply", result: "{}", created_at: Date.now() });
    }
  });
  fill();
  db.prepare("UPDATE collab_command_receipts SET state = 'durable', durable_at = ?").run(Date.now()); // confirmed receipts survive a load
  const doc = offlineDoc("d1");
  const cmd = await command(doc, () => ({ kind: "suggest", ...select(doc, "alpha"), text: "omega" }));
  const full = await post("d1", cmd, auth);
  assert.equal(full.status, 429);
  assert.equal(full.body.error, "document_request_limit");
  assert.equal(vaultHtml("d1"), BODY);
  assert.equal(receipt(auth, cmd.requestId), null);
  // Receipts past the retention window are pruned, which frees the document.
  db.prepare("UPDATE collab_command_receipts SET created_at = ? WHERE actor LIKE 'user:filler-%'").run(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const ok = await post("d1", cmd, auth);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(receiptCount(), 1, "the expired receipts were pruned");
});

test("kill switch off: the command endpoint still works (and the suggest socket is writable again)", { timeout: 20000 }, async () => {
  flag.collabSuggestEnforced = false;
  const auth = userAuth(SUGGESTER);
  const me = await client("d1", auth.socket);
  const r = await post("d1", await command(me, () => ({ kind: "suggest", ...select(me, "alpha"), text: "omega" })), auth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await settle();
  const p = me.getXmlFragment("default").get(1) as Y.XmlElement;
  (p.get(0) as Y.XmlText).insert(0, "LEGACY ");
  await settle();
  assert.match(yDocToHtml(live("d1")!), /<p>LEGACY beta<\/p>/, "legacy raw suggest write is accepted with the switch off");
});

// ── security review follow-ups (H1, H2, M1–M3, LOW-a/b) ─────────────────────

const stateOf = (name: string) => Buffer.from(Y.encodeStateAsUpdate(live(name)!)).toString("base64");

test("H1: a suggestion can never add unattributed content — line breaks are refused, and nothing is mutated", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const editor = await editorClient("d1");
  const before = stateOf("d1");
  for (const text of ["\n", "\n\n\n", "a\nb", "a\r\nb", "tail\n"]) {
    const r = await post("d1", await command(editor, () => ({ kind: "suggest", ...caretAfter(editor, "alpha"), text })), auth);
    assert.equal(r.status, 400, JSON.stringify(text));
    assert.equal(r.body.error, "invalid_command");
    assert.match(r.body.message, /line break/i);
  }
  const rep = await post("d1", await command(editor, () => ({ kind: "suggest", ...select(editor, "beta"), text: "x\ny" })), auth);
  assert.equal(rep.status, 400);
  assert.equal(stateOf("d1"), before);
  assert.equal(yDocToHtml(live("d1")!), BODY);
  assert.equal(receiptCount(), 0);
  assert.equal(writes(), 0);
});

test("H1: a range that cannot be marked completely is refused whole (code spans, line breaks, several paragraphs) — never a partial suggestion", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  fv.put({ id: "mix", tags: ["garden"], content: "<p>aa <code>bb</code> cc</p><p>one<br>two</p><p>last</p>", updatedAt: T0 });
  const editor = await editorClient("mix");
  const before = stateOf("mix");
  const range = (a: string, b: string) => {
    const doc = pm(editor);
    const from = findTextRange(doc, a)!.from;
    const to = findTextRange(doc, b)!.to;
    return { from, to, quote: doc.textBetween(from, to, "\n", "\ufffc") };
  };
  for (const [label, sel, text] of [
    ["delete across a code span", () => range("aa", "cc"), ""],
    ["replace across a code span", () => range("aa", "cc"), "new"],
    ["delete inside a code span", () => select(editor, "bb"), ""],
    ["delete across a line break", () => range("one", "two"), ""],
    ["replace across paragraphs", () => range("two", "last"), "joined"],
    ["delete across paragraphs", () => range("cc", "one"), ""],
  ] as const) {
    const r = await post("mix", await command(editor, () => ({ kind: "suggest", ...sel(), text })), auth);
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_command");
  }
  assert.equal(stateOf("mix"), before, "nothing was partially applied");
  assert.equal(receiptCount(), 0);
  // What IS accepted is exactly reversible: reject restores the original body,
  // accept yields the plain replacement — for insert, delete and replace.
  const html0 = yDocToHtml(live("mix")!);
  const ok = await post("mix", await command(editor, () => ({ kind: "suggest", ...select(editor, "aa"), text: "AA" })), auth);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const ins = await post("mix", await command(editor, () => ({ kind: "suggest", ...caretAfter(editor, "last"), text: " word" })), auth);
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  const del = await post("mix", await command(editor, () => ({ kind: "suggest", ...select(editor, "two"), text: "" })), auth);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const marked = pm(editor).toJSON() as PmNode;
  assert.equal(generateHTML(resolveSuggestions(marked, null, "reject") as never, collabExtensions()), html0);
  assert.equal(generateHTML(resolveSuggestions(marked, null, "accept") as never, collabExtensions()), "<p>AA <code>bb</code> cc</p><p>one<br></p><p>last word</p>");
});

test("H2: the endpoint addresses a note ONLY by its id — a path / title alias is 'not found', opens no second document and cannot wipe unsaved typing", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  fv.put({ id: "p1", tags: ["garden"], path: "Garden/Alias Note", content: BODY, updatedAt: T0 });
  fv.put({ id: "p2", tags: ["garden"], path: "roadmap", content: BODY, updatedAt: T0 });
  fv.put({ id: "p3", tags: ["garden"], metadata: { title: "Quarterly-Plan" }, content: BODY, updatedAt: T0 }); // reachable by unique TITLE
  const editor = await editorClient("p1");
  const p = editor.getXmlFragment("default").get(0) as Y.XmlElement;
  (p.get(0) as Y.XmlText).insert(0, "UNSAVED ");
  await settle();
  const cmd = await command(offlineDoc("p2"), () => ({ kind: "suggest", ...select(offlineDoc("p2"), "alpha"), text: "x" }));
  const missing = await post("no-such-note", cmd, auth);
  assert.equal(missing.status, 404);
  for (const alias of ["Garden/Alias Note", "garden/alias note", "GARDEN/ALIAS NOTE", "roadmap", "ROADMAP", "Quarterly-Plan", "quarterly-plan"]) {
    const calls = fv.calls.length;
    const r = await post(alias, cmd, auth);
    assert.equal(r.status, 404, `${alias}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, missing.body, "indistinguishable from a note that does not exist");
    assert.equal(live(alias), undefined);
    assert.equal(live(alias.toLowerCase()), undefined);
    assert.equal(getDocState(alias), null, "no second snapshot row for the same note");
    assert.ok(fv.calls.length - calls <= 1, "at most the one lookup");
  }
  // Ids outside the allowlist never reach the vault at all.
  for (const bad of ["a b", "a.b", "x".repeat(129), "a::b", "ü"]) {
    const calls = fv.calls.length;
    const r = await post(bad, cmd, auth);
    assert.equal(r.status, 404, bad);
    assert.equal(fv.calls.length, calls, "no vault call");
  }
  assert.equal(writes(), 0);
  assert.equal(receiptCount(), 0);
  assert.deepEqual([...hocuspocus.documents.keys()], ["p1"]);
  await reconcileLoadedDocs(hocuspocus as never);
  assert.match(yDocToHtml(live("p1")!), /UNSAVED alpha/, "the editor's unsaved typing is intact");
  assert.match(yDocToHtml(editor), /UNSAVED alpha/);
});

test("M1: a command applied WHILE another store's vault write is in flight is not confirmed by that store; if its own store fails it is 503, never a false 200", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const editor = await editorClient("d1");
  const p = editor.getXmlFragment("default").get(1) as Y.XmlElement;
  (p.get(0) as Y.XmlText).insert(0, "TYPED "); // unsaved raw edit → a store is pending
  await settle();
  const cmd = await command(editor, () => ({ kind: "suggest", ...select(editor, "alpha"), text: "omega" }));
  // Gate the vault: PATCH #1 (the editor's store) hangs until released; PATCH #2
  // (the command's own store) fails.
  const inner = globalThis.fetch;
  let patches = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.method ?? "GET").toUpperCase() === "PATCH" && url.pathname.endsWith("/notes/d1")) {
      patches++;
      if (patches === 1) await gate;
      if (patches === 2) fv.conflictOnNextWrite = true;
    }
    return inner(input, init);
  }) as typeof fetch;
  hocuspocus.flushPendingStores(); // store #1 renders (no suggestion yet) and waits on the vault
  await settle(150);
  assert.equal(patches, 1);
  const pending = post("d1", cmd, auth); // applied in memory while store #1 is in flight
  await settle(250);
  assert.equal(receipt(auth, cmd.requestId)!.state, "applied");
  open();
  const r = await pending;
  assert.equal(patches, 2);
  assert.doesNotMatch(vaultHtml("d1"), /data-suggestion/, "the vault never received the suggestion");
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.error, "not_confirmed");
  assert.equal(receipt(auth, cmd.requestId)!.state, "applied", "store #1 did not confirm a command it never wrote");
  // The change is lost with the document; the retry applies it once, for real.
  globalThis.fetch = inner;
  for (const pr of providers.splice(0)) pr.destroy();
  connected.length = 0;
  await unloaded("d1");
  const retry = await post("d1", cmd, auth);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.replayed, false, "never a replayed success for the lost change");
  await unloaded("d1");
  assert.deepEqual(suggestionIds(vaultHtml("d1")), [retry.body.suggestionId], "exactly one suggestion");
  assert.match(vaultHtml("d1"), /TYPED beta/, "the editor's stored typing is intact");
});

test("M2: the receipt cap is per actor — one suggester at its cap does not block anyone else; the document ceiling is separate", { timeout: 20000 }, async () => {
  const a = userAuth(SUGGESTER);
  const b = userAuth(SUGGESTER2);
  const g = guestAuth();
  db.transaction(() => {
    for (let i = 0; i < RECEIPTS_PER_ACTOR; i++) {
      insertCollabReceipt({ vault_id: "primary", note_id: "d1", doc_name: "d1", actor: a.identity, request_id: `a-${i}`, command_hash: "h", kind: "reply", result: "{}", created_at: Date.now() });
    }
  })();
  db.prepare("UPDATE collab_command_receipts SET state = 'durable', durable_at = ?").run(Date.now());
  const doc = offlineDoc("d1");
  const mine = await post("d1", await command(doc, () => ({ kind: "suggest", ...select(doc, "alpha"), text: "omega" })), a);
  assert.equal(mine.status, 429);
  assert.equal(mine.body.error, "actor_request_limit");
  assert.equal(vaultHtml("d1"), BODY);
  const theirs = await post("d1", await command(doc, () => ({ kind: "suggest", ...select(doc, "alpha"), text: "omega" })), b);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  await unloaded("d1");
  const d = offlineDoc("d1");
  const guests = await post("d1", await command(d, () => ({ kind: "comment", ...select(d, "beta"), text: "hi" })), g);
  assert.equal(guests.status, 200, JSON.stringify(guests.body));
  // A's cap frees itself as its receipts age out.
  db.prepare("UPDATE collab_command_receipts SET created_at = ? WHERE request_id LIKE 'a-%'").run(Date.now() - RECEIPT_RETENTION_MS - 1000);
  await unloaded("d1");
  const d2 = offlineDoc("d1");
  const again = await post("d1", await command(d2, () => ({ kind: "reply", threadId: guests.body.threadId, text: "ok" })), a);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(receiptCount(), 3);
});

test("M2: short retention can never permit a re-apply — once a receipt is old enough to prune, its request is already refused as expired", { timeout: 20000 }, async () => {
  assert.ok(RECEIPT_RETENTION_MS >= HUMAN_COLLAB_LIMITS.maxAgeMs + FUTURE_SKEW_MS, "retention covers max age + the allowed clock skew");
  assert.ok(RECEIPT_RETENTION_MS <= 2 * HUMAN_COLLAB_LIMITS.maxAgeMs, "…and is no longer days");
  const t0 = Date.now();
  const mem = await loadDocumentState("d1", new Y.Doc());
  const ctx = (now: number): HumanCommandContext => ({ vaultId: "primary", noteId: "d1", docName: "d1", actor: "user:x", level: "suggest", author: { name: "x", color: "#000", actorId: "h_x" }, now });
  // Worst case for the proof: the client's clock is as far AHEAD as allowed, so
  // its createdAt stays "fresh" for the longest possible time.
  const cmd = { requestId: randomUUID(), createdAt: t0 + FUTURE_SKEW_MS, revision: humanRevision(mem), kind: "suggest" as const, ...select(mem, "alpha"), text: "omega" };
  assert.equal(executeHumanCommand(mem, ctx(t0), cmd).replayed, false);
  // Just before the receipt may be pruned it still answers.
  const edge = t0 + RECEIPT_RETENTION_MS;
  pruneCollabReceipts(edge - RECEIPT_RETENTION_MS);
  assert.equal(executeHumanCommand(mem, ctx(edge), cmd).replayed, true);
  // One millisecond later it is prunable — and the same request, on a document
  // where its effect is gone (so the revision matches again), is refused.
  const later = edge + 1;
  assert.equal(pruneCollabReceipts(later - RECEIPT_RETENTION_MS), 1);
  const fresh = await loadDocumentState("d1", new Y.Doc());
  assert.equal(humanRevision(fresh), cmd.revision);
  assert.throws(() => executeHumanCommand(fresh, ctx(later), cmd), (e: any) => e.code === "expired");
  assert.equal(yDocToHtml(fresh), BODY);
});

test("M3: growth budgets — document size, pending suggestions per actor, replies per thread, threads per document, comment length", { timeout: 30000 }, async () => {
  const auth = userAuth(SUGGESTER);
  // Document size: a suggestion that would push the rendered note past the budget.
  const big = `<p>${"word ".repeat((MAX_DOCUMENT_BYTES - 6000) / 5)}</p><p>tail end</p>`;
  fv.put({ id: "big", tags: ["garden"], content: big, updatedAt: T0 });
  const bd = offlineDoc("big");
  const tooBig = await post("big", await command(bd, () => ({ kind: "suggest", ...caretAfter(bd, "tail end"), text: "y".repeat(10_000) })), auth);
  assert.equal(tooBig.status, 413, JSON.stringify(tooBig.body).slice(0, 200));
  assert.equal(tooBig.body.error, "document_too_large");
  assert.equal(vaultHtml("big"), big);
  const small = await post("big", await command(bd, () => ({ kind: "suggest", ...caretAfter(bd, "tail end"), text: "!" })), auth);
  assert.equal(small.status, 200, "a change that fits is still accepted");

  // Pending suggestions per actor.
  const me = documentActorId(auth.identity);
  const span = (i: number, actor: string) => `<span data-suggestion="insert" data-user="S" data-color="#000" data-suggestion-id="s-${actor}-${i}" data-actor-id="${actor}">i${i}</span> `;
  const many = (actor: string, n: number) => Array.from({ length: n }, (_, i) => span(i, actor)).join("");
  fv.put({ id: "pend", tags: ["garden"], content: `<p>${many(me, PENDING_SUGGESTIONS_PER_ACTOR)}</p><p>${many("h_someone_else", 5)}</p><p>clean text</p>`, updatedAt: T0 });
  const pd = offlineDoc("pend");
  const full = await post("pend", await command(pd, () => ({ kind: "suggest", ...select(pd, "clean"), text: "tidy" })), auth);
  assert.equal(full.status, 429, JSON.stringify(full.body));
  assert.equal(full.body.error, "too_many_pending_suggestions");
  const other = await post("pend", await command(pd, () => ({ kind: "suggest", ...select(pd, "clean"), text: "tidy" })), userAuth(SUGGESTER2));
  assert.equal(other.status, 200, "someone else's budget is their own");
  await unloaded("pend");
  const pd2 = offlineDoc("pend");
  const comment = await post("pend", await command(pd2, () => ({ kind: "comment", ...select(pd2, "text"), text: "comments are not suggestions" })), auth);
  assert.equal(comment.status, 200, JSON.stringify(comment.body));

  // Comment length.
  const d = offlineDoc("d1");
  const long = await post("d1", await command(d, () => ({ kind: "comment", ...select(d, "alpha"), text: "c".repeat(HUMAN_COLLAB_LIMITS.commentText + 1) })), auth);
  assert.equal(long.status, 400);

  // Replies per thread, and threads per document.
  const editor = await editorClient("d1");
  editor.transact(() => {
    const mk = (id: string, n: number) => {
      const t = new Y.Map<unknown>();
      t.set("id", id);
      t.set("quote", "x");
      t.set("resolved", false);
      const arr = new Y.Array<unknown>();
      arr.push(Array.from({ length: n }, (_, i) => ({ author: "a", color: "#000", text: `r${i}`, createdAt: i })));
      t.set("comments", arr);
      editor.getMap("comments").set(id, t);
    };
    mk("c-full", COMMENTS_PER_THREAD);
    for (let i = 0; i < THREADS_PER_DOCUMENT - 1; i++) mk(`c-${i}`, 1);
  });
  await caughtUp(editor);
  const reply = await post("d1", await command(editor, () => ({ kind: "reply", threadId: "c-full", text: "one more" })), auth);
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.error, "thread_full");
  const roomy = await post("d1", await command(editor, () => ({ kind: "reply", threadId: "c-0", text: "fits" })), auth);
  assert.equal(roomy.status, 200, JSON.stringify(roomy.body));
  const thread = await post("d1", await command(editor, () => ({ kind: "comment", ...select(editor, "alpha"), text: "one too many" })), auth);
  assert.equal(thread.status, 429, JSON.stringify(thread.body));
  assert.equal(thread.body.error, "too_many_threads");
  // Resolving and deleting stay possible when a document is at its limits.
  assert.equal((await post("d1", await command(editor, () => ({ kind: "resolve", threadId: "c-full", resolved: true })), auth)).status, 200);
});

for (const kind of ["comment", "reply"] as const) {
  test(`LOW-a: a ${kind} whose store failed leaves no residue after reload, and the retry applies it exactly once`, { timeout: 20000 }, async () => {
    const auth = userAuth(SUGGESTER);
    let threadId = "";
    if (kind === "reply") {
      const d0 = offlineDoc("d1");
      const made = await post("d1", await command(d0, () => ({ kind: "comment", ...select(d0, "alpha"), text: "root" })), auth);
      assert.equal(made.status, 200, JSON.stringify(made.body));
      threadId = made.body.threadId;
      await unloaded("d1");
    }
    const off = offlineDoc("d1");
    const stored = vaultHtml("d1");
    const cmd = await command(off, () => (kind === "comment" ? { kind, ...select(off, "beta"), text: "note" } : { kind, threadId, text: "note" }));
    if (kind === "comment") {
      // The command's own store fails: the half-saved snapshot keeps the thread
      // in the comments map while the reload folds the body back from the vault.
      fv.conflictOnNextWrite = true;
      const lost = await post("d1", cmd, auth);
      assert.equal(lost.status, 503);
      await unloaded("d1");
    } else {
      // A reply changes no body, so its store needs no vault write. The way an
      // unconfirmed reply ends up in a snapshot is M1's: ANOTHER store saves the
      // snapshot while the reply's own store has not run — and then the process dies.
      const mem = await loadDocumentState("d1", new Y.Doc());
      const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", docName: "d1", actor: auth.identity, level: "suggest", author: { name: "Sue Gester", color: "#000", actorId: documentActorId(auth.identity) } };
      assert.equal(executeHumanCommand(mem, ctx, cmd as never).state, "applied");
      saveDocState("d1", Y.encodeStateAsUpdate(mem), getDocState("d1")!.sourceUpdatedAt);
      mem.destroy();
      assert.equal(receipt(auth, cmd.requestId)!.state, "applied");
    }
    const retry = await post("d1", cmd, auth); // the SAME request
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.replayed, false);
    await unloaded("d1");
    const snap = offlineDoc("d1");
    const threads = snap.getMap<Y.Map<unknown>>("comments");
    if (kind === "comment") {
      assert.deepEqual([...threads.keys()], [retry.body.threadId], "exactly one thread — no orphan from the lost attempt");
      assert.equal((vaultHtml("d1").match(/data-comment-id=/g) ?? []).length, 1);
      assert.match(vaultHtml("d1"), new RegExp(`data-comment-id="${retry.body.threadId}"[^>]*>beta<`));
    } else {
      assert.deepEqual((threads.get(threadId)!.get("comments") as Y.Array<any>).toArray().map((i) => i.text), ["root", "note"], "exactly one reply");
      assert.equal(vaultHtml("d1"), stored);
    }
    assert.equal(receipt(auth, cmd.requestId)!.state, "durable");
  });
}

test("LOW-b: unconfirmed receipts belong to ONE in-memory document — loading the same note under another document name does not drop them", { timeout: 20000 }, async () => {
  insertCollabReceipt({ vault_id: "primary", note_id: "d1", doc_name: "space-key-1", actor: "user:x", request_id: "r-1", command_hash: "h", kind: "resolve", result: JSON.stringify({ requestId: "r-1", kind: "resolve", threadId: "c-none", resolved: true }), created_at: Date.now() });
  await loadDocumentState("d1", new Y.Doc());
  assert.equal(getCollabReceipt("primary", "d1", "user:x", "r-1")!.state, "applied", "the bare-id document's load left the space document's receipt alone");
  // …and storing the bare-id document does not confirm it either.
  const conn = await hocuspocus.openDirectConnection("d1", {});
  await conn.disconnect();
  assert.equal(getCollabReceipt("primary", "d1", "user:x", "r-1")!.state, "applied");
  await loadDocumentState("space-key-1", new Y.Doc());
  assert.equal(getCollabReceipt("primary", "d1", "user:x", "r-1"), null, "its own document's load drops it");
});

// ── second review (store fold, text hygiene, budgets, cost, migration) ──────

test("R1: a store that folds a newer vault copy does NOT confirm a command whose change the fold removed — 503, cleaned up, then stale", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  for (const kind of ["suggest", "comment"] as const) {
    const id = `fold-${kind}`;
    fv.put({ id, tags: ["garden"], content: BODY, updatedAt: T0 });
    const editor = await editorClient(id); // keeps the document in memory
    const cmd = await command(editor, () => (kind === "suggest" ? { kind, ...select(editor, "beta"), text: "gamma" } : { kind, ...select(editor, "beta"), text: "note" }));
    // An external writer replaces the note AFTER the command is applied in
    // memory and BEFORE its store reads the vault: the store folds that copy
    // over the live document, which removes the command's marks.
    const inner = globalThis.fetch;
    let done = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!done && getCollabReceipt("primary", id, auth.identity, cmd.requestId)) {
        done = true;
        fv.put({ id, tags: ["garden"], content: "<p>alpha</p><p>rewritten elsewhere</p>", updatedAt: "2026-12-01T00:00:00.000Z" });
      }
      return inner(input, init);
    }) as typeof fetch;
    const r = await post(id, cmd, auth);
    globalThis.fetch = inner;
    assert.equal(done, true);
    assert.equal(r.status, 503, `${kind}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "not_confirmed");
    assert.equal(getCollabReceipt("primary", id, auth.identity, cmd.requestId), null, "the receipt of the removed change is forgotten, not confirmed");
    const html = yDocToHtml(live(id)!);
    assert.equal(html, "<p>alpha</p><p>rewritten elsewhere</p>", "the external copy stands, with no leftover marks");
    assert.equal(live(id)!.getMap("comments").size, 0, "no thread left without its anchor");
    await caughtUp(editor);
    const retry = await post(id, cmd, auth);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, "stale_revision");
    assert.equal(retry.replayed, false);
    for (const p of providers.splice(0)) p.destroy();
    connected.length = 0;
    await unloaded(id);
  }
});

test("R2: ill-formed or control text is refused before it can reach the document; whitespace the stored HTML cannot keep is refused too", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const editor = await editorClient("d1");
  const before = stateOf("d1");
  const lone = "x\ud83dy";
  const raw = (o: Record<string, unknown>) => JSON.stringify(o).replace(/"__LONE__"/g, '"x\\ud83dy"');
  const base = await command(editor, () => ({ kind: "suggest", ...caretAfter(editor, "alpha"), text: "__LONE__" }));
  assert.equal(JSON.parse(raw(base)).text, lone, "the fixture really sends a lone surrogate");
  for (const body of [
    raw(base),
    raw({ ...base, kind: "comment", ...select(editor, "alpha"), text: "__LONE__" }),
    raw({ ...base, quote: "__LONE__" }),
    raw({ requestId: base.requestId, createdAt: base.createdAt, revision: base.revision, kind: "reply", threadId: "c-1", text: "__LONE__" }),
  ]) {
    const r = await post("d1", body, auth);
    assert.equal(r.status, 400, body.slice(0, 120));
    assert.equal(r.body.error, "invalid_command");
  }
  for (const text of ["a\u0000b", "a\u0007b", "a\tb", "a\u0085b", "   ", " ", "a  b", "  "]) {
    const r = await post("d1", await command(editor, () => ({ kind: "suggest", ...select(editor, "beta"), text })), auth);
    assert.equal(r.status, 400, JSON.stringify(text));
    assert.equal(r.body.error, "invalid_command");
  }
  // A space where HTML would collapse it: paragraph edge, or next to another space.
  fv.put({ id: "sp", tags: ["garden"], content: "<p>one two</p>", updatedAt: T0 });
  const sp = await editorClient("sp");
  for (const [sel, text] of [
    [() => caretAfter(sp, "one two"), "end "],
    [() => ({ from: 1, to: 1, quote: "" }), " start"],
    [() => caretAfter(sp, "one"), "x "],
    [() => caretAfter(sp, "one "), " x"],
  ] as const) {
    const r = await post("sp", await command(sp, () => ({ kind: "suggest", ...sel(), text })), auth);
    assert.equal(r.status, 400, JSON.stringify(text));
  }
  assert.equal((await post("d1", await command(editor, () => ({ kind: "comment", ...select(editor, "alpha"), text: "bell\u0007" })), auth)).status, 400);
  assert.equal(stateOf("d1"), before);
  assert.equal(receiptCount(), 0);
  // The engine refuses them too (not only the route's schema).
  const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", docName: "d1", actor: auth.identity, level: "suggest", author: { name: "x", color: "#000", actorId: "h_x" } };
  assert.throws(() => executeHumanCommand(live("d1")!, ctx, { ...base, text: lone } as never), (e: any) => e.code === "invalid_command");
  // What survives a reseed is accepted: inner single spaces, comments with line breaks and tabs.
  assert.equal((await post("sp", await command(sp, () => ({ kind: "suggest", ...caretAfter(sp, "one"), text: " and a half" })), auth)).status, 200);
  const multi = await post("d1", await command(editor, () => ({ kind: "comment", ...select(editor, "alpha"), text: "line one\n\tline two 😀" })), auth);
  assert.equal(multi.status, 200, JSON.stringify(multi.body));
  // Both parties still agree on the revision afterwards (no divergence).
  await caughtUp(editor);
  assert.equal(await clientRevision(editor), humanRevision(live("d1")!));
  // A hostile display name is bounded and cleaned before it is written.
  setUserProfile(SUGGESTER2, { name: `${"N".repeat(500)}\u0000\u0007` });
  const named = await post("d1", await command(editor, () => ({ kind: "suggest", ...select(editor, "beta"), text: "B" })), userAuth(SUGGESTER2));
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.match(vaultHtml("d1"), new RegExp(`data-user="N{${MAX_AUTHOR_NAME}}"`));
});

test("R3: a deletion-only suggestion is under the size budget too — per-command growth, run count and the document budget", { timeout: 30000 }, async () => {
  const auth = userAuth(SUGGESTER);
  // A formatting-dense paragraph: every word is its own run.
  const dense = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? `<strong>w${i}</strong>` : `<em>w${i}</em>`)).join(" ");
  fv.put({ id: "dense", tags: ["garden"], content: `<p>${dense(1200)}</p><p>tail</p>`, updatedAt: T0 });
  const d = offlineDoc("dense");
  const all = (() => {
    const doc = pm(d);
    const from = findTextRange(doc, "w0")!.from;
    const to = findTextRange(doc, "w1199")!.to;
    return { from, to, quote: doc.textBetween(from, to, "\n", "￼") };
  })();
  const sizeBefore = Buffer.byteLength(vaultHtml("dense"));
  const r = await post("dense", await command(d, () => ({ kind: "suggest", ...all, text: "" })), auth);
  assert.equal(r.status, 400, JSON.stringify(r.body).slice(0, 200));
  assert.match(r.body.message, /too many differently formatted/);
  const c = await post("dense", await command(d, () => ({ kind: "comment", ...all, text: "all of it" })), auth);
  assert.equal(c.status, 400);
  assert.equal(Buffer.byteLength(vaultHtml("dense")), sizeBefore, "the note did not grow");
  assert.equal(writes(), 0);
  // A deletion that would cross the document budget is refused even though it adds no text.
  // (Suggestion marks render as ONE span around the formatted runs since wave 4A — they rank
  // outside the formatting marks — so the deletion grows the note by a single span.)
  const filler = `<p>${"word ".repeat((MAX_DOCUMENT_BYTES - 800) / 5)}</p>`;
  fv.put({ id: "edge", tags: ["garden"], content: `${filler}<p>${dense(40)}</p>`, updatedAt: T0 });
  const e = offlineDoc("edge");
  const some = (() => {
    const doc = pm(e);
    const from = findTextRange(doc, "w0")!.from;
    const to = findTextRange(doc, "w39")!.to;
    return { from, to, quote: doc.textBetween(from, to, "\n", "￼") };
  })();
  const over = await post("edge", await command(e, () => ({ kind: "suggest", ...some, text: "" })), auth);
  assert.equal(over.status, 413, JSON.stringify(over.body).slice(0, 200));
  assert.equal(over.body.error, "document_too_large");
  assert.equal(writes(), 0);
});

test("R4: limits are checked before the expensive work, and each actor has its own per-document rate limit", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  // At the per-actor cap the request is refused before the revision is even looked at.
  db.transaction(() => {
    for (let i = 0; i < RECEIPTS_PER_ACTOR; i++) insertCollabReceipt({ vault_id: "primary", note_id: "d1", doc_name: "d1", actor: auth.identity, request_id: `a-${i}`, command_hash: "h", kind: "reply", result: "{}", created_at: Date.now() });
  })();
  db.prepare("UPDATE collab_command_receipts SET state = 'durable'").run();
  const capped = await post("d1", { requestId: randomUUID(), createdAt: Date.now(), revision: "0".repeat(64), kind: "suggest", from: 1, to: 1, quote: "", text: "x" }, auth);
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error, "actor_request_limit", "the cap answers before stale_revision would");
  // …but tidying up is budgeted separately, so the remedy stays available.
  const doc = offlineDoc("d1");
  const other = userAuth(SUGGESTER2);
  const thread = await post("d1", await command(doc, () => ({ kind: "comment", ...select(doc, "alpha"), text: "hi" })), other);
  assert.equal(thread.status, 200, JSON.stringify(thread.body));
  await unloaded("d1");
  const resolved = await post("d1", await command(offlineDoc("d1"), () => ({ kind: "resolve", threadId: thread.body.threadId, resolved: true })), auth);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));

  // Rate limit: per actor AND per document.
  flag.collabCommandsPerMinute = 3;
  fv.put({ id: "rl", tags: ["garden"], content: BODY, updatedAt: T0 });
  fv.put({ id: "rl2", tags: ["garden"], content: BODY, updatedAt: T0 });
  const bogus = () => ({ requestId: randomUUID(), createdAt: Date.now(), revision: "0".repeat(64), kind: "suggest", from: 1, to: 1, quote: "", text: "x" });
  for (let i = 0; i < 3; i++) assert.equal((await post("rl", bogus(), other)).status, 409);
  const limited = await post("rl", bogus(), other);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal((await post("rl2", bogus(), other)).status, 409, "another document has its own bucket");
  assert.equal((await post("rl", bogus(), guestAuth())).status, 409, "another actor has its own bucket");
  // Malformed requests do not use up the bucket of the actor they claim to be.
  flag.collabCommandsPerMinute = 100_000;
});

test("R5: per-actor size budgets — one actor cannot fill a document's body or comments budget, and others are unaffected", { timeout: 30000 }, async () => {
  const a = userAuth(SUGGESTER);
  const b = userAuth(SUGGESTER2);
  // Comments: max-size comments until the actor's budget is spent.
  fv.put({ id: "cb", tags: ["garden"], content: `<p>${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}</p>`, updatedAt: T0 });
  const viewer = await editorClient("cb");
  const big = "c".repeat(HUMAN_COLLAB_LIMITS.commentText);
  let made = 0;
  let last: Awaited<ReturnType<typeof post>> | null = null;
  for (let i = 0; i < 40; i++) {
    last = await post("cb", await command(viewer, () => ({ kind: "comment", ...select(viewer, `word${i}`), text: big })), a);
    if (last.status !== 200) break;
    made++;
  }
  assert.equal(last!.status, 429, JSON.stringify(last!.body));
  assert.equal(last!.body.error, "actor_growth_limit");
  assert.ok(made >= 10 && made * HUMAN_COLLAB_LIMITS.commentText <= ACTOR_COMMENT_BYTES, `stopped after ${made} max-size comments`);
  assert.ok(Buffer.byteLength(JSON.stringify(live("cb")!.getMap("comments").toJSON())) < MAX_COMMENTS_BYTES / 4, "nowhere near the document's comment budget");
  const reply = await post("cb", await command(viewer, () => ({ kind: "reply", threadId: [...viewer.getMap("comments").keys()][0]!, text: big })), a);
  assert.equal(reply.body.error, "actor_growth_limit");
  const theirs = await post("cb", await command(viewer, () => ({ kind: "comment", ...select(viewer, "word59"), text: "someone else still can" })), b);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  // The spent actor can still resolve and delete (its own threads).
  const mine = [...viewer.getMap<Y.Map<unknown>>("comments").values()].find((t) => (t.get("comments") as Y.Array<any>).get(0).text === big)!.get("id") as string;
  assert.equal((await post("cb", await command(viewer, () => ({ kind: "delete-comment", threadId: mine })), a)).status, 200);

  // Body: max-size insertions until the actor's body budget is spent.
  fv.put({ id: "bb", tags: ["garden"], content: Array.from({ length: 30 }, (_, i) => `<p>para${i} end</p>`).join(""), updatedAt: T0 });
  const v2 = await editorClient("bb");
  const chunk = "y".repeat(HUMAN_COLLAB_LIMITS.text);
  made = 0;
  for (let i = 0; i < 30; i++) {
    last = await post("bb", await command(v2, () => ({ kind: "suggest", ...caretAfter(v2, `para${i}`), text: chunk })), a);
    if (last.status !== 200) break;
    made++;
  }
  assert.equal(last!.status, 429, JSON.stringify(last!.body).slice(0, 200));
  assert.equal(last!.body.error, "actor_growth_limit");
  assert.ok(made >= 5 && made <= ACTOR_BODY_BYTES / HUMAN_COLLAB_LIMITS.text, `stopped after ${made} max-size insertions`);
  assert.ok(Buffer.byteLength(vaultHtml("bb")) < MAX_DOCUMENT_BYTES / 4, "the document is nowhere near its budget");
  const ok = await post("bb", await command(v2, () => ({ kind: "suggest", ...caretAfter(v2, "para29"), text: "fine" })), b);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // A signed-in user who ALSO presents a link is still that one account: same budget.
  const link = makeCapability("tag", "garden", "suggest");
  const both: Auth = { ...a, query: `?t=${encodeURIComponent(link)}` };
  const again = await post("bb", await command(v2, () => ({ kind: "suggest", ...caretAfter(v2, "para28"), text: chunk })), both);
  assert.equal(again.body.error, "actor_growth_limit");
});

test("R7: a database created by the earlier branch commits is migrated at boot (old table shapes are replaced, with the new index)", () => {
  const shapes = {
    first: `CREATE TABLE collab_command_receipts (vault_id TEXT NOT NULL, note_id TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL, command_hash TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, durable_at INTEGER, PRIMARY KEY (vault_id, note_id, actor, request_id));
            CREATE INDEX collab_command_receipts_doc ON collab_command_receipts(vault_id, note_id, state);
            CREATE INDEX collab_command_receipts_age ON collab_command_receipts(created_at);
            INSERT INTO collab_command_receipts VALUES ('primary','d1','user:x','r1','h','suggest','{}','durable',1,1);`,
    second: `CREATE TABLE collab_command_receipts (vault_id TEXT NOT NULL, note_id TEXT NOT NULL, doc_name TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL, command_hash TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, durable_at INTEGER, PRIMARY KEY (vault_id, note_id, actor, request_id));
            CREATE INDEX collab_command_receipts_doc ON collab_command_receipts(doc_name, state);`,
  };
  for (const [name, ddl] of Object.entries(shapes)) {
    const old = new Database(":memory:");
    old.exec(ddl);
    assert.equal(migrateCollabReceipts(old), "recreated", name);
    const cols = (old.prepare("PRAGMA table_info(collab_command_receipts)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["doc_name", "body_bytes", "comment_bytes", "command_hash", "durable_at"]) assert.ok(cols.includes(c), `${name}: ${c}`);
    const idx = old.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'collab_command_receipts_doc'").get() as { sql: string };
    assert.match(idx.sql, /\(doc_name, state\)/, `${name}: the index is on the document name`);
    // The statements db.ts prepares at module load now work against it.
    old.prepare("INSERT INTO collab_command_receipts (vault_id, note_id, doc_name, actor, request_id, command_hash, kind, result, state, created_at, durable_at, body_bytes, comment_bytes) VALUES ('v','n','d','a','r','h','k','{}','applied',1,NULL,0,0)").run();
    assert.equal(migrateCollabReceipts(old), "current", "idempotent");
    assert.equal((old.prepare("SELECT COUNT(*) AS n FROM collab_command_receipts").get() as { n: number }).n, 1, "a current table is left alone");
    old.close();
  }
  const fresh = new Database(":memory:");
  assert.equal(migrateCollabReceipts(fresh), "created");
  fresh.close();
});

test("LOW: cleaning up a lost comment never deletes other people's replies", { timeout: 20000 }, async () => {
  const mem = await loadDocumentState("d1", new Y.Doc());
  const ctx = (actor: string): HumanCommandContext => ({ vaultId: "primary", noteId: "d1", docName: "d1", actor, level: "suggest", author: { name: actor, color: "#000", actorId: documentActorId(actor) } });
  const c = { requestId: randomUUID(), createdAt: Date.now(), revision: humanRevision(mem), kind: "comment" as const, ...select(mem, "alpha"), text: "root" };
  const made = executeHumanCommand(mem, ctx("user:a"), c);
  const r = { requestId: randomUUID(), createdAt: Date.now(), revision: humanRevision(mem), kind: "reply" as const, threadId: made.result.threadId!, text: "someone else's reply" };
  executeHumanCommand(mem, ctx("user:b"), r);
  // Only the ROOT comment's command is lost; the reply was confirmed.
  const lost = db.prepare("SELECT rowid, kind, result FROM collab_command_receipts WHERE request_id = ?").all(c.requestId) as never;
  undoLostCommands(mem, lost);
  const t = mem.getMap<Y.Map<unknown>>("comments").get(made.result.threadId!);
  assert.ok(t, "the thread is kept because it holds someone else's reply");
  assert.deepEqual((t!.get("comments") as Y.Array<any>).toArray().map((i) => i.text), ["someone else's reply"]);
  assert.match(yDocToHtml(mem), new RegExp(`data-comment-id="${made.result.threadId}"`), "its anchor is kept while it is still in the body");
  // With no other reply the thread and its anchor both go.
  const solo = await loadDocumentState("d1", new Y.Doc());
  const c2 = { ...c, requestId: randomUUID(), revision: humanRevision(solo) };
  const m2 = executeHumanCommand(solo, ctx("user:a"), c2);
  undoLostCommands(solo, db.prepare("SELECT rowid, kind, result FROM collab_command_receipts WHERE request_id = ?").all(c2.requestId) as never);
  assert.equal(solo.getMap("comments").has(m2.result.threadId!), false);
  assert.equal(yDocToHtml(solo), BODY);
});
