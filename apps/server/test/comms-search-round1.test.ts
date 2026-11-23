// Task 4 fix round 1 (review task-4-review.md): one Unicode normalisation for index and query
// (I1), transcript lines indexed by diff (I2), maintained per-conversation counts (I3), bounded
// and yielding searches (I4), undo of a create = compare-and-set trash (I6), and the Minors.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { db, migrateCommsSearchIndex, COMMS_SEARCH_FORMAT } from "../src/db";
import { ensureSingleThread, getThread, putWindow, replaceConversationMembers, upsertConversation, type ConversationRow } from "../src/comms/store";
import {
  ftsQuery, messageCountsFor, normalizeText, purgeSearchIndexIfDisabled, replaceNoteRows, searchLimits, searchMessages, setSearchClockForTests,
} from "../src/comms/search-index";
import { same, tidyForThread } from "../src/comms/tidy";
import { invalidatePeople } from "../src/people-cache";
import { fromPlainText } from "../src/comms/richtext";
import type { Message } from "../src/comms/types";
import { deviceAuth, installFakeVault, resetDb, type FakeVault } from "./helpers";

const saved = { comms: process.env.COMMS_ENABLED, search: process.env.COMMS_SEARCH_ENABLED, tidy: process.env.COMMS_TIDY_ENABLED };
const savedLimits = { ...searchLimits };
let fv: FakeVault | null = null;
beforeEach(() => {
  resetDb();
  invalidatePeople();
  process.env.COMMS_ENABLED = "true";
  process.env.COMMS_SEARCH_ENABLED = "true";
  process.env.COMMS_TIDY_ENABLED = "true";
});
afterEach(() => {
  fv?.restore();
  fv = null;
  Object.assign(searchLimits, savedLimits);
  setSearchClockForTests(null);
  for (const [k, v] of [["COMMS_ENABLED", saved.comms], ["COMMS_SEARCH_ENABLED", saved.search], ["COMMS_TIDY_ENABLED", saved.tidy]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const NOW = Date.UTC(2026, 10, 22, 12, 0);
function conv(id: string, title: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title, titleSource: "contact", avatar: null,
    lastEventAt: new Date(NOW).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
    pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}
let seq = 0;
const msg = (threadId: string, text: string, at = NOW - ++seq * 60_000): Message => {
  const id = `$r${++seq}`;
  return {
    id, threadId, channel: { network: "whatsapp", accountLabel: null }, source: { network: "whatsapp", eventId: id, ref: id },
    sender: { id: "@x:hs", name: "X", avatar: null, isSelf: false, isOmni: false }, sentAt: new Date(at).toISOString(),
    body: fromPlainText(text), attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false,
  };
};
const texts = async (q: string) => (await searchMessages(q, {}, 0, 50, NOW))!.hits.map((h) => h.text);

// ── I1 ───────────────────────────────────────────────────────────────────────

test("I1: Korean, kana, ligatures, full-width, Thai, Devanagari and Latin accents search like they are indexed", async () => {
  const th = conv("c1", "Mixed");
  putWindow(th, [
    msg(th, "한국어 메시지 보냈어요"), msg(th, "ありがとうございます がんばって"), msg(th, "the ﬁnal draft"),
    msg(th, "ＡＢＣ Corp invoice"), msg(th, "สวัสดีครับ"), msg(th, "नमस्ते दुनिया"), msg(th, "Crème brûlée at José's"),
  ]);
  assert.equal((await texts("한국어")).length, 1);
  assert.equal((await texts("메시")).length, 1, "a Hangul prefix");
  assert.equal((await texts("がんばって")).length, 1, "a voiced kana mark is kept on both sides");
  assert.equal((await texts("ありがとうございます")).length, 1);
  assert.equal((await texts("final")).length, 1, "ﬁ ligature");
  assert.equal((await texts("abc")).length, 1, "full-width letters");
  assert.equal((await texts("ＡＢＣ")).length, 1, "full-width in the query too");
  assert.equal((await texts("สวัสดีครับ")).length, 1);
  assert.equal((await texts("नमस्ते")).length, 1);
  assert.equal((await texts("creme brulee jose")).length, 1, "Latin diacritics folded by the tokenizer");
  assert.equal((await texts("CRÈME")).length, 1);
  const k = (await searchMessages("메시지", {}, 0, 5, NOW))!.hits[0]!;
  assert.equal(k.text.slice(k.highlights[0]!.start, k.highlights[0]!.start + k.highlights[0]!.length), "메시지");
  assert.equal(normalizeText("ＡＢＣ ﬁ"), "ABC fi");
});

// ── I2 ───────────────────────────────────────────────────────────────────────

test("I2: a transcript is indexed by diff — an appended line is ONE insert, nothing else is rewritten", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => ({ sentAt: NOW - (1000 - i) * 60_000, sender: "Pat", body: `line ${i} about otters`, fromSelf: false }));
  assert.deepEqual(replaceNoteRows("n1", "n1", lines), { added: 1000, removed: 0 });
  const ids = (db.prepare(`SELECT id FROM comms_search_rows ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  const appended = [...lines, { sentAt: NOW, sender: "Pat", body: "a brand new line", fromSelf: false }];
  assert.deepEqual(replaceNoteRows("n1", "n1", appended), { added: 1, removed: 0 });
  const after = (db.prepare(`SELECT id FROM comms_search_rows ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  assert.deepEqual(after.slice(0, 1000), ids, "every earlier row (and its FTS row) is untouched");
  // A line that disappeared (archived elsewhere) is removed; nothing else changes.
  assert.deepEqual(replaceNoteRows("n1", "n1", appended.slice(1)), { added: 0, removed: 1 });
  // The same words twice in one minute are two messages.
  assert.deepEqual(replaceNoteRows("n2", "n2", [
    { sentAt: NOW, sender: "A", body: "ok", fromSelf: false }, { sentAt: NOW + 5_000, sender: "B", body: "ok", fromSelf: false },
  ]), { added: 2, removed: 0 });
});

// ── I3 ───────────────────────────────────────────────────────────────────────

test("I3: per-conversation counts are maintained by the index itself (no scan per request)", () => {
  const live = conv("c1", "Ann");
  const noted = conv("c2", "Bob", { vaultNoteId: "n2" });
  putWindow(live, [msg(live, "a"), msg(live, "b"), msg(live, "c")]);
  putWindow(noted, [msg(noted, "hello")]);
  replaceNoteRows("n2", "n2", [{ sentAt: NOW - 9e9, sender: "Bob", body: "older one", fromSelf: false }]);
  const truth = (scope: string) => (db.prepare(`SELECT COUNT(*) AS n FROM comms_search_rows WHERE COALESCE(thread_note_id, 't:' || thread_id) = ?`).get(scope) as { n: number }).n;
  const counts = messageCountsFor([`t:${live}`, "n2"]);
  assert.equal(counts.get(`t:${live}`), 3);
  assert.equal(counts.get("n2"), 2);
  assert.equal(truth("n2"), 2);
  replaceNoteRows("n2", "n2", []);
  assert.equal(messageCountsFor(["n2"]).get("n2"), 1, "deletes decrement");
});

test("I3/M1: tidy items read the counts; a spam DM never shows the needs-tidy dot", async () => {
  fv = installFakeVault();
  const th = conv("c1", "Ann");
  replaceConversationMembers("c1", [{ memberId: "@whatsapp_15550001111:hs", personId: null }]);
  putWindow(th, [msg(th, "one"), msg(th, "two")]);
  const r = await tidyForThread("primary", th);
  assert.equal(r?.item.messageCount, 2);
  conv("c9", "Spammer", { folder: "spam" });
  replaceConversationMembers("c9", [{ memberId: "@whatsapp_15550009999:hs", personId: null }]);
  assert.equal(getThread("th_c9")!.needsTidy, undefined, "header dot and Details agree");
  assert.equal(await tidyForThread("primary", "th_c9"), null);
});

// ── I4 ───────────────────────────────────────────────────────────────────────

test("I4: a search reads at most maxCandidates newest matches, in chunks, yielding between them", async () => {
  const th = conv("c1", "Ann");
  putWindow(th, Array.from({ length: 200 }, (_, i) => msg(th, `kayak ${i}`, NOW - i * 60_000)));
  for (let i = 0; i < 4; i++) putWindow(th, Array.from({ length: 200 }, (_, j) => msg(th, `kayak more ${i}-${j}`, NOW - (1000 + i * 200 + j) * 60_000)));
  Object.assign(searchLimits, { chunk: 100, maxCandidates: 300 });
  let turns = 0;
  const ticker = setInterval(() => turns++, 0);
  const r = (await searchMessages("kayak", {}, 0, 500, NOW))!;
  clearInterval(ticker);
  assert.equal(r.hits.length, 300);
  assert.equal(r.partial, true);
  assert.ok(turns >= 1, "the event loop ran between chunks");
  // The time budget: a clock that jumps past it stops after the first chunk.
  Object.assign(searchLimits, { chunk: 100, maxCandidates: 20_000 });
  let t = 0;
  setSearchClockForTests(() => (t += 1_000));
  const b = (await searchMessages("kayak", {}, 0, 500, NOW))!;
  assert.equal(b.hits.length, 100);
  assert.equal(b.partial, true);
  setSearchClockForTests(null);
  const all = (await searchMessages("kayak", {}, 0, 2000, NOW))!;
  assert.equal(all.hits.length, 1000);
  assert.equal(all.partial, false);
  assert.equal(ftsQuery("k"), `"k"`, "no one-letter prefix");
});

// ── M12 + format ─────────────────────────────────────────────────────────────

test("M12: with search off the index is cleared at startup; an older index format is rebuilt", () => {
  const th = conv("c1", "Ann");
  putWindow(th, [msg(th, "secret plans")]);
  assert.equal(purgeSearchIndexIfDisabled(), 0, "on: kept");
  delete process.env.COMMS_SEARCH_ENABLED;
  assert.equal(purgeSearchIndexIfDisabled(), 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM comms_search_fts`).get() as { n: number }).n, 0);
  process.env.COMMS_SEARCH_ENABLED = "true";
  putWindow(th, [msg(th, "again")]);
  db.prepare(`UPDATE comms_search_meta SET value = '1' WHERE key = 'format'`).run();
  migrateCommsSearchIndex(db);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM comms_search_rows`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT value FROM comms_search_meta WHERE key = 'format'`).get() as { value: string }).value, COMMS_SEARCH_FORMAT);
});

// ── M2 ───────────────────────────────────────────────────────────────────────

test("M2: undo's equality ignores object key order", () => {
  assert.equal(same({ channels: { matrix: "a", email: ["x"] } }, { channels: { email: ["x"], matrix: "a" } }), true);
  assert.equal(same({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(same(undefined, null), true);
  assert.equal(same({ a: 1, b: undefined }, { a: 1 }), true);
});

// ── I6 ───────────────────────────────────────────────────────────────────────

async function created(): Promise<{ actionId: string; personId: string; th: string }> {
  fv = installFakeVault();
  const th = conv("c1", "Dana", { network: "imessage" });
  replaceConversationMembers("c1", [{ memberId: "tel:+15550002222", personId: null }]);
  const r = await createApp().request("/api/comms/tidy/create", {
    method: "POST", headers: { ...deviceAuth(), "content-type": "application/json" }, body: JSON.stringify({ threadId: th, name: "Dana Diaz" }),
  });
  const body = await r.json() as { action: { id: string; personId: string } };
  assert.equal(r.status, 200, JSON.stringify(body));
  return { actionId: body.action.id, personId: body.action.personId, th };
}
const undo = async (actionId: string) => {
  const r = await createApp().request("/api/comms/tidy/undo", {
    method: "POST", headers: { ...deviceAuth(), "content-type": "application/json" }, body: JSON.stringify({ actionId }),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

test("I6: undo of an unedited create moves it to Prism's Trash with compare-and-set (never a hard delete)", async () => {
  const c = await created();
  const u = await undo(c.actionId);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const note = fv!.notes.get(c.personId)!;
  assert.ok(note, "the note still exists (restorable)");
  assert.ok(note.tags!.includes("prism-trashed"));
  assert.equal(typeof note.metadata!.prism_trashed_at, "string");
  assert.equal(fv!.calls.some((x) => x.method === "DELETE"), false, "no DELETE");
  const write = fv!.calls.filter((x) => x.method === "PATCH" && x.path.endsWith(`/notes/${c.personId}`)).at(-1)!;
  assert.ok((write.body as { if_updated_at?: string }).if_updated_at, "compare-and-set");
  assert.equal((write.body as { force?: boolean }).force, undefined);
  assert.equal(getThread(c.th)!.needsTidy, true);
});

test("I6: undo of a create is refused after an edit, a tag, a link, or a write that lands in between", async () => {
  for (const change of ["content", "tag", "link", "race"] as const) {
    resetDb();
    fv?.restore();
    const c = await created();
    const n = fv!.notes.get(c.personId)!;
    if (change === "content") fv!.put({ ...n, content: `${n.content}\nMet at the market.` });
    if (change === "tag") fv!.put({ ...n, tags: [...n.tags!, "family"] });
    if (change === "link") fv!.put({ ...n, links: [{ sourceId: "note-x", targetId: n.id, relationship: "mentions" }] });
    if (change === "race") fv!.conflictOnNextWrite = true;
    const u = await undo(c.actionId);
    assert.equal(u.status, 409, `${change}: ${JSON.stringify(u.body)}`);
    assert.equal(u.body.error, change === "race" ? "conflict" : "changed_since", change);
    assert.equal(fv!.notes.get(c.personId)!.tags!.includes("prism-trashed"), false, `${change}: not trashed`);
  }
});
