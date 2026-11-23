// Task 4 (contact tidy-up, D17): People to tidy, link / create / ignore, undo, shape rules, the
// "same person?" queue, and the safety gates. Synthetic fixtures only; the vault is the fake.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { ensureSingleThread, eventBounds, eventsAfter, getThread, putWindow, replaceConversationMembers, upsertConversation, type ConversationRow } from "../src/comms/store";
import { listTidy, memberHandle, memberKey, newPersonMetadata, tidyScore } from "../src/comms/tidy";
import { listRecommendations } from "../src/people-agent-store";
import { invalidatePeople } from "../src/people-cache";
import { shapeViolations, declaredViolations } from "../src/vault-shapes";
import { fromPlainText } from "../src/comms/richtext";
import type { Message } from "../src/comms/types";
import { deviceAuth, installFakeVault, resetDb, type FakeVault } from "./helpers";

const saved = { comms: process.env.COMMS_ENABLED, tidy: process.env.COMMS_TIDY_ENABLED, search: process.env.COMMS_SEARCH_ENABLED };
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  invalidatePeople();
  process.env.COMMS_ENABLED = "true";
  process.env.COMMS_TIDY_ENABLED = "true";
  process.env.COMMS_SEARCH_ENABLED = "true";
  fv = installFakeVault();
});
afterEach(() => {
  fv.restore();
  for (const [k, v] of [["COMMS_ENABLED", saved.comms], ["COMMS_TIDY_ENABLED", saved.tidy], ["COMMS_SEARCH_ENABLED", saved.search]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const NOW = Date.now();
const DAY = 86_400_000;

function dm(id: string, title: string, member: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title, titleSource: "contact", avatar: null,
    lastEventAt: new Date(NOW).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
    pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: null, ...over,
  });
  replaceConversationMembers(id, [{ memberId: member, personId: null }]);
  return ensureSingleThread(id);
}
let seq = 0;
const msg = (threadId: string, text: string): Message => {
  const id = `$m${++seq}`;
  return {
    id, threadId, channel: { network: "whatsapp", accountLabel: null }, source: { network: "whatsapp", eventId: id, ref: id },
    sender: { id: "@x:hs", name: "X", avatar: null, isSelf: false, isOmni: false }, sentAt: new Date(NOW - seq * 1000).toISOString(),
    body: fromPlainText(text), attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false,
  };
};
function person(id: string, name: string, metadata: Record<string, unknown> = {}) {
  return fv.put({ id, path: `vault/people/${name.toLowerCase().replace(/\s+/g, "-")}`, tags: ["person"], content: `# ${name}`, metadata: { type: "person", name, ...metadata } });
}

const app = () => createApp();
async function post(path: string, body: unknown, headers: Record<string, string> = deviceAuth()) {
  const r = await app().request(`/api/comms/tidy/${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, any> };
}
const get = async (path: string) => {
  const r = await app().request(`/api/comms/${path}`, { headers: deviceAuth() });
  return { status: r.status, body: await r.json() as Record<string, any> };
};

// ── pure helpers ─────────────────────────────────────────────────────────────

test("member keys and handles: puppets, phones, emails; never the raw puppet id shown", () => {
  assert.deepEqual(memberKey("@whatsapp_15550001111:hs"), { kind: "matrix", value: "@whatsapp_15550001111:hs" });
  assert.deepEqual(memberKey("tel:+15550001111"), { kind: "phone", value: "15550001111" });
  assert.deepEqual(memberKey("mailto:ann@example.test"), { kind: "email", value: "ann@example.test" });
  assert.equal(memberKey("tel:12"), null);
  assert.deepEqual(memberHandle("@whatsapp_15550001111:hs"), { kind: "phone", value: "+15550001111" });
  assert.deepEqual(memberHandle("@telegram_annlee:hs"), { kind: "username", value: "@annlee" });
  assert.equal(memberHandle("@whatsapp_lid-123456:hs"), null);
  assert.ok(tidyScore(100, NOW, NOW) > tidyScore(5, NOW, NOW));
  assert.ok(tidyScore(5, NOW, NOW) > tidyScore(5, NOW - 365 * DAY, NOW));
});

test("a new person's metadata obeys the vault field shapes (lists are lists, no empty scalars)", () => {
  for (const md of [
    newPersonMetadata("Ann Lee", [{ kind: "matrix", value: "@whatsapp_15550001111:hs" }], "whatsapp"),
    newPersonMetadata("Ann Lee", [{ kind: "phone", value: "15550001111" }], "imessage"),
    newPersonMetadata("Ann Lee", [{ kind: "email", value: "ann@example.test" }], "imessage"),
  ]) {
    assert.deepEqual(shapeViolations(md, "person"), []);
    assert.deepEqual(declaredViolations(md, "person"), []);
    for (const v of Object.values(md)) assert.notEqual(v, "");
  }
  const m = newPersonMetadata("Ann", [{ kind: "matrix", value: "@whatsapp_15550001111:hs" }], "whatsapp");
  assert.deepEqual(m.channels, { matrix: "@whatsapp_15550001111:hs", whatsapp: "@whatsapp_15550001111:hs" });
});

// ── the list ─────────────────────────────────────────────────────────────────

test("People to tidy: unlinked DMs ranked by volume + recency; spam, groups, linked and ignored ones left out", async () => {
  const busy = dm("c1", "Busy Bea", "@whatsapp_15550000001:hs");
  const quiet = dm("c2", "Quiet Quinn", "@whatsapp_15550000002:hs");
  const old = dm("c3", "Old Olga", "@whatsapp_15550000003:hs", { lastEventAt: new Date(NOW - 400 * DAY).toISOString() });
  dm("c4", "Spammy", "@whatsapp_15550000004:hs", { folder: "spam" });
  const linked = dm("c5", "Linked Lee", "@whatsapp_15550000005:hs");
  db.prepare(`UPDATE comms_threads SET person_id = 'p1' WHERE id = ?`).run(linked);
  putWindow(busy, Array.from({ length: 30 }, () => msg(busy, "hello there")));
  putWindow(quiet, [msg(quiet, "hi")]);
  putWindow(old, Array.from({ length: 30 }, () => msg(old, "long ago")));
  person("p_bea", "Busy Bea");
  const r = await listTidy("primary", { offset: 0, limit: 10 });
  assert.deepEqual(r.items.map((i) => i.threadId), [busy, quiet, old]);
  assert.equal(r.items[0]!.messageCount, 30);
  assert.deepEqual(r.items[0]!.handle, { kind: "phone", value: "+15550000001" });
  assert.deepEqual(r.items[0]!.suggestions, [{ personId: "p_bea", name: "Busy Bea", reason: "same-name" }]);
  assert.equal(getThread(busy)!.needsTidy, true);
  assert.equal(getThread(linked)!.needsTidy, undefined);
  const page = await get("tidy?limit=2");
  assert.equal(page.status, 200);
  assert.equal(page.body.people.length, 2);
  assert.ok(page.body.next);
  const page2 = await get(`tidy?limit=2&cursor=${page.body.next}`);
  assert.deepEqual(page2.body.people.map((p: { threadId: string }) => p.threadId), [old]);
  const one = await get(`tidy/threads/${busy}`);
  assert.equal(one.body.needed, true);
  assert.equal((await get(`tidy/threads/${linked}`)).body.needed, false);
});

// ── link + undo ──────────────────────────────────────────────────────────────

test("link writes the handle onto the person (compare-and-set), links the thread, and undo restores the fields", async () => {
  const th = dm("c1", "Ann (WhatsApp)", "@whatsapp_15550001111:hs");
  person("p_ann", "Ann Lee", { channels: { email: ["ann@example.test"] } });
  const r = await post("link", { threadId: th, personId: "p_ann" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action.kind, "link");
  assert.equal(r.body.thread.personId, "p_ann");
  assert.equal(r.body.thread.needsTidy, undefined);
  const note = fv.notes.get("p_ann")!;
  assert.deepEqual(note.metadata!.channels, { email: ["ann@example.test"], matrix: "@whatsapp_15550001111:hs" });
  const write = fv.calls.find((c) => c.method === "PATCH" && c.path.endsWith("/notes/p_ann"))!;
  assert.ok((write.body as { if_updated_at?: string }).if_updated_at, "compare-and-set, never force");
  assert.equal((write.body as { force?: boolean }).force, undefined);
  assert.equal(db.prepare(`SELECT person_id FROM comms_conversation_members WHERE member_id = ?`).pluck().get("@whatsapp_15550001111:hs"), "p_ann");
  const audit = db.prepare(`SELECT target, status FROM action_audit WHERE action = 'comms.tidy.link'`).get() as { target: string; status: string };
  assert.equal(audit.status, "ok");
  assert.ok(!audit.target.includes("15550001111") && !audit.target.includes("Ann"), "ids only in the audit");

  const u = await post("undo", { actionId: r.body.action.id });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.deepEqual(fv.notes.get("p_ann")!.metadata!.channels, { email: ["ann@example.test"] }, "the person note is as it was");
  assert.equal(getThread(th)!.personId, undefined);
  assert.equal(getThread(th)!.needsTidy, true);
  assert.equal((await post("undo", { actionId: r.body.action.id })).body.error, "already_undone");
});

test("undo never overwrites a person edited since the link (409 changed_since)", async () => {
  const th = dm("c1", "Ann", "@whatsapp_15550001111:hs");
  person("p_ann", "Ann Lee");
  const r = await post("link", { threadId: th, personId: "p_ann" });
  const n = fv.notes.get("p_ann")!;
  fv.put({ ...n, metadata: { ...n.metadata, channels: { matrix: "@whatsapp_15550001111:hs", telegram: "@ann" } }, updatedAt: "2026-12-01T00:00:00.000Z" });
  const u = await post("undo", { actionId: r.body.action.id });
  assert.equal(u.status, 409);
  assert.equal(u.body.error, "changed_since");
  assert.equal((fv.notes.get("p_ann")!.metadata!.channels as Record<string, string>).telegram, "@ann");
});

test("a handle another person already holds is never written (409 with who)", async () => {
  const th = dm("c1", "Ann", "@whatsapp_15550001111:hs");
  person("p_ann", "Ann Lee");
  person("p_other", "Someone Else", { phone: "+15550001111" });
  const r = await post("link", { threadId: th, personId: "p_ann" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "claimed_by_another_person");
  assert.equal(r.body.person.id, "p_other");
  assert.equal(fv.calls.some((c) => c.method === "PATCH"), false, "nothing written");
  assert.equal((await post("link", { threadId: th, personId: "p_missing" })).status, 404);
});

// ── create ───────────────────────────────────────────────────────────────────

test("create: refuses silently duplicating a name; allowSimilar creates and files 'same person?' (never merges)", async () => {
  const th = dm("c1", "Ann Lee", "@whatsapp_15550001111:hs");
  person("p_ann", "Ann Lee");
  const refused = await post("create", { threadId: th, name: "Ann Lee" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "similar_people");
  assert.deepEqual(refused.body.people, [{ id: "p_ann", name: "Ann Lee" }]);
  const made = await post("create", { threadId: th, name: "Ann Lee", allowSimilar: true });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.action.personId as string;
  const note = fv.notes.get(id)!;
  assert.equal(note.path, "vault/people/ann-lee-2", "the existing note's path is never adopted");
  assert.deepEqual(note.tags, ["person"]);
  assert.deepEqual(shapeViolations(note.metadata, "person"), []);
  assert.deepEqual(note.metadata, { type: "person", name: "Ann Lee", channels: { matrix: "@whatsapp_15550001111:hs", whatsapp: "@whatsapp_15550001111:hs" } });
  assert.ok(fv.notes.get("p_ann"), "the other person is untouched (no merge)");
  const recs = listRecommendations("primary");
  assert.equal(recs.length, 1);
  assert.deepEqual([...recs[0]!.personIds].sort(), [id, "p_ann"].sort());
  assert.equal(made.body.action.recommendations, 1);
  // Undo: the unchanged note goes to the Trash, the recommendation is closed.
  const u = await post("undo", { actionId: made.body.action.id });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.ok(fv.notes.get(id)!.tags!.includes("prism-trashed"), "to Prism's Trash (restorable), not deleted");
  assert.equal(listRecommendations("primary").length, 0);
  assert.equal(getThread(th)!.needsTidy, true);
});

test("create for an iMessage number stores the phone in E.164; bad names are refused", async () => {
  const th = dm("c1", "+1 555 000 2222", "tel:+15550002222", { network: "imessage" });
  assert.equal((await post("create", { threadId: th, name: "  " })).status, 422);
  assert.equal((await post("create", { threadId: th, name: "+1 555 000 2222" })).body.error, "invalid_name");
  assert.equal((await post("create", { threadId: th, name: "Bo‮b" })).status, 422);
  const made = await post("create", { threadId: th, name: "Dana Diaz" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const note = fv.notes.get(made.body.action.personId)!;
  assert.deepEqual(note.metadata, { type: "person", name: "Dana Diaz", phone: "+15550002222" });
  assert.equal((await post("create", { threadId: th, name: "Dana Diaz" })).body.error, "already_linked");
});

// ── ignore + gates ───────────────────────────────────────────────────────────

test("ignore is local and undoable; groups are refused; agent origin and the flag are gates", async () => {
  const th = dm("c1", "Ann", "@whatsapp_15550001111:hs");
  const ig = await post("ignore", { threadId: th });
  assert.equal(ig.status, 200);
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, 0, "ignore writes nothing to the vault");
  assert.equal(getThread(th)!.needsTidy, undefined);
  assert.equal((await listTidy("primary", { offset: 0, limit: 10 })).items.length, 0);
  await post("undo", { actionId: ig.body.action.id });
  assert.equal(getThread(th)!.needsTidy, true);
  upsertConversation({ id: "g1", network: "whatsapp", sourceRef: "!g1:hs", kind: "group", title: "G", titleSource: "room", avatar: null,
    lastEventAt: new Date(NOW).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false,
    muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: null });
  const g = ensureSingleThread("g1");
  assert.equal((await post("ignore", { threadId: g })).body.error, "not_a_dm");
  // Agent origin (a downgraded device request) is refused before anything happens.
  const agent = await post("ignore", { threadId: th }, { ...deviceAuth(), "x-prism-action-origin": "agent" });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.error, "owner_required");
  // Strict bodies.
  assert.equal((await post("link", { threadId: th, personId: "p", extra: 1 })).status, 422);
  assert.equal((await post("create", { threadId: th, name: "X Y", allowSimilar: "yes" })).status, 422);
  // Flag off: nothing listed, nothing written, no needsTidy on the wire.
  delete process.env.COMMS_TIDY_ENABLED;
  assert.equal((await get("tidy")).status, 404);
  assert.equal((await post("ignore", { threadId: th })).body.error, "tidy_disabled");
  assert.equal(getThread(th)!.needsTidy, undefined);
});

// ── sync across devices (owner-testing round 4) ─────────────────────────────────

test("every tidy decision (link, ignore, undo) is announced on the stream as thread.updated reason tidy", async () => {
  const tidyEvents = (after: number) =>
    eventsAfter(after, 100).filter((e) => e.kind === "thread.updated" && (e.payload as { reason?: string }).reason === "tidy").map((e) => (e.payload as { threadId: string }).threadId);
  const a = dm("c1", "Ann", "@whatsapp_15550001111:hs");
  const b = dm("c2", "Bob", "@whatsapp_15550002222:hs");
  person("p_ann", "Ann Lee");
  let seq = eventBounds().seq;
  const link = await post("link", { threadId: a, personId: "p_ann" });
  assert.equal(link.status, 200);
  assert.ok(tidyEvents(seq).includes(a), "a link tells the other devices");
  seq = eventBounds().seq;
  const ig = await post("ignore", { threadId: b });
  assert.deepEqual(tidyEvents(seq), [b], "an ignore tells the other devices");
  seq = eventBounds().seq;
  await post("undo", { actionId: ig.body.action.id });
  assert.deepEqual(tidyEvents(seq), [b], "an undo too");
  seq = eventBounds().seq;
  await post("undo", { actionId: link.body.action.id });
  assert.ok(tidyEvents(seq).includes(a));
});
