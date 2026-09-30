/**
 * WP0.2 — "comments need suggest", pinned end to end.
 *
 * A comment thread is a Y.Doc write (its data lives in the `comments` Y.Map, its
 * anchor is a `comment` mark in the body), and the collab socket is READ-ONLY
 * below "suggest". We decided NOT to filter comment-level updates server-side
 * (the anchor is a body write, and dropping any one of a client's updates leaves
 * a gap in its Yjs clock so later updates pend forever) — instead the UI offers
 * no comment affordance below suggest. These tests pin both halves:
 *
 *   1. over a REAL Hocuspocus socket, a comment-level client's write to the
 *      comments map never reaches the server's document, while a suggest-level
 *      client's does;
 *   2. the shared UI table (`@prism/core/collab-access`) offers comments only at
 *      suggest and above — so the UI never shows an affordance the server drops.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { collabAffordances } from "@prism/core/collab-access";
import { attachCollab, hocuspocus, resetReconcileState } from "../src/collab";
import { installFakeVault, resetDb, makeCapability, type FakeVault } from "./helpers";

let fv: FakeVault;
let server: Server;
let wsUrl: string;
const sockets = new Set<Socket>();

beforeEach(async () => {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  server = createServer();
  // Upgraded WebSocket sockets keep server.close() pending forever (and with it
  // the collab reconciler interval, which stops on "close") — track + destroy.
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  attachCollab(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
});

afterEach(async () => {
  hocuspocus.closeConnections();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
  // Unload (= destroy) every loaded doc: each holds a y-protocols Awareness whose
  // setInterval would otherwise keep this test process alive forever.
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
});

/** Connect a client, wait for the initial sync, and return it. */
async function connect(name: string, token: string): Promise<{ doc: Y.Doc; provider: HocuspocusProvider }> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name,
    token,
    document: doc,
    // No awareness: Hocuspocus (4.1) decodes every inbound awareness message into
    // a scratch Awareness it never destroys, leaking a live setInterval that
    // would keep this test process from exiting.
    awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime (node has no global WebSocket)
    WebSocketPolyfill: WebSocket,
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync timeout")), 5000);
    provider.on("synced", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return { doc, provider };
}

/** What the client-side comments module does (editor/comments.ts createThread). */
function writeThread(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const t = new Y.Map<unknown>();
    t.set("id", id);
    t.set("quote", "x");
    t.set("resolved", false);
    const arr = new Y.Array<unknown>();
    arr.push([{ author: "a", color: "#000", text: "hello", createdAt: 1 }]);
    t.set("comments", arr);
    doc.getMap("comments").set(id, t);
  });
}

const serverThreads = (name: string): number =>
  hocuspocus.documents.get(name)?.getMap("comments").size ?? -1;

const settle = () => new Promise((r) => setTimeout(r, 300));

test("a comment-level socket cannot persist a comment thread (dropped server-side)", { timeout: 15000 }, async () => {
  fv.put({ id: "cn1", content: "<p>hello world</p>", tags: ["team"] });
  const { doc, provider } = await connect("cn1", makeCapability("tag", "team", "comment"));
  try {
    writeThread(doc, "c-1");
    await settle();
    assert.equal(doc.getMap("comments").size, 1, "the client applied it locally");
    assert.equal(serverThreads("cn1"), 0, "the server's document never received it");
  } finally {
    provider.destroy();
  }
});

test("a suggest-level socket DOES persist a comment thread", { timeout: 15000 }, async () => {
  fv.put({ id: "cn2", content: "<p>hello world</p>", tags: ["team"] });
  const { doc, provider } = await connect("cn2", makeCapability("tag", "team", "suggest"));
  try {
    writeThread(doc, "c-2");
    await settle();
    assert.equal(serverThreads("cn2"), 1, "the thread reached the server's document");
  } finally {
    provider.destroy();
  }
});

test("UI table: comment affordances only at suggest and above (matches the socket)", () => {
  for (const lvl of ["view", "comment"]) {
    const a = collabAffordances(lvl);
    assert.equal(a.canComment, false, `${lvl}: no comment affordance`);
    assert.equal(a.editable, false, `${lvl}: read-only`);
    assert.equal(a.canReview, false);
  }
  const s = collabAffordances("suggest");
  assert.deepEqual(s, { editable: true, suggestOnly: true, canComment: true, canReview: false });
  for (const lvl of ["edit", "own", null]) {
    assert.deepEqual(collabAffordances(lvl), { editable: true, suggestOnly: false, canComment: true, canReview: true });
  }
  // Unknown strings fail closed.
  assert.equal(collabAffordances("administrate").canComment, false);
});
