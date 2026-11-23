// Review round 2 of the reconcile rotation: owed rooms must cost little.
//  1. One room that fails for ever used to bring the FULL sweep back every 5 minutes.
//  2. A pile of owed rooms whose probes hang used to eat every sweep (the rotation stood still),
//     and a room deferred for the repair budget had only probe priority, not repair priority.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { reconcileMatrix, type IngestVault } from "../src/worker/matrix";
import * as scheduler from "../src/worker/scheduler";
import { getSourceHealth } from "../src/worker/health";
import { config } from "../src/config";
import { getVaultRegistry, getWorkerCursor, setWorkerCursor } from "../src/db";
import { resetDb } from "./helpers";
import type { Note } from "../src/parachute";

type Client = Parameters<typeof reconcileMatrix>[0];
type Result = Awaited<ReturnType<typeof reconcileMatrix>> & { retry?: unknown[]; stuck?: string[] };
type Overrides = { deadlineMs: number; now: () => number; concurrency?: number; probeShare?: number; maxRepairs?: number; wallNow?: () => number; retryOnly?: boolean };
const S = scheduler as unknown as {
  runMatrixReconcileSweep: (entry: unknown, client: Client, vault: IngestVault, upTo: string, o: Overrides) => Promise<Result>;
  planMatrixReconcile?: (vaultId: string, now: number) => "full" | "retry" | null;
  noteMatrixReconcileStarted?: (vaultId: string, kind: "full" | "retry", now: number) => void;
  resetMatrixReconcilePlanForTests?: (vaultId: string) => void;
};

const entry = () => getVaultRegistry()[0]!;
const RETRY = "matrix-reconcile-retry";
const AFTER = "matrix-reconcile-after";
const owed = (): Array<{ id: string; tries?: number }> => (JSON.parse(getWorkerCursor(entry().id, RETRY) || "[]") as Array<string | { id: string; tries?: number }>).map((o) => (typeof o === "string" ? { id: o } : o));
const room = (i: number) => `!r${String(i).padStart(4, "0")}:hs`;

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
  return { vault, roomsWithNotes: () => [...notes.values()].map((n) => String(n.metadata?.matrixRoomId ?? "")).sort() };
}

/** `n` rooms. A probe costs one tick of the deadline clock; a room in `hang` costs `hangTicks` and then throws;
 *  a room in `behind` has one message (at the given time) the vault lacks. */
function homeserver(n: number, o: { hang?: Set<string>; hangTicks?: number; behind?: Map<string, number> } = {}) {
  const rooms = Array.from({ length: n }, (_, i) => room(i));
  const probes: string[] = [];
  let clock = 0;
  let listings = 0;
  const client: Client = {
    joinedRooms: async () => {
      listings++;
      return [...rooms];
    },
    messagesBefore: async (id: string, opts: { cap?: number }) => {
      if (opts.cap === 1) probes.push(id);
      if (o.hang?.has(id)) {
        clock += o.hangTicks ?? 1;
        throw new Error("matrix /messages → timed out");
      }
      clock++;
      const ts = o.behind?.get(id);
      return { messages: ts === undefined ? [] : [{ sender: "@telegram_1:hs", body: `news in ${id}`, ts, eventId: `$${id}` }], capped: false };
    },
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async (id: string) => `Room ${id.slice(2, 6)}`,
  };
  return { client, rooms, probes, now: () => clock, listings: () => listings };
}

const logs = { warn: console.warn, error: console.error, log: console.log };
beforeEach(() => {
  resetDb();
  S.resetMatrixReconcilePlanForTests?.(entry().id);
  console.warn = console.error = console.log = () => {};
});
afterEach(() => {
  Object.assign(console, logs);
});

/** The scheduler's decision, minute by minute, for `minutes` of wall time. Against a scheduler without the
 *  planner this replays what it did then: a full sweep when due, and due again in 5 min whenever anything was owed. */
async function simulate(hs: ReturnType<typeof homeserver>, vault: IngestVault, minutes: number, startAt = 10 * config.matrixReconcileMs): Promise<{ full: number; retryOnly: number }> {
  const id = entry().id;
  let lastFull = 0;
  const count = { full: 0, retryOnly: 0 };
  for (let m = 0; m < minutes; m++) {
    const wall = startAt + m * 60_000;
    const o: Overrides = { deadlineMs: 10_000, now: hs.now, concurrency: 1, wallNow: () => wall };
    if (S.planMatrixReconcile) {
      const kind = S.planMatrixReconcile(id, wall);
      if (!kind) continue;
      S.noteMatrixReconcileStarted!(id, kind, wall);
      const before = hs.listings();
      await S.runMatrixReconcileSweep(entry(), hs.client, vault, "c", { ...o, ...(kind === "retry" ? { retryOnly: true } : {}) });
      if (hs.listings() > before) count.full++;
      else count.retryOnly++;
    } else {
      if (wall - lastFull < config.matrixReconcileMs) continue;
      lastFull = wall;
      const r = await S.runMatrixReconcileSweep(entry(), hs.client, vault, "c", o);
      count.full++;
      if (r.deferred > 0 || r.unprobed || r.retry?.length) lastFull = wall - config.matrixReconcileMs + 300_000;
    }
  }
  return count;
}

test("1: a room that fails for ever costs ONE full sweep an hour — it is asked about alone, with a back-off", async () => {
  const hs = homeserver(40, { hang: new Set([room(7)]) });
  const { vault } = memoryVault();
  const hour = await simulate(hs, vault, 60);
  assert.equal(hour.full, 1, "the joined rooms are listed and swept once in the hour");
  assert.equal(hs.probes.filter((p) => p !== room(7)).length, 39, "every other room was probed exactly once");
  const asked = hs.probes.filter((p) => p === room(7)).length;
  assert.equal(asked, 3, "the failing room: in the sweep, 5 minutes later, 15 minutes after that — the next try is an hour on");
  assert.equal(hour.retryOnly, 2);
  assert.deepEqual(owed().map((o) => [o.id, o.tries]), [[room(7), 3]]);
});

test("1: after 6 failures in a row the room goes back to the ordinary rotation and is counted in /acl/workers", async () => {
  const hs = homeserver(12, { hang: new Set([room(3)]) });
  const { vault } = memoryVault();
  const day = await simulate(hs, vault, 8 * 60);
  assert.deepEqual(owed(), [], "nothing is owed: nobody comes back early for it any more");
  assert.deepEqual(JSON.parse(getWorkerCursor(entry().id, "matrix-reconcile-stuck") || "[]"), [room(3)]);
  assert.equal(day.full, 8, "one full sweep an hour, all day");
  assert.ok(day.retryOnly <= 5, `retry-only sweeps stop once the room is given up on (${day.retryOnly})`);
  const perHourAfter = hs.probes.filter((p) => p === room(3)).length;
  assert.ok(perHourAfter <= 6 + 4, `afterwards it is asked about once per rotation only (${perHourAfter} probes in 8 h)`);
  const matrix = (await getSourceHealth({ list: (async () => []) as never })).find((s) => s.name === "matrix");
  assert.deepEqual(matrix?.detail, { reconcileOwed: 0, reconcileStuck: 1 });

  // It answers again → it is forgotten.
  const well = homeserver(12);
  await S.runMatrixReconcileSweep(entry(), well.client, vault, "c", { deadlineMs: 10_000, now: well.now, concurrency: 1 });
  assert.deepEqual(JSON.parse(getWorkerCursor(entry().id, "matrix-reconcile-stuck") || "[]"), []);
});

test("2: 60 owed rooms whose probes hang do not stop the rotation — a bounded number is asked, the rest stay owed", async () => {
  const hung = new Set(Array.from({ length: 60 }, (_, i) => room(100 + i)));
  const hs = homeserver(400, { hang: hung, hangTicks: 50 });
  const { vault } = memoryVault();
  setWorkerCursor(entry().id, RETRY, JSON.stringify([...hung]));
  setWorkerCursor(entry().id, AFTER, room(9));
  const wall = 5_000_000_000;
  // 1000 ticks, 60 % for probing = 600; the 60 owed probes alone would take 3000.
  const r = await S.runMatrixReconcileSweep(entry(), hs.client, vault, "c", { deadlineMs: 1000, probeShare: 0.6, now: hs.now, concurrency: 1, wallNow: () => wall });
  const owedProbes = hs.probes.filter((p) => hung.has(p)).length;
  assert.ok(owedProbes >= 1 && owedProbes <= 7, `owed rooms got at most half of the probe window (${owedProbes} probed)`);
  const rotation = hs.probes.filter((p) => !hung.has(p));
  assert.ok(rotation.length >= 250, `the rotation went on (${rotation.length} rooms probed)`);
  assert.equal(rotation[0], room(10), "…from where it had stopped");
  const after = getWorkerCursor(entry().id, AFTER)!;
  assert.ok(after > room(200), `the resume point advanced (${after})`);
  assert.equal(owed().length, 60, "every hanging room is still owed");
  assert.equal(r.scanned, hs.probes.length);
});

test("2: a room deferred for the repair budget is repaired FIRST by the next sweep, before more recently active rooms", async () => {
  const t = (h: number) => Date.UTC(2026, 0, 1, h, 0);
  const hs = homeserver(20, { behind: new Map([[room(2), t(1)], [room(5), t(9)], [room(6), t(8)]]) });
  const v = memoryVault();
  let wall = 7_000_000_000;
  const o: Overrides = { deadlineMs: 10_000, now: hs.now, concurrency: 1, maxRepairs: 1, wallNow: () => wall };
  const first = await S.runMatrixReconcileSweep(entry(), hs.client, v.vault, "c", o);
  assert.equal(first.repaired, 1);
  assert.deepEqual(v.roomsWithNotes(), [room(5)], "the most recently active room first");
  assert.deepEqual(owed().map((x) => x.id), [room(2), room(6)]);

  // A room becomes active that is newer than both deferred ones.
  wall += 6 * 60_000;
  const busier = homeserver(20, { behind: new Map([[room(2), t(1)], [room(6), t(8)], [room(11), t(12)]]) });
  await S.runMatrixReconcileSweep(entry(), busier.client, v.vault, "c", { ...o, now: busier.now });
  assert.deepEqual(v.roomsWithNotes(), [room(5), room(6)], "a room that already waited once is repaired before the newcomer");
  wall += 6 * 60_000;
  await S.runMatrixReconcileSweep(entry(), busier.client, v.vault, "c", { ...o, now: busier.now, retryOnly: true });
  assert.deepEqual(v.roomsWithNotes(), [room(5), room(6), room(11)], "…and a retry-only sweep repairs the next one without sweeping the rooms");
  assert.deepEqual(owed().map((x) => x.id), [room(2)]);
  assert.equal(busier.listings(), 1, "the retry-only sweep listed no rooms");
});
