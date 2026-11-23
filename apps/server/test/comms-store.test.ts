import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./helpers";
import {
  upsertConversation, ensureSingleThread, listThreads, getThread, putWindow, readWindow,
  appendEvent, eventsAfter, pruneEvents, setOverride, InvalidCursorError, type ConversationRow,
} from "../src/comms/store";
import type { Message } from "../src/comms/types";

beforeEach(() => resetDb());

const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
function conv(id: string, over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id, network: "telegram", sourceRef: `!${id}:hs`, kind: "dm", title: `Title ${id}`, titleSource: "room",
    avatar: null, lastEventAt: at(1), lastPreview: null, unreadCount: 0, unreadTrusted: true,
    folder: "inbox", pinned: false, muted: false, archived: false, triage: null, accountLabel: null,
    capabilities: null, vaultNoteId: null, ...over,
  };
}
function add(id: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation(conv(id, over));
  return ensureSingleThread(id);
}
function msg(threadId: string, n: number): Message {
  return {
    id: `m${n}`, threadId, channel: { network: "telegram", accountLabel: null },
    source: { network: "telegram", eventId: `$e${n}`, ref: `$e${n}` },
    sender: { id: "u", name: "U", avatar: null, isSelf: false, isOmni: false },
    sentAt: at(n), body: null, attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false,
  };
}

test("listThreads orders pinned first then lastActivityAt desc", () => {
  add("a", { lastEventAt: at(1) });
  add("b", { lastEventAt: at(3) });
  add("c", { lastEventAt: at(2), pinned: true });
  add("d", { lastEventAt: at(0), pinned: true });
  const { threads, next } = listThreads({ limit: 10 });
  assert.deepEqual(threads.map((t) => t.title), ["Title c", "Title d", "Title b", "Title a"]);
  assert.equal(next, null);
  assert.equal(threads[0]?.pinned, true);
  assert.equal(getThread(threads[0].id)?.title, "Title c");
  assert.equal(getThread("nope"), null);
});

test("cursor paging is stable under inserts", () => {
  for (let i = 0; i < 120; i++) add(`r${String(i).padStart(3, "0")}`, { lastEventAt: at(i) });
  const p1 = listThreads({ limit: 50 });
  assert.equal(p1.threads.length, 50);
  assert.ok(p1.next);
  add("newer", { lastEventAt: at(500) });
  const p2 = listThreads({ limit: 50, cursor: p1.next! });
  const p3 = listThreads({ limit: 50, cursor: p2.next! });
  assert.equal(p3.next, null);
  const ids = [...p1.threads, ...p2.threads, ...p3.threads].map((t) => t.id);
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, 120);
  assert.ok(!p2.threads.some((t) => t.title === "Title newer"));
});

test("invalid cursors are rejected", () => {
  add("a");
  for (const c of ["!!!", Buffer.from("nonsense").toString("base64url"), Buffer.from('["x",1]').toString("base64url")]) {
    assert.throws(() => listThreads({ limit: 5, cursor: c }), InvalidCursorError);
  }
});

test("filters", () => {
  add("a", { unreadCount: 2, network: "telegram", title: "Sam Rivera" });
  add("b", { network: "whatsapp", title: "Family" });
  add("c", { network: "telegram", folder: "archived", title: "Old chat" });
  add("d", { network: "email", archived: true, title: "100% off_sale" });
  const titles = (q: Parameters<typeof listThreads>[0]) => listThreads(q).threads.map((t) => t.title).sort();
  assert.deepEqual(titles({ limit: 10, unread: true }), ["Sam Rivera"]);
  assert.deepEqual(titles({ limit: 10, networks: ["telegram"] }), ["Old chat", "Sam Rivera"]);
  assert.deepEqual(titles({ limit: 10, folder: "archived" }), ["100% off_sale", "Old chat"]);
  assert.deepEqual(titles({ limit: 10, folder: "inbox" }), ["Family", "Sam Rivera"]);
  assert.deepEqual(titles({ limit: 10, q: "sAm riv" }), ["Sam Rivera"]);
  assert.deepEqual(titles({ limit: 10, q: "%" }), ["100% off_sale"]);
  assert.deepEqual(titles({ limit: 10, q: "_" }), ["100% off_sale"]);
});

test("window keeps newest 200", () => {
  const t = add("w");
  putWindow(t, Array.from({ length: 250 }, (_, i) => msg(t, i)));
  const all = readWindow(t, undefined, 500);
  assert.equal(all.length, 200);
  assert.equal(all[0]?.id, "m50");
  assert.equal(all[199]?.id, "m249");
  const page = readWindow(t, "m100", 10);
  assert.deepEqual(page.map((m) => m.id), Array.from({ length: 10 }, (_, i) => `m${90 + i}`));
  putWindow(t, [{ ...msg(t, 249), editedAt: at(300) }]);
  assert.equal(readWindow(t, undefined, 1)[0]?.editedAt, at(300));
});

test("events monotonic and retained 7 days", () => {
  const a = appendEvent("thread.updated", "t1", { x: 1 });
  const b = appendEvent("message.created", null, { y: 2 });
  assert.ok(b > a);
  assert.deepEqual(eventsAfter(a, 10), [{ id: b, kind: "message.created", payload: { y: 2 } }]);
  assert.equal(eventsAfter(0, 1).length, 1);
  const DAY = 86_400_000;
  pruneEvents(Date.now() + 6 * DAY);
  assert.equal(eventsAfter(0, 10).length, 2);
  pruneEvents(Date.now() + 8 * DAY);
  assert.equal(eventsAfter(0, 10).length, 0);
  assert.ok(appendEvent("thread.updated", null, {}) > b, "ids never reused");
});

test("override persists through re-upsert", () => {
  const t = add("o", { title: "Before" });
  setOverride(t, { pinned: true, muted: true });
  upsertConversation(conv("o", { title: "After", pinned: false, muted: false }));
  assert.equal(ensureSingleThread("o"), t);
  const got = getThread(t)!;
  assert.equal(got.title, "After");
  assert.equal(got.pinned, true);
  assert.equal(got.muted, true);
  setOverride(t, { archived: true });
  assert.equal(getThread(t)!.folder, "archived");
  setOverride(t, { folder: "low" });
  assert.equal(getThread(t)!.folder, "low");
  assert.equal(getThread(t)!.pinned, true);
});

test("a corrupt stored row never breaks listThreads / readWindow / eventsAfter for everyone", async () => {
  const { db } = await import("../src/db");
  const good = add("good", { lastEventAt: at(2), avatar: { monogram: "G" } });
  const bad = add("bad", { lastEventAt: at(3) });
  db.prepare(`UPDATE comms_conversations SET avatar_json = '{oops', last_preview_json = 'nope', capabilities_json = '[' WHERE id = 'bad'`).run();
  const list = listThreads({ limit: 10, folder: "inbox" });
  assert.deepEqual(list.threads.map((t) => t.id), [bad, good]);
  const b = list.threads[0]!;
  assert.equal(b.avatar, null);
  assert.equal(b.lastMessage, undefined);
  assert.equal(getThread(bad)!.title, "Title bad");
  putWindow(good, [msg(good, 1), msg(good, 2)]);
  db.prepare(`UPDATE comms_messages SET json = '{broken' WHERE thread_id = ? AND source_event_id = '$e1'`).run(good);
  assert.deepEqual(readWindow(good, undefined, 10).map((m) => m.id), ["m2"]);
  const e1 = appendEvent("thread.updated", good, { threadId: good });
  db.prepare(`UPDATE comms_events SET payload_json = '{x' WHERE id = ?`).run(e1);
  const e2 = appendEvent("thread.updated", good, { threadId: good });
  assert.deepEqual(eventsAfter(e1 - 1, 10).map((e) => [e.id, e.payload]), [[e1, null], [e2, { threadId: good }]]);
});
