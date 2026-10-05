/**
 * Matrix ingest: no duplicate and no lost message when passes overlap, when a
 * write races another writer, or when a room fails while the cursor moves on.
 *
 *  B1  one pass per vault at a time (`runMatrixOnce` joins a running pass; the
 *      manual route answers 409) + the append is compare-and-set, and a 409 is
 *      resolved by re-reading and dropping what is already in the note.
 *  S2  a room a pass failed on is replayed by the next pass — the window between
 *      the failed pass's cursor and the current one — and given up on loudly.
 *
 * Fakes only: an injected Matrix client and a recording, CAS-enforcing vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MatrixClient, ingestMatrix, reconcileMatrix, type IngestVault, type SyncResult, type RoomBatch } from "../src/worker/matrix";
import { parseThread, ARCHIVE_TAG } from "../src/worker/matrix-rollover";
import * as scheduler from "../src/worker/scheduler";
import { config } from "../src/config";
import { getVaultRegistry, getWorkerCursor, setWorkerCursor } from "../src/db";
import { createApp } from "../src/app";
import { resetDb, installFakeVault, makeSession, sessionCookie } from "./helpers";
import { getSourceHealth, evaluateAlerts, resetSourceHealth } from "../src/worker/health";
import { listActionAudit } from "../src/actions/store";
import type { Note } from "../src/parachute";

// Looked up dynamically so this file loads (and FAILS, rather than not importing)
// against a scheduler without the guard.
const sched = scheduler as unknown as {
  runMatrixOnce: (entry: unknown, deps?: unknown) => Promise<number>;
  matrixPassRunning?: (id: string) => boolean;
  pendingMatrixReplays?: (id: string) => Array<{ roomId: string; since?: string; tries: number }>;
  matrixReconcileRunning?: (id: string) => boolean;
  matrixReconcileSettled?: (id: string) => Promise<void>;
  lostMatrixRooms?: (id: string) => Array<{ roomId: string }>;
};

class VaultStatusError extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
  }
}

function casVault(seed: Note[]) {
  const notes = new Map(seed.map((n) => [n.id, structuredClone(n)]));
  let clock = 100;
  let seq = 0;
  const gets: string[] = [];
  const attempts: Array<{ id: string; ifUpdatedAt?: string }> = [];
  const writes: Array<Record<string, unknown>> = [];
  /** `landed`: the write IS applied and then the call fails (a timeout after the vault committed). */
  const failures: Array<{ op: "update" | "create" | "get"; error: Error; landed?: boolean }> = [];
  /** Runs after the Nth body read of a thread (1-based) — "someone else wrote meanwhile". */
  const afterGet = new Map<number, () => void>();
  const vault: IngestVault = {
    async listNotes(o) {
      const rows = [...notes.values()].filter((n) => (!o.pathPrefix || (n.path ?? "").startsWith(o.pathPrefix)) && (!o.tags?.length || o.tags.every((t) => n.tags?.includes(t))));
      if (o.includeContent) return rows.map((n) => structuredClone(n));
      return rows.map((n) => {
        const { content, ...rest } = structuredClone(n);
        return { ...rest, byteSize: Buffer.byteLength(content, "utf8") } as unknown as Note;
      });
    },
    async getNote(id) {
      const f = failures.findIndex((x) => x.op === "get");
      if (f !== -1) throw failures.splice(f, 1)[0]!.error;
      gets.push(id);
      const n = notes.get(id);
      if (!n) throw new VaultStatusError(404, "GET: 404");
      const copy = structuredClone(n);
      afterGet.get(gets.length)?.();
      return copy;
    },
    async createNote(p) {
      const f = failures.findIndex((x) => x.op === "create");
      if (f !== -1) throw failures.splice(f, 1)[0]!.error;
      if (p.path && [...notes.values()].some((n) => n.path === p.path)) throw new VaultStatusError(409, "POST /notes: 409 path_conflict");
      const n: Note = { id: `c${++seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "t", updatedAt: `u${clock++}` };
      notes.set(n.id, n);
      writes.push({ op: "create", path: p.path });
      return structuredClone(n);
    },
    async updateNote(id, p) {
      attempts.push({ id, ifUpdatedAt: p.ifUpdatedAt });
      const f = failures.findIndex((x) => x.op === "update");
      const fail = f !== -1 ? failures.splice(f, 1)[0]! : null;
      if (fail && !fail.landed) throw fail.error;
      const cur = notes.get(id)!;
      if (p.ifUpdatedAt !== undefined && p.ifUpdatedAt !== cur.updatedAt) throw new VaultStatusError(409, "PATCH: 409 conflict");
      notes.set(id, { ...cur, ...(p.content !== undefined ? { content: p.content } : {}), ...(p.metadata ? { metadata: { ...(cur.metadata ?? {}), ...p.metadata } } : {}), updatedAt: `u${clock++}` });
      writes.push({ op: "update", id });
      if (fail) throw fail.error;
      return structuredClone(notes.get(id)!);
    },
    async removeTags() {},
  };
  /** Another writer: appends `lines` and bumps the version. */
  const external = (id: string, lines: string[], count = lines.length) => {
    const cur = notes.get(id)!;
    notes.set(id, { ...cur, content: `${cur.content}\n${lines.join("\n")}`, metadata: { ...cur.metadata, messageCount: Number(cur.metadata?.messageCount ?? 0) + count }, updatedAt: `x${clock++}` });
  };
  return { vault, notes, gets, attempts, writes, failures, afterGet, external };
}

const T0 = Date.UTC(2026, 0, 1, 10, 0);
const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
const line = (i: number, who = "One", body = `message ${i}`) => `[${stamp(T0 + i * 60_000)}] ${who}: ${body}`;
const m = (i: number, body = `message ${i}`) => ({ sender: "@telegram_1:hs", body, ts: T0 + i * 60_000, eventId: `$e${i}` });
const thread = (id: string, roomId: string, name: string, n: number): Note => ({
  id,
  path: `vault/messages/telegram/${name.toLowerCase()}`,
  tags: ["message-thread"],
  metadata: { type: "message-thread", platform: "telegram", matrixRoomId: roomId, lastMessageAt: T0 + (n - 1) * 60_000, messageCount: n, participants: ["One"] },
  content: `# ${name} — telegram\n\n${Array.from({ length: n }, (_, i) => line(i)).join("\n")}`,
  createdAt: "t",
  updatedAt: `u-${id}`,
});
const batch = (roomId: string, name: string | null, messages: ReturnType<typeof m>[], extra: Partial<RoomBatch> = {}): RoomBatch => ({ roomId, name, memberIds: ["@telegram_1:hs"], displayNames: { "@telegram_1:hs": "One" }, messages, ...extra });
const syncOf = (nextBatch: string, rooms: RoomBatch[]) => async (): Promise<SyncResult> => ({ nextBatch, invites: [], rooms: structuredClone(rooms) });
const entries = (v: ReturnType<typeof casVault>, id: string) => parseThread(v.notes.get(id)!.content).entries;

const entry = () => getVaultRegistry()[0]!;
const logs = { warn: console.warn, error: console.error, log: console.log };
let restoreVault: (() => void) | null = null;
const prevTries = config.matrixReplayMaxTries;
beforeEach(() => {
  resetDb();
  console.warn = console.error = console.log = () => {};
});
afterEach(() => {
  Object.assign(console, logs);
  restoreVault?.();
  restoreVault = null;
  (config as { matrixReplayMaxTries: number }).matrixReplayMaxTries = prevTries;
  delete process.env.MATRIX_THREAD_MAX_BYTES;
  delete process.env.MATRIX_THREAD_KEEP_BYTES;
});

// ── B1: overlapping passes ──────────────────────────────────────────────────

test("B1: two overlapping runMatrixOnce calls run ONE pass — no duplicate line, messageCount exact, cursor advanced once", async () => {
  const v = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const gates: Array<() => void> = [];
  const sinces: Array<string | undefined> = [];
  const client = {
    // Each sync call waits for its own gate: the first pass is still "in /sync" when
    // the second starts, and — unguarded — the second would resume from the SAME cursor.
    sync: async (since?: string): Promise<SyncResult> => {
      sinces.push(since);
      await new Promise<void>((r) => gates.push(r));
      return { nextBatch: "s2", invites: [], rooms: [batch("!a:hs", "Alpha", [m(10), m(11)])] };
    },
  };
  const passA = sched.runMatrixOnce(entry(), { client, vault: v.vault });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sched.matrixPassRunning?.(entry().id), true);
  const passB = sched.runMatrixOnce(entry(), { client, vault: v.vault }); // the tick firing again / a manual sync
  await new Promise((r) => setTimeout(r, 5));
  gates[0]?.();
  assert.equal(await passA, 2);
  gates[1]?.(); // (only an unguarded second pass is waiting here)
  assert.equal(await passB, 2, "the second call joined the running pass");
  assert.deepEqual(sinces, ["s1"], "one /sync, from the stored cursor");
  assert.deepEqual(entries(v, "a"), [line(0), line(1), line(2), line(10), line(11)]);
  assert.equal(v.notes.get("a")!.metadata!.messageCount, 5);
  assert.equal(getWorkerCursor(entry().id, "matrix"), "s2");
  assert.equal(sched.matrixPassRunning?.(entry().id), false);
  // A pass that throws releases the guard too.
  await assert.rejects(sched.runMatrixOnce(entry(), { client: { sync: async () => Promise.reject(new Error("hs down")) }, vault: v.vault }), /hs down/);
  assert.equal(sched.matrixPassRunning?.(entry().id), false);
});

test("B1: POST /api/integrations/matrix/sync answers 409 busy while a pass runs (never a second pass)", async () => {
  const fv = installFakeVault();
  restoreVault = () => fv.restore();
  const v = casVault([]);
  let release!: () => void;
  const client = { sync: async (): Promise<SyncResult> => (await new Promise<void>((r) => (release = r)), { nextBatch: "s2", invites: [], rooms: [] }) };
  const running = sched.runMatrixOnce(entry(), { client, vault: v.vault });
  await new Promise((r) => setTimeout(r, 5));
  const app = createApp();
  const res = await app.request("/api/integrations/matrix/sync", { method: "POST", headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, "busy");
  release();
  await running;
});

// ── B1: the append is compare-and-set ───────────────────────────────────────

test("B1: an external edit between the body read and the write → 409 → re-read → appended ONCE on top of it; nothing lost, nothing doubled", async () => {
  const v = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  v.afterGet.set(1, () => v.external("a", [line(5, "Other", "written meanwhile")]));
  const res = await ingestMatrix({ sync: syncOf("s2", [batch("!a:hs", "Alpha", [m(10)])]) }, v.vault, { since: "s1" });
  assert.equal(res.updated, 1);
  assert.deepEqual(res.failedRooms, []);
  assert.deepEqual(entries(v, "a"), [line(0), line(1), line(2), line(5, "Other", "written meanwhile"), line(10)]);
  assert.equal(v.notes.get("a")!.metadata!.messageCount, 5);
  assert.equal(v.attempts.length, 2, "one refused, one landed");
  assert.ok(v.attempts.every((a) => typeof a.ifUpdatedAt === "string"), "every append names the version it read");
  assert.equal(v.writes.length, 1);
  assert.deepEqual(v.gets, ["a", "a"]);
});

test("B1: when the other writer appended the SAME events (an overlapping pass), the 409 path writes nothing — no duplicate, count untouched", async () => {
  const v = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  v.afterGet.set(1, () => v.external("a", [line(10), line(11)]));
  const res = await ingestMatrix({ sync: syncOf("s2", [batch("!a:hs", "Alpha", [m(10), m(11)])]) }, v.vault, { since: "s1" });
  assert.deepEqual(res.failedRooms, []);
  assert.deepEqual(entries(v, "a"), [line(0), line(1), line(2), line(10), line(11)]);
  assert.equal(v.notes.get("a")!.metadata!.messageCount, 5);
  assert.equal(v.writes.length, 0, "our write was refused and not repeated");
  // Partly written by the other side: only the missing event is appended. Two genuinely
  // identical messages (same minute, sender, text) are still both kept.
  const w = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  w.afterGet.set(1, () => w.external("a", [line(10, "One", "ok")]));
  await ingestMatrix({ sync: syncOf("s2", [batch("!a:hs", "Alpha", [m(10, "ok"), m(10, "ok"), m(12)])]) }, w.vault, { since: "s1" });
  assert.deepEqual(entries(w, "a"), [line(0), line(1), line(2), line(10, "One", "ok"), line(10, "One", "ok"), line(12)]);
  assert.equal(w.notes.get("a")!.metadata!.messageCount, 6);
});

test("B1: a second 409 fails the room for this pass (reported for replay) — it is never forced through", async () => {
  const v = casVault([thread("a", "!a:hs", "Alpha", 3), thread("b", "!b:hs", "Beta", 2)]);
  v.afterGet.set(1, () => v.external("a", [line(5, "Other", "one")]));
  v.afterGet.set(2, () => v.external("a", [line(6, "Other", "two")]));
  const res = await ingestMatrix({ sync: syncOf("s2", [batch("!a:hs", "Alpha", [m(10)]), batch("!b:hs", "Beta", [m(11)])]) }, v.vault, { since: "s1" });
  assert.deepEqual(res.failedRooms, ["!a:hs"]);
  assert.deepEqual(entries(v, "a"), [line(0), line(1), line(2), line(5, "Other", "one"), line(6, "Other", "two")], "the other writer's lines are intact");
  assert.equal(entries(v, "b").at(-1), line(11), "the other room still landed");
  assert.equal(res.nextBatch, "s2");
});

test("B1: the append-time ROLLOVER is compare-and-set too — a 409 on the trim re-reads and recounts instead of re-appending blindly", async () => {
  process.env.MATRIX_THREAD_MAX_BYTES = "700";
  process.env.MATRIX_THREAD_KEEP_BYTES = "250";
  const v = casVault([thread("a", "!a:hs", "Alpha", 14)]);
  const news = Array.from({ length: 8 }, (_, i) => m(100 + i));
  // The other writer lands the first three of our events while we hold the stale copy.
  v.afterGet.set(1, () => v.external("a", [line(100), line(101), line(102)]));
  await ingestMatrix({ sync: syncOf("s2", [batch("!a:hs", "Alpha", news)]) }, v.vault, { since: "s1" });
  const all = [...[...v.notes.values()].filter((n) => n.tags?.includes(ARCHIVE_TAG)).sort((x, y) => (x.path! < y.path! ? -1 : 1)).flatMap((n) => parseThread(n.content).entries), ...entries(v, "a")];
  assert.deepEqual(all, [...Array.from({ length: 14 }, (_, i) => line(i)), ...news.map((_, i) => line(100 + i))], "every message exactly once, in order");
  assert.equal(v.notes.get("a")!.metadata!.messageCount, 14 + 8);
  assert.ok(Buffer.byteLength(v.notes.get("a")!.content) <= 700);
});

// ── S2: a failed room is replayed ───────────────────────────────────────────

/** A homeserver timeline per room, with sync tokens s1 < s2 < s3 … marking positions. */
function homeserver(timeline: Record<string, Array<{ msg: ReturnType<typeof m>; before: string }>>) {
  const order = (t?: string) => (t ? Number(t.slice(1)) : 0);
  const calls: Array<{ room: string; from?: string; to?: string }> = [];
  let down = false;
  return {
    calls,
    fail: (v: boolean) => (down = v),
    messagesBefore: async (room: string, o: { from?: string; to?: string; sinceTs?: number; cap?: number }) => {
      calls.push({ room, from: o.from, to: o.to });
      if (down) throw new Error("matrix /messages → 502");
      // Events sent after token `to` and before token `from`.
      const msgs = (timeline[room] ?? []).filter((e) => order(e.before) <= order(o.from) && order(e.before) > order(o.to)).map((e) => e.msg);
      return { messages: msgs, capped: false };
    },
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async () => "Fresh",
  };
}

test("S2: a room that fails in pass 1 and gets NEWER messages in pass 2 keeps the lost ones — replayed from the failed pass's cursor, in order, once", async () => {
  const v = casVault([thread("x", "!x:hs", "Xray", 2), thread("y", "!y:hs", "Yank", 2)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  // m(10) arrives in pass 1 (s1→s2), m(20) in pass 2 (s2→s3).
  const hs = homeserver({ "!x:hs": [{ msg: m(10), before: "s2" }, { msg: m(20), before: "s3" }] });
  v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500") });
  const pass1 = { ...hs, sync: syncOf("s2", [batch("!x:hs", "Xray", [m(10)]), batch("!y:hs", "Yank", [m(11)])]) };
  await sched.runMatrixOnce(entry(), { client: pass1, vault: v.vault });
  assert.deepEqual(entries(v, "x"), [line(0), line(1)], "pass 1 lost !x's message");
  assert.equal(getWorkerCursor(entry().id, "matrix"), "s2", "…and the cursor moved on");
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), [{ roomId: "!x:hs", since: "s1", tries: 0 }]);

  const pass2 = { ...hs, sync: syncOf("s3", [batch("!x:hs", "Xray", [m(20)])]) };
  await sched.runMatrixOnce(entry(), { client: pass2, vault: v.vault });
  assert.deepEqual(hs.calls, [{ room: "!x:hs", from: "s2", to: "s1" }], "exactly the failed pass's window");
  assert.deepEqual(entries(v, "x"), [line(0), line(1), line(10), line(20)]);
  assert.equal(v.notes.get("x")!.metadata!.messageCount, 4);
  assert.equal(v.notes.get("x")!.metadata!.lastMessageAt, T0 + 20 * 60_000);
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), []);
  // A third pass has nothing to replay and repeats nothing.
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s4", []) }, vault: v.vault });
  assert.equal(hs.calls.length, 1);
  assert.deepEqual(entries(v, "x"), [line(0), line(1), line(10), line(20)]);
});

test("S2: the replay does not double what later passes already wrote, and a room that keeps failing keeps its ORIGINAL cursor", async () => {
  const v = casVault([thread("x", "!x:hs", "Xray", 2)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const hs = homeserver({ "!x:hs": [{ msg: m(10), before: "s2" }, { msg: m(20), before: "s3" }, { msg: m(30), before: "s4" }] });
  v.failures.push({ op: "get", error: new VaultStatusError(503, "GET: 503") }); // pass 1: the body read fails
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s2", [batch("!x:hs", "Xray", [m(10)])]) }, vault: v.vault });
  // Pass 2: the homeserver cannot page (replay fails) but the room's new message lands.
  hs.fail(true);
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s3", [batch("!x:hs", "Xray", [m(20)])]) }, vault: v.vault });
  assert.deepEqual(entries(v, "x"), [line(0), line(1), line(20)]);
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), [{ roomId: "!x:hs", since: "s1", tries: 1 }]);
  // Pass 3: replay of (s1, s3] returns m(10) AND m(20); only m(10) is new to the note.
  hs.fail(false);
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s4", [batch("!x:hs", "Xray", [m(30)])]) }, vault: v.vault });
  assert.deepEqual(hs.calls.at(-1), { room: "!x:hs", from: "s3", to: "s1" });
  assert.deepEqual(entries(v, "x"), [line(0), line(1), line(20), line(10), line(30)], "nothing lost, nothing twice (the recovered message lands late)");
  assert.equal(v.notes.get("x")!.metadata!.messageCount, 5);
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), []);
});

test("S2: a NEW room whose create failed is replayed into ONE thread note, and the same pass's batch appends to it", async () => {
  const v = casVault([]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const hs = homeserver({ "!n:hs": [{ msg: m(10), before: "s2" }, { msg: m(20), before: "s3" }] });
  v.failures.push({ op: "create", error: new VaultStatusError(500, "POST: 500") });
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s2", [batch("!n:hs", "Fresh", [m(10)])]) }, vault: v.vault });
  assert.equal(v.notes.size, 0);
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s3", [batch("!n:hs", "Fresh", [m(20)])]) }, vault: v.vault });
  const threads = [...v.notes.values()].filter((n) => n.metadata?.matrixRoomId === "!n:hs");
  assert.equal(threads.length, 1, "one note for the room");
  assert.deepEqual(parseThread(threads[0]!.content).entries, [line(10), line(20)]);
  assert.equal(threads[0]!.metadata!.messageCount, 2);
});

test("S2: a failed gap-fill (tail written, window lost) is replayed too", async () => {
  const v = casVault([thread("x", "!x:hs", "Xray", 2)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const hs = homeserver({ "!x:hs": [{ msg: m(8), before: "s2" }, { msg: m(9), before: "s2" }, { msg: m(10), before: "s2" }] });
  hs.fail(true);
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s2", [batch("!x:hs", "Xray", [m(10)], { limited: true, prevBatch: "p1" })]) }, vault: v.vault });
  assert.deepEqual(entries(v, "x"), [line(0), line(1), line(10)], "only the tail landed");
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), [{ roomId: "!x:hs", since: "s1", tries: 0 }]);
  hs.fail(false);
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s3", []) }, vault: v.vault });
  assert.deepEqual(entries(v, "x"), [line(0), line(1), line(10), line(8), line(9)]);
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), []);
});

test("S2: after the retry cap the room is given up on LOUDLY — the pass is a failure naming the count, the room is recorded, and it stops being retried", async () => {
  (config as { matrixReplayMaxTries: number }).matrixReplayMaxTries = 3;
  const v = casVault([thread("x", "!x:hs", "Xray", 2)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const hs = homeserver({ "!x:hs": [{ msg: m(10), before: "s2" }] });
  v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500") });
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s2", [batch("!x:hs", "Xray", [m(10)])]) }, vault: v.vault });
  hs.fail(true);
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s3", []) }, vault: v.vault }); // try 1
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s4", []) }, vault: v.vault }); // try 2
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), [{ roomId: "!x:hs", since: "s1", tries: 2 }]);
  await assert.rejects(sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s5", []) }, vault: v.vault }), /gave up replaying 1 room\(s\) after 3 attempt/);
  assert.equal(getWorkerCursor(entry().id, "matrix"), "s5", "the pass itself still completed and persisted");
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), []);
  const lost = JSON.parse(getWorkerCursor(entry().id, "matrix-lost") ?? "[]") as Array<{ roomId: string; since: string }>;
  assert.deepEqual(lost.map((l) => [l.roomId, l.since]), [["!x:hs", "s1"]]);
  const calls = hs.calls.length;
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s6", []) }, vault: v.vault });
  assert.equal(hs.calls.length, calls, "not retried again");
});

// ── S1: every vault call of a pass is bounded ───────────────────────────────

test("S1: a vault that never answers fails the pass within the vault timeout (and frees the guard) instead of hanging the tick", async () => {
  const prevMs = config.matrixVaultTimeoutMs;
  // (MATRIX_VAULT_TIMEOUT_MS=0 in the environment = the old, unbounded client.)
  (config as { matrixVaultTimeoutMs: number }).matrixVaultTimeoutMs = Number(process.env.MATRIX_VAULT_TIMEOUT_MS ?? 150);
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_u: unknown, init?: RequestInit) =>
    new Promise((_res, rej) => {
      calls++;
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as typeof fetch;
  let guard: NodeJS.Timeout | undefined;
  try {
    const t0 = Date.now();
    const pass = sched.runMatrixOnce(entry(), { client: { sync: syncOf("s2", [batch("!a:hs", "Alpha", [m(1)])]) } }); // real vaultClient
    await assert.rejects(
      Promise.race([pass, new Promise((_r, rej) => (guard = setTimeout(() => rej(new Error("the pass hung on the vault")), 3000)))]),
      (e: Error) => !/hung on the vault/.test(e.message),
    );
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(calls, 1, "the listing");
    assert.equal(sched.matrixPassRunning?.(entry().id), false);
  } finally {
    clearTimeout(guard);
    globalThis.fetch = prevFetch;
    (config as { matrixVaultTimeoutMs: number }).matrixVaultTimeoutMs = prevMs;
  }
});

// ── delta review: replay window, sender-free identity, reconcile guard, timeouts, durable give-up ──

test("R1: a room with NO thread note is replayed from its START (not just the failed pass's window) — its earlier history is not lost", async () => {
  const v = casVault([]);
  setWorkerCursor(entry().id, "matrix", "s1");
  // A newly joined portal: two messages from before the cursor, one in the failed pass.
  const hs = homeserver({ "!n:hs": [{ msg: m(1), before: "s1" }, { msg: m(2), before: "s1" }, { msg: m(10), before: "s2" }] });
  v.failures.push({ op: "create", error: new VaultStatusError(500, "POST: 500") });
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s2", [batch("!n:hs", "Fresh", [m(10)])]) }, vault: v.vault });
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s3", []) }, vault: v.vault });
  assert.deepEqual(hs.calls, [{ room: "!n:hs", from: "s2", to: undefined }], "paged without a lower bound");
  const t = [...v.notes.values()].filter((n) => n.metadata?.matrixRoomId === "!n:hs");
  assert.equal(t.length, 1);
  assert.deepEqual(parseThread(t[0]!.content).entries, [line(1), line(2), line(10)]);
});

test("R2: dedupe identity ignores the RENDERED sender — a write that landed with fallback ids is not appended again once the names resolve (and the reverse)", async () => {
  const v = casVault([thread("x", "!x:hs", "Xray", 2)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const hs = homeserver({ "!x:hs": [{ msg: m(10), before: "s2" }, { msg: m(11, "two\nlines  "), before: "s2" }] });
  // Pass 1: no display names at all (member lookup unavailable) → lines carry the short id;
  // the vault write LANDS but its answer is lost (500).
  v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500 (after commit)"), landed: true });
  const nameless = { sync: syncOf("s2", [batch("!x:hs", "Xray", [m(10), m(11, "two\nlines  ")], { displayNames: {} })]) };
  await sched.runMatrixOnce(entry(), { client: nameless, vault: v.vault });
  const afterPass1 = entries(v, "x");
  assert.equal(afterPass1.length, 4);
  assert.doesNotMatch(afterPass1[2]!, /One:/, "rendered with the fallback id");
  // Pass 2: the replay resolves "One" — the same two events, another rendering.
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s3", []) }, vault: v.vault });
  assert.deepEqual(entries(v, "x"), afterPass1, "nothing appended twice (multi-line + trailing blanks included)");
  assert.equal(v.notes.get("x")!.metadata!.messageCount, 4);
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), []);
  // The 409 path uses the same identity: the other writer's copy carries other names.
  const w = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  w.afterGet.set(1, () => w.external("a", [line(10, "telegram_1"), line(11, "Someone Else")]));
  await ingestMatrix({ sync: syncOf("s2", [batch("!a:hs", "Alpha", [m(10), m(11), m(12)])]) }, w.vault, { since: "s1" });
  assert.deepEqual(entries(w, "a"), [line(0), line(1), line(2), line(10, "telegram_1"), line(11, "Someone Else"), line(12)]);
  assert.equal(w.notes.get("a")!.metadata!.messageCount, 6);
});

test("R2: a member lookup that fails inside a replay fails the replay (kept for the next pass) — it never writes lines with fallback names", async () => {
  const v = casVault([thread("x", "!x:hs", "Xray", 2)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const hs = homeserver({ "!x:hs": [{ msg: m(10), before: "s2" }] });
  v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500") });
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s2", [batch("!x:hs", "Xray", [m(10)])]) }, vault: v.vault });
  const broken = { ...hs, joinedMembers: async () => Promise.reject(new Error("matrix /joined_members → 502")) };
  await sched.runMatrixOnce(entry(), { client: { ...broken, sync: syncOf("s3", []) }, vault: v.vault });
  assert.deepEqual(entries(v, "x"), [line(0), line(1)], "nothing written");
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), [{ roomId: "!x:hs", since: "s1", tries: 1 }]);
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s4", []) }, vault: v.vault });
  assert.deepEqual(entries(v, "x"), [line(0), line(1), line(10)]);
});

test("R3: the reconcile runs under its OWN guard — ingest keeps its cadence while a sweep is in flight, and no second sweep starts", async () => {
  const prev = config.matrixReconcileMs;
  (config as { matrixReconcileMs: number }).matrixReconcileMs = 1; // always due
  const v = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  let releaseRooms!: () => void;
  let sweeps = 0;
  let syncs = 0;
  const client = {
    sync: async (): Promise<SyncResult> => ({ nextBatch: `s${++syncs + 1}`, invites: [], rooms: syncs === 2 ? [batch("!a:hs", "Alpha", [m(10)])] : [] }),
    joinedRooms: async () => (sweeps++, await new Promise<void>((r) => (releaseRooms = r)), ["!a:hs"]),
    messagesBefore: async () => ({ messages: [m(10)], capped: false }),
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async () => null,
  };
  try {
    assert.equal(await sched.runMatrixOnce(entry(), { client, vault: v.vault }), 0);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(sched.matrixPassRunning?.(entry().id), false, "the ingest guard is released once ingest + cursor are done");
    assert.equal(sched.matrixReconcileRunning?.(entry().id), true, "…while the sweep is still running");
    // The next tick's pass runs — and ingests — during the sweep.
    assert.equal(await sched.runMatrixOnce(entry(), { client, vault: v.vault }), 1);
    assert.equal(syncs, 2);
    assert.equal(sweeps, 1, "no second sweep while one runs");
    assert.deepEqual(entries(v, "a"), [line(0), line(1), line(2), line(10)]);
    releaseRooms();
    await sched.matrixReconcileSettled?.(entry().id);
    assert.equal(sched.matrixReconcileRunning?.(entry().id), false);
    assert.deepEqual(entries(v, "a"), [line(0), line(1), line(2), line(10)], "the sweep found nothing to repair");
  } finally {
    releaseRooms?.();
    await sched.matrixReconcileSettled?.(entry().id);
    (config as { matrixReconcileMs: number }).matrixReconcileMs = prev;
  }
});

test("R3: ingest and reconcile writing the SAME room at once — no duplicate, no loss", async () => {
  const v = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  // The reconcile has read the note (holding lines 0–2) and is about to write its repair
  // (m(5), m(6)); right then a full ingest pass lands m(6) and m(20) on the same thread.
  const realUpdate = v.vault.updateNote.bind(v.vault);
  let first = true;
  v.vault.updateNote = async (id, p) => {
    if (first) {
      first = false;
      await ingestMatrix({ sync: syncOf("s3", [batch("!a:hs", "Alpha", [m(6), m(20)])]) }, v.vault, { since: "s2" });
    }
    return realUpdate(id, p);
  };
  const client = {
    joinedRooms: async () => ["!a:hs"],
    messagesBefore: async (_r: string, o: { cap?: number }) => (o.cap === 1 ? { messages: [m(6)], capped: false } : { messages: [m(2), m(5), m(6)], capped: false }),
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async () => null,
  };
  const r = await reconcileMatrix(client, v.vault, { upTo: "s2" });
  assert.equal(r.repaired, 1);
  assert.deepEqual(entries(v, "a"), [line(0), line(1), line(2), line(6), line(20), line(5)]);
  assert.equal(v.notes.get("a")!.metadata!.messageCount, 6);
  assert.equal(v.notes.get("a")!.metadata!.lastMessageAt, T0 + 20 * 60_000, "never rewound");
});

test("R3: reconcileMatrix has an overall deadline — unreached rooms are left for the next sweep, nothing throws", async () => {
  const rooms = Array.from({ length: 12 }, (_, i) => `!r${i}:hs`);
  const v = casVault([]);
  let clock = 0;
  const probed: string[] = [];
  const client = {
    joinedRooms: async () => rooms,
    messagesBefore: async (room: string) => (probed.push(room), (clock += 100), { messages: [], capped: false }),
    joinedMembers: async () => ({}),
    roomName: async () => null,
  };
  const r = await reconcileMatrix(client, v.vault, { upTo: "c", concurrency: 1, deadlineMs: 450, probeShare: 1, now: () => clock });
  assert.deepEqual(probed, [...rooms].sort().slice(0, 5), "rooms are probed in sorted order");
  assert.equal(r.unprobed, 7);
  assert.equal(r.scanned, 5, "`scanned` is what was actually probed");
  assert.equal(r.rooms, 12);
  // No deadline → every room, and no `unprobed` key at all.
  probed.length = 0;
  const all = await reconcileMatrix(client, v.vault, { upTo: "c", concurrency: 1 });
  assert.equal(probed.length, 12);
  assert.equal("unprobed" in all, false);
});

test("R4: join / leave / sendText are bounded like every read — a homeserver that never answers rejects at the timeout", async () => {
  const seen: Array<{ url: string; hasSignal: boolean }> = [];
  const hang = ((u: unknown, init?: RequestInit) =>
    new Promise((_res, rej) => {
      seen.push({ url: String(u), hasSignal: !!init?.signal });
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as typeof fetch;
  const c = new MatrixClient({ homeserver: "http://hs.test", accessToken: "t" } as never, hang, 60);
  for (const call of [() => c.join("!r:hs"), () => c.leave("!r:hs"), () => c.sendText("!r:hs", "sync-chats")]) {
    let guard: NodeJS.Timeout | undefined;
    const t0 = Date.now();
    await assert.rejects(Promise.race([call(), new Promise((_r, rej) => (guard = setTimeout(() => rej(new Error("hung")), 1500)))]), (e: Error) => e.message !== "hung");
    clearTimeout(guard);
    assert.ok(Date.now() - t0 < 1000);
  }
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.hasSignal));
});

test("R5: a given-up room is DURABLY surfaced — matrix reads `failing` with the count until the owner clears it, alerts once, and is not replayed in a loop", async () => {
  const fv = installFakeVault();
  restoreVault = () => fv.restore();
  resetSourceHealth();
  (config as { matrixReplayMaxTries: number }).matrixReplayMaxTries = 1;
  const v = casVault([thread("x", "!x:hs", "Xray", 2)]);
  setWorkerCursor(entry().id, "matrix", "s1");
  const hs = homeserver({ "!x:hs": [{ msg: m(10), before: "s2" }] });
  const matrix = async () => (await getSourceHealth({ list: async () => [] })).find((h) => h.name === "matrix")!;
  assert.notEqual((await matrix()).status, "failing");
  v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500") });
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s2", [batch("!x:hs", "Xray", [m(10)])]) }, vault: v.vault });
  hs.fail(true);
  await assert.rejects(sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s3", []) }, vault: v.vault }), /gave up/);
  assert.deepEqual(sched.lostMatrixRooms?.(entry().id).map((l) => l.roomId), ["!x:hs"]);

  // Many clean passes later it still reads failing (one rejected pass used to be all there was).
  for (let i = 4; i < 8; i++) await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf(`s${i}`, []) }, vault: v.vault });
  const h = await matrix();
  assert.equal(h.status, "failing");
  assert.match(h.lastError!, /1 room\(s\) given up on/);
  assert.match(h.lastError!, /!x:hs/);
  // One alert per episode through the ordinary health-alert path.
  const notes: string[] = [];
  const flags = new Map<string, string>();
  const deps = { send: async () => {}, writeNote: async (n: { path: string }) => void notes.push(n.path), getFlag: (_v: string, k: string) => flags.get(k) ?? null, setFlag: (_v: string, k: string, val: string) => void flags.set(k, val) };
  assert.deepEqual((await evaluateAlerts([h], { deps, force: true })).alerted, ["matrix"]);
  assert.deepEqual((await evaluateAlerts([await matrix()], { deps, force: true })).alerted, []);
  assert.equal(notes.length, 1);

  // The room fails again on its next message: NOT queued again while it is listed as lost.
  v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500") });
  await sched.runMatrixOnce(entry(), { client: { ...hs, sync: syncOf("s9", [batch("!x:hs", "Xray", [m(30)])]) }, vault: v.vault });
  assert.deepEqual(sched.pendingMatrixReplays?.(entry().id), []);

  // The owner looks, then clears. Members cannot; the DELETE is CSRF-guarded and audited.
  const app = createApp();
  const owner = { cookie: sessionCookie(makeSession(config.ownerEmail)) };
  const listed = (await (await app.request("/acl/workers/matrix/lost", { headers: owner })).json()) as { rooms: Array<{ roomId: string; since: string }> };
  assert.deepEqual(listed.rooms.map((r) => [r.roomId, r.since]), [["!x:hs", "s1"]]);
  assert.equal((await app.request("/acl/workers/matrix/lost", { method: "DELETE", headers: { cookie: sessionCookie(makeSession("member@example.com")), "content-type": "application/json" } })).status, 403);
  assert.equal((await app.request("/acl/workers/matrix/lost", { method: "DELETE", headers: owner })).status, 415);
  assert.equal((await app.request("/acl/workers/matrix/lost", { method: "DELETE", headers: { ...owner, "content-type": "application/json", "sec-fetch-site": "cross-site" } })).status, 403);
  const del = await app.request("/acl/workers/matrix/lost", { method: "DELETE", headers: { ...owner, "content-type": "application/json" } });
  assert.deepEqual(await del.json(), { ok: true, cleared: 1 });
  assert.deepEqual(sched.lostMatrixRooms?.(entry().id), []);
  assert.notEqual((await matrix()).status, "failing");
  const audit = listActionAudit({ action: ["admin.matrix-lost-clear"] });
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0]!.target, { cleared: 1 });
  // The episode closes (here silently: this test vault has no Matrix credential, so the source reads `disabled`).
  await evaluateAlerts([await matrix()], { deps, force: true });
  assert.equal(flags.get("health-alerted:matrix"), "0");
});

test("isConflict reads the error's status, not its text: a 500 whose message contains \"409\" is not retried as a conflict", async () => {
  const v = casVault([thread("a", "!a:hs", "Alpha", 3)]);
  v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH /notes/a: 500 upstream said 409 once") });
  const res = await ingestMatrix({ sync: syncOf("s2", [batch("!a:hs", "Alpha", [m(10)])]) }, v.vault, { since: "s1" });
  assert.deepEqual(res.failedRooms, ["!a:hs"]);
  assert.equal(v.attempts.length, 1, "no conflict retry");
  assert.deepEqual(v.gets, ["a"]);
});
