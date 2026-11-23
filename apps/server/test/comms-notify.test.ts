// Sprint Task 1: read markers + unread counts, mark read/unread routes, D10 receipt gates,
// notification settings, Comms APNs registration, and the notifier's decisions + payload privacy.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db } from "../src/db";
import { issueDeviceToken, revokeDevice } from "../src/auth/device";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import {
  upsertConversation, ensureSingleThread, getThread, listThreads, putWindow, appendEvent, setOverride, unreadSummary, type ConversationRow,
} from "../src/comms/store";
import {
  markThreadRead, markThreadUnread, readMarker, isViewing, setViewing, setReadStateClockForTests, setReceiptSenderForTests, _resetViewingForTests, VIEWING_LEASE_MS,
} from "../src/comms/read-state";
import { getNotifySettings, updateNotifySettings, _resetNotifySettingsForTests, sanitizeNotifySettings, DEFAULT_NOTIFY_SETTINGS } from "../src/comms/notify-settings";
import {
  _resetNotifyForTests, buildCommsNotification, decideOnArrival, flush, processEvents, setNotifyDepsForTests, setNotifyTuningForTests,
  _waitingForTests, _burstsForTests, MAX_AGE_MS,
} from "../src/comms/notify";
import { liveCommsApnsTokens, saveCommsApnsToken, configureApns, _resetApns, apnsTopicForApplication, sendApns, type ApnsRequest } from "../src/apns";
import type { Message } from "../src/comms/types";
import type { ApnsNotification } from "../src/apns";

const envKeys = ["COMMS_ENABLED", "COMMS_NOTIFY_ENABLED", "COMMS_READ_RECEIPTS_ENABLED"] as const;
const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
beforeEach(() => {
  resetDb();
  process.env.COMMS_ENABLED = "true";
  delete process.env.COMMS_NOTIFY_ENABLED;
  delete process.env.COMMS_READ_RECEIPTS_ENABLED;
  _resetNotifySettingsForTests();
  _resetViewingForTests();
  setReceiptSenderForTests(null);
  setReadStateClockForTests(null);
  _resetNotifyForTests();
  setNotifyTuningForTests(null);
});
afterEach(() => {
  for (const k of envKeys) if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  setNotifyDepsForTests(null);
  setReceiptSenderForTests(null);
  _resetNotifyForTests();
});

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function conv(id: string, over: Partial<ConversationRow> = {}): string {
  const row: ConversationRow = {
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title: `Sam ${id}`, titleSource: "person",
    avatar: null, lastEventAt: at(5), lastPreview: { text: "hello", senderName: "Sam", isSelf: false, sentAt: at(5) },
    unreadCount: 1, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null,
    accountLabel: null, capabilities: null, vaultNoteId: null, ...over,
  };
  upsertConversation(row);
  return ensureSingleThread(id);
}

function msg(threadId: string, min: number, over: Partial<Message> = {}): Message {
  return {
    id: `$e${min}`, threadId, channel: { network: "whatsapp", accountLabel: null },
    source: { network: "whatsapp", eventId: `$e${min}`, ref: `$e${min}` },
    sender: { id: "@sam:hs", name: "Sam", avatar: null, isSelf: false, isOmni: false },
    sentAt: at(min), body: { plain: `secret text ${min}`, spans: [] } as unknown as Message["body"],
    attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false, ...over,
  };
}

const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const device = (client = "comms-native", email = config.ownerEmail) => {
  const t = issueDeviceToken(email, "Comms (test)", client);
  return { headers: { authorization: `Bearer ${t.token}` }, id: t.id };
};
const req = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
  createApp().request(path, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// ── unread counts ──────────────────────────────────────────────────────────────

test("no marker: the source's guess shows, untrusted (Phase-1 placeholder)", () => {
  const t = conv("a");
  assert.deepEqual(getThread(t)!.unread, { count: 1, trusted: false });
});

test("a marker counts the cached incoming messages after it, ignoring own/redacted/system", () => {
  const t = conv("a", { lastEventAt: at(6), lastPreview: { text: "x", senderName: "Sam", isSelf: false, sentAt: at(6) } });
  putWindow(t, [
    msg(t, 1), msg(t, 2), msg(t, 3, { redacted: true }), msg(t, 4, { system: { kind: "join", text: "joined" } }), msg(t, 5), msg(t, 6),
  ]);
  markThreadRead(t, at(2));
  assert.deepEqual(getThread(t)!.unread, { count: 2, trusted: true });
  markThreadRead(t);
  assert.deepEqual(getThread(t)!.unread, { count: 0, trusted: true });
});

test("the owner's own later message ends unread; marker never moves back", () => {
  const t = conv("a", { lastEventAt: at(6), lastPreview: { text: "x", senderName: "Sam", isSelf: false, sentAt: at(6) } });
  putWindow(t, [msg(t, 1), msg(t, 2), msg(t, 3, { sender: { id: "@me:hs", name: "Me", avatar: null, isSelf: true, isOmni: false } }), msg(t, 6)]);
  markThreadRead(t, at(0));
  assert.equal(getThread(t)!.unread.count, 1); // only the message after the owner's reply
  markThreadRead(t, at(6));
  markThreadRead(t, at(1));
  assert.equal(readMarker(t)!.readAt, at(6)); // never back to at(1)
});

test("mark as unread: ≥1 until read again; announces thread.updated", () => {
  const t = conv("a");
  markThreadRead(t);
  assert.equal(getThread(t)!.unread.count, 0);
  const before = db.prepare("SELECT COUNT(*) AS n FROM comms_events").get() as { n: number };
  assert.equal(markThreadUnread(t), true);
  assert.equal(markThreadUnread(t), false); // idempotent, no second event
  assert.equal(getThread(t)!.unread.count, 1);
  const after = db.prepare("SELECT COUNT(*) AS n FROM comms_events").get() as { n: number };
  assert.equal(after.n, before.n + 1);
  assert.equal(listThreads({ limit: 10, unread: true }).threads.length, 1);
  markThreadRead(t);
  assert.equal(listThreads({ limit: 10, unread: true }).threads.length, 0);
});

test("unreadSummary: needs-attention unread threads (the badge), muted excluded", () => {
  const a = conv("a", { status: "urgent" });
  conv("b", { status: "informational" });
  const c = conv("c", { status: "action-required" });
  setOverride(c, { muted: true });
  assert.deepEqual(unreadSummary(), { threads: 2, attention: 1 });
  markThreadRead(a);
  assert.deepEqual(unreadSummary(), { threads: 1, attention: 0 });
});

// ── routes ─────────────────────────────────────────────────────────────────────

test("POST /threads/:id/read + /unread: owner only, JSON, 404 for unknown", async () => {
  const t = conv("a");
  const r = await req(`/api/comms/threads/${t}/read`, "POST", owner(), {});
  assert.equal(r.status, 200);
  const j = (await r.json()) as { thread: { unread: { count: number } }; receipt: string };
  assert.equal(j.thread.unread.count, 0);
  assert.equal(j.receipt, "off");
  const u = await req(`/api/comms/threads/${t}/unread`, "POST", owner(), {});
  assert.equal(((await u.json()) as { thread: { unread: { count: number } } }).thread.unread.count, 1);
  assert.equal((await req(`/api/comms/threads/nope/read`, "POST", owner(), {})).status, 404);
  assert.equal((await req(`/api/comms/threads/${t}/read`, "POST", { cookie: sessionCookie(makeSession("stranger@test.local")) }, {})).status, 403);
  // a session write without JSON content type is refused (CSRF guard)
  assert.equal((await createApp().request(`/api/comms/threads/${t}/read`, { method: "POST", headers: owner() })).status, 415);
  assert.equal((await req(`/api/comms/threads/${t}/read`, "POST", owner(), { upTo: "yesterday" })).status, 422);
});

test("D10: no receipt unless server flag AND owner toggle AND the owner's device", async () => {
  const sent: string[] = [];
  setReceiptSenderForTests(async (_room, ev) => { sent.push(ev); });
  const mk = () => {
    const t = conv(`r${Math.random().toString(36).slice(2, 7)}`, { lastEventAt: at(6), lastPreview: { text: "x", senderName: "Sam", isSelf: false, sentAt: at(6) } });
    putWindow(t, [msg(t, 6)]);
    return t;
  };
  const dev = device().headers;
  // flag off, toggle off
  let j = (await (await req(`/api/comms/threads/${mk()}/read`, "POST", dev, {})).json()) as { receipt: string };
  assert.equal(j.receipt, "off");
  // toggle on, flag off
  updateNotifySettings({ readReceipts: true });
  j = (await (await req(`/api/comms/threads/${mk()}/read`, "POST", dev, {})).json()) as { receipt: string };
  assert.equal(j.receipt, "off");
  // flag on, toggle on, but a browser session → off
  process.env.COMMS_READ_RECEIPTS_ENABLED = "true";
  j = (await (await req(`/api/comms/threads/${mk()}/read`, "POST", owner(), {})).json()) as { receipt: string };
  assert.equal(j.receipt, "off");
  // agent downgrade header on the device → off
  j = (await (await req(`/api/comms/threads/${mk()}/read`, "POST", { ...dev, "x-prism-action-origin": "agent" }, {})).json()) as { receipt: string };
  assert.equal(j.receipt, "off");
  // per-network override off wins over the global toggle
  updateNotifySettings({ readReceiptsByNetwork: { whatsapp: false } });
  j = (await (await req(`/api/comms/threads/${mk()}/read`, "POST", dev, {})).json()) as { receipt: string };
  assert.equal(j.receipt, "off");
  assert.deepEqual(sent, []);
  // all gates open → sent, to the newest incoming event
  updateNotifySettings({ readReceiptsByNetwork: { whatsapp: true } });
  j = (await (await req(`/api/comms/threads/${mk()}/read`, "POST", dev, {})).json()) as { receipt: string };
  assert.equal(j.receipt, "sent");
  assert.deepEqual(sent, ["$e6"]);
  // iMessage: unsupported (no Private API, D6)
  const im = conv("im", { network: "imessage", sourceRef: "iMessage;-;+15550001111" });
  j = (await (await req(`/api/comms/threads/${im}/read`, "POST", dev, {})).json()) as { receipt: string };
  assert.ok(j.receipt === "unsupported" || j.receipt === "off");
  assert.equal(sent.length, 1);
});

test("viewing lease: on, expires, off", async () => {
  let now = T0;
  setReadStateClockForTests(() => now);
  const t = conv("a");
  await req(`/api/comms/threads/${t}/read`, "POST", device().headers, { viewing: true });
  assert.equal(isViewing(t), true);
  now += VIEWING_LEASE_MS + 1;
  assert.equal(isViewing(t), false);
  setViewing(t, "d1", true);
  setViewing(t, "d1", false);
  assert.equal(isViewing(t), false);
});

test("notification settings: defaults (D18), validation, partial merge, agent origin refused", async () => {
  const g = (await (await req("/api/comms/notifications/settings", "GET", owner())).json()) as { settings: typeof DEFAULT_NOTIFY_SETTINGS; available: { push: boolean; readReceipts: boolean } };
  assert.deepEqual(g.settings.statuses, {
    urgent: true, "action-required": true, informational: false, low: false, social: false, triaged: false, handled: false, unclassified: false,
  });
  assert.deepEqual(g.settings.folders, {});
  assert.equal(g.settings.readReceipts, false);
  assert.equal(g.settings.hidePreviews, false);
  assert.deepEqual(g.available, { push: false, readReceipts: false });
  assert.equal((await req("/api/comms/notifications/settings", "PUT", owner(), { statuses: { spam: true } })).status, 422);
  assert.equal((await req("/api/comms/notifications/settings", "PUT", owner(), { spam: true })).status, 422);
  assert.equal((await req("/api/comms/notifications/settings", "PUT", owner(), { networks: { whatsapp: "no" } })).status, 422);
  assert.equal((await req("/api/comms/notifications/settings", "PUT", { ...device().headers, "x-prism-action-origin": "agent" }, { hidePreviews: true })).status, 403);
  const p = (await (await req("/api/comms/notifications/settings", "PUT", owner(), { hidePreviews: true, statuses: { informational: true }, networks: { telegram: false } })).json()) as { settings: typeof DEFAULT_NOTIFY_SETTINGS };
  assert.equal(p.settings.hidePreviews, true);
  assert.equal(p.settings.statuses.urgent, true); // untouched
  assert.equal(p.settings.statuses.informational, true);
  assert.deepEqual(p.settings.networks, { telegram: false });
  assert.deepEqual(getNotifySettings(), p.settings);
  // corrupt stored row reads as defaults
  db.prepare("UPDATE settings SET value = '{' WHERE key = 'comms_notify_v1'").run();
  assert.deepEqual(getNotifySettings(), sanitizeNotifySettings({}));
});

// ── APNs registration ─────────────────────────────────────────────────────────

test("Comms APNs registration: comms-native device only; revoke drops it; topic is the Comms bundle id", async () => {
  const token = "ab".repeat(32);
  const body = { token, environment: "production", platform: "macos" };
  assert.equal((await req("/api/comms/devices/apns", "POST", owner(), body)).status, 403);
  assert.equal((await req("/api/comms/devices/apns", "POST", device("prism-native").headers, body)).status, 403);
  const d = device();
  assert.equal((await req("/api/comms/devices/apns", "POST", d.headers, { ...body, platform: "watch" })).status, 422);
  const r = await req("/api/comms/devices/apns", "POST", d.headers, body);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, pushEnabled: false });
  assert.equal(liveCommsApnsTokens(config.ownerEmail).length, 1);
  // the same token from a new credential moves, never doubles
  const d2 = device();
  await req("/api/comms/devices/apns", "POST", d2.headers, body);
  assert.equal(liveCommsApnsTokens(config.ownerEmail).length, 1);
  await revokeDevice(d2.id);
  assert.equal(liveCommsApnsTokens(config.ownerEmail).length, 0);
  // Omni / Prism registrations are untouched by Comms ones (separate table)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM apns_tokens").get() as { n: number }).n, 0);
  assert.equal(apnsTopicForApplication("comms"), "com.benjaminlife.comms");
  configureApns({ omniTopic: "com.example.omni", commsTopic: "com.example.comms" });
  assert.equal(apnsTopicForApplication("omni"), "com.example.omni");
  assert.equal(apnsTopicForApplication("comms"), "com.example.comms");
  _resetApns();
});

test("sendApns addresses a comms row with the Comms topic; a 410 prunes only the Comms row", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { writeFileSync, mkdtempSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "apns-"));
  const keyPath = join(dir, "k.p8");
  writeFileSync(keyPath, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(keyPath, 0o600);
  const seen: ApnsRequest[] = [];
  configureApns({
    keyPath, keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", topic: "com.example.omni", commsTopic: "com.benjaminlife.comms",
    transport: { send: async (r) => { seen.push(r); return { status: 410, body: "{}" }; }, close() {} },
  });
  try {
    const d = device();
    saveCommsApnsToken({ deviceId: d.id, token: "cd".repeat(32), environment: "production", platform: "ios", email: config.ownerEmail, vaultId: "v" });
    const [row] = liveCommsApnsTokens(config.ownerEmail);
    assert.equal(await sendApns(row!, { payload: { aps: {} } }), "pruned");
    assert.equal(seen[0]!.headers["apns-topic"], "com.benjaminlife.comms");
    assert.equal(liveCommsApnsTokens(config.ownerEmail).length, 0);
  } finally {
    _resetApns();
  }
});

// ── notifier ──────────────────────────────────────────────────────────────────

const S = () => getNotifySettings();
const recent = (min = 0) => new Date(Date.now() - min * 60_000).toISOString();

test("decideOnArrival: D18 defaults, never-folders, muted, network off, known-person fast path", () => {
  const urgent = getThread(conv("u", { status: "urgent" }))!;
  const fyi = getThread(conv("f", { status: "informational" }))!;
  const fresh = getThread(conv("n"))!;
  const m = { sentAt: recent() };
  assert.equal(decideOnArrival(S(), urgent, m), "now");
  assert.equal(decideOnArrival(S(), fyi, m), "wait");
  assert.equal(decideOnArrival(S(), fresh, m), "wait");
  for (const folder of ["unknown", "low", "spam"] as const) assert.equal(decideOnArrival(S(), getThread(conv(`x${folder}`, { status: "urgent", folder }))!, m), "never");
  const muted = conv("mu", { status: "urgent" });
  setOverride(muted, { muted: true });
  assert.equal(decideOnArrival(S(), getThread(muted)!, m), "never");
  updateNotifySettings({ networks: { whatsapp: false } });
  assert.equal(decideOnArrival(S(), urgent, m), "never");
  updateNotifySettings({ networks: { whatsapp: true }, enabled: false });
  assert.equal(decideOnArrival(S(), urgent, m), "never");
  updateNotifySettings({ enabled: true });
  // known person DM, no verdict → now; but not once the thread's last verdict is a switched-off one
  const known = conv("k");
  db.prepare("UPDATE comms_threads SET person_id = 'person-1' WHERE id = ?").run(known);
  assert.equal(decideOnArrival(S(), getThread(known)!, m), "now");
  db.prepare("INSERT INTO comms_thread_verdicts (thread_id, status, updated_at) VALUES (?, 'low', 0)").run(known);
  assert.equal(decideOnArrival(S(), getThread(known)!, m), "wait");
  db.prepare("UPDATE comms_thread_verdicts SET status = 'urgent' WHERE thread_id = ?").run(known);
  assert.equal(decideOnArrival(S(), getThread(known)!, m), "now"); // last verdict urgent (tags stripped on arrival)
  // already read past the message → never
  markThreadRead(urgent.id);
  assert.equal(decideOnArrival(S(), urgent, { sentAt: at(1) }), "never");
});

test("payload privacy: hidePreviews → no sender, no title, no text", () => {
  const t = getThread(conv("a", { status: "urgent" }))!;
  const m = msg(t.id, 1);
  const shown = buildCommsNotification(t, m, 1, sanitizeNotifySettings({}), 3);
  const aps = shown.payload.aps as Record<string, unknown>;
  assert.deepEqual(aps.alert, { title: "Sam", body: "secret text 1" });
  assert.equal(aps["interruption-level"], "time-sensitive");
  assert.equal(aps.badge, 3);
  const hidden = buildCommsNotification(t, m, 2, sanitizeNotifySettings({ hidePreviews: true }), 3);
  const text = JSON.stringify(hidden.payload);
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("Sam"));
  assert.deepEqual((hidden.payload.aps as Record<string, unknown>).alert, { body: "2 new messages" });
});

function capture(): { sent: ApnsNotification[] } {
  const out = { sent: [] as ApnsNotification[] };
  setNotifyDepsForTests({
    devices: () => [{ token: "ab".repeat(32), environment: "production", application: "comms" }],
    send: async (_r, n) => { out.sent.push(n); return { outcome: "sent", status: 200, reason: "" }; },
    enabled: () => true,
  });
  return out;
}

test("notifier end to end: urgent now (coalesced), waiting thread notifies on a qualifying verdict, dedupe, quiet while viewing", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const cap = capture();
  setNotifyTuningForTests({ coalesceMs: 60_000 });
  const u = conv("u", { status: "urgent" });
  _resetNotifyForTests();
  appendEvent("message.created", u, { threadId: u, message: msg(u, 0, { id: "m1", sentAt: recent(1) }) });
  appendEvent("message.created", u, { threadId: u, message: msg(u, 0, { id: "m2", sentAt: recent() }) });
  appendEvent("message.created", u, { threadId: u, message: msg(u, 0, { id: "m3", sentAt: recent(), sender: { id: "me", name: "Me", avatar: null, isSelf: true, isOmni: false } }) });
  await processEvents();
  assert.deepEqual(_burstsForTests(), [u]);
  await flush(u);
  assert.equal(cap.sent.length, 1); // two incoming coalesced into one; own message ignored
  // a replay of the same message id is deduped
  appendEvent("message.created", u, { threadId: u, message: msg(u, 0, { id: "m2", sentAt: recent() }) });
  await processEvents();
  await flush(u);
  assert.equal(cap.sent.length, 1);

  // waiting: an unclassified thread notifies when the classifier says action-required
  const w = conv("w");
  appendEvent("message.created", w, { threadId: w, message: msg(w, 0, { id: "w1", sentAt: recent() }) });
  await processEvents();
  assert.deepEqual(_waitingForTests(), [w]);
  db.prepare("UPDATE comms_conversations SET status = 'action-required' WHERE id = 'w'").run();
  appendEvent("thread.updated", w, { threadId: w });
  await processEvents();
  assert.deepEqual(_waitingForTests(), []);
  await flush(w);
  assert.equal(cap.sent.length, 2);

  // waiting → a verdict the owner does not notify for (social) → dropped
  const s = conv("s");
  appendEvent("message.created", s, { threadId: s, message: msg(s, 0, { id: "s1", sentAt: recent() }) });
  await processEvents();
  db.prepare("UPDATE comms_conversations SET status = 'social' WHERE id = 's'").run();
  appendEvent("thread.updated", s, { threadId: s });
  await processEvents();
  assert.deepEqual(_waitingForTests(), []);
  assert.deepEqual(_burstsForTests(), []);

  // viewing on another device → nothing pushed (and logged as handled)
  setViewing(u, "mac", true);
  appendEvent("message.created", u, { threadId: u, message: msg(u, 0, { id: "m9", sentAt: recent() }) });
  await processEvents();
  await flush(u);
  assert.equal(cap.sent.length, 2);

  // too old (backfill / catch-up) → ignored
  setViewing(u, "mac", false);
  appendEvent("message.created", u, { threadId: u, message: msg(u, 0, { id: "old", sentAt: new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString() }) });
  await processEvents();
  assert.deepEqual(_burstsForTests(), []);
});

test("COMMS_NOTIFY_ENABLED off: nothing is pushed", async () => {
  const cap = capture();
  const u = conv("u", { status: "urgent" });
  _resetNotifyForTests();
  appendEvent("message.created", u, { threadId: u, message: msg(u, 0, { id: "m1", sentAt: recent() }) });
  await processEvents();
  await flush(u);
  assert.equal(cap.sent.length, 0);
});

test("the status the thread had before the strip still counts as its verdict", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const cap = capture();
  const t = conv("t", { status: "urgent" });
  _resetNotifyForTests();
  appendEvent("thread.updated", t, { threadId: t }); // records urgent as the last verdict
  await processEvents();
  db.prepare("UPDATE comms_conversations SET status = 'unclassified' WHERE id = 't'").run(); // ingest stripped the tags
  appendEvent("message.created", t, { threadId: t, message: msg(t, 0, { id: "x", sentAt: recent() }) });
  await processEvents();
  await flush(t);
  assert.equal(cap.sent.length, 1);
});

// ── fix round 1 ───────────────────────────────────────────────────────────────

test("I1 (D10 ruling): an explicit Mark as Read sends a receipt with the toggle off; opening/viewing never does", async () => {
  const sent: string[] = [];
  setReceiptSenderForTests(async (_room, ev) => { sent.push(ev); });
  process.env.COMMS_READ_RECEIPTS_ENABLED = "true"; // server flag on, owner toggle OFF (default)
  const dev = device().headers;
  const mk = (id: string) => {
    const t = conv(id, { lastEventAt: at(6), lastPreview: { text: "x", senderName: "Sam", isSelf: false, sentAt: at(6) } });
    putWindow(t, [msg(t, 4), msg(t, 6)]);
    return t;
  };
  const read = async (t: string, body: Record<string, unknown>, h: Record<string, string> = dev) =>
    ((await (await req(`/api/comms/threads/${t}/read`, "POST", h, body)).json()) as { receipt: string }).receipt;
  // opening, lease renewals, closing: never
  const a = mk("a");
  assert.equal(await read(a, { viewing: true }), "off");
  assert.equal(await read(a, { viewing: true }), "nothing"); // lease renewal: marker unchanged
  assert.equal(await read(a, { viewing: false }), "nothing");
  assert.deepEqual(sent, []);
  // explicit after it was opened (marker did not move): sent
  assert.equal(await read(a, { explicit: true }), "sent");
  assert.deepEqual(sent, ["$e6"]);
  // explicit on an unread thread: sent
  assert.equal(await read(mk("b"), { explicit: true }), "sent");
  // explicit from a browser session or an agent: off
  assert.equal(await read(mk("c"), { explicit: true }, owner()), "off");
  assert.equal(await read(mk("d"), { explicit: true }, { ...dev, "x-prism-action-origin": "agent" }), "off");
  // explicit with the server flag off: off
  delete process.env.COMMS_READ_RECEIPTS_ENABLED;
  assert.equal(await read(mk("e"), { explicit: true }), "off");
  process.env.COMMS_READ_RECEIPTS_ENABLED = "true";
  // explicit iMessage: unsupported (no Private API)
  const im = conv("im", { network: "imessage", sourceRef: "iMessage;-;+15550001111" });
  assert.equal(await read(im, { explicit: true }), "unsupported");
  assert.equal(sent.length, 2);
  assert.equal((await req(`/api/comms/threads/${a}/read`, "POST", dev, { explicit: "yes" })).status, 422);
});

test("M3: the receipt names the newest incoming message at or before the read point", async () => {
  const sent: string[] = [];
  setReceiptSenderForTests(async (_room, ev) => { sent.push(ev); });
  process.env.COMMS_READ_RECEIPTS_ENABLED = "true";
  const t = conv("a", { lastEventAt: at(6), lastPreview: { text: "x", senderName: "Sam", isSelf: false, sentAt: at(6) } });
  putWindow(t, [msg(t, 2), msg(t, 4), msg(t, 6)]);
  await req(`/api/comms/threads/${t}/read`, "POST", device().headers, { explicit: true, upTo: at(4) });
  assert.deepEqual(sent, ["$e4"]);
});

test("M1/M2: verdicts are seeded at start; the badge and interruption level use the verdict, not the stripped status", async () => {
  const { seedVerdicts } = await import("../src/comms/notify");
  const t = conv("t", { status: "urgent" });
  conv("q"); // unclassified: no verdict row
  assert.equal(seedVerdicts(), 1);
  assert.equal(seedVerdicts(), 0); // idempotent
  db.prepare("UPDATE comms_conversations SET status = 'unclassified' WHERE id = 't'").run(); // ingest stripped the tags
  assert.equal(unreadSummary().attention, 1);
  const n = buildCommsNotification(getThread(t)!, msg(t, 1), 1, sanitizeNotifySettings({}), 1);
  assert.equal((n.payload.aps as Record<string, unknown>)["interruption-level"], "time-sensitive");
});

// ── polish r2: archived / muted threads never push ─────────────────────────────

test("a message that un-archives a thread never pushes (Messages brings it back quietly); the next one does", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const cap = capture();
  const t = conv("arch", { status: "urgent" }); // urgent: would push "now" if it were in the inbox
  _resetNotifyForTests();
  setOverride(t, { archived: true }); // archived at "now" (o_archived_at)
  assert.equal(getThread(t)!.folder, "archived");
  // Production: archived 03:46:38Z, a message sent 03:46:54Z arrived and was pushed.
  const later = new Date(Date.now() + 1_000).toISOString();
  appendEvent("message.created", t, { threadId: t, message: msg(t, 0, { id: "wake", sentAt: later }) });
  // Ordering: the un-archive has already happened when the notifier evaluates the message.
  assert.equal(getThread(t)!.folder, "inbox");
  await processEvents();
  assert.deepEqual(_burstsForTests(), []);
  await flush(t);
  assert.equal(cap.sent.length, 0);
  // Back in the inbox now: a further message notifies as usual.
  appendEvent("message.created", t, { threadId: t, message: msg(t, 0, { id: "next", sentAt: new Date(Date.now() + 2_000).toISOString() }) });
  await processEvents();
  await flush(t);
  assert.equal(cap.sent.length, 1);
});

test("the un-archiving message stays silent even if it first waits for a verdict", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const cap = capture();
  const t = conv("archw"); // unclassified → would wait for the classifier
  _resetNotifyForTests();
  setOverride(t, { archived: true });
  appendEvent("message.created", t, { threadId: t, message: msg(t, 0, { id: "w", sentAt: new Date(Date.now() + 1_000).toISOString() }) });
  await processEvents();
  db.prepare("UPDATE comms_conversations SET status = 'urgent' WHERE id = 'archw'").run();
  appendEvent("thread.updated", t, { threadId: t });
  await processEvents();
  for (const id of _burstsForTests()) await flush(id);
  assert.equal(cap.sent.length, 0);
});

test("a thread that stays archived (source archive, or a backfill older than the archive) never pushes", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const cap = capture();
  const src = conv("srcarch", { status: "urgent", archived: true }); // archived at the source (e.g. WhatsApp)
  const own = conv("ownarch", { status: "urgent" });
  _resetNotifyForTests();
  setOverride(own, { archived: true });
  appendEvent("message.created", src, { threadId: src, message: msg(src, 0, { id: "s1", sentAt: recent() }) });
  // sent BEFORE the owner archived: does not un-archive
  appendEvent("message.created", own, { threadId: own, message: msg(own, 0, { id: "o1", sentAt: new Date(Date.now() - 30_000).toISOString() }) });
  await processEvents();
  assert.equal(getThread(src)!.folder, "archived");
  assert.equal(getThread(own)!.folder, "archived");
  for (const id of [src, own]) await flush(id);
  assert.equal(cap.sent.length, 0);
  assert.equal(decideOnArrival(getNotifySettings(), getThread(src)!, { sentAt: recent() }), "never");
});

test("archiving or muting after a message was queued: the burst is dropped at flush", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const cap = capture();
  setNotifyTuningForTests({ coalesceMs: 60_000 });
  const a = conv("qa", { status: "urgent" });
  const m = conv("qm", { status: "urgent" });
  _resetNotifyForTests();
  appendEvent("message.created", a, { threadId: a, message: msg(a, 0, { id: "a1", sentAt: recent() }) });
  appendEvent("message.created", m, { threadId: m, message: msg(m, 0, { id: "m1", sentAt: recent() }) });
  await processEvents();
  assert.deepEqual(_burstsForTests().sort(), [a, m].sort());
  setOverride(a, { archived: true });
  setOverride(m, { muted: true });
  await flush(a);
  await flush(m);
  assert.equal(cap.sent.length, 0);
});

test("a muted thread never pushes, urgent or not, whatever arrives", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const cap = capture();
  const t = conv("mu", { status: "urgent", kind: "dm" });
  _resetNotifyForTests();
  setOverride(t, { muted: true });
  for (let i = 0; i < 3; i++) appendEvent("message.created", t, { threadId: t, message: msg(t, 0, { id: `mu${i}`, sentAt: recent() }) });
  await processEvents();
  await flush(t);
  assert.equal(cap.sent.length, 0);
  assert.equal(decideOnArrival({ ...getNotifySettings(), statuses: { ...getNotifySettings().statuses, unclassified: true } }, getThread(t)!, { sentAt: recent() }), "never");
});

// ── every device, every thread (owner-testing round 4: "iOS gets one thread only") ─────────────

async function realApns(answer: (r: ApnsRequest) => { status: number; body: string }): Promise<ApnsRequest[]> {
  const { generateKeyPairSync } = await import("node:crypto");
  const { writeFileSync, mkdtempSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "apns-"));
  const keyPath = join(dir, "k.p8");
  writeFileSync(keyPath, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(keyPath, 0o600);
  const seen: ApnsRequest[] = [];
  configureApns({
    keyPath, keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", topic: "com.example.prism", commsTopic: "com.benjaminlife.comms",
    sleep: async () => {},
    transport: { send: async (r) => { seen.push(r); return answer(r); }, close() {} },
  });
  return seen;
}

test("every push goes to EVERY Comms device: a sandbox iPhone at the sandbox origin, a Mac at production, one per thread, never collapsed", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  const seen = await realApns(() => ({ status: 200, body: "" }));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const mac = device();
    const phone = device();
    saveCommsApnsToken({ deviceId: mac.id, token: "aa".repeat(32), environment: "production", platform: "macos", email: config.ownerEmail, vaultId: "v" });
    saveCommsApnsToken({ deviceId: phone.id, token: "bb".repeat(32), environment: "sandbox", platform: "ios", email: config.ownerEmail, vaultId: "v" });
    setNotifyTuningForTests({ coalesceMs: 60_000 });
    const threads = ["t1", "t2", "t3"].map((id) => conv(id, { status: "urgent" }));
    _resetNotifyForTests();
    for (const [i, t] of threads.entries()) appendEvent("message.created", t, { threadId: t, message: msg(t, 0, { id: `m${i}`, sentAt: recent() }) });
    await processEvents();
    for (const t of threads) await flush(t);
    assert.equal(seen.length, 6, "3 threads × 2 devices");
    const phoneReqs = seen.filter((r) => r.path.endsWith("bb".repeat(32)));
    const macReqs = seen.filter((r) => r.path.endsWith("aa".repeat(32)));
    assert.equal(phoneReqs.length, 3);
    assert.equal(macReqs.length, 3);
    for (const r of phoneReqs) assert.equal(r.origin, "https://api.sandbox.push.apple.com");
    for (const r of macReqs) assert.equal(r.origin, "https://api.push.apple.com");
    for (const r of seen) {
      assert.equal(r.headers["apns-topic"], "com.benjaminlife.comms");
      assert.equal(r.headers["apns-collapse-id"], undefined, "a collapse id would REPLACE one thread's alert with the next");
      assert.equal(r.headers["apns-push-type"], "alert");
    }
    assert.deepEqual(new Set(phoneReqs.map((r) => (JSON.parse(r.body).aps as Record<string, unknown>)["thread-id"])), new Set(threads), "one notification group per conversation");
    // One summary line per push: platform / environment / status — no ids, names or text.
    const summary = lines.filter((l) => l.startsWith("[comms-notify] push:"));
    assert.equal(summary.length, 3);
    for (const l of summary) {
      assert.match(l, /macos\/production 200/);
      assert.match(l, /ios\/sandbox 200/);
      assert.ok(!l.includes("secret") && !l.includes("Sam") && !threads.some((t) => l.includes(t)));
    }
  } finally {
    console.log = log;
    _resetApns();
  }
});

test("what APNs answered is logged per environment and shown in Notification settings; Send Test Notification reports per device", async () => {
  process.env.COMMS_NOTIFY_ENABLED = "true";
  await realApns((r) => r.origin.includes("sandbox") ? { status: 403, body: JSON.stringify({ reason: "BadEnvironmentKeyInToken" }) } : { status: 200, body: "" });
  const lines: string[] = [];
  const keep = { log: console.log, error: console.error };
  console.log = console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const mac = device();
    const phone = device();
    saveCommsApnsToken({ deviceId: mac.id, token: "aa".repeat(32), environment: "production", platform: "macos", email: config.ownerEmail, vaultId: "v" });
    saveCommsApnsToken({ deviceId: phone.id, token: "bb".repeat(32), environment: "sandbox", platform: "ios", email: config.ownerEmail, vaultId: "v" });
    // Before anything was sent: devices listed, no delivery yet.
    const before = await (await req("/api/comms/notifications/settings", "GET", phone.headers)).json() as any;
    assert.equal(before.devices.length, 2);
    assert.deepEqual(before.devices.map((d: any) => [d.platform, d.environment, d.thisDevice, d.lastDelivery]).sort(),
      [["ios", "sandbox", true, null], ["macos", "production", false, null]]);
    // Gates of the test route.
    assert.equal((await req("/api/comms/notifications/test", "POST", { ...phone.headers, "x-prism-action-origin": "agent" }, {})).status, 403);
    const t = await req("/api/comms/notifications/test", "POST", phone.headers, {});
    assert.equal(t.status, 200);
    const body = await t.json() as any;
    const ios = body.devices.find((d: any) => d.platform === "ios");
    const macos = body.devices.find((d: any) => d.platform === "macos");
    assert.deepEqual([ios.lastDelivery.status, ios.lastDelivery.reason, ios.lastDelivery.outcome], [403, "BadEnvironmentKeyInToken", "failed"]);
    assert.deepEqual([macos.lastDelivery.status, macos.lastDelivery.outcome], [200, "sent"]);
    assert.ok(lines.some((l) => /\[apns\] comms sandbox [0-9a-f]{8}: send failed 403 BadEnvironmentKeyInToken/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("[comms-notify] test:") && l.includes("ios/sandbox 403 BadEnvironmentKeyInToken") && l.includes("macos/production 200")));
    assert.ok(!lines.some((l) => l.includes("bb".repeat(32))), "never the token");
    // The settings screen shows the same afterwards.
    const after = await (await req("/api/comms/notifications/settings", "GET", mac.headers)).json() as any;
    assert.equal(after.devices.find((d: any) => d.platform === "ios").lastDelivery.reason, "BadEnvironmentKeyInToken");
    // Push off on the server → 503, nothing sent.
    delete process.env.COMMS_NOTIFY_ENABLED;
    assert.equal((await req("/api/comms/notifications/test", "POST", phone.headers, {})).status, 503);
  } finally {
    console.log = keep.log;
    console.error = keep.error;
    _resetApns();
  }
});
