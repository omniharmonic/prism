/**
 * Comms sending (Phase 2a): POST /api/comms/threads/:id/messages | /attachments.
 * Synthetic data only; the Matrix client is a fake (setCommsSendClientForTests) — nothing ever
 * reaches a homeserver.
 */
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, resolveVaultEntry } from "../src/db";
import { putSecret, deleteSecret } from "../src/secrets";
import { issueDeviceToken } from "../src/auth/device";
import { INPROCESS_ACTOR, INPROCESS_CLIENT_KEY } from "../src/auth/actor";
import { clearRateLimitsForTests } from "../src/middleware/ratelimit";
import { setMatrixActionClientForTests } from "../src/actions/matrix";
import { upsertConversation, ensureSingleThread, putWindow, removeConversation, type ConversationRow } from "../src/comms/store";
import { setCommsSendClientForTests, txnIdFor, type CommsSendClient } from "../src/comms/send";
import { RETRY_WINDOW_MS, setSendLedgerClockForTests } from "../src/comms/send-ledger";
import { messageOut } from "../src/comms/timeline";
import { normalizeEvents } from "../src/comms/normalize";
import { commsSelfIds, storeOwnerSenders } from "../src/comms/owner";
import type { Message } from "../src/comms/types";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import { claimSend, clientIdForEvent, markSent, releaseSend, PENDING_STALE_MS, RETRY_WINDOW_NO_DEVICE_MS } from "../src/comms/send-ledger";
import { shortHash } from "../src/actions/store";
import { roomMetaFromState } from "../src/comms/room-meta";

const ME = "@omni-agent:localhost"; // the stored credential's account (the agent's)
const OWNER_GHOST = "@whatsapp_111:example.test";
const ALEX = "@whatsapp_222:example.test";
const BOT = "@whatsappbot:example.test";
const CAPS = { react: true, edit: true, unsend: true, reply: true, typing: true, receipts: true, attachments: true };
const VAULT = () => resolveVaultEntry(undefined).id;

const envKeys = ["COMMS_ENABLED", "COMMS_SEND_ENABLED", "COMMS_SEND_MAX_BYTES", "COMMS_SEND_PER_10MIN", "COMMS_OWNER_GHOSTS"] as const;
const savedEnv: Record<string, string | undefined> = {};
const savedMatrixFlag = config.actionsMatrixEnabled;

interface Sent { roomId: string; type: string; txnId: string; content: Record<string, unknown> }
let sent: Sent[];
let uploads: Array<{ bytes: number; contentType: string; filename: string }>;
let joined: string[];
let members: Record<string, { name: string | null; avatar: string | null }>;
let sendImpl: (s: Sent) => Promise<string>;
let hsLimit: number | null;
let eventExists: boolean;
let deviceId: string | null;
let encryptedRooms: Set<string>;
let reactionsOn: Map<string, Array<{ eventId: string; sender: string; key: string }>>;
let redactions: Array<{ room: string; eventId: string; txnId: string }>;
/** eventId → the room it lives in (an event of another room is not found in this one). */
let roomEvents: Map<string, string>;

function conv(id: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:example.test`, kind: "dm", title: `Title ${id}`, titleSource: "contact",
    avatar: null, lastEventAt: "2026-11-20T10:00:00.000Z", lastPreview: null, unreadCount: 0, unreadTrusted: false,
    folder: "inbox", pinned: false, muted: false, archived: false, triage: null, accountLabel: null,
    capabilities: CAPS, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}

beforeEach(() => {
  resetDb();
  for (const k of envKeys) savedEnv[k] = process.env[k];
  process.env.COMMS_ENABLED = "true";
  process.env.COMMS_SEND_ENABLED = "true";
  process.env.COMMS_OWNER_GHOSTS = OWNER_GHOST;
  delete process.env.COMMS_SEND_MAX_BYTES;
  delete process.env.COMMS_SEND_PER_10MIN;
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = true;
  clearRateLimitsForTests("comms");
  clearRateLimitsForTests("actions");
  sent = [];
  uploads = [];
  joined = ["!c1:example.test", "!mgmt:example.test", "!email1:example.test"];
  members = { [ME]: { name: "Omni", avatar: null }, [OWNER_GHOST]: { name: "Owner", avatar: null }, [ALEX]: { name: "Alex", avatar: null }, [BOT]: { name: "bot", avatar: null } };
  sendImpl = async () => `$ev${sent.length}`;
  hsLimit = null;
  eventExists = true;
  deviceId = "DEVICEABC";
  encryptedRooms = new Set();
  reactionsOn = new Map();
  redactions = [];
  roomEvents = new Map();
  const fake: CommsSendClient = {
    async sendEvent(roomId, type, txnId, content) {
      const s = { roomId, type, txnId, content };
      sent.push(s);
      return sendImpl(s);
    },
    async joinedRooms() { return joined; },
    async whoamiInfo() { return { userId: ME, deviceId: deviceId }; },
    async roomEncrypted(room: string) { return encryptedRooms.has(room); },
    async reactionsTo(room: string, eventId: string) { return reactionsOn.get(`${room}|${eventId}`) ?? []; },
    async redactEvent(room: string, eventId: string, txnId: string) {
      redactions.push({ room, eventId, txnId });
      const k = [...reactionsOn.keys()].find((x) => x.startsWith(`${room}|`) && reactionsOn.get(x)!.some((r) => r.eventId === eventId));
      if (k) reactionsOn.set(k, reactionsOn.get(k)!.filter((r) => r.eventId !== eventId));
      return `$redaction${redactions.length}`;
    },
    async eventExists(room: string, eventId: string) { return eventExists && (!roomEvents.has(eventId) || roomEvents.get(eventId) === room); },
    async memberProfiles(room: string) {
      return room === "!mgmt:example.test" ? { [ME]: members[ME]!, [BOT]: members[BOT]! } : members;
    },
    async uploadMedia(bytes: Uint8Array, contentType: string, filename: string) {
      uploads.push({ bytes: bytes.byteLength, contentType, filename });
      return `mxc://example.test/up${uploads.length}`;
    },
    async mediaConfig() { return hsLimit; },
  };
  setCommsSendClientForTests(() => fake);
  setMatrixActionClientForTests(null); // clears the joined-rooms cache
  storeOwnerSenders([{ id: OWNER_GHOST, source: "override" }]); // the owner's phone ghost is self
  putSecret(VAULT(), config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://hs.example.test", accessToken: "stub-matrix-token" }));
  conv("c1");
});
afterEach(() => {
  for (const k of envKeys) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = savedMatrixFlag;
  setCommsSendClientForTests(null);
  setSendLedgerClockForTests(null);
});

const TH = "th_c1";
const device = (client = "comms-native") => ({ authorization: `Bearer ${issueDeviceToken(config.ownerEmail, "Comms (test)", client).token}` });
const J = { "content-type": "application/json" };
const uuid = () => crypto.randomUUID();
const postText = (body: unknown, headers: Record<string, string> = device(), thread = TH, env?: object) =>
  createApp().request(`/api/comms/threads/${thread}/messages`, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) }, env);
const json = async (r: Response) => (await r.json()) as any;
const audit = () => db.prepare(`SELECT * FROM action_audit WHERE action = 'comms.send' ORDER BY id`).all() as Array<Record<string, any>>;
const auditAll = () => db.prepare(`SELECT * FROM action_audit WHERE action LIKE 'comms.%' ORDER BY id`).all() as Array<Record<string, any>>;

function form(fields: Record<string, string>, file?: { bytes: Buffer; name: string; type?: string }, thumb?: { bytes: Buffer }): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (file) f.append("file", new Blob([file.bytes], { type: file.type ?? "application/octet-stream" }), file.name);
  if (thumb) f.append("thumbnail", new Blob([thumb.bytes], { type: "image/jpeg" }), "t.jpg");
  return f;
}
const postAtt = (fd: FormData, headers: Record<string, string> = device(), thread = TH) =>
  createApp().request(`/api/comms/threads/${thread}/attachments`, { method: "POST", headers, body: fd });

// ── bytes ──
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3]), Buffer.alloc(40)]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"), Buffer.from("ffc0001108000a001403012200021101031101", "hex"), Buffer.alloc(20)]);
const OGG_OPUS = Buffer.concat([Buffer.from("OggS", "latin1"), Buffer.alloc(24), Buffer.from("OpusHead", "latin1"), Buffer.alloc(40)]);
const OGG_VORBIS = Buffer.concat([Buffer.from("OggS", "latin1"), Buffer.alloc(24), Buffer.from("\x01vorbis", "latin1"), Buffer.alloc(40)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A ", "latin1"), Buffer.alloc(40)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(40)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(40)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!DOCTYPE html><html><body>x</body></html>");
const EXE = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(100)]);
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");

// ── origin ──────────────────────────────────────────────────────────────────

test("origin: only the owner's DEVICE token sends — session, MCP, loopback token, downgrade, anon and other users are refused; nothing sent", async () => {
  const body = () => ({ clientId: uuid(), text: "hi" });
  const session = await postText(body(), { cookie: sessionCookie(makeSession(config.ownerEmail)) });
  assert.equal(session.status, 403);
  assert.equal((await json(session)).error, "device_required");

  const owner = { kind: "user" as const, email: config.ownerEmail, role: "owner" as const, vaultId: VAULT(), grants: [] };
  const mcp = await postText(body(), {}, TH, { [INPROCESS_ACTOR]: owner, [INPROCESS_CLIENT_KEY]: "mcp:pat:t1" });
  assert.equal(mcp.status, 403);
  assert.equal((await json(mcp)).error, "device_required");

  const loop = await postText(body(), { authorization: `Bearer ${config.collabToken}` });
  assert.equal(loop.status, 403, "the loopback owner token is an agent origin");

  const down = await postText(body(), { ...device(), "x-prism-action-origin": "agent" });
  assert.equal(down.status, 403);
  assert.equal((await json(down)).error, "device_required");

  assert.equal((await postText(body(), {})).status, 403, "anon");
  const stranger = await postText(body(), { authorization: `Bearer ${issueDeviceToken("stranger@test.local", "x", "comms-native").token}` });
  assert.equal(stranger.status, 403);
  assert.equal(sent.length, 0);
  // The audit records the REAL origin of every refused attempt.
  const rows = audit().map((a) => [a.via, a.origin, a.status, a.error]);
  assert.deepEqual(rows.slice(0, 4), [
    ["session", "human", "refused", "device_required"],
    ["mcp", "agent", "refused", "device_required"],
    ["local-token", "agent", "refused", "device_required"],
    ["device", "agent", "refused", "device_required"],
  ]);
});

test("any of the owner's device clients counts (comms-native, prism-native, omni-native)", async () => {
  for (const client of ["comms-native", "prism-native", "omni-native"]) {
    const r = await postText({ clientId: uuid(), text: `from ${client}` }, device(client));
    assert.equal(r.status, 200, client);
  }
  assert.equal(sent.length, 3);
});

// ── flags ───────────────────────────────────────────────────────────────────

test("flags: COMMS_SEND_ENABLED off or the Matrix family flag off → 403 send_disabled; COMMS_ENABLED off → 404", async () => {
  process.env.COMMS_SEND_ENABLED = "false";
  let r = await postText({ clientId: uuid(), text: "x" });
  assert.equal(r.status, 403);
  assert.deepEqual(Object.keys(await json(r)).sort(), ["error", "message"]);
  process.env.COMMS_SEND_ENABLED = "true";
  (config as { actionsMatrixEnabled: boolean }).actionsMatrixEnabled = false;
  r = await postText({ clientId: uuid(), text: "x" });
  assert.equal(r.status, 403);
  assert.equal((await json(r)).error, "send_disabled");
  const att = await postAtt(form({ clientId: uuid(), kind: "image" }, { bytes: PNG, name: "a.png" }));
  assert.equal((await json(att)).error, "send_disabled");
  process.env.COMMS_ENABLED = "false";
  r = await postText({ clientId: uuid(), text: "x" });
  assert.equal(r.status, 404);
  assert.equal(sent.length + uploads.length, 0);
});

// ── thread resolution ───────────────────────────────────────────────────────

test("thread: unknown, removed (left) and not-joined threads → 404 not_found; nothing sent; a not-joined refusal frees the clientId", async () => {
  assert.equal((await json(await postText({ clientId: uuid(), text: "x" }, device(), "th_nope"))).error, "not_found");
  conv("gone");
  removeConversation("gone");
  assert.equal((await postText({ clientId: uuid(), text: "x" }, device(), "th_gone")).status, 404);

  joined = [];
  const id = uuid();
  const nj = await postText({ clientId: id, text: "x" });
  assert.equal(nj.status, 404);
  assert.equal((await json(nj)).error, "not_found");
  assert.equal(sent.length, 0);
  joined = ["!c1:example.test"];
  setMatrixActionClientForTests(null); // joined cache
  const ok = await postText({ clientId: id, text: "x" });
  assert.equal(ok.status, 200, "same clientId works once the room is joined");
});

test("thread: a bridge management room (only the account + bridge bots) is never a target", async () => {
  conv("mgmt");
  const r = await postText({ clientId: uuid(), text: "logout" }, device(), "th_mgmt");
  assert.equal(r.status, 404);
  assert.equal(sent.length, 0);
});

test("S2: a chat whose only other member is one of the agent's senders (OMNI_AGENT_MATRIX_IDS) is sendable", async () => {
  const OMNI_TG = "@telegram_7000000001:example.test";
  const saved = process.env.OMNI_AGENT_MATRIX_IDS;
  process.env.OMNI_AGENT_MATRIX_IDS = OMNI_TG;
  try {
    conv("omni", { network: "telegram" });
    joined = ["!omni:example.test"];
    setMatrixActionClientForTests(null);
    members = { [ME]: { name: "Omni", avatar: null }, [OMNI_TG]: { name: "Omni bot", avatar: null }, "@telegrambot:example.test": { name: "bot", avatar: null } };
    const r = await postText({ clientId: uuid(), text: "hello bot" }, device(), "th_omni");
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(sent.length, 1);
    // Still refused: only the posting account, the owner's own ghost and bridge bots.
    conv("selfonly", { network: "telegram" });
    joined = ["!selfonly:example.test"];
    setMatrixActionClientForTests(null);
    members = { [ME]: { name: "Omni", avatar: null }, [OWNER_GHOST]: { name: "Owner", avatar: null }, "@telegrambot:example.test": { name: "bot", avatar: null } };
    const no = await postText({ clientId: uuid(), text: "x" }, device(), "th_selfonly");
    assert.equal(no.status, 404);
    assert.match((await json(no)).message, /bridge bot/);
    members = { [ME]: { name: "Omni", avatar: null } };
    const alone = await postText({ clientId: uuid(), text: "x" }, device(), "th_selfonly");
    assert.match((await json(alone)).message, /only one in this conversation/);
    assert.equal(sent.length, 1);
  } finally {
    if (saved === undefined) delete process.env.OMNI_AGENT_MATRIX_IDS; else process.env.OMNI_AGENT_MATRIX_IDS = saved;
  }
});

test("fix round 1 (M3): a native (non-puppet) agent account never makes a bridge management room sendable", async () => {
  const saved = process.env.OMNI_AGENT_MATRIX_IDS;
  process.env.OMNI_AGENT_MATRIX_IDS = "@omni-helper:example.test";
  try {
    conv("mg2", { network: "telegram" });
    joined = ["!mg2:example.test"];
    setMatrixActionClientForTests(null);
    members = { [ME]: { name: "Omni", avatar: null }, "@omni-helper:example.test": { name: "Helper", avatar: null }, "@telegrambot:example.test": { name: "bot", avatar: null } };
    const r = await postText({ clientId: uuid(), text: "logout" }, device(), "th_mg2");
    assert.equal(r.status, 404);
    assert.equal(sent.length, 0);
  } finally {
    if (saved === undefined) delete process.env.OMNI_AGENT_MATRIX_IDS; else process.env.OMNI_AGENT_MATRIX_IDS = saved;
  }
});

test("S2: the posting account is never a recipient, even when it is listed as an agent sender", async () => {
  const saved = process.env.OMNI_AGENT_MATRIX_IDS;
  process.env.OMNI_AGENT_MATRIX_IDS = ME;
  try {
    conv("mgmt");
    const r = await postText({ clientId: uuid(), text: "logout" }, device(), "th_mgmt");
    assert.equal(r.status, 404);
    assert.equal(sent.length, 0);
  } finally {
    if (saved === undefined) delete process.env.OMNI_AGENT_MATRIX_IDS; else process.env.OMNI_AGENT_MATRIX_IDS = saved;
  }
});

test("unsupported networks: email, imessage, sms, plain matrix (would post as the agent) → 409 unsupported_network", async () => {
  for (const network of ["email", "imessage", "sms", "matrix"] as const) {
    conv(`${network}1`, { network });
    const r = await postText({ clientId: uuid(), text: "x" }, device(), `th_${network}1`);
    assert.equal(r.status, 409, network);
    assert.equal((await json(r)).error, "unsupported_network");
  }
  assert.equal(sent.length, 0);
});

// ── text ────────────────────────────────────────────────────────────────────

test("text: 200 {clientId, eventId, status}; m.text content; txn id derived from clientId; audit holds no text", async () => {
  const id = uuid();
  const r = await postText({ clientId: id, text: "Hello there, secret words" });
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { clientId: id, eventId: "$ev1", status: "sent" });
  assert.deepEqual(sent[0]!.content, { msgtype: "m.text", body: "Hello there, secret words" });
  assert.equal(sent[0]!.roomId, "!c1:example.test");
  assert.equal(sent[0]!.type, "m.room.message");
  assert.match(sent[0]!.txnId, /^comms-[0-9a-f]{32}$/);
  const rows = audit();
  assert.equal(rows.at(-1)!.status, "ok");
  assert.equal(rows.at(-1)!.via, "device");
  assert.equal(rows.at(-1)!.origin, "human");
  assert.ok(!JSON.stringify(rows).includes("secret words"));
});

test("text: validation → 422 invalid / 413 too_large / 415; the client can never name a room", async () => {
  const cases: Array<[unknown, number]> = [
    [{ clientId: "not-a-uuid", text: "x" }, 422],
    [{ clientId: uuid(), text: "   " }, 422],
    [{ clientId: uuid() }, 422],
    [{ clientId: uuid(), text: "x", roomId: "!other:example.test" }, 422],
    [{ clientId: uuid(), text: "x".repeat(32_001) }, 413],
    [{ clientId: uuid(), text: "x", replyTo: "not-an-event" }, 422],
    [[1, 2], 422],
  ];
  for (const [b, status] of cases) assert.equal((await postText(b)).status, status, JSON.stringify(b).slice(0, 60));
  const textPlain = await createApp().request(`/api/comms/threads/${TH}/messages`, { method: "POST", headers: { ...device(), "content-type": "text/plain" }, body: "{}" });
  assert.equal(textPlain.status, 415);
  assert.equal((await json(textPlain)).error, "unsupported_type");
  assert.equal(sent.length, 0);
});

test("idempotent: the same clientId replays the first result (sent once); a different message under it → 422", async () => {
  const id = uuid();
  const a = await postText({ clientId: id, text: "once" });
  const b = await postText({ clientId: id, text: "once" });
  assert.deepEqual(await json(a), await json(b));
  assert.equal(b.headers.get("idempotent-replayed"), "true");
  assert.equal(sent.length, 1);
  const other = await postText({ clientId: id, text: "different" });
  assert.equal(other.status, 422);
  assert.equal((await json(other)).error, "invalid");
  assert.equal(sent.length, 1);
  assert.ok(audit().some((r) => r.status === "replayed"));
});

test("idempotent: a request still running under the clientId → 409 in_progress", async () => {
  let release!: (v: string) => void;
  sendImpl = () => new Promise((res) => { release = res; });
  const id = uuid();
  const first = postText({ clientId: id, text: "slow" });
  while (!sent.length) await new Promise((r) => setImmediate(r));
  const second = await postText({ clientId: id, text: "slow" });
  assert.equal(second.status, 409);
  assert.equal((await json(second)).error, "in_progress");
  release("$slow");
  assert.equal((await first).status, 200);
  assert.equal(sent.length, 1);
});

test("rate limit: COMMS_SEND_PER_10MIN per owner → 429 rate_limited with Retry-After", async () => {
  process.env.COMMS_SEND_PER_10MIN = "2";
  assert.equal((await postText({ clientId: uuid(), text: "1" })).status, 200);
  assert.equal((await postText({ clientId: uuid(), text: "2" })).status, 200);
  const r = await postText({ clientId: uuid(), text: "3" });
  assert.equal(r.status, 429);
  assert.equal((await json(r)).error, "rate_limited");
  assert.ok(r.headers.get("retry-after"));
  assert.equal(sent.length, 2);
});

test("reply: m.relates_to.m.in_reply_to from a message of THIS thread; one that is not here → 422", async () => {
  putWindow(TH, [{ id: "$orig", source: { network: "whatsapp", eventId: "$orig", ref: "$orig" }, sentAt: "2026-11-20T10:00:00.000Z" } as unknown as Message]);
  const r = await postText({ clientId: uuid(), text: "yes", replyTo: "$orig" });
  assert.equal(r.status, 200);
  assert.deepEqual(sent[0]!.content, { msgtype: "m.text", body: "yes", "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } } });
  // not in the window: asked of the room itself
  eventExists = true;
  assert.equal((await postText({ clientId: uuid(), text: "older", replyTo: "$older" })).status, 200);
  eventExists = false;
  const bad = await postText({ clientId: uuid(), text: "x", replyTo: "$elsewhere" });
  assert.equal(bad.status, 422);
  assert.equal(sent.length, 2);
});

test("maybeSent: 5xx / network → 502 maybeSent:true, Try Again with the SAME clientId re-PUTs the same txn id; 4xx → maybeSent:false and the clientId is free", async () => {
  const id = uuid();
  sendImpl = async () => { throw Object.assign(new Error("boom"), { status: 502 }); };
  const r1 = await postText({ clientId: id, text: "hi" });
  assert.equal(r1.status, 502);
  assert.deepEqual(Object.keys(await json(r1)).sort(), ["error", "maybeSent", "message"]);
  sendImpl = async () => { throw new Error("socket hang up"); };
  const r2 = await postText({ clientId: id, text: "hi" });
  assert.equal(r2.status, 502);
  assert.equal((await json(r2)).maybeSent, true);
  sendImpl = async () => "$landed";
  const r3 = await postText({ clientId: id, text: "hi" });
  assert.equal(r3.status, 200);
  assert.equal((await json(r3)).eventId, "$landed");
  assert.equal(new Set(sent.map((s) => s.txnId)).size, 1, "every attempt used the same txn id");

  const id2 = uuid();
  sendImpl = async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); };
  const r4 = await postText({ clientId: id2, text: "x" });
  assert.equal(r4.status, 502);
  assert.deepEqual(await json(r4).then((j) => [j.error, j.maybeSent]), ["send_failed", false]);
  sendImpl = async () => "$ok";
  assert.equal((await postText({ clientId: id2, text: "x" })).status, 200);
});

test("maybeSent: past the retry window (or with another credential) the clientId is never re-sent blind", async () => {
  let now = 1_800_000_000_000;
  setSendLedgerClockForTests(() => now);
  const id = uuid();
  sendImpl = async () => { throw new Error("timeout"); };
  assert.equal((await postText({ clientId: id, text: "hi" })).status, 502);
  now += RETRY_WINDOW_MS + 1;
  sendImpl = async () => "$late";
  const r = await postText({ clientId: id, text: "hi" });
  assert.equal(r.status, 502);
  assert.deepEqual(await json(r).then((j) => [j.error, j.maybeSent]), ["send_failed", true]);
  assert.equal(sent.length, 1, "no second PUT");

  now = 1_900_000_000_000;
  const id2 = uuid();
  sendImpl = async () => { throw new Error("timeout"); };
  await postText({ clientId: id2, text: "hi" });
  putSecret(VAULT(), config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://hs.example.test", accessToken: "a-new-token" }));
  sendImpl = async () => "$x";
  assert.equal((await postText({ clientId: id2, text: "hi" })).status, 502);
  assert.equal(sent.length, 2);
});

test("no matrix credential → 503 source_unavailable, nothing sent", async () => {
  deleteSecret(VAULT(), config.ownerEmail, "matrix");
  const r = await postText({ clientId: uuid(), text: "x" });
  assert.equal(r.status, 503);
  assert.equal((await json(r)).error, "source_unavailable");
});

// ── attachments ─────────────────────────────────────────────────────────────

test("image: uploaded with the SNIFFED type, then m.image with mimetype/size/w/h; optional thumbnail", async () => {
  const id = uuid();
  const r = await postAtt(form({ clientId: id, kind: "image" }, { bytes: PNG, name: "photo.png", type: "text/html" }, { bytes: JPEG }));
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { clientId: id, eventId: "$ev1", status: "sent" });
  assert.deepEqual(uploads, [{ bytes: PNG.length, contentType: "image/png", filename: "photo.png" }, { bytes: JPEG.length, contentType: "image/jpeg", filename: "thumbnail" }]);
  assert.deepEqual(sent[0]!.content, {
    msgtype: "m.image", body: "photo.png", filename: "photo.png", url: "mxc://example.test/up1",
    info: { mimetype: "image/png", size: PNG.length, w: 2, h: 3, thumbnail_url: "mxc://example.test/up2", thumbnail_info: { mimetype: "image/jpeg", size: JPEG.length, w: 20, h: 10 } },
  });
});

test("video / file / voice content shapes (voice = MSC3245 + MSC1767, duration also in info)", async () => {
  assert.equal((await postAtt(form({ clientId: uuid(), kind: "video", durationMs: "4200", w: "640", h: "480" }, { bytes: MP4, name: "clip.mp4" }))).status, 200);
  assert.deepEqual(sent[0]!.content, { msgtype: "m.video", body: "clip.mp4", filename: "clip.mp4", url: "mxc://example.test/up1", info: { mimetype: "video/mp4", size: MP4.length, w: 640, h: 480, duration: 4200 } });

  assert.equal((await postAtt(form({ clientId: uuid(), kind: "file" }, { bytes: PDF, name: "../../etc/Report.pdf" }))).status, 200);
  assert.deepEqual(sent[1]!.content, { msgtype: "m.file", body: "Report.pdf", filename: "Report.pdf", url: "mxc://example.test/up2", info: { mimetype: "application/pdf", size: PDF.length } });

  const wave = [0, 10, 512, 1024, 3];
  assert.equal((await postAtt(form({ clientId: uuid(), kind: "voice", durationMs: "3100", waveform: JSON.stringify(wave) }, { bytes: OGG_OPUS, name: "rec.ogg" }))).status, 200);
  assert.deepEqual(sent[2]!.content, {
    msgtype: "m.audio", body: "Voice message", filename: "Voice message.ogg", url: "mxc://example.test/up3",
    info: { mimetype: "audio/ogg", size: OGG_OPUS.length, duration: 3100 },
    "org.matrix.msc1767.audio": { duration: 3100, waveform: wave },
    "org.matrix.msc3245.voice": {},
  });
  // AAC .m4a is accepted too (bridges convert or pass it through; Ogg/Opus is preferred)
  assert.equal((await postAtt(form({ clientId: uuid(), kind: "voice" }, { bytes: M4A, name: "rec.m4a" }))).status, 200);
  assert.deepEqual(sent[3]!.content["org.matrix.msc3245.voice"], {});
  assert.equal((sent[3]!.content.info as { mimetype: string }).mimetype, "audio/mp4");
});

test("Opus-in-CAF voice (Messages' format) is refused for a bridged network: nothing uploaded or sent", async () => {
  const head = Buffer.from("caff\x00\x01\x00\x00desc", "latin1");
  const len = Buffer.alloc(8); len.writeBigInt64BE(32n);
  const rate = Buffer.alloc(8); rate.writeDoubleBE(24_000);
  const caf = Buffer.concat([head, len, rate, Buffer.from("opus", "latin1"), Buffer.alloc(20), Buffer.alloc(64, 7)]);
  const r = await postAtt(form({ clientId: uuid(), kind: "voice", durationMs: "1000" }, { bytes: caf, name: "Audio Message.caf" }));
  assert.equal(r.status, 415);
  assert.equal((await json(r)).error, "unsupported_type");
  assert.equal(uploads.length + sent.length, 0);
});

test("bad type → 415: SVG / HTML / text as image, HEIC, executables and web pages as files, Vorbis as voice", async () => {
  const cases: Array<[string, Buffer, string]> = [
    ["image", SVG, "x.svg"], ["image", HTML, "x.png"], ["image", Buffer.from("just text"), "x.jpg"], ["image", HEIC, "x.heic"],
    ["file", EXE, "setup.pdf"], ["file", PDF, "invoice.exe"], ["file", HTML, "page.txt"], ["file", Buffer.from("plain"), "page.html"],
    ["file", Buffer.from("#!/bin/sh\nrm -rf ~"), "notes.txt"], ["voice", OGG_VORBIS, "a.ogg"], ["voice", PNG, "a.ogg"], ["video", M4A, "a.mp4"],
  ];
  for (const [kind, bytes, name] of cases) {
    const r = await postAtt(form({ clientId: uuid(), kind }, { bytes, name }));
    assert.equal(r.status, 415, `${kind} ${name}`);
    assert.equal((await json(r)).error, "unsupported_type");
  }
  assert.equal(uploads.length + sent.length, 0);
});

test("oversize → 413: the configured cap, the homeserver's m.upload.size, the declared length; the thumbnail cap", async () => {
  process.env.COMMS_SEND_MAX_BYTES = "100";
  const big = Buffer.concat([PNG, Buffer.alloc(200)]);
  let r = await postAtt(form({ clientId: uuid(), kind: "image" }, { bytes: big, name: "a.png" }));
  assert.equal(r.status, 413);
  assert.equal((await json(r)).error, "too_large");
  delete process.env.COMMS_SEND_MAX_BYTES;
  hsLimit = 50;
  setCommsSendClientForTests(null); // drop the cached homeserver limit…
  const fakeAgain = { // …and reinstall a fake reporting 50 bytes
    sendEvent: async () => "$x", joinedRooms: async () => joined, whoamiInfo: async () => ({ userId: ME, deviceId: "D" }), roomEncrypted: async () => false, memberProfiles: async () => members,
    uploadMedia: async () => "mxc://example.test/u", mediaConfig: async () => hsLimit, eventExists: async () => true,
  } as unknown as CommsSendClient;
  setCommsSendClientForTests(() => fakeAgain);
  r = await postAtt(form({ clientId: uuid(), kind: "image" }, { bytes: PNG, name: "a.png" }));
  assert.equal(r.status, 413);
  const declared = await createApp().request(`/api/comms/threads/${TH}/attachments`, {
    method: "POST", headers: { ...device(), "content-type": "multipart/form-data; boundary=x", "content-length": String(60 * 1024 * 1024) }, body: "--x--",
  });
  assert.equal(declared.status, 413);
});

test("attachments: invalid fields → 422 (unknown field, missing file, bad waveform, waveform on an image, bad duration)", async () => {
  const cases: FormData[] = [
    form({ clientId: uuid(), kind: "image", roomId: "!x:y" }, { bytes: PNG, name: "a.png" }),
    form({ clientId: uuid(), kind: "image" }),
    form({ clientId: uuid(), kind: "sticker" }, { bytes: PNG, name: "a.png" }),
    form({ clientId: uuid(), kind: "voice", waveform: "[1,2,1025]" }, { bytes: OGG_OPUS, name: "a.ogg" }),
    form({ clientId: uuid(), kind: "voice", waveform: JSON.stringify(new Array(201).fill(1)) }, { bytes: OGG_OPUS, name: "a.ogg" }),
    form({ clientId: uuid(), kind: "voice", waveform: "nope" }, { bytes: OGG_OPUS, name: "a.ogg" }),
    form({ clientId: uuid(), kind: "image", waveform: "[1]" }, { bytes: PNG, name: "a.png" }),
    form({ clientId: uuid(), kind: "voice", durationMs: "-5" }, { bytes: OGG_OPUS, name: "a.ogg" }),
    form({ clientId: "nope", kind: "image" }, { bytes: PNG, name: "a.png" }),
  ];
  for (const fd of cases) assert.equal((await postAtt(fd)).status, 422);
  const json415 = await createApp().request(`/api/comms/threads/${TH}/attachments`, { method: "POST", headers: { ...device(), ...J }, body: "{}" });
  assert.equal(json415.status, 415);
  assert.equal(uploads.length + sent.length, 0);
});

test("attachments: idempotent by clientId (same bytes replay, other bytes → 422); a failed upload sends nothing and frees the clientId", async () => {
  const id = uuid();
  assert.equal((await postAtt(form({ clientId: id, kind: "image" }, { bytes: PNG, name: "a.png" }))).status, 200);
  const again = await postAtt(form({ clientId: id, kind: "image" }, { bytes: PNG, name: "a.png" }));
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal((await postAtt(form({ clientId: id, kind: "image" }, { bytes: JPEG, name: "a.jpg" }))).status, 422);
  assert.equal(uploads.length, 1);
  assert.equal(sent.length, 1);

  const failing = {
    sendEvent: async () => "$x", joinedRooms: async () => joined, whoamiInfo: async () => ({ userId: ME, deviceId: "D" }), roomEncrypted: async () => false, memberProfiles: async () => members,
    uploadMedia: async () => { throw Object.assign(new Error("down"), { status: 500 }); }, mediaConfig: async () => null, eventExists: async () => true,
  } as unknown as CommsSendClient;
  setCommsSendClientForTests(() => failing);
  const id2 = uuid();
  const r = await postAtt(form({ clientId: id2, kind: "image" }, { bytes: PNG, name: "a.png" }));
  assert.equal(r.status, 502);
  assert.equal((await json(r)).maybeSent, false);
  assert.equal(sent.length, 1);
});

// ── capabilities ────────────────────────────────────────────────────────────

test("capabilities: send {enabled, maxAttachmentBytes} (lowered by the homeserver's limit) + messages:send; per-channel send flag", async () => {
  hsLimit = 20 * 1024 * 1024;
  for (const path of ["/api/integrations/comms/capabilities", "/api/comms/capabilities"]) {
    const r = await createApp().request(path, { headers: device() });
    assert.equal(r.status, 200, path);
    const b = await json(r);
    assert.deepEqual(b.send, { enabled: true, maxAttachmentBytes: 20 * 1024 * 1024 });
    assert.ok(b.operations.includes("messages:send"));
  }
  conv("mail", { network: "email" });
  conv("native", { network: "matrix" });
  const list = await json(await createApp().request("/api/comms/threads?limit=10", { headers: device() }));
  const caps = Object.fromEntries(list.threads.map((t: any) => [t.channels[0].network, t.channels[0].capabilities.send]));
  assert.deepEqual(caps, { whatsapp: true, email: false, matrix: false });
  process.env.COMMS_SEND_ENABLED = "false";
  const off = await json(await createApp().request("/api/comms/capabilities", { headers: device() }));
  assert.deepEqual(off.send, { enabled: false, maxAttachmentBytes: 50 * 1024 * 1024 });
  assert.ok(!off.operations.includes("messages:send"));
  const detail = await json(await createApp().request(`/api/comms/threads/${TH}`, { headers: device() }));
  assert.equal(detail.capabilities.send, false);
});

// ── the echo ────────────────────────────────────────────────────────────────

test("echo: the sent event from the agent's Matrix account normalizes as isSelf and goes out with clientId + isOmni:false", async () => {
  const id = uuid();
  sendImpl = async () => "$echo1";
  assert.equal((await postText({ clientId: id, text: "hello" })).status, 200);
  const r = normalizeEvents(
    [{ event_id: "$echo1", sender: ME, type: "m.room.message", origin_server_ts: 1_790_000_000_000, content: { msgtype: "m.text", body: "hello" } }],
    { threadId: TH, network: "whatsapp", selfIds: commsSelfIds(ME), agentIds: [ME], names: {}, avatars: {} },
  );
  const m = r.messages[0]!;
  assert.equal(m.sender.isSelf, true);
  assert.equal(m.source.eventId, "$echo1");
  const out = messageOut(m, { email: config.ownerEmail });
  assert.equal(out.clientId, id);
  assert.equal(out.sender.isSelf, true);
  assert.equal(out.sender.isOmni, false);
  // An agent message Comms did not send keeps isOmni (no clientId).
  const other = messageOut({ ...m, id: "$agent", source: { ...m.source, eventId: "$agent" } }, { email: config.ownerEmail });
  assert.equal(other.clientId, undefined);
  assert.equal(other.sender.isOmni, true);
});

test("echo before the 200 (Matrix): unsigned.transaction_id maps to the clientId while the send is still pending; never on the wire", async () => {
  const id = uuid();
  // The ledger has the claim (pending), the send has not answered yet.
  const claim = claimSend({ clientId: id, actorEmail: config.ownerEmail, threadId: TH, kind: "text", requestHash: "h", credHash: "c", retryWindowMs: RETRY_WINDOW_MS });
  assert.equal(claim.kind, "claimed");
  const ev = (txn: string) => normalizeEvents(
    [{ event_id: "$early", sender: ME, type: "m.room.message", origin_server_ts: 1_790_000_000_000, content: { msgtype: "m.text", body: "hi" }, unsigned: { transaction_id: txn } as never }],
    { threadId: TH, network: "whatsapp", selfIds: commsSelfIds(ME), agentIds: [ME], names: {}, avatars: {} },
  ).messages[0]!;
  const out = messageOut(ev(txnIdFor(id)), { email: config.ownerEmail });
  assert.equal(out.clientId, id);
  assert.equal(out.sender.isOmni, false);
  assert.equal((out as { sendTxn?: string }).sendTxn, undefined, "the txn id is server-only");
  // A txn id that is no Comms send (another client of the account) gets nothing.
  assert.equal(messageOut(ev("m1234.5"), { email: config.ownerEmail }).clientId, undefined);
  assert.equal(messageOut(ev(txnIdFor(uuid())), { email: config.ownerEmail }).clientId, undefined);
});

// ── fix round 1 (security review) ───────────────────────────────────────────

test("I1 encrypted rooms: projected → send:false and 409 encrypted_room before any read; live state → 409, nothing sent, clientId freed", async () => {
  // the projection marks a room with m.room.encryption state
  const meta = roomMetaFromState([{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }], [ME, ALEX], [ME]);
  assert.equal(meta.capabilities.encrypted, true);
  assert.equal(roomMetaFromState([], [ME, ALEX], [ME]).capabilities.encrypted, undefined);

  conv("e2e", { network: "whatsapp", capabilities: { ...CAPS, encrypted: true } });
  const detail = await json(await createApp().request("/api/comms/threads/th_e2e", { headers: device() }));
  assert.equal(detail.capabilities.send, false);
  const r = await postText({ clientId: uuid(), text: "secret" }, device(), "th_e2e");
  assert.equal(r.status, 409);
  assert.equal((await json(r)).error, "encrypted_room");
  const att = await createApp().request("/api/comms/threads/th_e2e/attachments", {
    method: "POST", headers: { ...device(), "content-type": "multipart/form-data; boundary=x", "content-length": String(60 * 1024 * 1024) }, body: "--x--",
  });
  assert.equal(att.status, 409, "refused before the body is read (no 413)");

  // the projection does not know yet, the room says so live
  encryptedRooms.add("!c1:example.test");
  const id = uuid();
  const live = await postText({ clientId: id, text: "secret" });
  assert.equal(live.status, 409);
  assert.equal((await json(live)).error, "encrypted_room");
  assert.equal(sent.length + uploads.length, 0);
  encryptedRooms.clear();
  assert.equal((await postText({ clientId: id, text: "secret" })).status, 200, "the clientId was released");
});

test("I2 audit: a rate-limited attempt leaves a refused row", async () => {
  process.env.COMMS_SEND_PER_10MIN = "1";
  await postText({ clientId: uuid(), text: "1" });
  assert.equal((await postText({ clientId: uuid(), text: "2" })).status, 429);
  const last = audit().at(-1)!;
  assert.deepEqual([last.status, last.error, last.origin, last.via], ["refused", "rate_limited", "human", "device"]);
});

test("M1 bridge commands: text starting with ! + letters → 422 bridge_command, nothing sent", async () => {
  for (const text of ["!wa logout", "  !tg delete-portal", "!signal help", "!Slack x", "!discord", "!meta", "!fb", "!ig", "!tw", "!anything"]) {
    const r = await postText({ clientId: uuid(), text });
    assert.equal(r.status, 422, text);
    assert.deepEqual(await json(r), { error: "bridge_command", message: "Messages starting with ! are bridge commands and are not sent." });
  }
  assert.equal(sent.length, 0);
  for (const text of ["! not a command", "hi !wa", "!!", "!1"]) assert.equal((await postText({ clientId: uuid(), text })).status, 200, text);
});

test("M2 ledger: writes are bound to the attempt — a slow first attempt cannot delete or overwrite the row a Try Again reclaimed", () => {
  let now = 2_000_000_000_000;
  setSendLedgerClockForTests(() => now);
  const p = { clientId: uuid(), actorEmail: config.ownerEmail, threadId: TH, kind: "text" as const, requestHash: "h", credHash: "c", retryWindowMs: RETRY_WINDOW_MS };
  const first = claimSend(p);
  assert.deepEqual(first, { kind: "claimed", retry: false, attempt: 1 });
  now += PENDING_STALE_MS - 1;
  assert.equal(claimSend(p).kind, "in_progress");
  now += 2;
  const second = claimSend(p);
  assert.deepEqual(second, { kind: "claimed", retry: true, attempt: 2 });
  releaseSend(p.clientId, 1, false); // the first attempt fails late, before its PUT
  markSent(p.clientId, 1, "$stale"); // …or finishes late: ignored too
  markSent(p.clientId, 2, "$second");
  assert.equal(clientIdForEvent("$second"), p.clientId);
  assert.equal(clientIdForEvent("$stale"), null);
  // the stale window covers every deadline of one attempt
  assert.ok(PENDING_STALE_MS >= 5 * 15_000 + 2 * 120_000 + 30_000);
});

test("M3 bookkeeping failure after the PUT → still 200 with the eventId; on a maybe-sent path → 502 maybeSent:true; never a bare 500", async () => {
  const breakLedger = () => db.exec(`CREATE TRIGGER comms_sends_fail BEFORE UPDATE ON comms_sends BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
  const fixLedger = () => db.exec(`DROP TRIGGER IF EXISTS comms_sends_fail`);
  try {
    sendImpl = async () => { breakLedger(); return "$posted"; };
    const r = await postText({ clientId: uuid(), text: "x" });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).eventId, "$posted");
    fixLedger();
    sendImpl = async () => { breakLedger(); throw new Error("timeout"); };
    const r2 = await postText({ clientId: uuid(), text: "y" });
    assert.equal(r2.status, 502);
    assert.equal((await json(r2)).maybeSent, true);
  } finally {
    fixLedger();
  }
});

test("M4 a token without a device id: the maybe-sent retry window is 25 min, not 6 h", async () => {
  let now = 2_100_000_000_000;
  setSendLedgerClockForTests(() => now);
  deviceId = null;
  const id = uuid();
  sendImpl = async () => { throw new Error("timeout"); };
  assert.equal((await postText({ clientId: id, text: "hi" })).status, 502);
  now += RETRY_WINDOW_NO_DEVICE_MS + 1;
  sendImpl = async () => "$late";
  const r = await postText({ clientId: id, text: "hi" });
  assert.equal(r.status, 502);
  assert.equal((await json(r)).maybeSent, true);
  assert.equal(sent.length, 1, "no second PUT");
  // with a device the same delay is still retryable
  setCommsSendClientForTests(null);
  deviceId = "DEV";
  const fake2 = {
    sendEvent: async (roomId: string, type: string, txnId: string, content: Record<string, unknown>) => { sent.push({ roomId, type, txnId, content }); return sendImpl({ roomId, type, txnId, content }); },
    joinedRooms: async () => joined, whoamiInfo: async () => ({ userId: ME, deviceId }), roomEncrypted: async () => false,
    memberProfiles: async () => members, uploadMedia: async () => "mxc://example.test/u", mediaConfig: async () => null, eventExists: async () => true,
  } as unknown as CommsSendClient;
  setCommsSendClientForTests(() => fake2);
  const id2 = uuid();
  sendImpl = async () => { throw new Error("timeout"); };
  await postText({ clientId: id2, text: "hi" });
  now += RETRY_WINDOW_NO_DEVICE_MS + 1;
  sendImpl = async () => "$ok";
  assert.equal((await postText({ clientId: id2, text: "hi" })).status, 200);
});

test("M5 at most 3 uploads in flight per owner → 429 busy; the thread is checked before the body is read", async () => {
  const releases: Array<() => void> = [];
  const slow = {
    sendEvent: async () => "$x", joinedRooms: async () => joined, whoamiInfo: async () => ({ userId: ME, deviceId: "D" }), roomEncrypted: async () => false,
    memberProfiles: async () => members, mediaConfig: async () => null, eventExists: async () => true,
    uploadMedia: () => new Promise<string>((res) => releases.push(() => res("mxc://example.test/slow"))),
  } as unknown as CommsSendClient;
  setCommsSendClientForTests(() => slow);
  const pending = [0, 1, 2].map(() => postAtt(form({ clientId: uuid(), kind: "image" }, { bytes: PNG, name: "a.png" })));
  while (releases.length < 3) await new Promise((r) => setImmediate(r));
  const fourth = await postAtt(form({ clientId: uuid(), kind: "image" }, { bytes: PNG, name: "a.png" }));
  assert.equal(fourth.status, 429);
  assert.equal((await json(fourth)).error, "busy");
  for (const r of releases) r();
  for (const p of pending) assert.equal((await p).status, 200);
  const fifth = postAtt(form({ clientId: uuid(), kind: "image" }, { bytes: PNG, name: "a.png" }));
  while (releases.length < 4) await new Promise((r) => setImmediate(r));
  releases[3]!();
  assert.equal((await fifth).status, 200, "slots are freed");

  const unknown = await createApp().request("/api/comms/threads/th_nope/attachments", {
    method: "POST", headers: { ...device(), "content-type": "multipart/form-data; boundary=x", "content-length": String(60 * 1024 * 1024) }, body: "--x--",
  });
  assert.equal(unknown.status, 404, "unknown thread answered before the (oversized) body");
});

test("M6 stored hashes of the text are keyed (HMAC), not a plain hash", async () => {
  assert.equal((await postText({ clientId: uuid(), text: "ok" })).status, 200);
  const row = audit().at(-1)!;
  const target = JSON.parse(row.target);
  assert.ok(target.textHash);
  assert.notEqual(target.textHash, shortHash("ok"));
  const ledger = db.prepare(`SELECT request_hash FROM comms_sends`).get() as { request_hash: string };
  assert.match(ledger.request_hash, /^[0-9a-f]{64}$/);
});

test("M7 a bot with a bare network name (@signal:hs) does not make a management room look like a conversation", async () => {
  conv("bare");
  members = { [ME]: { name: "Omni", avatar: null }, "@signal:example.test": { name: "Signal bridge", avatar: null } };
  const r = await postText({ clientId: uuid(), text: "help" }, device(), "th_bare");
  assert.equal(r.status, 404);
  assert.equal(sent.length, 0);
});

test("M11 gaps: same clientId on another thread → 422; a maybe-sent Try Again with other text → 422 and no PUT; session + bearer and a capability link refused; eventExists failing → 502 maybeSent:false", async () => {
  conv("c2");
  joined.push("!c2:example.test");
  setMatrixActionClientForTests(null);
  const id = uuid();
  assert.equal((await postText({ clientId: id, text: "same" })).status, 200);
  assert.equal((await postText({ clientId: id, text: "same" }, device(), "th_c2")).status, 422);

  const id2 = uuid();
  sendImpl = async () => { throw new Error("timeout"); };
  assert.equal((await postText({ clientId: id2, text: "first" })).status, 502);
  const before = sent.length;
  sendImpl = async () => "$x";
  assert.equal((await postText({ clientId: id2, text: "edited" })).status, 422);
  assert.equal(sent.length, before);

  const both = await postText({ clientId: uuid(), text: "x" }, { ...device(), cookie: sessionCookie(makeSession(config.ownerEmail)) });
  assert.equal(both.status, 403);
  assert.equal((await json(both)).error, "device_required");
  const cap = makeCapability("note", "n1", "edit");
  assert.equal((await postText({ clientId: uuid(), text: "x" }, { authorization: `Capability ${cap}` })).status, 403);

  const broken = {
    sendEvent: async () => "$x", joinedRooms: async () => joined, whoamiInfo: async () => ({ userId: ME, deviceId: "D" }), roomEncrypted: async () => false,
    memberProfiles: async () => members, uploadMedia: async () => "mxc://x/y", mediaConfig: async () => null,
    eventExists: async () => { throw new Error("hs down"); },
  } as unknown as CommsSendClient;
  setCommsSendClientForTests(() => broken);
  const r = await postText({ clientId: uuid(), text: "re", replyTo: "$unknown" });
  assert.equal(r.status, 502);
  assert.equal((await json(r)).maybeSent, false);
});

// ── reactions ───────────────────────────────────────────────────────────────

const R = (msg: string, thread = TH) => `/api/comms/threads/${thread}/messages/${encodeURIComponent(msg)}/reactions`;
const react = (msg: string, body: unknown, headers: Record<string, string> = device(), thread = TH, env?: object) =>
  createApp().request(R(msg, thread), { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) }, env);
const unreact = (msg: string, key: string, headers: Record<string, string> = device(), thread = TH) =>
  createApp().request(`${R(msg, thread)}/${encodeURIComponent(key)}`, { method: "DELETE", headers });

test("react: m.reaction (m.annotation) on the message's event id → 200 {clientId, eventId, status}; idempotent by clientId; audited as comms.react", async () => {
  const id = uuid();
  const r = await react("$msg1", { clientId: id, key: "❤️" });
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { clientId: id, eventId: "$ev1", status: "sent" });
  assert.deepEqual(sent[0], { roomId: "!c1:example.test", type: "m.reaction", txnId: sent[0]!.txnId, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg1", key: "❤️" } } });
  assert.match(sent[0]!.txnId, /^comms-[0-9a-f]{32}$/);
  const again = await react("$msg1", { clientId: id, key: "❤️" });
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(await json(again), { clientId: id, eventId: "$ev1", status: "sent" });
  assert.equal(sent.length, 1);
  assert.equal((await react("$msg1", { clientId: id, key: "👍" })).status, 422, "same clientId, other reaction");
  const rows = auditAll().filter((a) => a.action === "comms.react");
  assert.deepEqual(rows.map((a) => a.status), ["ok", "replayed", "refused"]);
  assert.equal(rows[0]!.origin, "human");
});

test("react: refused when the owner (stored account OR his bridge ghost) already has that key → 409 already_reacted", async () => {
  reactionsOn.set("!c1:example.test|$msg1", [{ eventId: "$r0", sender: OWNER_GHOST, key: "👍" }, { eventId: "$r1", sender: ALEX, key: "❤️" }]);
  const dup = await react("$msg1", { clientId: uuid(), key: "👍" });
  assert.equal(dup.status, 409);
  assert.equal((await json(dup)).error, "already_reacted");
  assert.equal((await react("$msg1", { clientId: uuid(), key: "❤️" })).status, 200, "someone else's ❤️ does not count");
  assert.equal(sent.length, 1);
});

test("react: a message id of ANOTHER room (cross-room), an unknown thread, unsupported networks, encrypted rooms → refused, nothing sent", async () => {
  roomEvents.set("$elsewhere", "!other:example.test");
  const cross = await react("$elsewhere", { clientId: uuid(), key: "👍" });
  assert.equal(cross.status, 404);
  assert.equal((await json(cross)).error, "not_found");
  assert.equal((await react("$m", { clientId: uuid(), key: "👍" }, device(), "th_nope")).status, 404);
  for (const network of ["email", "imessage", "sms", "matrix"] as const) {
    conv(`r${network}`, { network });
    assert.equal((await react("$m", { clientId: uuid(), key: "👍" }, device(), `th_r${network}`)).status, 409, network);
  }
  conv("noreact", { capabilities: { ...CAPS, react: false } });
  assert.equal((await json(await react("$m", { clientId: uuid(), key: "👍" }, device(), "th_noreact"))).error, "unsupported_network");
  encryptedRooms.add("!c1:example.test");
  assert.equal((await json(await react("$m", { clientId: uuid(), key: "👍" }))).error, "encrypted_room");
  assert.equal(sent.length, 0);
});

test("react: same gates as send — session / MCP / downgrade refused (audited with the real origin), flag off, bad key/id/body", async () => {
  assert.equal((await json(await react("$m", { clientId: uuid(), key: "👍" }, { cookie: sessionCookie(makeSession(config.ownerEmail)) }))).error, "device_required");
  const owner = { kind: "user" as const, email: config.ownerEmail, role: "owner" as const, vaultId: VAULT(), grants: [] };
  assert.equal((await react("$m", { clientId: uuid(), key: "👍" }, {}, TH, { [INPROCESS_ACTOR]: owner, [INPROCESS_CLIENT_KEY]: "mcp:pat:t1" })).status, 403);
  assert.equal((await react("$m", { clientId: uuid(), key: "👍" }, { ...device(), "x-prism-action-origin": "agent" })).status, 403);
  assert.equal((await unreact("$m", "👍", { cookie: sessionCookie(makeSession(config.ownerEmail)) })).status, 403);
  const rows = auditAll().filter((a) => a.action === "comms.react" || a.action === "comms.unreact").map((a) => [a.action, a.via, a.origin, a.error]);
  assert.deepEqual(rows, [
    ["comms.react", "session", "human", "device_required"],
    ["comms.react", "mcp", "agent", "device_required"],
    ["comms.react", "device", "agent", "device_required"],
    ["comms.unreact", "session", "human", "device_required"],
  ]);
  for (const body of [{ clientId: uuid(), key: "" }, { clientId: uuid(), key: "x".repeat(65) }, { clientId: uuid(), key: "a\nb" }, { clientId: "no", key: "👍" }, { clientId: uuid(), key: "👍", eventId: "$x" }]) {
    assert.equal((await react("$m", body)).status, 422, JSON.stringify(body));
  }
  assert.equal((await react("not-an-event", { clientId: uuid(), key: "👍" })).status, 422);
  process.env.COMMS_SEND_ENABLED = "false";
  assert.equal((await json(await react("$m", { clientId: uuid(), key: "👍" }))).error, "send_disabled");
  assert.equal((await json(await unreact("$m", "👍"))).error, "send_disabled");
  assert.equal(sent.length + redactions.length, 0);
});

test("react: the matrix-react budget is shared with /api/actions/matrix/react → 429 rate_limited (audited)", async () => {
  for (let i = 0; i < 120; i++) assert.equal((await react(`$m${i}`, { clientId: uuid(), key: "👍" })).status, 200);
  const r = await react("$last", { clientId: uuid(), key: "👍" });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"));
  assert.equal(auditAll().at(-1)!.error, "rate_limited");
});

test("unreact: redacts ONLY the stored account's reaction events with that key; someone else's / the owner's phone ghost's → 404; then 404 again", async () => {
  reactionsOn.set("!c1:example.test|$msg1", [
    { eventId: "$mine", sender: ME, key: "👍" },
    { eventId: "$mine2", sender: ME, key: "👍" },
    { eventId: "$mineHeart", sender: ME, key: "❤️" },
    { eventId: "$alex", sender: ALEX, key: "😂" },
    { eventId: "$phone", sender: OWNER_GHOST, key: "‼️" },
  ]);
  const r = await unreact("$msg1", "👍");
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { status: "removed" });
  assert.deepEqual(redactions.map((x) => [x.room, x.eventId]), [["!c1:example.test", "$mine"], ["!c1:example.test", "$mine2"]]);
  assert.match(redactions[0]!.txnId, /^comms-redact-[0-9a-f]{32}$/);
  assert.equal((await unreact("$msg1", "👍")).status, 404, "nothing left to remove");
  const other = await unreact("$msg1", "😂");
  assert.equal(other.status, 404, "someone else's reaction is never redacted");
  assert.equal((await unreact("$msg1", "‼️")).status, 404, "the owner's phone (bridge ghost) reaction is not Comms's to redact");
  assert.equal(redactions.length, 2);
  roomEvents.set("$foreign", "!other:example.test");
  assert.equal((await unreact("$foreign", "👍")).status, 404);
  assert.ok(auditAll().some((a) => a.action === "comms.unreact" && a.status === "ok"));
});

test("unreact: a redaction the homeserver refuses → 502 maybeSent:false; no answer → maybeSent:true; never a 500", async () => {
  reactionsOn.set("!c1:example.test|$msg1", [{ eventId: "$mine", sender: ME, key: "👍" }]);
  const failing = (err: Error) => ({
    sendEvent: async () => "$x", joinedRooms: async () => joined, whoamiInfo: async () => ({ userId: ME, deviceId: "D" }), roomEncrypted: async () => false,
    memberProfiles: async () => members, uploadMedia: async () => "mxc://x/y", mediaConfig: async () => null, eventExists: async () => true,
    reactionsTo: async () => reactionsOn.get("!c1:example.test|$msg1") ?? [], redactEvent: async () => { throw err; },
  }) as unknown as CommsSendClient;
  setCommsSendClientForTests(() => failing(Object.assign(new Error("forbidden"), { status: 403 })));
  let r = await unreact("$msg1", "👍");
  assert.deepEqual([r.status, (await json(r)).maybeSent], [502, false]);
  setCommsSendClientForTests(() => failing(new Error("socket hang up")));
  r = await unreact("$msg1", "👍");
  assert.deepEqual([r.status, (await json(r)).maybeSent], [502, true]);
});

test("react capability: true only where Comms can react (bridged, sending on, not encrypted)", async () => {
  conv("rmail", { network: "email" });
  conv("rnative", { network: "matrix" });
  conv("rsms", { network: "sms" });
  conv("renc", { capabilities: { ...CAPS, encrypted: true } });
  const list = await json(await createApp().request("/api/comms/threads?limit=20", { headers: device() }));
  const caps = Object.fromEntries(list.threads.map((t: any) => [t.id, t.channels[0].capabilities.react]));
  assert.deepEqual(caps, { th_c1: true, th_rmail: false, th_rnative: false, th_rsms: false, th_renc: false });
  process.env.COMMS_SEND_ENABLED = "false";
  const off = await json(await createApp().request(`/api/comms/threads/${TH}`, { headers: device() }));
  assert.equal(off.capabilities.react, false);
});

test("echo: the stored account's reaction normalizes as mine:true with the sender as self; a redaction removes it", () => {
  const base = { event_id: "$t", sender: ALEX, type: "m.room.message", origin_server_ts: 1_790_000_000_000, content: { msgtype: "m.text", body: "hi" } };
  const reaction = { event_id: "$rx", sender: ME, type: "m.reaction", origin_server_ts: 1_790_000_001_000, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$t", key: "❤️" } } };
  const ctx = { threadId: TH, network: "whatsapp" as const, selfIds: commsSelfIds(ME), agentIds: [ME], names: { [ME]: "Omni" }, avatars: {} };
  const m = normalizeEvents([base, reaction], ctx).messages[0]!;
  assert.equal(m.reactions.length, 1);
  assert.equal(m.reactions[0]!.mine, true);
  assert.equal(m.reactions[0]!.senders[0]!.id, ME);
  assert.equal(m.reactions[0]!.senders[0]!.eventId, "$rx");
  const redaction = { event_id: "$red", sender: ME, type: "m.room.redaction", redacts: "$rx", origin_server_ts: 1_790_000_002_000, content: { redacts: "$rx" } };
  const after = normalizeEvents([base, reaction, redaction], ctx).messages[0]!;
  assert.equal(after.reactions.length, 0);
});

// ── polish: mentions, the composer's channel pick, any-emoji reactions ───────

test("mentions: a pill per mention (escaped HTML, matrix.to) + m.mentions; plain body unchanged; capability only on mention networks", async () => {
  conv("g1", { kind: "group" });
  joined.push("!g1:example.test");
  const text = "Hi Alex <b>&</b> see you";
  const r = await postText({ clientId: uuid(), text, mentions: [{ userId: ALEX, start: 3, length: 4 }] }, device(), "th_g1");
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual(sent[0]!.content, {
    msgtype: "m.text", body: text, format: "org.matrix.custom.html",
    formatted_body: `Hi <a href="https://matrix.to/#/${ALEX}">Alex</a> &lt;b&gt;&amp;&lt;/b&gt; see you`,
    "m.mentions": { user_ids: [ALEX] },
  });
  // A differently cased id goes out as the room's own spelling.
  assert.equal((await postText({ clientId: uuid(), text: "Alex hi", mentions: [{ userId: ALEX.toUpperCase().replace("@WHATSAPP", "@whatsapp"), start: 0, length: 4 }] }, device(), "th_g1")).status, 200);
  assert.deepEqual((sent.at(-1)!.content["m.mentions"] as { user_ids: string[] }).user_ids, [ALEX]);
  sent.pop();
  // No mentions → exactly the old content.
  assert.equal((await postText({ clientId: uuid(), text: "plain" }, device(), "th_g1")).status, 200);
  assert.deepEqual(sent[1]!.content, { msgtype: "m.text", body: "plain" });
  const caps = await json(await createApp().request(`/api/comms/threads/th_g1`, { headers: device() }));
  assert.equal(caps.capabilities.mentions, true);
});

test("mentions: refused (nothing sent) for non-members, the owner, bridge bots, bad ranges/ids, and networks without mentions", async () => {
  const cases: Array<[unknown, number]> = [
    [[{ userId: "@whatsapp_999:example.test", start: 0, length: 2 }], 422], // not in the room
    [[{ userId: OWNER_GHOST, start: 0, length: 2 }], 422], // the owner
    [[{ userId: BOT, start: 0, length: 2 }], 422], // a bridge bot
    [[{ userId: ALEX, start: 5, length: 99 }], 422], // outside the text
    [[{ userId: ALEX, start: 0, length: 2 }, { userId: ALEX, start: 1, length: 2 }], 422], // overlapping
    [[{ userId: "<script>", start: 0, length: 2 }], 422],
    [[{ userId: `@a:b" onclick="x`, start: 0, length: 2 }], 422],
    [[{ userId: ALEX, start: 0, length: 2, extra: 1 }], 422],
    ["nope", 422],
  ];
  for (const [mentions, status] of cases) {
    const r = await postText({ clientId: uuid(), text: "Al hi", mentions });
    assert.equal(r.status, status, JSON.stringify(mentions));
  }
  conv("li", { network: "linkedin" });
  joined.push("!li:example.test");
  assert.equal((await postText({ clientId: uuid(), text: "Al hi", mentions: [{ userId: ALEX, start: 0, length: 2 }] }, device(), "th_li")).status, 422);
  const caps = await json(await createApp().request(`/api/comms/threads/th_li`, { headers: device() }));
  assert.equal(caps.capabilities.mentions, undefined);
  assert.equal(sent.length, 0);
});

test("channel pick: the thread's own channel sends; any other network/account → 409, nothing sent (text and attachments)", async () => {
  assert.equal((await postText({ clientId: uuid(), text: "hi", channel: { network: "whatsapp" } })).status, 200);
  assert.equal((await postText({ clientId: uuid(), text: "hi", channel: { network: "whatsapp", accountLabel: null } })).status, 200);
  const other = await postText({ clientId: uuid(), text: "hi", channel: { network: "telegram" } });
  assert.equal(other.status, 409);
  assert.equal((await json(other)).error, "unsupported_network");
  assert.equal((await postText({ clientId: uuid(), text: "hi", channel: { network: "whatsapp", accountLabel: "Work" } })).status, 409);
  assert.equal((await postText({ clientId: uuid(), text: "hi", channel: { network: "WhatsApp!" } })).status, 422);
  assert.equal(sent.length, 2);
  const att = await postAtt(form({ clientId: uuid(), kind: "image", channel: JSON.stringify({ network: "signal" }) }, { bytes: PNG, name: "a.png" }));
  assert.equal(att.status, 409);
  assert.equal(uploads.length, 0);
  assert.equal((await postAtt(form({ clientId: uuid(), kind: "image", channel: JSON.stringify({ network: "whatsapp" }) }, { bytes: PNG, name: "a.png" }))).status, 200);
});

test("react: any emoji — ZWJ sequences, skin tones, flags, keycaps and Unicode 16 — goes out as the key", async () => {
  for (const key of ["🧑🏽‍🤝‍🧑🏿", "👍🏾", "🇯🇵", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "1️⃣", "❤️‍🔥", "🫩", "🌮"]) {
    const r = await react("$msg1", { clientId: uuid(), key });
    assert.equal(r.status, 200, key);
    assert.equal((sent.at(-1)!.content["m.relates_to"] as { key: string }).key, key);
  }
});

// ── owner report 2026-11-22: the Mac client's multipart, byte for byte ──────────────────────────
import { swiftMultipart, swiftUploadInit } from "./swift-multipart";
import { normalizeFilenameStar, multipartBoundary } from "../src/comms/multipart";

test("owner report: the Mac client's exact upload (WhatsApp) — kind image + w/h, legacy filename* and UTF-8 names → m.image with the real name", async () => {
  const names = ["IMG_4821.jpg", "Screenshot 2026-11-22 at 10.15.32 AM.jpg", "Café 照片 🌅.jpg", 'say "cheese".jpg'];
  for (const style of ["legacy", "utf8"] as const) {
    for (const filename of names) {
      sent = [];
      uploads = [];
      const safe = filename.replace(/"/g, ""); // the client's safeFilename drops quotes
      const r = await createApp().request(`/api/comms/threads/${TH}/attachments`, swiftUploadInit({
        clientId: uuid().toUpperCase(), kind: "image", w: 20, h: 10, filename: safe, mime: "image/jpeg", bytes: JPEG, style,
      }, device()));
      assert.equal(r.status, 200, `${style} ${JSON.stringify(safe)}: ${await r.clone().text()}`);
      assert.equal(sent[0]!.content.msgtype, "m.image");
      assert.equal(sent[0]!.content.filename, safe);
      assert.equal(uploads[0]!.bytes, JPEG.length, "the bytes are untouched");
    }
  }
});

test("attachments: a refused upload says why in the audit row and the log (a fixed reason code, never a name)", async () => {
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const garbage = await createApp().request(`/api/comms/threads/${TH}/attachments`, {
      method: "POST", headers: { ...device(), "content-type": "multipart/form-data; boundary=zz" }, body: "--zz\r\nContent-Disposition: nonsense\r\n\r\nx\r\n--zz--\r\n",
    });
    assert.equal(garbage.status, 422);
    assert.match((await json(garbage)).message, /could not be read/);
    const sized = await postAtt(form({ clientId: uuid(), kind: "file", w: "1", h: "1" }, { bytes: PDF, name: "Secret plan.pdf" }));
    assert.equal(sized.status, 422);
  } finally {
    console.warn = warn;
  }
  const rows = auditAll().filter((r) => r.status === "refused");
  const reasons = rows.map((r) => JSON.parse(r.target).reason);
  assert.deepEqual(reasons.slice(-2), ["multipart_unreadable", "size_kind"]);
  assert.ok(lines.some((l) => l.includes("attachment refused: 422 invalid (multipart_unreadable)")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("(size_kind)")));
  assert.doesNotMatch(lines.join("\n") + JSON.stringify(rows), /Secret plan/);
});

test("normalizeFilenameStar: folds filename* into filename in part headers only; bodies byte-identical; no filename* → same buffer", () => {
  const bin = Buffer.concat([JPEG, Buffer.from("\r\nfilename*=UTF-8''x\r\n"), Buffer.from([0, 255, 13, 10])]);
  const { body, contentType } = swiftMultipart({ clientId: uuid(), kind: "image", w: 1, h: 1, filename: "Ünï 😀.jpg", mime: "image/jpeg", bytes: bin, style: "legacy" });
  const fixed = normalizeFilenameStar(body, contentType);
  assert.notEqual(fixed, body);
  assert.ok(fixed.includes(bin), "the file part's bytes are copied untouched (even when they look like a header)");
  assert.match(fixed.toString("utf8"), /filename="Ünï 😀\.jpg"\r\n/);
  assert.doesNotMatch(fixed.subarray(0, fixed.indexOf(bin)).toString("utf8"), /filename\*/);
  const plain = swiftMultipart({ clientId: uuid(), kind: "image", filename: "a.jpg", mime: "image/jpeg", bytes: JPEG, style: "legacy" });
  assert.equal(normalizeFilenameStar(plain.body, plain.contentType), plain.body);
  assert.equal(multipartBoundary('multipart/form-data; boundary="a b"'), "a b");
  assert.equal(multipartBoundary("multipart/form-data"), null);
});
