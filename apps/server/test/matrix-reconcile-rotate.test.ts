/**
 * Matrix reconcile: a sweep cut off by its deadline CONTINUES where it stopped.
 *
 * Probing used to start at the front of the joined-rooms list every sweep, so with
 * more rooms than one deadline covers the rooms at the end were never probed at all.
 * The resume point (a room id; rooms are probed in sorted order) is persisted per
 * vault in the worker cursor table.
 *
 * Fakes only: an in-memory "homeserver" and an empty vault.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { reconcileMatrix, type IngestVault } from "../src/worker/matrix";
import * as scheduler from "../src/worker/scheduler";
import { config } from "../src/config";
import { getVaultRegistry, getWorkerCursor } from "../src/db";
import { resetDb } from "./helpers";
import type { Note } from "../src/parachute";

type Client = Parameters<typeof reconcileMatrix>[0];
type Result = Awaited<ReturnType<typeof reconcileMatrix>>;
// Looked up dynamically so this file loads — and FAILS on its assertions — against a
// scheduler that still starts every sweep at the front.
const sweep = (entry: unknown, client: Client, vault: IngestVault, upTo: string, o: { deadlineMs: number; now: () => number; concurrency?: number; probeShare?: number; maxRepairs?: number; wallNow?: () => number }): Promise<Result> => {
  const fn = (scheduler as unknown as { runMatrixReconcileSweep?: (...a: unknown[]) => Promise<Result> }).runMatrixReconcileSweep;
  if (fn) return fn(entry, client, vault, upTo, o);
  return reconcileMatrix(client, vault, { upTo, maxRepairs: config.matrixReconcilePerSweep, ...o });
};

const emptyVault: IngestVault = {
  async listNotes() {
    return [] as Note[];
  },
  async getNote() {
    throw new Error("no notes");
  },
  async createNote() {
    throw new Error("nothing is written by these sweeps");
  },
  async updateNote() {
    throw new Error("nothing is written by these sweeps");
  },
  async removeTags() {},
};

/** A homeserver of `n` rooms that lists them in a DIFFERENT order on every call, and a
 *  clock that advances one tick per probe (so a deadline of N covers N probes). */
function homeserver(n: number) {
  const rooms = new Set(Array.from({ length: n }, (_, i) => `!r${String(i).padStart(4, "0")}:hs`));
  const probes = new Map<string, number>();
  let clock = 0;
  let calls = 0;
  const client: Client = {
    joinedRooms: async () => {
      const list = [...rooms];
      // Rotate + reverse by call: the same set, never the same order twice.
      const k = (++calls * 37) % Math.max(1, list.length);
      const out = [...list.slice(k), ...list.slice(0, k)];
      return calls % 2 ? out.reverse() : out;
    },
    messagesBefore: async (room: string) => {
      clock++;
      probes.set(room, (probes.get(room) ?? 0) + 1);
      return { messages: [], capped: false };
    },
    joinedMembers: async () => ({}),
    roomName: async () => null,
  };
  return { client, rooms, probes, now: () => clock };
}

const entry = () => getVaultRegistry()[0]!;
const CURSOR = "matrix-reconcile-after";
/** The owed rooms' ids (the cursor holds `{id, tries, at, repair?}`; ids alone before the back-off existed). */
const owedIds = (): string[] => (JSON.parse(getWorkerCursor(entry().id, "matrix-reconcile-retry") ?? "[]") as Array<string | { id: string }>).map((o) => (typeof o === "string" ? o : o.id));
const logs = { warn: console.warn, error: console.error, log: console.log };
beforeEach(() => {
  resetDb();
  console.warn = console.error = console.log = () => {};
});
afterEach(() => {
  Object.assign(console, logs);
});

test("1,500 rooms, a deadline that covers 400 per sweep: after 4 sweeps every room was probed exactly once", async () => {
  const hs = homeserver(1500);
  const unprobed: Array<number | undefined> = [];
  for (let i = 0; i < 4; i++) {
    const r = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 400, probeShare: 1, now: hs.now });
    assert.equal((r as { rooms?: number }).rooms, 1500);
    assert.equal(r.scanned, i < 3 ? 400 : 300, "`scanned` counts the rooms this sweep probed");
    unprobed.push(r.unprobed);
    if (i === 0) assert.equal(getWorkerCursor(entry().id, CURSOR), "!r0399:hs", "the resume point is persisted (it survives a restart)");
  }
  assert.equal(hs.probes.size, 1500, "every room was reached");
  assert.deepEqual([...new Set(hs.probes.values())], [1], "…exactly once");
  assert.deepEqual(unprobed, [1100, 700, 300, undefined], "`unprobed` still reports what this sweep left behind");
  assert.equal(getWorkerCursor(entry().id, CURSOR) || "", "", "a sweep that reached the end clears the resume point");

  // The next cycle starts at the front again.
  hs.probes.clear();
  const again = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 400, probeShare: 1, now: hs.now });
  assert.equal(again.unprobed, 1100);
  assert.deepEqual([...hs.probes.keys()].sort().at(0), "!r0000:hs");
  assert.deepEqual([...hs.probes.keys()].sort().at(-1), "!r0399:hs");
});

test("rooms joined and left between sweeps (the resume room itself included) never restart or skip the cycle", async () => {
  const hs = homeserver(30);
  await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 10, probeShare: 1, now: hs.now, concurrency: 1 });
  assert.equal(getWorkerCursor(entry().id, CURSOR), "!r0009:hs");
  hs.rooms.delete("!r0009:hs"); // the room the sweep stopped at is gone
  hs.rooms.delete("!r0015:hs");
  hs.rooms.add("!r0012x:hs"); // joined meanwhile, sorts into the part still to do
  const second = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 10, probeShare: 1, now: hs.now, concurrency: 1 });
  assert.equal(hs.probes.get("!r0010:hs"), 1, "continues right behind the vanished room");
  assert.equal(hs.probes.get("!r0012x:hs"), 1);
  assert.equal(hs.probes.get("!r0000:hs"), 1, "the front is not probed again in this cycle");
  assert.equal(second.unprobed, 10);
  const third = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 10, probeShare: 1, now: hs.now, concurrency: 1 });
  assert.equal("unprobed" in third, false);
  for (const id of hs.rooms) assert.equal(hs.probes.get(id), 1, id);
});

test("without a deadline nothing changes: one sweep probes every room and leaves no resume point", async () => {
  const hs = homeserver(50);
  const r = await reconcileMatrix(hs.client, emptyVault, { upTo: "c" });
  assert.equal(hs.probes.size, 50);
  assert.equal("resumeAfter" in r, false);
  assert.equal("unprobed" in r, false);
});

// ── review round: what a cut sweep FINDS must not be lost with the resume point ──

/** A vault that keeps the thread notes a repair creates (lean listings without bodies). */
function memoryVault() {
  const notes = new Map<string, Note>();
  let seq = 0;
  const vault: IngestVault = {
    async listNotes(o) {
      const rows = [...notes.values()].filter((n) => !o.tags?.length || o.tags.every((t) => n.tags?.includes(t)));
      return rows.map((n) => (o.includeContent ? structuredClone(n) : ({ ...structuredClone(n), content: "", byteSize: n.content.length } as unknown as Note)));
    },
    async getNote(id) {
      const n = notes.get(id);
      if (!n) throw Object.assign(new Error("GET: 404"), { status: 404 });
      return structuredClone(n);
    },
    async createNote(p) {
      const n: Note = { id: `n${++seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "t", updatedAt: `u${seq}` };
      notes.set(n.id, n);
      return structuredClone(n);
    },
    async updateNote(id, p) {
      const cur = notes.get(id)!;
      const next = { ...cur, ...(p.content !== undefined ? { content: p.content } : {}), ...(p.metadata ? { metadata: { ...(cur.metadata ?? {}), ...p.metadata } } : {}), updatedAt: `u${++seq}` };
      notes.set(id, next);
      return structuredClone(next);
    },
    async removeTags() {},
  };
  const roomsWithNotes = () => new Set([...notes.values()].map((n) => String(n.metadata?.matrixRoomId ?? "")));
  return { vault, notes, roomsWithNotes };
}

/** 30 rooms; `behind` have one message the vault lacks; `failOnce` throw on their first probe.
 *  The clock advances one tick per homeserver read (probe or gap fetch). */
function busyHomeserver(o: { behind?: string[]; failOnce?: string[] }) {
  const rooms = Array.from({ length: 30 }, (_, i) => `!r${String(i).padStart(4, "0")}:hs`);
  const probes: string[] = [];
  const failed = new Set<string>();
  let clock = 0;
  const msg = (room: string) => ({ sender: "@telegram_1:hs", body: `news in ${room}`, ts: Date.UTC(2026, 0, 1, 10, 0), eventId: `$${room}` });
  const client: Client = {
    joinedRooms: async () => [...rooms].reverse(),
    messagesBefore: async (room: string, opts: { cap?: number }) => {
      clock++;
      if (opts.cap === 1) {
        probes.push(room);
        if (o.failOnce?.includes(room) && !failed.has(room)) {
          failed.add(room);
          throw new Error("matrix /messages → 502");
        }
      }
      return { messages: o.behind?.includes(room) ? [msg(room)] : [], capped: false };
    },
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async (room: string) => `Room ${room.slice(2, 6)}`,
  };
  return { client, rooms, probes, now: () => clock };
}

test("B1: rooms found behind in the FIRST segment of a multi-sweep cycle are repaired in that sweep — the resume point never leaves them behind", async () => {
  const behind = ["!r0003:hs", "!r0007:hs"];
  const hs = busyHomeserver({ behind });
  const v = memoryVault();
  // A deadline of 20 reads; probing may use half of it, so a sweep probes 10 rooms and still has time to repair.
  const first = await sweep(entry(), hs.client, v.vault, "c", { deadlineMs: 20, probeShare: 0.5, now: hs.now, concurrency: 1 });
  assert.equal(first.behind, 2);
  assert.equal(first.repaired, 2, "repaired by the sweep that found them");
  assert.deepEqual([...v.roomsWithNotes()].sort(), behind);
  assert.equal(getWorkerCursor(entry().id, CURSOR), "!r0009:hs", "the rotation goes on behind the 10 rooms probed");
  // The rest of the cycle: every room is reached, nothing is repaired twice.
  for (let i = 0; i < 4 && getWorkerCursor(entry().id, CURSOR); i++) await sweep(entry(), hs.client, v.vault, "c", { deadlineMs: 20, probeShare: 0.5, now: hs.now, concurrency: 1 });
  assert.equal(new Set(hs.probes).size, 30);
  assert.equal(v.notes.size, 2);
});

test("S1: a room whose probe THREW, and a room over the per-sweep repair budget, are tried first by the next sweep — not a whole cycle later", async () => {
  const hs = busyHomeserver({ behind: ["!r0002:hs", "!r0006:hs"], failOnce: ["!r0005:hs"] });
  const v = memoryVault();
  let wall = 1_000_000_000;
  const o = { deadlineMs: 24, probeShare: 0.5, now: hs.now, concurrency: 1, maxRepairs: 1, wallNow: () => wall };
  const first = await sweep(entry(), hs.client, v.vault, "c", o);
  assert.equal(first.scanned, 12, "`scanned` is the number of rooms probed, not the number joined");
  assert.equal(first.repaired, 1);
  assert.equal(first.deferred, 1);
  const owed = owedIds();
  assert.equal(owed.includes("!r0005:hs"), true, "the failed probe is owed");
  assert.equal(owed.length, 2, "…and so is the room over the repair budget");
  assert.equal(getWorkerCursor(entry().id, CURSOR), "!r0011:hs");

  wall += 6 * 60_000; // past the first back-off (5 min)
  const before = hs.probes.length;
  const second = await sweep(entry(), hs.client, v.vault, "c", o);
  assert.deepEqual(hs.probes.slice(before, before + 2).sort(), [...owed].sort(), "the owed rooms are probed FIRST");
  assert.equal(hs.probes[before + 2], "!r0012:hs", "then the rotation continues where it stopped");
  assert.equal(second.repaired, 1, "the deferred room is repaired by the very next sweep");
  assert.deepEqual([...v.roomsWithNotes()].sort(), ["!r0002:hs", "!r0006:hs"]);
  assert.deepEqual(JSON.parse(getWorkerCursor(entry().id, "matrix-reconcile-retry") ?? "[]"), [], "nothing is owed any more");
  assert.equal(hs.probes.filter((p) => p === "!r0005:hs").length, 2);
});

test("a room that fails on every sweep is retried with a back-off and never holds the rotation back", async () => {
  const hs = busyHomeserver({});
  const real = hs.client.messagesBefore;
  hs.client.messagesBefore = (async (room: string, opts: { cap?: number }) => {
    if (room === "!r0001:hs") { await real.call(hs.client, room, opts).catch(() => undefined); throw new Error("matrix /messages → 500"); }
    return real.call(hs.client, room, opts);
  }) as typeof real;
  let wall = 1_000_000_000;
  const o = { deadlineMs: 20, probeShare: 0.5, now: hs.now, concurrency: 1, wallNow: () => wall };
  for (let i = 0; i < 4; i++, wall += 6 * 60_000) await sweep(entry(), hs.client, emptyVault, "c", o);
  assert.equal(new Set(hs.probes).size, 30, "the whole list was still reached");
  assert.deepEqual(owedIds(), ["!r0001:hs"]);
  assert.equal(hs.probes.filter((p) => p === "!r0001:hs").length, 2, "asked about again after 5 min, then not before 15 more");
});
