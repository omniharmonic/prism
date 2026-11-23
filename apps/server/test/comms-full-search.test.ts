// Task 4 (Comms full search): FTS5 over projected messages + vault transcripts, incremental and
// resumable history indexing, injection-safe queries, ranking, highlights, paging, Photos/Links.
// Synthetic fixtures only.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { appendEvent, ensureSingleThread, putWindow, upsertConversation, type ConversationRow } from "../src/comms/store";
import { ftsQuery, indexLiveMessages, listMedia, parseMarked, pruneMedia, searchMessages, historyStatus } from "../src/comms/search-index";
import { indexBatch, noteChanged, parseTranscript, syncSources, REINDEX_MIN_MS, type HistorySource } from "../src/comms/search-vault";
import { fromPlainText } from "../src/comms/richtext";
import type { Message } from "../src/comms/types";
import type { Note } from "../src/parachute";
import type { TreeRow } from "../src/tree";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const saved = { comms: process.env.COMMS_ENABLED, search: process.env.COMMS_SEARCH_ENABLED };
beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; process.env.COMMS_SEARCH_ENABLED = "true"; });
afterEach(() => {
  for (const [k, v] of [["COMMS_ENABLED", saved.comms], ["COMMS_SEARCH_ENABLED", saved.search]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const NOW = Date.UTC(2026, 10, 22, 12, 0);
const DAY = 86_400_000;

function conv(id: string, title: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title, titleSource: "contact", avatar: null,
    lastEventAt: new Date(NOW).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
    pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}

let seq = 0;
function msg(threadId: string, text: string, at: number, over: Partial<Message> = {}): Message {
  const id = over.source?.eventId ?? `$e${++seq}`;
  return {
    id, threadId, channel: { network: "whatsapp", accountLabel: null }, source: { network: "whatsapp", eventId: id, ref: id },
    sender: { id: "@whatsapp_15550001111:hs", name: "Ann Lee", avatar: null, isSelf: false, isOmni: false },
    sentAt: new Date(at).toISOString(), body: fromPlainText(text), attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false,
    ...over,
  };
}

const texts = async (q: string, f = {}) => (await searchMessages(q, f, 0, 50, NOW))!.hits.map((h) => h.text);

// ── indexing projected messages ──────────────────────────────────────────────

test("projected messages are indexed as they arrive; an edit replaces, a deletion removes", async () => {
  const th = conv("c1", "Ann Lee");
  putWindow(th, [msg(th, "Lunch at the café on Friday?", NOW - DAY, { source: { network: "whatsapp", eventId: "$a", ref: "$a" } })]);
  assert.deepEqual(await texts("cafe"), ["Lunch at the café on Friday?"], "diacritics folded");
  appendEvent("message.updated", th, { threadId: th, message: msg(th, "Dinner at the café on Saturday?", NOW - DAY, { source: { network: "whatsapp", eventId: "$a", ref: "$a" } }) });
  assert.deepEqual(await texts("lunch"), []);
  assert.deepEqual(await texts("saturday"), ["Dinner at the café on Saturday?"]);
  appendEvent("message.deleted", th, { threadId: th, message: msg(th, "", NOW - DAY, { redacted: true, source: { network: "whatsapp", eventId: "$a", ref: "$a" } }) });
  assert.deepEqual(await texts("saturday"), []);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM comms_search_fts`).get() as { n: number }).n, 0, "no FTS row left behind");
});

test("flag off: nothing is indexed and the routes answer 404 search_disabled", async () => {
  delete process.env.COMMS_SEARCH_ENABLED;
  const th = conv("c1", "Ann");
  putWindow(th, [msg(th, "secret plans", NOW)]);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM comms_search_rows`).get() as { n: number }).n, 0);
  const app = createApp();
  const cookie = sessionCookie(makeSession("owner@test.local"));
  const r = await app.request("/api/comms/search?q=plans", { headers: { cookie } });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "search_disabled");
});

// ── the vault history ────────────────────────────────────────────────────────

function fakeSource(notes: Map<string, Partial<Note> & { id: string; tags: string[] }>): HistorySource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async list(tag) {
      return [...notes.values()].filter((n) => n.tags.includes(tag)).map((n) => ({ id: n.id, path: n.path ?? null, updatedAt: n.updatedAt ?? null, tags: n.tags }));
    },
    async read(id) {
      reads.push(id);
      const n = notes.get(id);
      if (!n) throw Object.assign(new Error("gone"), { status: 404 });
      return { id, content: n.content ?? "", updatedAt: n.updatedAt ?? null, path: n.path ?? null };
    },
  };
}

const transcript = (title: string, lines: string[]) => `# ${title} — whatsapp\n\n${lines.join("\n")}`;

test("transcripts parse into dated entries with continuation lines; unknown stamps are skipped", () => {
  const e = parseTranscript(transcript("Ann", ["[2019-03-04 10:15] Ann Lee: first line", "second line", "[unknown] Ann Lee: lost", "[2019-03-04 10:16] Me: reply"]), new Set(["me"]));
  assert.equal(e.length, 2);
  assert.equal(e[0]!.body, "first line\nsecond line");
  assert.equal(e[0]!.sentAt, Date.UTC(2019, 2, 4, 10, 15));
  assert.equal(e[1]!.fromSelf, true);
});

test("history: incremental, bounded batches; resumable; unchanged notes are never re-read; archives map to their thread", async () => {
  const notes = new Map<string, Partial<Note> & { id: string; tags: string[] }>();
  for (let i = 0; i < 12; i++) {
    notes.set(`n${i}`, { id: `n${i}`, path: `vault/messages/whatsapp/t${i}`, tags: ["message-thread"], updatedAt: `2026-01-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
      content: transcript(`T${i}`, [`[2018-05-0${(i % 9) + 1} 09:00] Pat: zebra number ${i}`]) });
  }
  notes.set("a0", { id: "a0", path: "vault/messages/whatsapp/t0/archive/001", tags: ["message-archive"], updatedAt: "2026-01-01T00:00:00.000Z",
    content: transcript("T0", ["[2012-01-01 08:00] Pat: ancient aardvark"]) });
  const src = fakeSource(notes);
  const s = await syncSources(src);
  assert.deepEqual(s, { notes: 13, pending: 13, dropped: 0 });
  assert.equal(await indexBatch(src, 5), 5, "a batch reads at most n notes");
  assert.equal(src.reads.length, 5);
  assert.equal(historyStatus().pending, 8, "the rest waits in SQLite (resumable after a restart)");
  while (await indexBatch(src, 5)) { /* drain */ }
  assert.equal(src.reads.length, 13, "every note read exactly once");
  assert.equal(historyStatus().pending, 0);
  // The thread exists in Comms: transcript rows resolve to it.
  const th = conv("c0", "T0", { vaultNoteId: "n0" });
  const hits = (await searchMessages("aardvark", {}, 0, 10, NOW))!.hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.threadId, th, "an archive's lines belong to its thread");
  assert.equal(hits[0]!.origin, "history");
  // A rows for a thread no Comms conversation projects are not returned (nothing to open).
  assert.equal((await searchMessages("zebra", {}, 0, 50, NOW))!.hits.length, 1);
  // Re-sync: nothing changed → nothing pending, nothing read.
  assert.equal((await syncSources(src)).pending, 0);
  assert.equal(await indexBatch(src, 5), 0);
  // One note changes → only that one is re-read and its rows replaced.
  notes.get("n0")!.content = transcript("T0", ["[2018-05-01 09:00] Pat: zebra replaced by yak"]);
  notes.get("n0")!.updatedAt = "2026-02-01T00:00:00.000Z";
  assert.equal((await syncSources(src)).pending, 1);
  assert.equal(await indexBatch(src, 5), 0, "indexed minutes ago: waits for the re-index interval (live rows cover it)");
  await indexBatch(src, 5, new Set(), Date.now() + REINDEX_MIN_MS + 1);
  assert.equal(src.reads.length, 14);
  assert.deepEqual((await texts("yak")).length, 1);
  assert.equal((await searchMessages("zebra", { threadId: th }, 0, 10, NOW))!.hits[0]?.text.includes("yak"), true);
  // A deleted note's rows go.
  notes.delete("a0");
  assert.equal((await syncSources(src)).dropped, 1);
  assert.equal((await texts("aardvark")).length, 0);
});

test("history: a tree change marks one note pending without a read; a failing vault stops the batch and retries", async () => {
  const notes = new Map<string, Partial<Note> & { id: string; tags: string[] }>([
    ["n1", { id: "n1", path: "p/1", tags: ["message-thread"], updatedAt: "2026-01-01T00:00:00.000Z", content: transcript("A", ["[2020-01-01 00:00] A: hello walrus"]) }],
  ]);
  const src = fakeSource(notes);
  await syncSources(src);
  await indexBatch(src);
  const row = { id: "n1", path: "p/1", tags: ["message-thread"], updatedAt: "2026-03-01T00:00:00.000Z", creator: null, visibility: "workspace" } as TreeRow;
  assert.equal(noteChanged({ kind: "upsert", row, prev: undefined }), true);
  assert.equal(src.reads.length, 1, "no read on the change itself");
  const failing: HistorySource = { list: src.list, read: async () => { throw Object.assign(new Error("down"), { status: 503 }); } };
  const later = Date.now() + REINDEX_MIN_MS + 1;
  assert.equal(await indexBatch(failing, 5, new Set(), later), 1);
  assert.equal(historyStatus().pending, 1, "still pending after one failure");
  notes.get("n1")!.content = transcript("A", ["[2020-01-01 00:00] A: hello narwhal"]);
  notes.get("n1")!.updatedAt = "2026-03-01T00:00:00.000Z";
  await indexBatch(src, 5, new Set(), later);
  conv("c1", "A", { vaultNoteId: "n1" });
  assert.equal((await texts("narwhal")).length, 1);
  assert.equal((await texts("walrus")).length, 0);
});

test("a message seen live AND in the transcript is one result (live wins)", async () => {
  const th = conv("c1", "Ann", { vaultNoteId: "n1" });
  const at = Date.UTC(2026, 10, 20, 9, 30, 12);
  putWindow(th, [msg(th, "see you at the pier", at)]);
  const src = fakeSource(new Map([["n1", { id: "n1", path: "p", tags: ["message-thread"], updatedAt: "2026-11-20T10:00:00.000Z",
    content: transcript("Ann", ["[2026-11-20 09:30] Ann Lee: see you at the pier", "[2026-11-19 08:00] Ann Lee: older pier talk"]) }]]));
  await syncSources(src);
  await indexBatch(src);
  const hits = (await searchMessages("pier", {}, 0, 10, NOW))!.hits;
  assert.equal(hits.length, 2);
  assert.equal(hits.find((h) => h.text === "see you at the pier")?.origin, "live");
});

// ── queries ──────────────────────────────────────────────────────────────────

test("query injection: FTS5 syntax is never passed through", async () => {
  const th = conv("c1", "Ann");
  putWindow(th, [msg(th, "alpha beta OR gamma", NOW)]);
  // Each chunk is one quoted FTS5 string ("" doubled): no syntax inside, the table's tokenizer splits it.
  assert.equal(ftsQuery(`he said "hi" OR NEAR(a b) col:x* ^start -minus`), `"he" "said" """hi""" "OR" "NEAR(a" "b)" "col:x*" "^start"`);
  assert.equal(ftsQuery("b"), `"b"`, "a one-letter word is not a prefix (it would match most of the index)");
  assert.equal(ftsQuery("  ** \"\" () :: "), null);
  assert.equal(ftsQuery("beta "), `"beta"`, "a trailing separator ends the prefix");
  assert.equal(ftsQuery("bet"), `"bet"*`);
  for (const q of [`"`, `*`, `)`, `NEAR(`, `alpha OR`, `a AND NOT b`, `{col}: x`, `'; DROP TABLE comms_search_rows; --`, "\u0000", "e".repeat(5000)]) {
    await assert.doesNotReject(async () => { await searchMessages(q, {}, 0, 10, NOW); }, q);
  }
  assert.deepEqual(await texts("OR gamma"), ["alpha beta OR gamma"], "OR is a word, not an operator");
  assert.deepEqual(await texts("alpha NOT"), [], "NOT is a word that must be present");
  assert.ok(db.prepare(`SELECT 1 FROM comms_search_rows`).get(), "table intact");
});

test("ranking blends relevance with recency; highlights are UTF-16 ranges", async () => {
  const th = conv("c1", "Ann");
  putWindow(th, [
    msg(th, "budget", NOW - 3 * 365 * DAY),
    msg(th, "the budget draft and more words around it to dilute the match a little", NOW - DAY),
    msg(th, "😀 budget 😀 budget", NOW - 400 * DAY),
  ]);
  const hits = (await searchMessages("budget", {}, 0, 10, NOW))!.hits;
  assert.equal(hits[0]!.text.startsWith("the budget draft"), true, "yesterday's message first");
  const emoji = hits.find((h) => h.text.startsWith("😀"))!;
  assert.deepEqual(emoji.highlights, [{ start: 3, length: 6 }, { start: 13, length: 6 }]);
  assert.equal(emoji.text.slice(3, 9), "budget");
  assert.deepEqual(parseMarked("abc"), { text: "abc", highlights: [{ start: 1, length: 1 }] });
});

test("paging: a stable cursor, bound to its query; filters by thread / person / sender", async () => {
  const a = conv("c1", "Ann");
  const b = conv("c2", "Bob");
  db.prepare(`UPDATE comms_threads SET person_id = 'p_bob' WHERE id = ?`).run(b);
  putWindow(a, Array.from({ length: 45 }, (_, i) => msg(a, `kayak trip ${i}`, NOW - i * 60_000)));
  putWindow(b, [msg(b, "kayak from bob", NOW, { sender: { id: "@me:hs", name: "Me", avatar: null, isSelf: true, isOmni: false } })]);
  const app = createApp();
  const cookie = sessionCookie(makeSession("owner@test.local"));
  const get = async (qs: string) => app.request(`/api/comms/search?${qs}`, { headers: { cookie } });
  const p1 = await (await get("q=kayak&limit=20")).json();
  assert.equal(p1.messages.length, 20);
  assert.ok(p1.next);
  assert.ok(Array.isArray(p1.suggestions.threads), "first page carries suggestions");
  assert.ok(p1.threads.some((t: { id: string }) => t.id === a), "the result threads ride along");
  const p2 = await (await get(`q=kayak&limit=20&cursor=${p1.next}`)).json();
  const p3 = await (await get(`q=kayak&limit=20&cursor=${p2.next}`)).json();
  const ids = [...p1.messages, ...p2.messages, ...p3.messages].map((m: { id: string }) => m.id);
  assert.equal(ids.length, 46);
  assert.equal(new Set(ids).size, 46, "no repeats across pages");
  assert.equal(p3.next, null);
  assert.equal(p2.suggestions, undefined);
  assert.equal((await get(`q=other&cursor=${p1.next}`)).status, 400, "a cursor of another query is refused");
  assert.equal((await get(`q=kayak&cursor=%22bad`)).status, 400);
  assert.equal((await get(`q=kayak&limit=99`)).status, 400);
  assert.equal((await (await get(`q=kayak&thread=${b}`)).json()).messages.length, 1);
  assert.equal((await (await get(`q=kayak&person=p_bob`)).json()).messages.length, 1);
  assert.equal((await (await get(`q=kayak&from=me`)).json()).messages[0].sender.isSelf, true);
  assert.equal((await get(`q=kayak&from=x`)).status, 400);
  assert.equal((await get(`q=`)).status, 400);
});

test("Photos and Links: last ~90 days, newest first, keyset paging; media tokens, never mxc", async () => {
  const th = conv("c1", "Ann");
  putWindow(th, [
    msg(th, "", NOW - DAY, { attachments: [{ kind: "image", mxc: "mxc://hs/abc", name: "beach.jpg", w: 10, h: 10 }] }),
    msg(th, "", NOW - 100 * DAY, { attachments: [{ kind: "image", mxc: "mxc://hs/old", name: "old.jpg" }] }),
    msg(th, "read https://example.test/a) and https://example.test/b.", NOW - 2 * DAY, {
      linkPreviews: [{ url: "https://example.test/a", title: "Article A" }],
    }),
  ], );
  // putWindow indexes with Date.now(); re-index against the test clock for the 90-day rule.
  indexLiveMessages(th, [
    msg(th, "", NOW - DAY, { source: { network: "whatsapp", eventId: "$p1", ref: "$p1" }, attachments: [{ kind: "image", mxc: "mxc://hs/abc", name: "beach.jpg" }] }),
    msg(th, "", NOW - 100 * DAY, { source: { network: "whatsapp", eventId: "$p2", ref: "$p2" }, attachments: [{ kind: "image", mxc: "mxc://hs/old", name: "old.jpg" }] }),
  ], NOW);
  const photos = listMedia("photo", { limit: 10, now: NOW });
  assert.ok(photos.items.every((p) => Date.parse(p.sentAt) >= NOW - 90 * DAY));
  assert.ok(photos.items.some((p) => p.attachment?.name === "beach.jpg"));
  const links = listMedia("link", { limit: 1, now: NOW });
  assert.equal(links.items.length, 1);
  const more = listMedia("link", { limit: 10, now: NOW, after: links.next });
  assert.deepEqual([...links.items, ...more.items].map((l) => l.link!.url).sort(), ["https://example.test/a", "https://example.test/b"]);
  assert.equal(listMedia("link", { q: "article", limit: 10, now: NOW }).items.length, 1);
  const app = createApp();
  const cookie = sessionCookie(makeSession("owner@test.local"));
  const r = await (await app.request(`/api/comms/search/media?kind=photos`, { headers: { cookie } })).json();
  assert.ok(r.items.length >= 1);
  assert.equal(JSON.stringify(r).includes("mxc://"), false, "no mxc leaves the server");
  assert.ok(r.items[0].attachment.thumbToken);
  assert.equal((await app.request(`/api/comms/search/media?kind=videos`, { headers: { cookie } })).status, 400);
  pruneMedia(NOW + 200 * DAY, true);
  assert.equal(listMedia("photo", { limit: 10, now: NOW }).items.length, 0, "pruned after 90 days");
});

test("perf: one search over 50 000 indexed messages stays bounded (CPU, not wall clock)", async () => {
  const { threadCpuMs } = await import("./probe");
  const th = conv("c1", "Ann");
  const words = ["river", "stone", "lamp", "orbit", "maple", "cedar", "quartz", "harbor"];
  db.transaction(() => {
    for (let i = 0; i < 50; i++) {
      putWindow(th, Array.from({ length: 1000 }, (_, j) => msg(th, `${words[(i + j) % 8]} ${words[(i * j) % 8]} note ${i}-${j}`, NOW - (i * 1000 + j) * 60_000)));
    }
  })();
  const cpu: number[] = [];
  for (const q of ["river", "stone lamp", "note 3", "orb", "zzz"]) {
    const t0 = threadCpuMs();
    await searchMessages(q, {}, 0, 30, NOW);
    cpu.push(threadCpuMs() - t0);
  }
  console.log(`search CPU ms: ${cpu.map((n) => n.toFixed(0)).join(", ")}`);
  assert.ok(Math.max(...cpu) < 2_000, `search CPU ${cpu.join(", ")} ms`);
});
