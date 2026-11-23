// Prism Client backfill (Comms sprint Task 6): the Prism web app and the Prism Client desktop read
// Messages from /api/comms. Proves the READ routes answer the owner's browser session and the
// owner's prism-native device, that nobody else gains anything, that sending stays device-only,
// and the two additive read fields the web needs (`thread.noteId`, `threads?note=`).
// Synthetic data only; the Matrix reader is the test hook.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { resolveVaultEntry } from "../src/db";
import { putSecret } from "../src/secrets";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { upsertConversation, ensureSingleThread, type ConversationRow } from "../src/comms/store";
import { setCommsReaderForTests, type CommsReader } from "../src/comms/timeline";
import { issueDeviceToken } from "../src/auth/device";
import type { MatrixEvent } from "../src/worker/matrix";

const ME = "@me:example.test";
const ALEX = "@whatsapp_111:example.test";
const prevComms = process.env.COMMS_ENABLED;
const prevSend = process.env.COMMS_SEND_ENABLED;
const prevMatrix = config.actionsMatrixEnabled;
beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; });
afterEach(() => {
  if (prevComms === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prevComms;
  if (prevSend === undefined) delete process.env.COMMS_SEND_ENABLED; else process.env.COMMS_SEND_ENABLED = prevSend;
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = prevMatrix;
  setCommsReaderForTests(null);
});

function conv(id: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:example.test`, kind: "dm", title: `Title ${id}`, titleSource: "contact",
    avatar: null, lastEventAt: "2026-11-20T10:00:00.000Z", lastPreview: null, unreadCount: 0, unreadTrusted: false,
    folder: "inbox", pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null,
    vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}
const ev = (id: string, n: number, sender: string, body: string): MatrixEvent =>
  ({ event_id: id, origin_server_ts: 1_790_000_000_000 + n * 1000, sender, type: "m.room.message", content: { msgtype: "m.text", body } }) as MatrixEvent;
function withTimeline() {
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture_secret" }));
  const reader = (): CommsReader => ({
    whoami: async () => ME,
    memberProfiles: async () => ({ [ME]: { name: "Me", avatar: null }, [ALEX]: { name: "Alex", avatar: null } }),
    timelinePage: async () => ({ chunk: [ev("$b", 2, ME, "see you"), ev("$a", 1, ALEX, "hello")], start: "s0", end: null }),
  } as never);
  setCommsReaderForTests(reader);
}

const session = (email = config.ownerEmail) => ({ cookie: sessionCookie(makeSession(email)) });
const json = async (r: Response) => (await r.json()) as any;
const READS = (id: string) => [
  "/api/comms/threads",
  "/api/comms/threads/status-counts?folder=inbox",
  `/api/comms/threads/${id}`,
  `/api/comms/threads/${id}/messages`,
  "/api/comms/capabilities",
];

test("the owner's browser session reads every Messages route Prism web uses", async () => {
  withTimeline();
  const id = conv("a", { sourceRef: "!a:example.test", vaultNoteId: "note-a" });
  const app = createApp();
  for (const path of READS(id)) {
    const r = await app.request(path, { headers: session() });
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("cache-control"), "private, no-store", path);
  }
  const msgs = await json(await app.request(`/api/comms/threads/${id}/messages`, { headers: session() }));
  assert.deepEqual(msgs.messages.map((m: any) => [m.id, m.sender.isSelf]), [["$a", false], ["$b", true]]);
});

test("the owner's Prism Client (prism-native device) reads the same routes", async () => {
  withTimeline();
  const id = conv("a", { sourceRef: "!a:example.test" });
  const h = { authorization: `Bearer ${issueDeviceToken(config.ownerEmail, "Prism Client (test)", "prism-native").token}` };
  const app = createApp();
  for (const path of READS(id)) assert.equal((await app.request(path, { headers: h })).status, 200, path);
});

test("no one but the owner reads: another account's session or device, anon → refused", async () => {
  withTimeline();
  const id = conv("a", { sourceRef: "!a:example.test" });
  const app = createApp();
  const other = { authorization: `Bearer ${issueDeviceToken("other@test.local", "Phone", "prism-native").token}` };
  for (const path of READS(id).filter((p) => !p.endsWith("/capabilities"))) {
    assert.equal((await app.request(path, { headers: session("other@test.local") })).status, 403, `session ${path}`);
    assert.equal((await app.request(path, { headers: other })).status, 403, `device ${path}`);
    assert.notEqual((await app.request(path)).status, 200, `anon ${path}`);
  }
});

test("sending stays device-only: the owner's browser session cannot send (one door)", async () => {
  process.env.COMMS_SEND_ENABLED = "true";
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = true;
  const id = conv("a");
  const r = await createApp().request(`/api/comms/threads/${id}/messages`, {
    method: "POST",
    headers: { ...session(), "content-type": "application/json", origin: config.appOrigin },
    body: JSON.stringify({ clientId: "8f14e45f-ceea-4e6d-a3a5-1b7c8d9e0f11", text: "hi" }),
  });
  assert.equal(r.status, 403);
  assert.equal((await json(r)).error, "device_required");
});

test("thread wire carries noteId (the projected vault note) only when there is one", async () => {
  const withNote = conv("a", { vaultNoteId: "note-a" });
  const without = conv("b");
  const b = await json(await createApp().request("/api/comms/threads", { headers: session() }));
  const byId = Object.fromEntries(b.threads.map((t: any) => [t.id, t]));
  assert.equal(byId[withNote].noteId, "note-a");
  assert.equal("noteId" in byId[without], false);
  const d = await json(await createApp().request(`/api/comms/threads/${withNote}`, { headers: session() }));
  assert.equal(d.thread.noteId, "note-a");
});

test("threads?note= finds the conversation of a vault note in any folder; bad values are 400", async () => {
  const a = conv("a", { vaultNoteId: "note-a", folder: "archived" });
  conv("b", { vaultNoteId: "note-b" });
  const app = createApp();
  const get = async (q: string) => app.request(`/api/comms/threads?${q}`, { headers: session() });
  assert.deepEqual((await json(await get("note=note-a"))).threads.map((t: any) => t.id), [a]);
  assert.deepEqual((await json(await get("note=note-a&folder=inbox"))).threads, []);
  assert.deepEqual((await json(await get("note=missing"))).threads, []);
  assert.equal((await get("note=")).status, 400);
  assert.equal((await get(`note=${"x".repeat(201)}`)).status, 400);
  assert.equal((await json(await get(`note=${"x".repeat(201)}`))).error, "invalid_note");
  // without `note`, the inbox default is unchanged
  assert.deepEqual((await json(await get(""))).threads.map((t: any) => t.id).sort(), [conv("b", { vaultNoteId: "note-b" })]);
});
