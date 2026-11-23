/**
 * Cross-site WebSocket hijacking (launch security review): a WebSocket handshake is not
 * subject to CORS, and the SameSite=Lax session cookie rides it from any SAME-SITE page.
 * The collab upgrade therefore honours a cookie only from an Origin the one origin rule
 * accepts (`dropForeignCollabCookie`); a capability link or a device token still works from
 * anywhere, and a client that sends no Origin (not a browser) is unchanged.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { attachCollab, dropForeignCollabCookie, hocuspocus, resetReconcileState } from "../src/collab";
import { config } from "../src/config";
import { ensureUser } from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

const EDITOR = "editor@test.local";
const SIBLING = "http://evil.localhost:8787";
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
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  attachCollab(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab?schema=${COLLAB_SCHEMA_VERSION}`;
  ensureUser(EDITOR);
  grantUser(EDITOR, "tag", "team", "edit");
  fv.put({ id: "d1", content: "<p>secret</p>", tags: ["team"] });
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

/** Connect with the handshake headers a browser would send; "synced" or the refusal reason. */
function open(headers: Record<string, string>, token = "session"): Promise<{ outcome: string; doc: Y.Doc }> {
  class BrowserLike extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers });
    }
  }
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: base,
    name: "d1",
    token,
    document: doc,
    awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime (node has no global WebSocket)
    WebSocketPolyfill: BrowserLike,
  });
  providers.push(provider);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no outcome")), 5000);
    provider.on("synced", () => {
      clearTimeout(t);
      resolve({ outcome: "synced", doc });
    });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      clearTimeout(t);
      resolve({ outcome: reason || "refused", doc });
    });
  });
}

test("a session cookie opens a live page from APP_ORIGIN and from a client that sends no Origin", async () => {
  const cookie = sessionCookie(makeSession(EDITOR));
  assert.equal((await open({ cookie, origin: config.appOrigin })).outcome, "synced");
  assert.equal((await open({ cookie })).outcome, "synced");
});

test("a session cookie riding a handshake from a sibling-subdomain page is ignored: the socket is refused and reads nothing", async () => {
  const cookie = sessionCookie(makeSession(EDITOR));
  const r = await open({ cookie, origin: SIBLING });
  assert.notEqual(r.outcome, "synced");
  assert.equal(r.doc.getXmlFragment("default").length, 0, "no document content reached the foreign page");
});

test("a capability link still opens the page from any Origin (it is the page's own credential)", async () => {
  const t = makeCapability("note", "d1", "view");
  assert.equal((await open({ origin: SIBLING, cookie: sessionCookie(makeSession(EDITOR)) }, t)).outcome, "synced");
});

test("dropForeignCollabCookie: only a cookie with a foreign Origin is removed", () => {
  const req = (headers: Record<string, string>) => ({ url: "/collab", headers: { host: "localhost:8787", ...headers }, socket: { remoteAddress: "100.64.0.9" } }) as unknown as IncomingMessage;
  const foreign = req({ cookie: "prism_session=x", origin: SIBLING });
  assert.equal(dropForeignCollabCookie(foreign), true);
  assert.equal(foreign.headers.cookie, undefined);
  const own = req({ cookie: "prism_session=x", origin: config.appOrigin });
  assert.equal(dropForeignCollabCookie(own), false);
  assert.equal(own.headers.cookie, "prism_session=x");
  for (const n of config.nativeOrigins) assert.equal(dropForeignCollabCookie(req({ cookie: "c=1", origin: n })), false, n);
  assert.equal(dropForeignCollabCookie(req({ cookie: "prism_session=x" })), false, "no Origin: not a browser");
  assert.equal(dropForeignCollabCookie(req({ origin: SIBLING })), false, "nothing to drop");
});
