/**
 * Wave 2A: mentions → notifications + backlinks, comment replies, the inbox API,
 * reminders (worker), access requests and delivery settings. Real routes over the
 * fake vault; push delivery observed through `setDeliveryHook`.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { api } from "../src/routes/api";
import { config } from "../src/config";
import { db, setAccount, grantsForUser, upsertGrant } from "../src/db";
import { resetTreeForTests } from "../src/tree";
import { documentActorId } from "../src/human-collab";
import {
  _resetNotifications,
  noteContentStored,
  commentsStored,
  primeComments,
  runRemindersOnce,
  runEmailDigestOnce,
  setDeliveryHook,
  setDigestSender,
  createNotification,
  zonedTimeToUtc,
  parseReminderAt,
  clearNoteInfoCache,
} from "../src/notifications";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

process.env.NOTIFY_READS_PER_MINUTE = "100000"; // the polling helper below reads the inbox often
const OWNER = config.ownerEmail; // owner@test.local
const ADA = "ada@test.local";
const BOB = "bob@test.local";
const EVE = "eve@test.local";
let fv: FakeVault;
let delivered: Array<{ id: string; recipient: string; type: string }>;

const chip = (kind: string, id: string, uid: string, extra = "") =>
  `<span data-type="mention" data-kind="${kind}" data-id="${id}" data-mention-uid="${uid}"${extra}>@x</span>`;

beforeEach(() => {
  resetDb();
  _resetNotifications();
  resetTreeForTests();
  fv = installFakeVault();
  delivered = [];
  setDeliveryHook((n) => delivered.push(n));
  for (const [e, n] of [[ADA, "Ada Lovelace"], [BOB, "Bob"], [EVE, "Eve"]] as const) setAccount(e, n, "scrypt$fixture");
  fv.put({ id: "p-ada", path: "vault/people/Ada Lovelace", tags: ["person"], metadata: { name: "Ada Lovelace", email: ADA } });
  fv.put({ id: "p-eve", path: "vault/people/Eve", tags: ["person"], metadata: { name: "Eve", emails: [EVE] } });
  fv.put({ id: "doc", path: "vault/Projects/Plan", tags: ["team"], content: "<p>hello</p>" });
  fv.put({ id: "secret", path: "vault/Private/Secret", tags: ["hidden"], content: "<p>s</p>" });
  grantUser(ADA, "tag", "team", "edit");
  grantUser(BOB, "tag", "team", "edit");
  // The @ menu only offers people the author can view; the server holds chips to the same rule.
  for (const e of [ADA, BOB]) grantUser(e, "tag", "person", "view");
});
afterEach(() => {
  setDeliveryHook(null);
  setDigestSender(null);
  fv.restore();
});

const as = (email: string, headers: Record<string, string> = {}) => ({ cookie: sessionCookie(makeSession(email)), ...headers });
const J = { "content-type": "application/json" };
const req = (path: string, email: string | null, init: RequestInit = {}) =>
  api.request(path, { ...init, headers: { ...(email ? as(email) : {}), ...J, ...(init.headers as Record<string, string> | undefined) } });
async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
const inbox = async (email: string, q = "") => (await (await req(`/notifications${q}`, email)).json()) as { items: Array<Record<string, unknown>>; unread: number; next: string | null };

// ── mentions ─────────────────────────────────────────────────────────────────

test("a new person mention notifies that person's account, never the author; re-saving does not re-notify; backlink added", async () => {
  const html = `<p>hi ${chip("person", "p-ada", "u1")} see ${chip("page", "secret", "u2")}</p>`;
  const r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>hello</p>", next: html, authors: [BOB], updatedAt: fv.notes.get("doc")!.updatedAt });
  assert.equal(r.notified, 1);
  const items = (await inbox(ADA)).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.type, "mention");
  assert.equal(items[0]!.title, "Plan");
  assert.deepEqual(items[0]!.anchor, { mention: "u1" });
  assert.deepEqual(items[0]!.actor, { name: "Bob" });
  assert.ok(!JSON.stringify(items).includes(BOB), "never an email of the actor");
  assert.equal(delivered.length, 1);
  // Backlink to the person; NOT to a page the author (Bob) cannot view.
  const links = fv.notes.get("doc")!.links ?? [];
  assert.deepEqual(links.map((l) => [l.targetId, l.relationship]), [["p-ada", "mentions"]]);
  // Same content again (prev now includes the chip) → nothing new.
  const again = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: html, next: html + "<p>more</p>", authors: [BOB], updatedAt: null });
  assert.equal(again.notified, 0);
  assert.equal((await inbox(ADA)).items.length, 1);
});

test("self-mention and a mention of someone who can't view the page notify nobody", async () => {
  const html = `<p>${chip("person", "p-ada", "a")} ${chip("person", "p-eve", "e")}</p>`;
  const r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "", next: html, authors: [ADA], updatedAt: null });
  assert.equal(r.notified, 0, "Ada wrote it; Eve has no access to the page");
  assert.equal((await inbox(EVE)).items.length, 0);
});

test("REST content writes run the hook (owner passthrough AND member route) and only notify on success", async () => {
  const html = `<p>${chip("person", "p-ada", "r1")}</p>`;
  // Owner passthrough.
  const res = await req("/notes/doc", OWNER, { method: "PATCH", body: JSON.stringify({ content: html }), headers: { "x-prism-editor-schema": "99" } });
  assert.equal(res.status, 200);
  const got = await until(() => inbox(ADA), (v) => v.items.length === 1);
  assert.equal(got.items.length, 1);
  // Member (Bob, edit via tag) adds a second chip.
  const html2 = `${html}<p>${chip("person", "p-ada", "r2")}</p>`;
  const res2 = await req("/notes/doc", BOB, { method: "PATCH", body: JSON.stringify({ content: html2, if_updated_at: fv.notes.get("doc")!.updatedAt }), headers: { "x-prism-editor-schema": "99" } });
  assert.equal(res2.status, 200);
  assert.equal((await until(() => inbox(ADA), (v) => v.items.length === 2)).items.length, 2);
  // A refused write (Eve can't edit) never notifies.
  const res3 = await req("/notes/doc", EVE, { method: "PATCH", body: JSON.stringify({ content: `${html2}${chip("person", "p-ada", "r3")}` }), headers: { "x-prism-editor-schema": "99" } });
  assert.ok(res3.status >= 400);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await inbox(ADA)).items.length, 2);
});

test("revoking access hides the notification (and its title) at read time; unread count follows", async () => {
  await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "", next: chip("person", "p-ada", "z"), authors: [BOB], updatedAt: null });
  assert.equal((await inbox(ADA)).unread, 1);
  // Make the page private to someone else → Ada can no longer view it.
  fv.notes.get("doc")!.metadata = { prism_creator: BOB, prism_visibility: "private" };
  resetTreeForTests();
  clearNoteInfoCache();
  const after = await inbox(ADA);
  assert.equal(after.items.length, 0);
  assert.equal(after.unread, 0);
});

// ── comments ─────────────────────────────────────────────────────────────────

test("a reply notifies earlier thread participants; a comment @-mention notifies the mentioned person; first sight is baseline only", async () => {
  const doc = new Y.Doc();
  const threads = doc.getMap<Y.Map<unknown>>("comments");
  const t = new Y.Map<unknown>();
  t.set("id", "t1");
  const arr = new Y.Array<Record<string, unknown>>();
  arr.push([{ id: "c1", actorId: documentActorId(`user:${ADA}`), author: "Ada", text: "First", createdAt: 1 }]);
  t.set("comments", arr);
  threads.set("t1", t);
  // Never-seen doc: baseline only.
  assert.equal(await commentsStored("doc", "primary", "doc", doc, [ADA]), 0);
  // Bob replies and mentions Eve (no access) — Ada (participant) is notified.
  arr.push([{ id: "c2", actorId: documentActorId(`user:${BOB}`), author: "Bob", text: "Agreed @[Eve](person:p-eve)", createdAt: 2 }]);
  assert.equal(await commentsStored("doc", "primary", "doc", doc, [BOB]), 1);
  const items = (await inbox(ADA)).items;
  assert.equal(items[0]!.type, "comment_reply");
  assert.deepEqual(items[0]!.anchor, { thread: "t1" });
  assert.equal(items[0]!.preview, "Agreed @Eve");
  assert.equal((await inbox(EVE)).items.length, 0, "Eve can't view the page");
  // Grant Eve, Bob mentions her again in a new item → comment_mention.
  grantUser(EVE, "note", "doc", "view");
  arr.push([{ id: "c3", actorId: documentActorId(`user:${BOB}`), text: "@[Eve](person:p-eve) ping", createdAt: 3 }]);
  await commentsStored("doc", "primary", "doc", doc, [BOB]);
  assert.equal((await inbox(EVE)).items[0]!.type, "comment_mention");
  primeComments("doc2", doc); // a loaded doc primes the baseline
  assert.equal(await commentsStored("doc2", "primary", "doc", doc, [BOB]), 0);
});

// ── inbox API ────────────────────────────────────────────────────────────────

test("inbox API: auth, CSRF, mark read / all, archive, paging, other users can't touch my items", async () => {
  for (let i = 0; i < 5; i++) createNotification({ vaultId: "primary", recipient: ADA, type: "mention", noteId: "doc", actorEmail: BOB, dedupe: `t:${i}` });
  assert.equal((await req("/notifications", null)).status, 401);
  const cap = makeCapability("note", "doc", "view");
  assert.equal((await api.request("/notifications", { headers: { authorization: `Capability ${cap}` } })).status, 401);
  const p1 = await inbox(ADA, "?limit=2");
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next);
  const p2 = await inbox(ADA, `?limit=2&before=${encodeURIComponent(p1.next!)}`);
  const p3 = await inbox(ADA, `?limit=2&before=${encodeURIComponent(p2.next!)}`);
  assert.equal(p3.items.length, 1);
  assert.equal(p3.next, null);
  const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id as string);
  assert.equal(new Set(ids).size, 5);
  // CSRF: cross-site refused; wrong content type refused.
  assert.equal((await req("/notifications/read", ADA, { method: "POST", body: JSON.stringify({ all: true }), headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await api.request("/notifications/read", { method: "POST", body: "{}", headers: { ...as(ADA), "content-type": "text/plain" } })).status, 415);
  // Bob marking Ada's items does nothing.
  await req("/notifications/read", BOB, { method: "POST", body: JSON.stringify({ ids }) });
  assert.equal((await inbox(ADA)).unread, 5);
  const r1 = await (await req("/notifications/read", ADA, { method: "POST", body: JSON.stringify({ ids: [ids[0]] }) })).json();
  assert.equal((r1 as { unread: number }).unread, 4);
  await req("/notifications/archive", ADA, { method: "POST", body: JSON.stringify({ ids: [ids[1]], archived: true }) });
  assert.equal((await inbox(ADA)).items.length, 4);
  assert.equal((await inbox(ADA, "?box=archived")).items.length, 1);
  await req("/notifications/read", ADA, { method: "POST", body: JSON.stringify({ all: true }) });
  assert.equal((await (await req("/notifications/unread", ADA)).json() as { unread: number }).unread, 0);
  assert.equal((await req("/notifications?type=bogus", ADA)).status, 400);
  assert.equal((await inbox(ADA, "?type=reminder")).items.length, 0);
});

test("settings: push off for a category skips delivery; email digest respects settings and is content-free", async () => {
  const put = await req("/notifications/settings", ADA, { method: "PUT", body: JSON.stringify({ settings: { mention: { push: false, email: true } } }) });
  assert.equal(put.status, 200);
  assert.equal((await req("/notifications/settings", ADA, { method: "PUT", body: JSON.stringify({ settings: { mention: { push: "yes" } } }) })).status, 400);
  createNotification({ vaultId: "primary", recipient: ADA, type: "mention", noteId: "doc", actorEmail: BOB, dedupe: "s1" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(delivered.length, 0, "mention push disabled");
  createNotification({ vaultId: "primary", recipient: ADA, type: "comment_reply", noteId: "doc", actorEmail: BOB, dedupe: "s2" });
  await until(() => delivered.length, (n) => n === 1);
  assert.equal(delivered[0]!.type, "comment_reply");
  // Digest: both unread → one email with a count, nothing else.
  const sent: Array<[string, number]> = [];
  setDigestSender(async (to, n) => void sent.push([to, n]));
  assert.equal(await runEmailDigestOnce(Date.now() + 3_600_000), 1);
  assert.deepEqual(sent, [[ADA, 2]]);
  assert.equal(await runEmailDigestOnce(Date.now() + 7_200_000), 0, "already emailed");
});

// ── reminders ────────────────────────────────────────────────────────────────

test("reminders: date-only is 09:00 in the caller's zone (DST-correct); instants need an offset", () => {
  assert.equal(new Date(zonedTimeToUtc(2026, 10, 3, 9, 0, "America/Denver")).toISOString(), "2026-10-03T15:00:00.000Z");
  assert.equal(new Date(zonedTimeToUtc(2026, 12, 3, 9, 0, "America/Denver")).toISOString(), "2026-12-03T16:00:00.000Z");
  assert.equal(new Date(parseReminderAt("2026-10-03", "Europe/Berlin", true)!).toISOString(), "2026-10-03T07:00:00.000Z");
  assert.equal(parseReminderAt("2026-10-03T09:00", "UTC", false), null, "no offset → refused");
  assert.equal(parseReminderAt("2026-10-03T09:00:00-06:00", "UTC", false), Date.parse("2026-10-03T15:00:00Z"));
});

test("reminders: view required, own only, fire once at time, cancelled never fires, lost access drops it", async () => {
  const at = new Date(Date.now() + 60_000).toISOString();
  const tz = "America/Denver";
  assert.equal((await req("/reminders", ADA, { method: "POST", body: JSON.stringify({ noteId: "secret", at, tz }) })).status, 404, "unviewable = missing");
  assert.equal((await req("/reminders", ADA, { method: "POST", body: JSON.stringify({ noteId: "nope", at, tz }) })).status, 404);
  assert.equal((await req("/reminders", ADA, { method: "POST", body: JSON.stringify({ noteId: "doc", at, tz: "Mars/Base" }) })).status, 400);
  const created = await req("/reminders", ADA, { method: "POST", body: JSON.stringify({ noteId: "doc", at, tz, uid: "chip1" }) });
  assert.equal(created.status, 201);
  const { reminder } = (await created.json()) as { reminder: { id: string; title: string; status: string } };
  assert.equal(reminder.title, "Plan");
  // Bob can't see, edit or cancel it.
  assert.equal(((await (await req("/reminders", BOB)).json()) as { items: unknown[] }).items.length, 0);
  assert.equal((await api.request(`/reminders/${reminder.id}`, { method: "DELETE", headers: as(BOB) })).status, 404);
  assert.equal((await req(`/reminders/${reminder.id}`, BOB, { method: "PATCH", body: JSON.stringify({ at, tz }) })).status, 404);
  // Not due yet.
  assert.equal(await runRemindersOnce(Date.now()), 0);
  // Due: fires once.
  assert.equal(await runRemindersOnce(Date.now() + 120_000), 1);
  assert.equal(await runRemindersOnce(Date.now() + 120_000), 0, "idempotent");
  const items = (await inbox(ADA)).items;
  assert.equal(items[0]!.type, "reminder");
  assert.deepEqual(items[0]!.anchor, { reminder: reminder.id, mention: "chip1" });
  // A cancelled reminder never fires.
  const c2 = (await (await req("/reminders", ADA, { method: "POST", body: JSON.stringify({ noteId: "doc", at, tz }) })).json()) as { reminder: { id: string } };
  assert.equal((await api.request(`/reminders/${c2.reminder.id}`, { method: "DELETE", headers: as(ADA) })).status, 200);
  assert.equal(await runRemindersOnce(Date.now() + 120_000), 0);
  // Lost access before the time → dropped.
  const c3 = (await (await req("/reminders", BOB, { method: "POST", body: JSON.stringify({ noteId: "doc", at, tz }) })).json()) as { reminder: { id: string } };
  assert.ok(c3.reminder.id);
  db.prepare("DELETE FROM grants WHERE subject = ?").run(BOB);
  assert.equal(grantsForUser(BOB).length, 0);
  assert.equal(await runRemindersOnce(Date.now() + 120_000), 0);
  assert.equal((await inbox(BOB)).items.length, 0);
});

// ── access requests ──────────────────────────────────────────────────────────

test("access requests: always 202 (no oracle), owner notified + decides, approve grants, requester notified", async () => {
  const ask = (email: string, body: unknown) => req("/access-requests", email, { method: "POST", body: JSON.stringify(body) });
  assert.equal((await ask(EVE, { noteId: "does-not-exist" })).status, 202);
  assert.equal((await ask(EVE, { noteId: "secret", level: "edit", message: "please" })).status, 202);
  assert.equal((await ask(EVE, { noteId: "secret", level: "own" })).status, 400);
  assert.equal((await req("/access-requests", null, { method: "POST", body: JSON.stringify({ noteId: "secret" }) })).status, 401);
  await until(() => inbox(OWNER), (v) => v.items.length === 1);
  const ownerItems = (await inbox(OWNER)).items;
  assert.equal(ownerItems.length, 1, "nothing for the nonexistent note");
  assert.equal(ownerItems[0]!.type, "access_request");
  assert.equal(ownerItems[0]!.title, "Secret");
  // Bob (no share) sees no requests and can't decide.
  assert.deepEqual(((await (await req("/access-requests", BOB)).json()) as { items: unknown[] }).items, []);
  const list = ((await (await req("/access-requests", OWNER)).json()) as { items: Array<{ id: string; requester: { email: string }; level: string; message: string }> }).items;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0]!.requester.email, list[0]!.level, list[0]!.message], [EVE, "edit", "please"]);
  assert.equal((await req(`/access-requests/${list[0]!.id}`, BOB, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status, 404);
  const ok = await req(`/access-requests/${list[0]!.id}`, OWNER, { method: "POST", body: JSON.stringify({ decision: "approve", level: "comment" }) });
  assert.deepEqual(await ok.json(), { ok: true, status: "approved" });
  assert.ok(grantsForUser(EVE).some((g) => g.resource === "secret" && g.level === "comment"));
  assert.equal((await req(`/access-requests/${list[0]!.id}`, OWNER, { method: "POST", body: JSON.stringify({ decision: "deny" }) })).status, 409);
  const eve = (await inbox(EVE)).items;
  assert.equal(eve[0]!.type, "access_granted");
  assert.equal(eve[0]!.title, "Secret");
  assert.equal((await inbox(OWNER)).unread, 0, "the request item is read once decided");
});

test("access requests: a share-cap holder decides only within their own caps; a denial shows no title", async () => {
  db.prepare("DELETE FROM grants WHERE subject = ?").run(BOB);
  upsertGrant({ vault_id: "primary", subject_type: "user", subject: BOB, resource_type: "note", resource: "secret", level: "view", caps: ["view", "comment", "share"], created_by: "test" });
  const ask = async (level: string) => {
    await req("/access-requests", EVE, { method: "POST", body: JSON.stringify({ noteId: "secret", level }) });
    const items = await until(async () => ((await (await req("/access-requests", BOB)).json()) as { items: Array<{ id: string }> }).items, (v) => v.length === 1);
    return items[0]!.id;
  };
  const id = await ask("edit");
  assert.equal((await req(`/access-requests/${id}`, BOB, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status, 403, "can't hand out edit");
  assert.deepEqual(await (await req(`/access-requests/${id}`, BOB, { method: "POST", body: JSON.stringify({ decision: "approve", level: "comment" }) })).json(), { ok: true, status: "approved" });
  db.prepare("DELETE FROM grants WHERE subject = ?").run(EVE);
  clearNoteInfoCache();
  const id2 = await ask("view");
  const deny = await req(`/access-requests/${id2}`, OWNER, { method: "POST", body: JSON.stringify({ decision: "deny" }) });
  assert.deepEqual(await deny.json(), { ok: true, status: "denied" });
  const denied = (await inbox(EVE)).items.find((i) => i.type === "access_denied")!;
  assert.equal(denied.title, null, "no title for a page the requester can't view");
});

test("a request for access you already have is dropped silently", async () => {
  await req("/access-requests", ADA, { method: "POST", body: JSON.stringify({ noteId: "doc", level: "view" }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await inbox(OWNER)).items.length, 0);
});

// ── the live-editor path ─────────────────────────────────────────────────────
import { storeDocumentState, contentToYUpdate, noteDocEditor, resetReconcileState } from "../src/collab";

test("collab store: a chip typed in the live editor notifies (attributed to the socket's account) and links", async () => {
  resetReconcileState();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, contentToYUpdate(`<p>hello ${chip("person", "p-ada", "live1")}</p>`));
  noteDocEditor("doc", { email: BOB });
  await storeDocumentState("doc", doc);
  const got = await until(() => inbox(ADA), (v) => v.items.length === 1);
  assert.equal(got.items[0]!.type, "mention");
  assert.deepEqual(got.items[0]!.actor, { name: "Bob" });
  assert.ok(fv.notes.get("doc")!.content.includes('data-type="mention"'), "the chip round-trips through the shared schema");
  await until(() => fv.notes.get("doc")!.links ?? [], (l) => l.length === 1);
  assert.deepEqual((fv.notes.get("doc")!.links ?? []).map((l) => l.targetId), ["p-ada"]);
  // The author typing their own chip notifies nobody.
  Y.applyUpdate(doc, contentToYUpdate(`<p>x ${chip("person", "p-ada", "live2")}</p>`));
  noteDocEditor("doc", { email: ADA });
  await storeDocumentState("doc", doc);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await inbox(ADA)).items.length, 1);
});

test("live-editor comments (no actorId) are attributed to the socket's account and get reply notifications later", async () => {
  const doc = new Y.Doc();
  const threads = doc.getMap<Y.Map<unknown>>("comments");
  primeComments("doc-live", doc);
  const t = new Y.Map<unknown>();
  t.set("id", "t9");
  const arr = new Y.Array<Record<string, unknown>>();
  arr.push([{ author: "Ada", text: "Started here", createdAt: 10 }]);
  t.set("comments", arr);
  threads.set("t9", t);
  assert.equal(await commentsStored("doc-live", "primary", "doc", doc, [ADA]), 0);
  arr.push([{ author: "Bob", text: "reply", createdAt: 11 }]);
  assert.equal(await commentsStored("doc-live", "primary", "doc", doc, [BOB]), 1);
  assert.equal((await inbox(ADA)).items[0]!.type, "comment_reply");
  assert.equal((await inbox(BOB)).items.length, 0, "never the author");
});

// ── review M1–M4, L1–L7 ──────────────────────────────────────────────────────

test("M1: one sender can't exhaust a recipient's budget; reminders/shares/access outcomes always land (push may be skipped)", async () => {
  // Bob churns chips with fresh uids at Ada.
  let made = 0;
  for (let i = 0; i < 60; i++) if (createNotification({ vaultId: "primary", recipient: ADA, type: "mention", noteId: "doc", actorEmail: BOB, dedupe: `spam:${i}` })) made++;
  assert.ok(made <= 20, `per-sender cap (got ${made})`);
  assert.ok(made >= 5);
  // Eve (another sender) still reaches Ada.
  grantUser(EVE, "tag", "team", "edit");
  assert.ok(createNotification({ vaultId: "primary", recipient: ADA, type: "mention", noteId: "doc", actorEmail: EVE, dedupe: "eve:1" }));
  // A duplicate (dedupe) spends no budget: the same key 50× → one row.
  for (let i = 0; i < 50; i++) createNotification({ vaultId: "primary", recipient: BOB, type: "mention", noteId: "doc", actorEmail: EVE, dedupe: "same" });
  assert.ok(createNotification({ vaultId: "primary", recipient: BOB, type: "mention", noteId: "doc", actorEmail: EVE, dedupe: "other" }));
  // Exhaust the recipient's hourly push budget, then a reminder still creates its row.
  for (let i = 0; i < 400; i++) createNotification({ vaultId: "primary", recipient: ADA, type: "share", noteId: "doc", actorEmail: `s${i}@test.local`, dedupe: `share:${i}` });
  const at = new Date(Date.now() + 60_000).toISOString();
  await req("/reminders", ADA, { method: "POST", body: JSON.stringify({ noteId: "doc", at, tz: "UTC" }) });
  assert.equal(await runRemindersOnce(Date.now() + 120_000), 1);
  assert.ok((await inbox(ADA, "?type=reminder")).items.length === 1, "reminder row created even over the push budget");
});

test("M2: email digest isn't blocked by rows whose category has email off; pages per recipient", async () => {
  await req("/notifications/settings", ADA, { method: "PUT", body: JSON.stringify({ settings: { reminder: { push: true, email: false } } }) });
  for (let i = 0; i < 1100; i++) db.prepare("INSERT INTO notifications (id, vault_id, recipient, type, note_id, created_at) VALUES (?, 'primary', ?, 'reminder', 'doc', ?)").run(`old${i}`, ADA, 1000 + i);
  createNotification({ vaultId: "primary", recipient: BOB, type: "comment_reply", noteId: "doc", actorEmail: ADA, dedupe: "b1" });
  const sent: Array<[string, number]> = [];
  setDigestSender(async (to, n) => void sent.push([to, n]));
  await runEmailDigestOnce(Date.now() + 3_600_000);
  assert.deepEqual(sent, [[BOB, 1]]);
});

test("M3: a live-editor comment carrying someone else's actorId is credited to the socket's account", async () => {
  const doc = new Y.Doc();
  const threads = doc.getMap<Y.Map<unknown>>("comments");
  primeComments("m3", doc);
  const t = new Y.Map<unknown>();
  t.set("id", "t3");
  const arr = new Y.Array<Record<string, unknown>>();
  // Eve (editor) writes an item that claims to be Ada's, with a token at Bob.
  arr.push([{ actorId: documentActorId(`user:${ADA}`), author: "Ada", text: "x", createdAt: 1 }]);
  t.set("comments", arr);
  threads.set("t3", t);
  grantUser(EVE, "tag", "team", "edit");
  await commentsStored("m3", "primary", "doc", doc, [EVE]);
  // Bob replies: the earlier participant is Eve (the real writer), not Ada.
  arr.push([{ actorId: documentActorId(`user:${BOB}`), author: "Bob", text: "reply", createdAt: 2 }]);
  await commentsStored("m3", "primary", "doc", doc, [BOB]);
  assert.equal((await inbox(ADA)).items.length, 0, "Ada never wrote here");
  assert.equal((await inbox(EVE)).items[0]!.type, "comment_reply");
});

test("M4: REST autosaves of a page with known chips don't re-read the vault; new chips still notify", async () => {
  const html = `<p>${chip("person", "p-ada", "k1")}</p>`;
  await req("/notes/doc", OWNER, { method: "PATCH", body: JSON.stringify({ content: html }), headers: { "x-prism-editor-schema": "99" } });
  await until(() => inbox(ADA), (v) => v.items.length === 1);
  const reads = () => fv.calls.filter((c) => c.method === "GET" && c.path.endsWith("/notes/doc")).length;
  const before = reads();
  for (let i = 0; i < 5; i++) {
    await req("/notes/doc", OWNER, { method: "PATCH", body: JSON.stringify({ content: `${html}<p>typing ${i}</p>` }), headers: { "x-prism-editor-schema": "99" } });
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reads() - before, 0, "no pre-read while the chip set is unchanged");
  await req("/notes/doc", OWNER, { method: "PATCH", body: JSON.stringify({ content: `${html}${chip("person", "p-ada", "k2")}` }), headers: { "x-prism-editor-schema": "99" } });
  assert.equal((await until(() => inbox(ADA), (v) => v.items.length === 2)).items.length, 2);
});

test("L1: deleting the last chip to a target removes the mentions backlink; L4: a multi-editor batch credits 'a collaborator' and still notifies a mentioned editor", async () => {
  const one = `<p>${chip("person", "p-ada", "l1")}</p>`;
  await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "", next: one, authors: [BOB], updatedAt: null });
  assert.equal((fv.notes.get("doc")!.links ?? []).length, 1);
  await noteContentStored({ vaultId: "primary", noteId: "doc", prev: one, next: "<p>gone</p>", authors: [BOB], updatedAt: null });
  assert.equal((fv.notes.get("doc")!.links ?? []).length, 0);
  // Two editors in the batch, one of them (Ada) is mentioned → notified, no actor name.
  await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "", next: `<p>${chip("person", "p-ada", "l4")}</p>`, authors: [BOB, ADA], updatedAt: null });
  const item = (await inbox(ADA)).items.find((i) => (i.anchor as { mention?: string })?.mention === "l4")!;
  assert.ok(item);
  assert.equal(item.actor, null);
});

test("L2: approving a request never lowers an existing grant; L7: share-holders see names, not emails", async () => {
  grantUser(EVE, "note", "secret", "edit");
  db.prepare("INSERT INTO access_requests (id, vault_id, note_id, requester, level, status, created_at) VALUES ('r1','primary','secret',?, 'view','pending',?)").run(EVE, Date.now());
  await req("/access-requests/r1", OWNER, { method: "POST", body: JSON.stringify({ decision: "approve", level: "view" }) });
  assert.ok(grantsForUser(EVE).some((g) => g.resource === "secret" && g.level === "edit"), "still edit");
  upsertGrant({ vault_id: "primary", subject_type: "user", subject: BOB, resource_type: "note", resource: "doc", level: "view", caps: ["view", "share"], created_by: "test" });
  db.prepare("INSERT INTO access_requests (id, vault_id, note_id, requester, level, status, created_at) VALUES ('r2','primary','doc',?, 'view','pending',?)").run(EVE, Date.now());
  const asBob = ((await (await req("/access-requests", BOB)).json()) as { items: Array<{ requester: Record<string, unknown> }> }).items;
  assert.equal(asBob.length, 1);
  assert.equal(asBob[0]!.requester.email, undefined);
  assert.equal(asBob[0]!.requester.name, "Eve");
  const asOwner = ((await (await req("/access-requests", OWNER)).json()) as { items: Array<{ requester: Record<string, unknown> }> }).items;
  assert.equal(asOwner[0]!.requester.email, EVE);
});

test("L3: a comment @-token only notifies people the author can see", async () => {
  const doc = new Y.Doc();
  primeComments("l3", doc);
  const t = new Y.Map<unknown>();
  t.set("id", "t");
  const arr = new Y.Array<Record<string, unknown>>();
  arr.push([{ text: "hi @[Eve](person:p-eve)", createdAt: 1 }]);
  t.set("comments", arr);
  doc.getMap<Y.Map<unknown>>("comments").set("t", t);
  grantUser(EVE, "tag", "team", "view");
  // Author: a member with no view of person notes.
  const ZED = "zed@test.local";
  setAccount(ZED, "Zed", "scrypt$fixture");
  grantUser(ZED, "tag", "team", "edit");
  await commentsStored("l3", "primary", "doc", doc, [ZED]);
  assert.equal((await inbox(EVE)).items.length, 0);
});

test("final L3: approving a request that raises an existing grant keeps who made that grant", async () => {
  upsertGrant({ vault_id: "primary", subject_type: "user", subject: EVE, resource_type: "note", resource: "secret", level: "view", created_by: "first-admin@test.local" });
  db.prepare("INSERT INTO access_requests (id, vault_id, note_id, requester, level, status, created_at) VALUES ('r9','primary','secret',?, 'edit','pending',?)").run(EVE, Date.now());
  const ok = await req("/access-requests/r9", OWNER, { method: "POST", body: JSON.stringify({ decision: "approve", level: "edit" }) });
  assert.equal(ok.status, 200);
  const g = grantsForUser(EVE).find((x) => x.resource === "secret" && x.resource_type === "note")!;
  assert.equal(g.level, "edit");
  assert.equal(g.created_by, "first-admin@test.local", "raised, not re-authored by the decider");
});

// ── suggestions accepted / declined (wave 3) ─────────────────────────────────
import { suggestionsResolved } from "../src/notifications";
const sug = (kind: "insert" | "delete", id: string, actor: string | null, text: string) =>
  `<span data-suggestion="${kind}" data-user="Someone" data-color="#888" data-suggestion-id="${id}"${actor ? ` data-actor-id="${actor}"` : ""}>${text}</span>`;

test("the suggester is told when an editor accepts or declines their suggestion — once, by account, view re-checked", async () => {
  const ada = documentActorId(`user:${ADA}`);
  const prev = `<p>hello ${sug("delete", "s1", ada, "world")}${sug("insert", "s1", ada, "there")} and ${sug("insert", "s2", ada, "extra")} and ${sug("delete", "s3", ada, "cut me")}</p>`;
  // Bob accepts s1 (replacement applied), declines s2 (insert dropped), accepts s3 (deletion applied).
  const next = "<p>hello there and  and </p>";
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next, editors: [BOB] }), 3);
  const items = (await inbox(ADA)).items;
  assert.deepEqual(items.map((i) => i.type).sort(), ["suggestion_accepted", "suggestion_accepted", "suggestion_rejected"]);
  const declined = items.find((i) => i.type === "suggestion_rejected")!;
  assert.equal(declined.preview, "extra");
  assert.equal((declined.actor as { name?: string } | null)?.name, "Bob");
  assert.equal(JSON.stringify(items).includes(BOB), false, "no account email in the inbox payload");
  assert.equal((await inbox(ADA, "?type=comment")).items.length, 3, "listed under the comments filter");
  // Idempotent: the same store again sends nothing.
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next, editors: [BOB] }), 0);
  assert.equal((await inbox(BOB)).items.length, 0);
});

test("no notification without a resolvable account, for one's own change, for a server-internal store, or without view", async () => {
  const ada = documentActorId(`user:${ADA}`);
  const eve = documentActorId(`user:${EVE}`); // Eve has an account but cannot view the page
  const guest = documentActorId("capability:link-1");
  const prev = `<p>${sug("insert", "g1", guest, "guest text")}${sug("insert", "n1", null, "typed live")}${sug("insert", "e1", eve, "eve text")}${sug("insert", "a1", ada, "ada text")}</p>`;
  const next = "<p>guest text typed live eve text</p>";
  // Ada changed the page herself (withdrew a1): nothing for her; guest/no-id/unviewable: nothing.
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next, editors: [ADA] }), 0);
  // A reconcile/restore store has no editor: nobody decided anything.
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next, editors: [] }), 0);
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next, editors: [BOB] }), 1, "only Ada's a1");
  assert.equal((await inbox(EVE)).items.length, 0);
  // Two editors in the batch: sent, but the decider is not named.
  const prev2 = `<p>${sug("insert", "a2", ada, "more")}</p>`;
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev: prev2, next: "<p>more</p>", editors: [BOB, OWNER] }), 1);
  const latest = (await inbox(ADA)).items.find((i) => i.preview === "more")!;
  assert.equal(latest.type, "suggestion_accepted");
  assert.equal(latest.actor ?? null, null);
  // A suggestion still pending is not "resolved".
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev: prev2, next: prev2, editors: [BOB] }), 0);
});

test("legacy agent suggestions (email as actor id) still reach the account", async () => {
  const prev = `<p>${sug("insert", "m1", ADA, "agent text")}</p>`;
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next: "<p></p>", editors: [BOB] }), 1);
  assert.equal((await inbox(ADA)).items[0]!.type, "suggestion_rejected");
});

// ── mentioning a member who has no person note (wave 3) ──────────────────────
import { setMembership } from "../src/db";
import { writerIdFor } from "../src/writer-stamp";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
const CAL = "cal@test.local"; // a workspace member with an account and NO person note

test("the @ list offers members without a person page — opaque id + name, never an email; guests get nothing", async () => {
  resetDatabaseCachesForTests();
  setAccount(CAL, "Cal Newport", "scrypt$fixture");
  for (const e of [ADA, BOB, CAL]) setMembership("primary", e, "member", OWNER);
  const list = async (email: string | null, q = "") => {
    const r = await req(`/mentions/members?q=${encodeURIComponent(q)}`, email);
    return { status: r.status, body: r.status === 200 ? ((await r.json()) as { members: Array<{ id: string; name: string }> }) : null, raw: "" };
  };
  const bob = await list(BOB);
  assert.equal(bob.status, 200);
  // Ada has a person page Bob can view → offered as a person, not here. Cal has none.
  assert.deepEqual(bob.body!.members.map((m) => m.name).sort(), ["Cal Newport"]);
  assert.deepEqual(bob.body!.members.map((m) => m.id), [writerIdFor(CAL)]);
  assert.match(bob.body!.members[0]!.id, /^u_[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(bob.body).includes("@"), false, "no email anywhere in the answer");
  assert.deepEqual((await list(BOB, "newp")).body!.members.map((m) => m.name), ["Cal Newport"]);
  assert.deepEqual((await list(BOB, "zzz")).body!.members, []);
  // Cal cannot view Ada's person page, so for Cal she is offered by account; never Cal himself.
  assert.deepEqual((await list(CAL)).body!.members.map((m) => m.name).sort(), ["Ada Lovelace", "Bob"]);
  setAccount("nameless@test.local", null as never, "scrypt$fixture");
  setMembership("primary", "nameless@test.local", "member", OWNER);
  assert.equal((await list(CAL)).body!.members.length, 2, "a nameless account could only be shown by its email — not offered");
  // A guest (an account with only a shared page) cannot enumerate the workspace.
  grantUser(EVE, "note", "doc", "edit");
  assert.deepEqual((await list(EVE)).body!.members, []);
  assert.equal((await list(null)).status, 401);
  // A capability link is not an account.
  const link = makeCapability("note", "doc", "edit");
  assert.equal((await api.request(`/mentions/members?t=${encodeURIComponent(link)}`)).status, 401);
});

test("an account mention notifies that member (view re-checked), adds no link, and a guest author cannot use it", async () => {
  resetDatabaseCachesForTests();
  setAccount(CAL, "Cal Newport", "scrypt$fixture");
  for (const e of [ADA, BOB, CAL]) setMembership("primary", e, "member", OWNER);
  const calId = writerIdFor(CAL);
  const html = (uid: string) => `<p>hello ${chip("person", calId, uid, ' data-label="Cal Newport"')}</p>`;
  const patchesBefore = fv.calls.filter((c) => c.method === "PATCH").length;
  // Cal cannot view the page yet: nothing is sent.
  let r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>hello</p>", next: html("m1"), authors: [BOB], updatedAt: fv.notes.get("doc")!.updatedAt });
  assert.deepEqual([r.notified, r.linked], [0, 0]);
  grantUser(CAL, "tag", "team", "view");
  clearNoteInfoCache();
  r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>hello</p>", next: html("m2"), authors: [BOB], updatedAt: fv.notes.get("doc")!.updatedAt });
  assert.deepEqual([r.notified, r.linked], [1, 0], "notified; an account is not a note, so no backlink");
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, patchesBefore, "no links write to the vault");
  const items = (await inbox(CAL)).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.type, "mention");
  assert.deepEqual(items[0]!.anchor, { mention: "m2" });
  assert.equal(JSON.stringify(items).includes(BOB), false);
  // The same chip again: no second notification.
  r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: html("m2"), next: html("m2"), authors: [BOB], updatedAt: null });
  assert.equal(r.notified, 0);
  // A guest author (edit on this page only) cannot ping members by account, nor can a made-up id.
  grantUser(EVE, "note", "doc", "edit");
  r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>x</p>", next: `<p>${chip("person", writerIdFor(ADA), "m3")}${chip("person", "u_0000000000000000", "m4")}</p>`, authors: [EVE], updatedAt: null });
  assert.equal(r.notified, 0);
  assert.equal((await inbox(ADA)).items.length, 0);
  // Never the author themselves.
  r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>x</p>", next: `<p>${chip("person", writerIdFor(BOB), "m5")}</p>`, authors: [BOB], updatedAt: null });
  assert.equal(r.notified, 0);
});

// ── review M2: accepted vs declined is read from DECODED text, and never guessed ──
test("M2: entity-encoded text is still recognised as accepted; ambiguous text gets a neutral notification", async () => {
  const ada = documentActorId(`user:${ADA}`);
  // Accepted insertion whose text needs HTML escaping.
  let prev = `<p>Our ${sug("insert", "e1", ada, "R&amp;D plan &lt;v2&gt;")} is ready.</p>`;
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next: "<p>Our R&amp;D plan &lt;v2&gt; is ready.</p>", editors: [BOB] }), 1);
  // Declined insertion of a word that exists elsewhere on the page: we cannot tell → neutral.
  prev = `<p>Read the notes ${sug("insert", "e2", ada, "the")} carefully, then the plan.</p>`;
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next: "<p>Read the notes carefully, then the plan.</p>", editors: [BOB] }), 1);
  // A short insertion (too little to match on) → neutral, even when unique.
  prev = `<p>Alpha ${sug("insert", "e3", ada, "zq")} beta</p>`;
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next: "<p>Alpha beta</p>", editors: [BOB] }), 1);
  // A unique, long-enough declined insertion is still "declined"; an accepted deletion is "accepted".
  prev = `<p>Keep ${sug("insert", "e4", ada, "this sentence out")} and ${sug("delete", "e5", ada, "remove these words")} here.</p>`;
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next: "<p>Keep  and  here.</p>", editors: [BOB] }), 2);
  // A replacement whose two halves disagree (new text gone AND old text gone) → neutral.
  prev = `<p>${sug("delete", "e6", ada, "old wording here")}${sug("insert", "e6", ada, "new wording here")}</p>`;
  assert.equal(await suggestionsResolved({ vaultId: "primary", noteId: "doc", prev, next: "<p>rewritten entirely</p>", editors: [BOB] }), 1);
  const byPreview = new Map((await inbox(ADA)).items.map((i) => [String(i.preview), String(i.type)]));
  assert.equal(byPreview.get("R&D plan <v2>"), "suggestion_accepted");
  assert.equal(byPreview.get("the"), "suggestion_resolved");
  assert.equal(byPreview.get("zq"), "suggestion_resolved");
  assert.equal(byPreview.get("this sentence out"), "suggestion_rejected");
  assert.equal(byPreview.get("remove these words"), "suggestion_accepted");
  assert.equal(byPreview.get("new wording here"), "suggestion_resolved");
  assert.equal((await inbox(ADA, "?type=comment")).items.length, 6);
});

test("review low 5: a guest cannot piggyback on a member co-editor to ping members by account", async () => {
  resetDatabaseCachesForTests();
  setAccount(CAL, "Cal Newport", "scrypt$fixture");
  for (const e of [ADA, BOB, CAL]) setMembership("primary", e, "member", OWNER);
  grantUser(CAL, "tag", "team", "view");
  grantUser(EVE, "note", "doc", "edit"); // a guest editing this one page
  clearNoteInfoCache();
  const html = (uid: string) => `<p>${chip("person", writerIdFor(CAL), uid, ' data-label="Cal Newport"')}</p>`;
  // Guest + member in one batch: the chip may be the guest's — nobody is notified.
  let r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>x</p>", next: html("g1"), authors: [EVE, BOB], updatedAt: null });
  assert.equal(r.notified, 0);
  assert.equal((await inbox(CAL)).items.length, 0);
  // Members only: delivered.
  r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>x</p>", next: html("g2"), authors: [ADA, BOB], updatedAt: null });
  assert.equal(r.notified, 1);
  // No author at all (server-internal store): nothing.
  r = await noteContentStored({ vaultId: "primary", noteId: "doc", prev: "<p>x</p>", next: html("g3"), authors: [], updatedAt: null });
  assert.equal(r.notified, 0);
});
