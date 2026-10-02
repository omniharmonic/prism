/**
 * Suggest-only enforcement on the RAW collab socket (R07/R12).
 *
 * A "Can suggest" grant used to be a client-side convention: the suggest-level
 * socket was read-write, so a modified client could send any Yjs update. These
 * tests drive a REAL Hocuspocus server with real HocuspocusProvider clients (and
 * hand-built protocol frames, which is what a hostile client would send) and pin:
 *
 *  - as a suggest-only actor — a signed-in user AND a capability-link guest —
 *    none of these changes the server document or what is persisted: a normal
 *    insert, a deletion-set-only update, a write to a hidden/extra Y root (a new
 *    map, the comments map), an update with pending structs (a clock gap), and a
 *    SyncStep2 that carries unseen content at connect;
 *  - the server tells the client its scope ("readonly"), which is how the web
 *    client discovers that it must use the command endpoint;
 *  - a suggest actor still READS live (an editor's later typing reaches it), and
 *    edit-level clients collaborate normally next to it;
 *  - the kill switch (COLLAB_SUGGEST_ENFORCED=false) restores the old writable
 *    suggest socket.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { attachCollab, hocuspocus, resetReconcileState, yDocToHtml } from "../src/collab";
import { config } from "../src/config";
import { ensureUser, getDocState, upsertGrant } from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { installFakeVault, resetDb, makeCapability, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const SUGGESTER = "suggester@test.local";
const BODY = "<p>hello world</p><p>second paragraph</p>";

let fv: FakeVault;
let server: Server;
let wsUrl: string;
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];
const flag = config as { collabSuggestEnforced: boolean };

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  flag.collabSuggestEnforced = true;
  fv = installFakeVault();
  server = createServer();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  attachCollab(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  ensureUser(SUGGESTER);
  grantUser(SUGGESTER, "tag", "team", "suggest");
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
  flag.collabSuggestEnforced = true;
});

/** The two kinds of human suggest actor: a signed-in account (device token as the
 *  socket token, the native client's path) and an anyone-with-link guest. */
const ACTORS: Array<{ label: string; token: () => string }> = [
  { label: "signed-in user", token: () => issueDeviceToken(SUGGESTER, "test", "prism-native").token },
  { label: "capability-link guest", token: () => makeCapability("tag", "team", "suggest") },
];

interface ConnectOptions {
  /** Send this Cookie header on the upgrade request (a browser session). */
  cookie?: string;
  /** Use a real Awareness (presence). Default off — see the awareness test. */
  awareness?: boolean;
}
async function connect(name: string, token: string, doc = new Y.Doc(), opts: ConnectOptions = {}): Promise<{ doc: Y.Doc; provider: HocuspocusProvider }> {
  const cookie = opts.cookie;
  class Socket extends WebSocket {
    constructor(url: string | URL) {
      super(url, cookie ? { headers: { cookie } } : {});
    }
  }
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name,
    token,
    document: doc,
    // Hocuspocus 4.1 leaks a scratch Awareness interval per awareness message, so
    // presence is off except in the one test that cleans those intervals up.
    ...(opts.awareness ? {} : { awareness: null }),
    // @ts-expect-error WebSocketPolyfill is accepted at runtime (node has no global WebSocket)
    WebSocketPolyfill: Socket,
  });
  providers.push(provider);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync timeout")), 5000);
    provider.on("synced", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return { doc, provider };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const live = (name: string) => hocuspocus.documents.get(name) as Y.Doc;

/** Everything a raw write could change in the server's document. */
function fingerprint(name: string) {
  const d = live(name);
  return {
    state: Buffer.from(Y.encodeStateAsUpdate(d)).toString("base64"),
    roots: [...d.share.keys()].sort().join(","),
    pendingStructs: d.store.pendingStructs !== null,
    pendingDs: d.store.pendingDs !== null,
    html: yDocToHtml(d),
  };
}

/** A hand-built Hocuspocus sync frame (what a modified client would send). */
function frame(name: string, syncType: 1 | 2, update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, name);
  encoding.writeVarUint(e, 0); // MessageType.Sync
  encoding.writeVarUint(e, syncType); // 1 = SyncStep2, 2 = Update
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}
function sendRaw(provider: HocuspocusProvider, bytes: Uint8Array): void {
  (provider.configuration.websocketProvider as unknown as { send(b: Uint8Array): void }).send(bytes);
}

const firstText = (doc: Y.Doc, n = 0) => (doc.getXmlFragment("default").get(n) as Y.XmlElement).get(0) as Y.XmlText;

/** A private copy of the server state, with every local transaction's update captured. */
function scratchOf(name: string): { doc: Y.Doc; updates: Uint8Array[] } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live(name)));
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  return { doc, updates };
}

/** Close every client, let the store run, unload, and return what was persisted. */
async function persisted(id: string): Promise<{ vault: string; snapshotHtml: string; snapshotRoots: string }> {
  for (const p of providers.splice(0)) p.destroy();
  await settle(150);
  hocuspocus.flushPendingStores();
  await settle(150);
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  const snap = new Y.Doc();
  Y.applyUpdate(snap, getDocState(id)!.state);
  return { vault: fv.notes.get(id)!.content, snapshotHtml: yDocToHtml(snap), snapshotRoots: [...snap.share.keys()].sort().join(",") };
}

for (const actor of ACTORS) {
  test(`[${actor.label}] the server reports a readonly scope to a suggest actor`, { timeout: 15000 }, async () => {
    fv.put({ id: "s0", content: BODY, tags: ["team"] });
    const { provider } = await connect("s0", actor.token());
    assert.equal(provider.authorizedScope, "readonly");
    const editor = await connect("s0", makeCapability("tag", "team", "edit"));
    assert.equal(editor.provider.authorizedScope, "read-write");
  });

  test(`[${actor.label}] a normal insert from a suggest socket never reaches the server or storage`, { timeout: 15000 }, async () => {
    fv.put({ id: "s1", content: BODY, tags: ["team"] });
    const { doc, provider } = await connect("s1", actor.token());
    const before = fingerprint("s1");
    firstText(doc).insert(0, "RAW ");
    await settle();
    assert.match(yDocToHtml(doc), /RAW hello/, "the client applied it locally");
    assert.deepEqual(fingerprint("s1"), before, "the server document is untouched");
    assert.ok(provider.unsyncedChanges > 0, "the client is told its change was not applied");
    const p = await persisted("s1");
    assert.equal(p.vault, BODY);
    assert.equal(p.snapshotHtml, BODY);
  });

  test(`[${actor.label}] a deletion-set-only update is rejected`, { timeout: 15000 }, async () => {
    fv.put({ id: "s2", content: BODY, tags: ["team"] });
    const { doc, provider } = await connect("s2", actor.token());
    const before = fingerprint("s2");
    // Through the provider (the editor's own path) …
    firstText(doc).delete(0, 6);
    // … and as a hand-built frame holding ONLY a delete set (no structs at all).
    const s = scratchOf("s2");
    firstText(s.doc, 1).delete(0, 7);
    assert.equal(s.updates.length, 1);
    const decoded = Y.decodeUpdate(s.updates[0]!);
    assert.equal(decoded.structs.length, 0, "fixture really is deletion-set only");
    assert.ok(decoded.ds.clients.size > 0);
    sendRaw(provider, frame("s2", 2, s.updates[0]!));
    await settle();
    assert.deepEqual(fingerprint("s2"), before);
    const p = await persisted("s2");
    assert.equal(p.vault, BODY);
    assert.equal(p.snapshotHtml, BODY);
  });

  test(`[${actor.label}] writes to hidden / extra Y roots (a new map, the comments map) are rejected`, { timeout: 15000 }, async () => {
    fv.put({ id: "s3", content: BODY, tags: ["team"] });
    const { doc, provider } = await connect("s3", actor.token());
    const before = fingerprint("s3");
    doc.getMap("prism-hidden-root").set("k", "v");
    const thread = new Y.Map<unknown>();
    thread.set("id", "c-raw");
    doc.getMap("comments").set("c-raw", thread);
    const s = scratchOf("s3");
    s.doc.getMap("another-root").set("x", 1);
    s.doc.getArray("rows").push([new Y.Array()]);
    for (const u of s.updates) sendRaw(provider, frame("s3", 2, u));
    await settle();
    assert.deepEqual(fingerprint("s3"), before);
    const d = live("s3");
    for (const root of ["prism-hidden-root", "another-root", "rows"]) assert.equal(d.share.has(root), false, `${root} was never created`);
    assert.equal(d.share.has("comments") ? d.getMap("comments").size : 0, 0);
    const p = await persisted("s3");
    assert.equal(p.vault, BODY);
    assert.equal(p.snapshotHtml, BODY);
    assert.equal(p.snapshotRoots, "default");
  });

  test(`[${actor.label}] an update with pending structs (a clock gap) is rejected, and leaves nothing pending`, { timeout: 15000 }, async () => {
    fv.put({ id: "s4", content: BODY, tags: ["team"] });
    const { provider } = await connect("s4", actor.token());
    const before = fingerprint("s4");
    const s = scratchOf("s4");
    firstText(s.doc).insert(0, "A");
    firstText(s.doc).insert(1, "B"); // depends on the first transaction
    assert.equal(s.updates.length, 2);
    sendRaw(provider, frame("s4", 2, s.updates[1]!)); // skip the first → a gap
    await settle();
    const after = fingerprint("s4");
    assert.equal(after.pendingStructs, false, "no pending structs parked on the server");
    assert.equal(after.pendingDs, false);
    assert.deepEqual(after, before);
    // Sending the missing update afterwards must not complete anything either.
    sendRaw(provider, frame("s4", 2, s.updates[0]!));
    await settle();
    assert.deepEqual(fingerprint("s4"), before);
    const p = await persisted("s4");
    assert.equal(p.vault, BODY);
    assert.equal(p.snapshotHtml, BODY);
  });

  test(`[${actor.label}] a SyncStep2 carrying unseen content at connect is rejected`, { timeout: 15000 }, async () => {
    fv.put({ id: "s5", content: BODY, tags: ["team"] });
    // Keep the doc loaded and learn its state through an ordinary editor.
    const editor = await connect("s5", makeCapability("tag", "team", "edit"));
    const before = fingerprint("s5");
    // The suggest client arrives with offline changes already in its Y.Doc, so
    // its reply to the server's SyncStep1 is a SyncStep2 holding them.
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(live("s5")));
    firstText(offline).insert(0, "OFFLINE ");
    offline.getMap("comments").set("c-offline", new Y.Map());
    const { provider } = await connect("s5", actor.token(), offline);
    await settle();
    assert.deepEqual(fingerprint("s5"), before, "handshake SyncStep2 was not applied");
    // And an explicit SyncStep2 frame with the full client state.
    sendRaw(provider, frame("s5", 1, Y.encodeStateAsUpdate(offline)));
    await settle();
    assert.deepEqual(fingerprint("s5"), before);
    assert.equal(yDocToHtml(editor.doc), BODY, "nothing reached the other client");
    const p = await persisted("s5");
    assert.equal(p.vault, BODY);
    assert.equal(p.snapshotHtml, BODY);
  });

  test(`[${actor.label}] editors keep collaborating beside a suggest actor, who keeps reading live`, { timeout: 15000 }, async () => {
    fv.put({ id: "s6", content: BODY, tags: ["team"] });
    const a = await connect("s6", makeCapability("tag", "team", "edit"));
    const b = await connect("s6", makeCapability("tag", "team", "edit"));
    const s = await connect("s6", actor.token());
    firstText(s.doc).insert(0, "IGNORED "); // rejected; the suggest client now has local-only state
    await settle();
    firstText(a.doc).insert(0, "ONE ");
    await settle();
    firstText(b.doc, 1).insert(0, "TWO ");
    await settle();
    const want = "<p>ONE hello world</p><p>TWO second paragraph</p>";
    assert.equal(yDocToHtml(live("s6")), want);
    assert.equal(yDocToHtml(a.doc), want);
    assert.equal(yDocToHtml(b.doc), want);
    // The suggest actor still receives edits made AFTER its rejected write (its
    // own unsent text stays local to it — nobody else ever sees it).
    assert.match(yDocToHtml(s.doc), /ONE /);
    assert.match(yDocToHtml(s.doc), /TWO second/);
    const p = await persisted("s6");
    assert.equal(p.vault, want);
  });

  test(`[${actor.label}] kill switch: COLLAB_SUGGEST_ENFORCED=false restores the writable suggest socket`, { timeout: 15000 }, async () => {
    flag.collabSuggestEnforced = false;
    fv.put({ id: "s7", content: BODY, tags: ["team"] });
    const { doc, provider } = await connect("s7", actor.token());
    assert.equal(provider.authorizedScope, "read-write");
    firstText(doc).insert(0, "LEGACY ");
    await settle();
    assert.equal(yDocToHtml(live("s7")), "<p>LEGACY hello world</p><p>second paragraph</p>");
    // view / comment stay read-only either way.
    const viewer = await connect("s7", makeCapability("tag", "team", "comment"));
    assert.equal(viewer.provider.authorizedScope, "readonly");
  });
}

// ── other credentials, live access changes, presence ────────────────────────

test("a suggest user authenticated by SESSION COOKIE (the browser path) gets a read-only socket", { timeout: 15000 }, async () => {
  fv.put({ id: "k1", content: BODY, tags: ["team"] });
  const cookie = sessionCookie(makeSession(SUGGESTER));
  const { doc, provider } = await connect("k1", "session", new Y.Doc(), { cookie });
  assert.equal(provider.authorizedScope, "readonly");
  const before = fingerprint("k1");
  firstText(doc).insert(0, "COOKIE ");
  doc.getMap("comments").set("c-cookie", new Y.Map());
  await settle();
  assert.deepEqual(fingerprint("k1"), before);
  // The same cookie with an edit grant is read-write (the cookie path is not blanket read-only).
  ensureUser("ed@test.local");
  grantUser("ed@test.local", "tag", "team", "edit");
  const ed = await connect("k1", "session", new Y.Doc(), { cookie: sessionCookie(makeSession("ed@test.local")) });
  assert.equal(ed.provider.authorizedScope, "read-write");
  const p = await persisted("k1");
  assert.equal(p.vault, BODY);
});

test("live downgrade edit → suggest and upgrade suggest → edit over an open socket: the socket is closed (\"Access changed\"), the reconnect gets the right scope, nothing written while suggest-only", { timeout: 30000 }, async () => {
  const USER = "moving@test.local";
  ensureUser(USER);
  grantUser(USER, "tag", "team", "edit");
  fv.put({ id: "m1", content: BODY, tags: ["team"] });
  const setLevel = (level: "suggest" | "edit") => void upsertGrant({ subject_type: "user", subject: USER, resource_type: "tag", resource: "team", level, created_by: "test", vault_id: "primary" });
  const { doc, provider } = await connect("m1", issueDeviceToken(USER, "test", "prism-native").token);
  // The shipped client recognises this close by its reason ("Access changed. …").
  const closes: string[] = [];
  provider.on("close", ({ event }: { event: { code?: number; reason?: string } }) => closes.push(`${event?.code}:${event?.reason ?? ""}`));
  const accessClose = () => closes.some((c) => c.includes("Access changed."));
  // …and then reconnects itself, exactly as apps/web CollabDoc does: Hocuspocus
  // closes the DOCUMENT channel, which the provider does not re-open on its own.
  provider.on("close", ({ event }: { event: { reason?: string } }) => {
    if (!event?.reason?.startsWith("Access changed.")) return;
    const transport = provider.configuration.websocketProvider;
    const done = () => {
      transport.off("close", done);
      void provider.connect();
    };
    transport.on("close", done);
    provider.disconnect();
  });
  const scope = async (want: string) => {
    for (let i = 0; i < 200 && !(provider.authorizedScope === want && provider.synced); i++) await settle(25);
    assert.equal(provider.authorizedScope, want);
  };
  assert.equal(provider.authorizedScope, "read-write");
  firstText(doc).insert(0, "ASEDITOR ");
  await settle();
  assert.match(yDocToHtml(live("m1")), /<p>ASEDITOR hello/, "an editor's write lands");

  // Downgrade while connected.
  provider.authorizedScope = undefined;
  setLevel("suggest");
  await settle(100);
  assert.ok(accessClose(), `the server closed the socket for the access change (saw ${closes.join(" | ")})`);
  await scope("readonly");
  const asSuggest = fingerprint("m1");
  firstText(doc, 1).insert(0, "ASSUGGESTER ");
  await settle();
  assert.deepEqual(fingerprint("m1"), asSuggest, "nothing is written while the grant is suggest");
  assert.doesNotMatch(yDocToHtml(live("m1")), /ASSUGGESTER/);

  // Upgrade while connected.
  closes.length = 0;
  provider.authorizedScope = undefined;
  setLevel("edit");
  await settle(100);
  assert.ok(accessClose(), `closed again for the upgrade (saw ${closes.join(" | ")})`);
  await scope("read-write");
  assert.deepEqual(fingerprint("m1").pendingStructs, false);
  firstText(doc).insert(0, "AGAIN ");
  await settle();
  assert.match(yDocToHtml(live("m1")), /<p>AGAIN ASEDITOR hello/, "an editor again");
  // Observed, and expected of a CRDT client: text the user typed locally while
  // suggest-only is still in THEIR Y.Doc, so it syncs once they hold edit.
  assert.match(yDocToHtml(live("m1")), /ASSUGGESTER second/);
});

test("the loopback COLLAB_TOKEN owner path is unchanged: read-write under enforcement, with no grant at all", { timeout: 15000 }, async () => {
  assert.ok(config.collabToken);
  fv.put({ id: "o1", content: BODY, tags: ["private-to-owner"] });
  const { doc, provider } = await connect("o1", config.collabToken);
  assert.equal(provider.authorizedScope, "read-write");
  firstText(doc).insert(0, "OWNER ");
  await settle();
  assert.equal(yDocToHtml(live("o1")), "<p>OWNER hello world</p><p>second paragraph</p>");
  // A wrong token on the same loopback connection gets nothing.
  await assert.rejects(connect("o1", "not-the-token"), /sync timeout/);
});

test("presence: a read-only suggest socket can publish awareness, and awareness cannot alter the document", { timeout: 20000 }, async () => {
  // Hocuspocus 4.1 decodes every inbound awareness message into a scratch
  // Awareness it never destroys (a live setInterval each). Collect every
  // interval created during this test and clear them at the end.
  const realSetInterval = globalThis.setInterval;
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    intervals.push(h);
    return h;
  }) as typeof setInterval;
  try {
    fv.put({ id: "a1", content: BODY, tags: ["team"] });
    const editor = await connect("a1", makeCapability("tag", "team", "edit"), new Y.Doc(), { awareness: true });
    const me = await connect("a1", makeCapability("tag", "team", "suggest"), new Y.Doc(), { awareness: true });
    assert.equal(me.provider.authorizedScope, "readonly");
    const before = fingerprint("a1");
    me.provider.setAwarenessField("user", { name: "Sue Gester", color: "#f0f" });
    // A hostile presence payload is still only presence.
    me.provider.setAwarenessField("doc", { content: "<p>pwned</p>", update: "AAAA", cursor: { anchor: 1, head: 9 } });
    await settle(400);
    const serverStates = [...(live("a1") as unknown as { awareness: { getStates(): Map<number, any> } }).awareness.getStates().values()];
    assert.ok(serverStates.some((s) => s?.user?.name === "Sue Gester"), "the server holds the suggest actor's presence");
    const seenByEditor = [...editor.provider.awareness!.getStates().values()];
    assert.ok(seenByEditor.some((s: any) => s?.user?.name === "Sue Gester"), "…and the editor sees it");
    assert.deepEqual(fingerprint("a1"), before, "the document is untouched by awareness");
    assert.equal(yDocToHtml(editor.doc), BODY);
    const p = await persisted("a1");
    assert.equal(p.vault, BODY);
    assert.equal(p.snapshotHtml, BODY);
  } finally {
    for (const p of providers.splice(0)) p.destroy();
    globalThis.setInterval = realSetInterval;
    for (const h of intervals) clearInterval(h);
  }
});
