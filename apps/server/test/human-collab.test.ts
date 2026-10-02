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
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { canonicalCollabState, humanCollabRevision, humanCollabRevisionInput } from "@prism/core/collab-commands";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { attachCollab, collabSchema, contentToYUpdate, hocuspocus, loadDocumentState, resetReconcileState, yDocToHtml } from "../src/collab";
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
  removeGrant,
  setUserProfile,
  suggestionsForNote,
  upsertGrant,
} from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { verifyCapability } from "../src/auth/capability";
import { documentActorId, executeHumanCommand, humanRevision, RECEIPTS_PER_DOCUMENT, type HumanCommandContext } from "../src/human-collab";
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
const flag = config as { collabSuggestEnforced: boolean };
const schema = collabSchema();

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  flag.collabSuggestEnforced = true;
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
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
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
  assert.equal(canonicalCollabState({ b: 1, a: [{ d: undefined, c: "é \"" }], n: null }), '{"a":[{"c":"é \\"","d":null}],"b":1,"n":null}');
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
  assert.match(vaultHtml("d1"), new RegExp(`data-user="${OTHER}"[^>]*data-actor-id="${documentActorId(`user:${OTHER}`)}"`));
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
    const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", actor: auth.identity, level: "suggest", author: { name: "x", color: "#000", actorId: "x" } };
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
    const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", actor: auth.identity, level: "suggest", author: { name: "x", color: "#000", actorId: "x" } };
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
    const ctx: HumanCommandContext = { vaultId: "primary", noteId: "d1", actor: auth.identity, level: "suggest", author: { name: actor.name, color: "#000", actorId: documentActorId(auth.identity) } };
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

test("receipts are bounded per document (429 past the cap) and scoped to the note", { timeout: 20000 }, async () => {
  const auth = userAuth(SUGGESTER);
  const fill = db.transaction(() => {
    for (let i = 0; i < RECEIPTS_PER_DOCUMENT; i++) {
      insertCollabReceipt({ vault_id: "primary", note_id: "d1", actor: "user:filler", request_id: `r-${i}`, command_hash: "h", kind: "reply", result: "{}", created_at: Date.now() });
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
  db.prepare("UPDATE collab_command_receipts SET created_at = ? WHERE actor = 'user:filler'").run(Date.now() - 8 * 24 * 60 * 60 * 1000);
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
