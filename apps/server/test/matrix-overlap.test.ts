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
import { ingestMatrix, type IngestVault, type SyncResult, type RoomBatch } from "../src/worker/matrix";
import { parseThread, ARCHIVE_TAG } from "../src/worker/matrix-rollover";
import * as scheduler from "../src/worker/scheduler";
import { config } from "../src/config";
import { getVaultRegistry, getWorkerCursor, setWorkerCursor } from "../src/db";
import { createApp } from "../src/app";
import { resetDb, installFakeVault, makeSession, sessionCookie } from "./helpers";
import type { Note } from "../src/parachute";

// Looked up dynamically so this file loads (and FAILS, rather than not importing)
// against a scheduler without the guard.
const sched = scheduler as unknown as {
  runMatrixOnce: (entry: unknown, deps?: unknown) => Promise<number>;
  matrixPassRunning?: (id: string) => boolean;
  pendingMatrixReplays?: (id: string) => Array<{ roomId: string; since?: string; tries: number }>;
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
  const failures: Array<{ op: "update" | "create" | "get"; error: Error }> = [];
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
      if (f !== -1) throw failures.splice(f, 1)[0]!.error;
      const cur = notes.get(id)!;
      if (p.ifUpdatedAt !== undefined && p.ifUpdatedAt !== cur.updatedAt) throw new VaultStatusError(409, "PATCH: 409 conflict");
      notes.set(id, { ...cur, ...(p.content !== undefined ? { content: p.content } : {}), ...(p.metadata ? { metadata: { ...(cur.metadata ?? {}), ...p.metadata } } : {}), updatedAt: `u${clock++}` });
      writes.push({ op: "update", id });
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
