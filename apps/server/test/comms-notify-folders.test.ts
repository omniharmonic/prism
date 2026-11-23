// Per-folder and per-status notification rules (owner, 2026-11-22: "we should be able to change
// notifications based on tag type or folder"). Precedence: thread Mute > folder "none" >
// folder "all" > status / network rules; spam never notifies; full previews stay the default.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db } from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { upsertConversation, ensureSingleThread, eventBounds, eventsAfter, getThread, setOverride, type ConversationRow } from "../src/comms/store";
import { addToFolder, createFolder, deleteFolder } from "../src/comms/folders";
import {
  DEFAULT_NOTIFY_SETTINGS, folderRuleOf, getNotifySettings, sanitizeNotifySettings, updateNotifySettings, _resetNotifySettingsForTests,
  type CommsNotifySettings,
} from "../src/comms/notify-settings";
import { _resetNotifyForTests, buildCommsNotification, decideOnArrival } from "../src/comms/notify";
import type { Message } from "../src/comms/types";

const FLAGS = ["COMMS_ENABLED", "COMMS_FOLDERS_ENABLED"] as const;
const prev = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  resetDb();
  process.env.COMMS_ENABLED = "true";
  process.env.COMMS_FOLDERS_ENABLED = "true";
  _resetNotifySettingsForTests();
  _resetNotifyForTests();
});
afterEach(() => {
  for (const k of FLAGS) if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
  _resetNotifyForTests();
});

function conv(id: string, over: Partial<ConversationRow> = {}): string {
  const now = new Date().toISOString();
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title: `Sam ${id}`, titleSource: "person",
    avatar: null, lastEventAt: now, lastPreview: { text: "hello", senderName: "Sam", isSelf: false, sentAt: now },
    unreadCount: 1, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null,
    accountLabel: null, capabilities: null, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}
const m = () => ({ sentAt: new Date().toISOString() });
const S = () => getNotifySettings();
const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const req = (method: string, headers: Record<string, string>, body?: unknown) =>
  createApp().request("/api/comms/notifications/settings", {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const put = (body: unknown, headers: Record<string, string> = owner()) => req("PUT", headers, body);

test("defaults: full previews on, every status listed, only Needs attention on, no folder rules", () => {
  assert.equal(DEFAULT_NOTIFY_SETTINGS.hidePreviews, false);
  assert.deepEqual(Object.keys(DEFAULT_NOTIFY_SETTINGS.statuses).sort(),
    ["action-required", "handled", "informational", "low", "social", "triaged", "unclassified", "urgent"]);
  assert.deepEqual(Object.entries(DEFAULT_NOTIFY_SETTINGS.statuses).filter(([, v]) => v).map(([k]) => k).sort(), ["action-required", "urgent"]);
  assert.deepEqual(DEFAULT_NOTIFY_SETTINGS.folders, {});
  // Full preview payload: sender as title, the text as body.
  const t = getThread(conv("p", { status: "urgent" }))!;
  const msg = {
    id: "$1", threadId: t.id, channel: { network: "whatsapp", accountLabel: null }, source: { network: "whatsapp", eventId: "$1", ref: "$1" },
    sender: { id: "@sam:hs", name: "Sam", avatar: null, isSelf: false, isOmni: false }, sentAt: m().sentAt,
    body: { plain: "the whole message text", spans: [] }, attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false,
  } as unknown as Message;
  const n = buildCommsNotification(t, msg, 1, getNotifySettings(), 0);
  assert.deepEqual((n.payload.aps as { alert: unknown }).alert, { title: "Sam", body: "the whole message text" });
});

test("policy precedence matrix: Mute > folder none > folder all > status / network rules", () => {
  const work = createFolder("Work").id;
  const family = createFolder("Family").id;
  type Case = { name: string; status?: string; folder?: ConversationRow["folder"]; muted?: boolean; in?: string[];
    rules?: Record<string, "all" | "none">; settings?: Partial<CommsNotifySettings>; expect: "now" | "wait" | "never" };
  const cases: Case[] = [
    // status rules alone (no folder rule)
    { name: "urgent, default", status: "urgent", expect: "now" },
    { name: "informational, default", status: "informational", expect: "wait" },
    { name: "social, default", status: "social", expect: "wait" },
    { name: "social switched on", status: "social", settings: { statuses: { ...DEFAULT_NOTIFY_SETTINGS.statuses, social: true } }, expect: "now" },
    { name: "handled switched on", status: "handled", settings: { statuses: { ...DEFAULT_NOTIFY_SETTINGS.statuses, handled: true } }, expect: "now" },
    { name: "no verdict + Not Yet Sorted on", settings: { statuses: { ...DEFAULT_NOTIFY_SETTINGS.statuses, unclassified: true } }, expect: "now" },
    { name: "no verdict, default", expect: "wait" },
    { name: "Low folder, default", status: "low", folder: "low", expect: "never" },
    { name: "Low folder + low on", status: "low", folder: "low", settings: { statuses: { ...DEFAULT_NOTIFY_SETTINGS.statuses, low: true } }, expect: "now" },
    { name: "network off", status: "urgent", settings: { networks: { whatsapp: false } }, expect: "never" },
    // folder "all": every message, beating status, network, strangers and low
    { name: "all + informational", status: "informational", in: [work], rules: { [work]: "all" }, expect: "now" },
    { name: "all + no verdict", in: [work], rules: { [work]: "all" }, expect: "now" },
    { name: "all + network off", status: "informational", in: [work], rules: { [work]: "all" }, settings: { networks: { whatsapp: false } }, expect: "now" },
    { name: "all + strangers", folder: "unknown", in: [work], rules: { [work]: "all" }, expect: "now" },
    { name: "all + low folder", status: "low", folder: "low", in: [work], rules: { [work]: "all" }, expect: "now" },
    { name: "all + spam (never)", folder: "spam", in: [work], rules: { [work]: "all" }, expect: "never" },
    { name: "all + muted (Mute wins)", status: "urgent", muted: true, in: [work], rules: { [work]: "all" }, expect: "never" },
    { name: "all + master switch off", status: "urgent", in: [work], rules: { [work]: "all" }, settings: { enabled: false }, expect: "never" },
    // folder "none": silence, beating status and "all"
    { name: "none + urgent", status: "urgent", in: [work], rules: { [work]: "none" }, expect: "never" },
    { name: "none beats all (two folders)", status: "urgent", in: [work, family], rules: { [work]: "all", [family]: "none" }, expect: "never" },
    // default folder rule = status rules
    { name: "default folder + urgent", status: "urgent", in: [work], expect: "now" },
    { name: "default folder + informational", status: "informational", in: [work], expect: "wait" },
    { name: "rule on another folder only", status: "informational", in: [family], rules: { [work]: "all" }, expect: "wait" },
  ];
  cases.forEach((c, i) => {
    _resetNotifySettingsForTests();
    const id = conv(`c${i}`, { ...(c.status ? { status: c.status as ConversationRow["status"] } : {}), ...(c.folder ? { folder: c.folder } : {}) });
    if (c.muted) setOverride(id, { muted: true });
    for (const f of c.in ?? []) addToFolder(f, [id]);
    updateNotifySettings({ ...(c.settings ?? {}), ...(c.rules ? { folders: c.rules } : {}) });
    assert.equal(decideOnArrival(S(), getThread(id)!, m()), c.expect, c.name);
  });
});

test("folder rules are ignored while COMMS_FOLDERS_ENABLED is off (threads carry no folders)", () => {
  const work = createFolder("Work").id;
  const id = conv("off", { status: "urgent" });
  addToFolder(work, [id]);
  updateNotifySettings({ folders: { [work]: "none" } });
  assert.equal(decideOnArrival(S(), getThread(id)!, m()), "never");
  delete process.env.COMMS_FOLDERS_ENABLED;
  assert.equal(decideOnArrival(S(), getThread(id)!, m()), "now");
});

test("folderRuleOf: none wins, then all, else null", () => {
  const s = sanitizeNotifySettings({ folders: { a: "all", b: "none" } });
  assert.equal(folderRuleOf(s, ["a"]), "all");
  assert.equal(folderRuleOf(s, ["a", "b"]), "none");
  assert.equal(folderRuleOf(s, ["c"]), null);
  assert.equal(folderRuleOf(s, undefined), null);
  // junk stored values are dropped
  assert.deepEqual(sanitizeNotifySettings({ folders: { a: "loud", "bad id!": "all", ok: "none" } }).folders, { ok: "none" });
});

test("PUT folders: partial merge per folder, default removes, unknown folder / bad value 422, agent refused, synced on GET", async () => {
  const work = createFolder("Work").id;
  const family = createFolder("Family").id;
  const seq = eventBounds().seq;
  let r = await put({ folders: { [work]: "all" } });
  assert.equal(r.status, 200);
  // announced to every device like a folder change
  assert.deepEqual(eventsAfter(seq, 10).map((e) => [e.kind, (e.payload as { reason?: string }).reason]), [["thread.updated", "folders"]]);
  const seq2 = eventBounds().seq;
  await put({ knownPeopleImmediately: true });
  assert.equal(eventsAfter(seq2, 10).length, 0, "other settings are not announced");
  assert.deepEqual(((await r.json()) as { settings: CommsNotifySettings }).settings.folders, { [work]: "all" });
  // another key leaves folders alone; another folder merges
  await put({ hidePreviews: true });
  r = await put({ folders: { [family]: "none" } });
  let s = ((await r.json()) as { settings: CommsNotifySettings }).settings;
  assert.deepEqual(s.folders, { [work]: "all", [family]: "none" });
  assert.equal(s.hidePreviews, true);
  // "default" removes the rule
  s = ((await (await put({ folders: { [work]: "default" } })).json()) as { settings: CommsNotifySettings }).settings;
  assert.deepEqual(s.folders, { [family]: "none" });
  // refusals change nothing
  assert.equal((await put({ folders: { [work]: "loud" } })).status, 422);
  assert.equal((await put({ folders: { cf_missing: "all" } })).status, 422);
  assert.equal((await put({ folders: ["all"] })).status, 422);
  const dev = issueDeviceToken(config.ownerEmail, "Comms (test)", "comms-native");
  assert.equal((await put({ folders: { [work]: "all" } }, { authorization: `Bearer ${dev.token}`, "x-prism-action-origin": "agent" })).status, 403);
  // every device reads the same rules
  const g = (await (await req("GET", { authorization: `Bearer ${dev.token}` })).json()) as { settings: CommsNotifySettings };
  assert.deepEqual(g.settings.folders, { [family]: "none" });
  // a deleted folder's rule goes with it
  deleteFolder(family);
  assert.deepEqual(getNotifySettings().folders, {});
  const stored = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'comms_notify_v1'").get() as { value: string }).value);
  await put({ hidePreviews: false });
  assert.ok(stored.folders);
  assert.deepEqual(JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'comms_notify_v1'").get() as { value: string }).value).folders, {});
});
