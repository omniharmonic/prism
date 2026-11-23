import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
import { createHttpLiveActionsClient } from "../../../packages/core/src/lib/actions/client";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { putSecret } from "../src/secrets";
import { db, addVaultEntry } from "../src/db";
import { MatrixClient } from "../src/worker/matrix";
import { projectMessage, setThreadReaderForTests } from "../src/routes/threads";
import { resetDb, installFakeVault, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";
let fv: FakeVault;
let reads: Array<{ room: string; before?: string }>;
const event = { type: "m.room.message", event_id: "$one", sender: "@one:example.test", origin_server_ts: 1790870400000, content: { body: "LIVE_PRIVATE_FIXTURE", msgtype: "m.text" } };
beforeEach(() => {
  resetDb(); fv = installFakeVault(); reads = [];
  fv.put({ id: "thread", tags: ["message-thread", "team"], content: "SAVED_FIXTURE", metadata: { matrixRoomId: "!room:example.test" } });
  putSecret("primary", config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://example.test", accessToken: "fixture-token" }));
  setThreadReaderForTests(() => ({
    whoami: async () => "@self:example.test", joinedRooms: async () => ["!room:example.test"],
    joinedMembers: async () => ({ "@one:example.test": "Alex", "@two:example.test": "Alex" }),
    messagePage: async (room, before) => { reads.push({ room, before }); return { chunk: [event, event, { ...event, event_id: "$two", sender: "@two:example.test" }], start: before ?? "newest", end: before ? before : "older" }; },
  }));
});
afterEach(() => { setThreadReaderForTests(null); fv.restore(); });
const get = (path = "/api/threads/thread/live", email = config.ownerEmail, vault = "primary") => createApp().request(path, { headers: { cookie: sessionCookie(makeSession(email)), "X-Prism-Vault": vault } });

test("owner live timeline preserves stable identities and cursor, deduplicating only event IDs", async () => {
  const response = await get(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json() as any;
  assert.deepEqual(result.messages.map((m: any) => [m.event_id, m.sender_name, m.sender, m.is_outgoing]), [["$one", "Alex", "@one:example.test", false], ["$two", "Alex", "@two:example.test", false]]);
  assert.equal(result.end, "older"); assert.equal(result.has_more, true);
  const end = await (await get("/api/threads/thread/live?before=older")).json() as any;
  assert.equal(end.has_more, false); assert.equal(end.end, null);
  assert.deepEqual(reads, [{ room: "!room:example.test", before: undefined }, { room: "!room:example.test", before: "older" }]);
  assert.ok(!JSON.stringify(result).includes("fixture-token"));
});

test("a transcript grant cannot read the owner's live connector, including anon and secondary vault", async () => {
  grantUser("reader@test.local", "note", "thread", "view");
  assert.equal((await get(undefined, "reader@test.local")).status, 403);
  assert.equal((await createApp().request("/api/threads/thread/live")).status, 403);
  addVaultEntry({ id: "secondary", label: "Secondary", url: "https://other.example.test", vault: "second", token: "other-token" });
  assert.equal((await get(undefined, config.ownerEmail, "secondary")).status, 409);
  assert.deepEqual(reads, []);
});

test("live reader refuses cursor abuse, unjoined rooms and ordinary documents", async () => {
  assert.equal((await get("/api/threads/thread/live?before=" + "a".repeat(2050))).status, 400);
  fv.put({ id: "plain", tags: ["document"], content: "BODY", metadata: { matrixRoomId: "!room:example.test" } });
  assert.equal((await get("/api/threads/plain/live")).status, 404);
  setThreadReaderForTests(() => ({ whoami: async () => "@self:example.test", joinedRooms: async () => [], joinedMembers: async () => ({}), messagePage: async () => { throw Error("must not fetch"); } }));
  assert.equal((await get()).status, 404); assert.deepEqual(reads, []);
});

test("revoked session during an upstream read never receives its late messages", async () => {
  setThreadReaderForTests(() => ({
    whoami: async () => "@self:example.test", joinedRooms: async () => ["!room:example.test"], joinedMembers: async () => ({}),
    messagePage: async () => { db.prepare("DELETE FROM sessions").run(); return { chunk: [event], start: null, end: null }; },
  }));
  const response = await get(); assert.equal(response.status, 403); assert.ok(!(await response.text()).includes("LIVE_PRIVATE_FIXTURE"));
});

test("source projection uses verified self identity and never exposes redacted bodies", () => {
  assert.equal(projectMessage(event, "@one:example.test", {})!.is_outgoing, true);
  const removed = projectMessage({ ...event, unsigned: { redacted_because: {} } }, "@self:example.test", {})!;
  assert.equal(removed.body, "Message removed"); assert.equal(removed.media_url, null);
  assert.equal(projectMessage({ ...event, event_id: "" }, "self", {}), null);
  assert.equal(projectMessage({ ...event, content: { body: "x".repeat(64001) } }, "self", {})!.truncated, true);
});

test("Matrix page transport encodes room and opaque cursor without changing ingest pagination", async () => {
  let requested = "";
  const client = new MatrixClient({ homeserver: "https://example.test", accessToken: "fixture" }, (async (input) => {
    requested = String(input); return Response.json({ chunk: [event], start: "a", end: "b" });
  }) as typeof fetch);
  assert.equal((await client.messagePage("!room:example.test", "x&y=?", 50)).chunk[0]!.event_id, "$one");
  const url = new URL(requested);
  assert.equal(url.searchParams.get("from"), "x&y=?"); assert.equal(url.searchParams.get("dir"), "b");
  assert.equal(url.searchParams.get("limit"), "50");
});


test("the real actions client discovers status at the mounted server route", async () => {
  const app = createApp();
  const client = createHttpLiveActionsClient({
    fetch: async (path, init) => app.request(path, init),
    headers: () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) }),
  });
  assert.equal((await client.status()).matrix.configured, true);
  const guest = createHttpLiveActionsClient({
    fetch: async (path, init) => app.request(path, init),
    headers: () => ({ cookie: sessionCookie(makeSession("reader@test.local")) }),
  });
  await assert.rejects(guest.status(), (error: any) => error.status === 403);
});
