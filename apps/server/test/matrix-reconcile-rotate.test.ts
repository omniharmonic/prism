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
const sweep = (entry: unknown, client: Client, vault: IngestVault, upTo: string, o: { deadlineMs: number; now: () => number; concurrency?: number }): Promise<Result> => {
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
    const r = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 400, now: hs.now });
    assert.equal(r.scanned, 1500);
    unprobed.push(r.unprobed);
    if (i === 0) assert.equal(getWorkerCursor(entry().id, CURSOR), "!r0399:hs", "the resume point is persisted (it survives a restart)");
  }
  assert.equal(hs.probes.size, 1500, "every room was reached");
  assert.deepEqual([...new Set(hs.probes.values())], [1], "…exactly once");
  assert.deepEqual(unprobed, [1100, 700, 300, undefined], "`unprobed` still reports what this sweep left behind");
  assert.equal(getWorkerCursor(entry().id, CURSOR) || "", "", "a sweep that reached the end clears the resume point");

  // The next cycle starts at the front again.
  hs.probes.clear();
  const again = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 400, now: hs.now });
  assert.equal(again.unprobed, 1100);
  assert.deepEqual([...hs.probes.keys()].sort().at(0), "!r0000:hs");
  assert.deepEqual([...hs.probes.keys()].sort().at(-1), "!r0399:hs");
});

test("rooms joined and left between sweeps (the resume room itself included) never restart or skip the cycle", async () => {
  const hs = homeserver(30);
  await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 10, now: hs.now, concurrency: 1 });
  assert.equal(getWorkerCursor(entry().id, CURSOR), "!r0009:hs");
  hs.rooms.delete("!r0009:hs"); // the room the sweep stopped at is gone
  hs.rooms.delete("!r0015:hs");
  hs.rooms.add("!r0012x:hs"); // joined meanwhile, sorts into the part still to do
  const second = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 10, now: hs.now, concurrency: 1 });
  assert.equal(hs.probes.get("!r0010:hs"), 1, "continues right behind the vanished room");
  assert.equal(hs.probes.get("!r0012x:hs"), 1);
  assert.equal(hs.probes.get("!r0000:hs"), 1, "the front is not probed again in this cycle");
  assert.equal(second.unprobed, 10);
  const third = await sweep(entry(), hs.client, emptyVault, "c", { deadlineMs: 10, now: hs.now, concurrency: 1 });
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
