// S4 (phase 2b): thread search — title OR preview, case/diacritic-folded, fast on a realistic list.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, migrateCommsSearch } from "../src/db";
import { ensureSingleThread, listThreads, upsertConversation, type ConversationRow } from "../src/comms/store";
import { foldSearch, likePattern } from "../src/comms/search-text";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { cpuOf } from "./probe";

const prev = process.env.COMMS_ENABLED;
beforeEach(() => { resetDb(); process.env.COMMS_ENABLED = "true"; });
afterEach(() => { if (prev === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prev; });

function conv(id: string, title: string, preview: string | null, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title, titleSource: "contact", avatar: null,
    lastEventAt: new Date(Date.UTC(2026, 10, 1) + Number.parseInt(id.replace(/\D/g, "") || "0", 10) * 60_000).toISOString(),
    lastPreview: preview === null ? null : { text: preview, senderName: null, isSelf: false, sentAt: "2026-11-01T00:00:00.000Z" },
    unreadCount: 0, unreadTrusted: false, folder: "inbox", pinned: false, muted: false, archived: false, triage: null,
    accountLabel: null, capabilities: null, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}
const ids = (q: string, folder?: "inbox") => listThreads({ q, limit: 50, ...(folder ? { folder } : {}) }).threads.map((t) => t.id).sort();

test("folding: case, diacritics and whitespace", () => {
  assert.equal(foldSearch("  José  ÅNGSTRÖM\nçà "), "jose angstrom ca");
  assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
  assert.equal(likePattern("   "), null);
});

test("q matches the title OR the last-message preview, diacritic-insensitive; LIKE wildcards are literal", () => {
  conv("c1", "José Álvarez", "see you at the café");
  conv("c2", "Book club", "Dana: chapter 4 tonight?");
  conv("c3", "Eli", "100% done");
  conv("c4", "Fox", "100 percent");
  assert.deepEqual(ids("jose"), ["th_c1"]);
  assert.deepEqual(ids("CAFE"), ["th_c1"]);
  assert.deepEqual(ids("chapter"), ["th_c2"]);
  assert.deepEqual(ids("dana"), ["th_c2"], "a group preview's sender prefix is searchable");
  assert.deepEqual(ids("100%"), ["th_c3"]);
  assert.deepEqual(ids("_"), []);
  assert.equal(ids("").length, 4, "an empty q is no filter");
});

test("the stored search text follows the row (re-projection with a new title / preview)", () => {
  conv("c1", "Old name", "first");
  assert.deepEqual(ids("old"), ["th_c1"]);
  conv("c1", "New name", "second");
  assert.deepEqual(ids("old"), []);
  assert.deepEqual(ids("second"), ["th_c1"]);
});

test("migration: an old table gains search_text and existing rows are backfilled", () => {
  const old = new Database(":memory:");
  old.exec(`CREATE TABLE comms_conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, last_preview_json TEXT)`);
  old.prepare(`INSERT INTO comms_conversations VALUES ('a', 'Zoë', '{"text":"Crème brûlée"}'), ('b', 'Bob', '{oops')`).run();
  migrateCommsSearch(old as unknown as typeof db);
  migrateCommsSearch(old as unknown as typeof db); // idempotent
  const rows = old.prepare(`SELECT id, search_text FROM comms_conversations ORDER BY id`).all();
  assert.deepEqual(rows, [{ id: "a", search_text: "zoe creme brulee" }, { id: "b", search_text: "bob" }]);
});

test("perf: q over 6 000 threads — p95 under 100 ms of CPU per search (bounded page)", async () => {
  // CPU time of THIS thread (test/probe.ts), never the wall clock: a busy machine cannot fail it.
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
  db.transaction(() => {
    for (let i = 0; i < 6_000; i++) {
      const w = (k: number) => words[(i * 7 + k * 3) % words.length]!;
      conv(`c${i}`, `${w(0)} ${w(1)} ${i}`, `${w(2)}: message number ${i} about ${w(3)} café`, { folder: i % 5 === 0 ? "archived" : "inbox", pinned: i % 500 === 0 });
    }
  })();
  const queries = ["a", "al", "alp", "alpha", "bravo char", "message", "cafe", "4321", "zzz", "number 59", "e", "lima", "kilo", "x"];
  const cpu: number[] = [];
  for (let round = 0; round < 4; round++) {
    for (const q of queries) {
      for (const folder of ["inbox", undefined] as const) {
        const { value, cpuMs } = cpuOf(() => listThreads({ q, limit: 30, ...(folder ? { folder } : {}) }));
        assert.ok(value.threads.length <= 30);
        cpu.push(cpuMs);
      }
    }
  }
  cpu.sort((a, b) => a - b);
  const p95 = cpu[Math.floor(cpu.length * 0.95)]!;
  console.log(`[perf] listThreads q over 6000 threads: CPU p50 ${cpu[Math.floor(cpu.length / 2)]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  assert.ok(p95 < 100, `p95 ${p95.toFixed(1)} ms CPU`);
  // The route answers the same search (bounded page), and the folded preview matches across the set.
  const r = await createApp().request(`/api/comms/threads?q=caf%C3%A9&limit=30`, { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { threads: unknown[] }).threads.length, 30);
  assert.equal(listThreads({ q: "number 5999", limit: 5, folder: "inbox" }).threads.length, 1);
});
