/**
 * The LEAN Matrix thread listing (2026-10-03 host stall): a pass lists rows only
 * (no bodies, three metadata keys) and reads a thread's body once, right before
 * it writes that thread.
 *
 * This is the ingest path that must never drop or duplicate a message, so the
 * centre of the file is a GOLDEN test: the same scripted syncs run through the
 * ingester as it was at main 3c1df0a5 (`fixtures/matrix-ingest-3c1df0a.ts`,
 * verbatim) and through the lean one, against two copies of the same vault, and
 * the vaults must end up identical — every note, every write, in order.
 *
 * The fake vault behaves like vault 0.7.9: `include_content=false` rows have no
 * `content` and carry `byteSize` (UTF-8 bytes); `include_metadata` filters keys;
 * PATCH merges metadata; `if_updated_at` conflicts; a taken path is a 409.
 * Nothing here reaches a homeserver or a vault.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { probed } from "./probe";
import {
  MatrixClient,
  THREAD_LIST_KEYS,
  SIZE_PROBES_PER_PASS,
  _resetThreadSizeCacheForTests,
  ingestMatrix,
  reconcileMatrix,
  sweepOversizedThreads,
  type IngestVault,
  type SyncResult,
  type RoomBatch,
} from "../src/worker/matrix";
import * as legacy from "./fixtures/matrix-ingest-3c1df0a";
import { ARCHIVE_TAG, parseThread, rolloverThread } from "../src/worker/matrix-rollover";
import type { Note } from "../src/parachute";

const LIMITS = { maxBytes: 1500, keepBytes: 400 };
beforeEach(() => {
  process.env.MATRIX_THREAD_MAX_BYTES = String(LIMITS.maxBytes);
  process.env.MATRIX_THREAD_KEEP_BYTES = String(LIMITS.keepBytes);
  _resetThreadSizeCacheForTests();
});
afterEach(() => {
  delete process.env.MATRIX_THREAD_MAX_BYTES;
  delete process.env.MATRIX_THREAD_KEEP_BYTES;
});

class VaultStatusError extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
  }
}

interface ListCall {
  tags: string[];
  pathPrefix?: string;
  includeContent?: boolean;
  includeMetadata?: string[];
}

/** A vault 0.7.9 stand-in that RECORDS every call. */
function leanVault(seed: Note[], opts: { byteSize?: boolean } = {}) {
  const notes = new Map(seed.map((n) => [n.id, structuredClone(n)]));
  let clock = 100;
  let seq = 0;
  const lists: ListCall[] = [];
  const gets: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const failures: Array<{ op: "update" | "create"; error: Error }> = [];
  const vault: IngestVault = {
    async listNotes(o) {
      lists.push({ tags: o.tags ?? [], pathPrefix: o.pathPrefix, includeContent: o.includeContent, includeMetadata: o.includeMetadata });
      const rows = [...notes.values()].filter(
        (n) => (!o.pathPrefix || (n.path ?? "").startsWith(o.pathPrefix)) && (!o.tags?.length || o.tags.every((t) => n.tags?.includes(t))),
      );
      if (o.includeContent) return rows.map((n) => structuredClone(n));
      return rows.map((n) => {
        const { content, ...rest } = structuredClone(n);
        const metadata = o.includeMetadata?.length ? Object.fromEntries(Object.entries(rest.metadata ?? {}).filter(([k]) => o.includeMetadata!.includes(k))) : rest.metadata;
        return { ...rest, metadata, ...(opts.byteSize === false ? {} : { byteSize: Buffer.byteLength(content, "utf8") }), preview: content.slice(0, 20) } as unknown as Note;
      });
    },
    async getNote(id) {
      gets.push(id);
      const n = notes.get(id);
      if (!n) throw new VaultStatusError(404, `GET /notes/${id}: 404`);
      return structuredClone(n);
    },
    async createNote(p) {
      const f = failures.findIndex((x) => x.op === "create");
      if (f !== -1) throw failures.splice(f, 1)[0]!.error;
      if (p.path && [...notes.values()].some((n) => n.path === p.path)) throw new VaultStatusError(409, "POST /notes: 409 path_conflict");
      const n: Note = { id: `c${++seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "t", updatedAt: `u${clock++}` };
      notes.set(n.id, n);
      writes.push({ op: "create", ...structuredClone(p) });
      return structuredClone(n);
    },
    async updateNote(id, p) {
      const f = failures.findIndex((x) => x.op === "update");
      if (f !== -1) throw failures.splice(f, 1)[0]!.error;
      const cur = notes.get(id);
      if (!cur) throw new VaultStatusError(404, `PATCH /notes/${id}: 404`);
      if (p.ifUpdatedAt !== undefined && p.ifUpdatedAt !== cur.updatedAt) throw new VaultStatusError(409, "PATCH: 409");
      const next: Note = {
        ...cur,
        ...(p.content !== undefined ? { content: p.content } : {}),
        ...(p.metadata ? { metadata: { ...(cur.metadata ?? {}), ...p.metadata } } : {}),
        updatedAt: `u${clock++}`,
      };
      notes.set(id, next);
      writes.push({ op: "update", id, ...structuredClone(p) });
      return structuredClone(next);
    },
    async removeTags(id, tags) {
      const cur = notes.get(id)!;
      notes.set(id, { ...cur, tags: (cur.tags ?? []).filter((t) => !tags.includes(t)) });
      writes.push({ op: "removeTags", id, tags });
    },
  };
  /** Body reads of THREAD notes (the people index etc. never run in these tests). */
  return { vault, notes, lists, gets, writes, failures };
}

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
const T0 = Date.UTC(2026, 0, 1, 10, 0);
const line = (i: number, who = "One", body = `message number ${i} with a little padding`) => `[${stamp(T0 + i * 60_000)}] ${who}: ${body}`;
const m = (i: number, body = `message number ${i} with a little padding`, sender = "@telegram_1:hs") => ({ sender, body, ts: T0 + i * 60_000, eventId: `$e${i}` });

function thread(id: string, roomId: string, name: string, n: number, extra: Partial<Note> = {}): Note {
  return {
    id,
    path: `vault/messages/telegram/${name.toLowerCase()}`,
    tags: ["message-thread"],
    metadata: { type: "message-thread", platform: "telegram", matrixRoomId: roomId, lastMessageAt: T0 + (n - 1) * 60_000, messageCount: n, participants: ["One"], custom: "kept" },
    content: `# ${name} — telegram\n\n${Array.from({ length: n }, (_, i) => line(i)).join("\n")}`,
    createdAt: "t",
    updatedAt: `u${id}`,
    ...extra,
  };
}
const batch = (roomId: string, name: string | null, messages: ReturnType<typeof m>[], extra: Partial<RoomBatch> = {}): RoomBatch => ({
  roomId,
  name,
  memberIds: ["@telegram_1:hs"],
  displayNames: { "@telegram_1:hs": "One" },
  messages,
  ...extra,
});

/** Every message entry of one thread across its archives + the live note, oldest first. */
function allEntries(notes: Map<string, Note>, id: string): string[] {
  const archives = [...notes.values()].filter((n) => n.metadata?.archiveOf === id).sort((a, b) => (a.path! < b.path! ? -1 : 1));
  return [...archives.flatMap((a) => parseThread(a.content).entries), ...parseThread(notes.get(id)!.content).entries];
}

const snapshot = (notes: Map<string, Note>) => [...notes.values()].map((n) => ({ id: n.id, path: n.path, tags: n.tags, metadata: n.metadata, content: n.content, updatedAt: n.updatedAt }));

// ── the golden test ─────────────────────────────────────────────────────────

/** A vault state that has everything a pass can meet. */
async function goldenSeed(): Promise<Note[]> {
  // A crash between "archive created" and "live note trimmed": build it for real.
  const crashed = leanVault([thread("crash", "!crash:hs", "Crash", 40)]);
  crashed.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500") });
  await assert.rejects(rolloverThread(crashed.vault, crashed.notes.get("crash")!, { limits: LIMITS }));
  assert.ok([...crashed.notes.values()].some((n) => n.tags?.includes(ARCHIVE_TAG)), "the archive exists, the live note is untrimmed");
  return [
    thread("a", "!a:hs", "Alpha", 3, { tags: ["message-thread", "triaged", "low"] }),
    thread("b", "!b:hs", "Busy", 18), // under the limit until this pass appends
    thread("big", "!big:hs", "Big", 60), // already oversized, no new messages → the sweep
    ...crashed.notes.values(),
    thread("dup", "!dup1:hs", "Same", 2), // holds the path a NEW same-named room wants
    thread("gap", "!gap:hs", "Gap", 4),
    thread("late", "!late:hs", "Late", 5),
    thread("quiet", "!quiet:hs", "Quiet", 6),
    // Never a thread: an archive that even carries the thread tag and a room id.
    { id: "rogue", path: "vault/messages/telegram/alpha/archive/001", tags: ["message-thread", ARCHIVE_TAG], metadata: { matrixRoomId: "!a:hs", archiveOf: "a" }, content: "# x", createdAt: "t", updatedAt: "ur" },
  ].map((n) => structuredClone(n));
}

function goldenClient() {
  const sync = async (): Promise<SyncResult> => ({
    nextBatch: "s2",
    invites: [],
    rooms: [
      batch("!a:hs", "Alpha", [m(10), m(11)], { memberIds: ["@telegram_1:hs", "@telegram_2:hs"], displayNames: { "@telegram_1:hs": "One", "@telegram_2:hs": "Two" } }),
      batch("!b:hs", "Busy", Array.from({ length: 14 }, (_, i) => m(100 + i))), // crosses the limit → append + rollover in one write
      batch("!crash:hs", "Crash", [m(200)]), // append onto the half-rolled thread → recovery
      // A room joined since the last pass, limited: paged back without an exact bound (dedupe by line).
      batch("!new:hs", "Fresh", [m(300), m(301, "two\nlines")], { limited: true, prevBatch: "p-new" }),
      batch("!dup2:hs", "Same", [m(310)]), // path taken by !dup1 → room-id suffix
      batch("!gap:hs", "Gap", [m(31), m(32)], { limited: true, prevBatch: "p-gap" }), // exact gap-fill
      batch("!late:hs", "Late", [m(40)], { limited: true, prevBatch: "p-late" }),
      batch("!empty:hs", "Empty", []),
    ],
  });
  const history: Record<string, ReturnType<typeof m>[]> = {
    "!a:hs": [m(11)],
    "!b:hs": [m(113)],
    "!big:hs": [m(59)],
    "!crash:hs": [m(200)],
    "!new:hs": [m(301, "two\nlines")],
    "!dup1:hs": [m(1)],
    "!dup2:hs": [m(310)],
    "!gap:hs": [m(32)],
    "!late:hs": [m(40)],
    // Behind: the note's high-water mark is m(5); the homeserver has two more, plus the boundary one.
    "!quiet:hs": [m(5), m(6), m(7)],
    "!ghost:hs": [m(400), m(401)], // joined out-of-band, no note at all
    "!silent:hs": [],
  };
  const messagesBefore = async (room: string, o: { from?: string; to?: string; sinceTs?: number; cap?: number }) => {
    if (o.from === "p-gap") return { messages: [m(29), m(30)], capped: false };
    if (o.from === "p-late") return { messages: [m(38), m(39), m(40)], capped: false }; // m(40) is also in the tail
    if (o.from === "p-new") return { messages: [m(298), m(299)], capped: false };
    const all = history[room] ?? [];
    if (o.cap === 1) return { messages: all.slice(-1), capped: false };
    return { messages: all.filter((x) => x.ts >= (o.sinceTs ?? 0)), capped: false };
  };
  return {
    sync,
    messagesBefore,
    joinedRooms: async () => Object.keys(history),
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async (room: string) => (room === "!ghost:hs" ? "Ghost Room" : null),
    profileName: async () => null,
  };
}

test("GOLDEN: the lean ingester leaves the vault exactly as the body-listing ingester did (ingest pass + reconcile sweep + a second pass)", async () => {
  const quiet = console.log;
  const quietErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const seed = await goldenSeed();
    const oldV = leanVault(seed);
    const newV = leanVault(seed);
    const run = async (impl: { ingestMatrix: typeof ingestMatrix; reconcileMatrix: typeof reconcileMatrix }, v: ReturnType<typeof leanVault>) => {
      const client = goldenClient();
      const r1 = await impl.ingestMatrix(client, v.vault, { since: "s1" });
      const r2 = await impl.reconcileMatrix(client, v.vault, { upTo: "s2" });
      // A second, later pass over what the first left (the rolled threads, the new notes).
      const again = { ...client, sync: async (): Promise<SyncResult> => ({ nextBatch: "s3", invites: [], rooms: [batch("!b:hs", "Busy", [m(500)]), batch("!new:hs", "Fresh", [m(501)]), batch("!big:hs", "Big", [m(502)])] }) };
      const r3 = await impl.ingestMatrix(again, v.vault, { since: "s2" });
      return { r1, r2, r3 };
    };
    const oldR = await run(legacy as never, oldV);
    const newR = await run({ ingestMatrix, reconcileMatrix }, newV);

    // (The lean ingester also reports failed/replayed rooms — none here — and its plain
    // appends are compare-and-set; the old one's were unconditional. Everything else is equal.)
    const counts = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "failedRooms" && k !== "replayed"));
    for (const k of ["r1", "r3"] as const) {
      assert.deepEqual(counts(newR[k] as never), counts(oldR[k] as never), "same counts reported");
      assert.deepEqual((newR[k] as { failedRooms: string[] }).failedRooms, []);
    }
    // The reconcile RESULT gained one field since the fixture was taken: `rooms` (rooms joined;
    // `scanned` is the number probed — the same without a deadline). The counts must still agree.
    const { rooms: joinedRooms, ...r2 } = newR.r2 as typeof newR.r2 & { rooms: number };
    assert.deepEqual(r2, oldR.r2);
    assert.equal(joinedRooms, (oldR.r2 as { scanned: number }).scanned);
    const uncas = (ws: Array<Record<string, unknown>>) => ws.map(({ ifUpdatedAt: _cas, ...w }) => w);
    assert.deepEqual(uncas(newV.writes), uncas(oldV.writes), "the same writes, in the same order, with the same bodies and metadata");
    assert.ok(newV.writes.filter((w) => w.op === "update").every((w) => typeof w.ifUpdatedAt === "string"), "every lean write names the version it read");
    assert.deepEqual(snapshot(newV.notes), snapshot(oldV.notes), "identical vault contents");

    // …and the run really exercised what it claims to.
    assert.equal(oldR.r1.created, 2);
    assert.ok(oldR.r1.updated >= 5);
    assert.equal(oldR.r2.repaired, 2, "reconcile repaired the quiet room and created the ghost room");
    assert.ok([...newV.notes.values()].filter((n) => n.tags?.includes(ARCHIVE_TAG)).length >= 4, "big, busy and crash were rolled over");
    assert.ok([...newV.notes.values()].some((n) => /^vault\/messages\/telegram\/same-/.test(n.path ?? "")), "suffixed path for the same-named room");
    assert.equal(newV.notes.get("rogue")!.content, "# x", "the archive was never adopted");
    assert.equal(newV.notes.get("a")!.metadata!.custom, "kept");
    assert.deepEqual(newV.notes.get("a")!.tags, ["message-thread"], "stale triage tags stripped");

    // The old one listed bodies; the new one never does.
    assert.ok(oldV.lists.some((l) => l.tags.includes("message-thread") && l.includeContent === true));
    assert.equal(oldV.gets.length, 0);
    for (const l of newV.lists) assert.notEqual(l.includeContent, true, `no listing asks for content (${JSON.stringify(l)})`);
    for (const l of newV.lists.filter((x) => x.tags.includes("message-thread"))) assert.deepEqual(l.includeMetadata, THREAD_LIST_KEYS);
  } finally {
    console.log = quiet;
    console.error = quietErr;
  }
});

// ── what is listed, what is fetched ─────────────────────────────────────────

test("the thread listing asks for no content and exactly matrixRoomId / lastMessageAt / archiveOf", async () => {
  const v = leanVault([thread("a", "!a:hs", "Alpha", 3)]);
  await ingestMatrix({ sync: async () => ({ nextBatch: "s", invites: [], rooms: [] }) }, v.vault);
  await reconcileMatrix({ joinedRooms: async () => [], messagesBefore: async () => ({ messages: [], capped: false }), joinedMembers: async () => ({}), roomName: async () => null }, v.vault, { upTo: "s" });
  assert.equal(v.lists.length, 2);
  for (const l of v.lists) assert.deepEqual(l, { tags: ["message-thread"], pathPrefix: undefined, includeContent: false, includeMetadata: ["matrixRoomId", "lastMessageAt", "archiveOf"] });
  assert.equal(v.gets.length, 0);
  assert.equal(v.writes.length, 0);
});

test("a room with new messages costs exactly ONE body read and ONE write, built on the body the vault holds NOW", async () => {
  const v = leanVault([thread("a", "!a:hs", "Alpha", 3), thread("z", "!z:hs", "Zed", 3)]);
  // Someone wrote the thread after the pass listed it (another writer, a restore): the
  // append must land on THAT body, with THAT metadata — the listing's row is not a source.
  const realList = v.vault.listNotes.bind(v.vault);
  v.vault.listNotes = async (o) => {
    const rows = await realList(o);
    const cur = v.notes.get("a")!;
    v.notes.set("a", { ...cur, content: `${cur.content}\n${line(3, "Other", "written after the listing")}`, metadata: { ...cur.metadata, messageCount: 4, lastMessageAt: T0 + 3 * 60_000, participants: ["One", "Other"] }, updatedAt: "u-later" });
    return rows;
  };
  const res = await ingestMatrix({ sync: async () => ({ nextBatch: "s", invites: [], rooms: [batch("!a:hs", "Alpha", [m(10)])] }) }, v.vault);
  assert.equal(res.updated, 1);
  assert.deepEqual(v.gets, ["a"], "one body read, of the room that has news — never of !z");
  const updates = v.writes.filter((w) => w.op === "update");
  assert.equal(updates.length, 1);
  const a = v.notes.get("a")!;
  assert.deepEqual(parseThread(a.content).entries, [line(0), line(1), line(2), line(3, "Other", "written after the listing"), line(10)]);
  assert.equal(a.metadata!.messageCount, 5);
  assert.deepEqual(a.metadata!.participants, ["One", "Other"]);
  assert.equal(a.metadata!.custom, "kept");
});

test("a NEW room reads no body; the same-name path collision is still decided from the (lean) listing", async () => {
  const v = leanVault([thread("dup", "!dup1:hs", "Same", 2)]);
  const res = await ingestMatrix({ sync: async () => ({ nextBatch: "s", invites: [], rooms: [batch("!dup2:hs", "Same", [m(1)])] }) }, v.vault);
  assert.equal(res.created, 1);
  assert.equal(v.gets.length, 0);
  const creates = v.writes.filter((w) => w.op === "create");
  assert.equal(creates.length, 1, "no 409 eaten first");
  assert.equal(creates[0]!.path, "vault/messages/telegram/same-dup2");
});

test("dedupe (repair paths) runs on the FRESH body: a line that reached the note after the listing is not appended twice", async () => {
  const v = leanVault([thread("q", "!q:hs", "Quiet", 3)]);
  const realList = v.vault.listNotes.bind(v.vault);
  v.vault.listNotes = async (o) => {
    const rows = await realList(o);
    const cur = v.notes.get("q")!; // the incremental pass appended m(3) meanwhile
    v.notes.set("q", { ...cur, content: `${cur.content}\n${line(3)}`, updatedAt: "u-later" });
    return rows;
  };
  const client = {
    joinedRooms: async () => ["!q:hs"],
    messagesBefore: async (_r: string, o: { cap?: number }) => (o.cap === 1 ? { messages: [m(4)], capped: false } : { messages: [m(2), m(3), m(4)], capped: false }),
    joinedMembers: async () => ({ "@telegram_1:hs": "One" }),
    roomName: async () => null,
  };
  const r = await reconcileMatrix(client, v.vault, { upTo: "c" });
  assert.equal(r.repaired, 1);
  assert.deepEqual(parseThread(v.notes.get("q")!.content).entries, [line(0), line(1), line(2), line(3), line(4)]);
  assert.deepEqual(v.gets, ["q"]);
});

// ── rollover under a lean listing ───────────────────────────────────────────

test("sweep: an oversized thread is found from the row's byteSize, read once, rolled; small threads are never read; a re-run reads nothing", async () => {
  const quiet = console.log;
  console.log = () => {};
  try {
    const v = leanVault([thread("big", "!big:hs", "Big", 60), thread("s1", "!s1:hs", "Small", 2), thread("s2", "!s2:hs", "Tiny", 1)]);
    const before = parseThread(v.notes.get("big")!.content).entries;
    await ingestMatrix({ sync: async () => ({ nextBatch: "s", invites: [], rooms: [] }) }, v.vault);
    assert.deepEqual(v.gets, ["big"]);
    assert.ok(Buffer.byteLength(v.notes.get("big")!.content) <= LIMITS.maxBytes);
    assert.deepEqual(allEntries(v.notes, "big"), before, "nothing lost, nothing duplicated, order kept");
    const writes = v.writes.length;
    await ingestMatrix({ sync: async () => ({ nextBatch: "s", invites: [], rooms: [] }) }, v.vault);
    assert.deepEqual(v.gets, ["big"], "the second pass reads no body");
    assert.equal(v.writes.length, writes, "and writes nothing");
  } finally {
    console.log = quiet;
  }
});

test("sweep: a stale row (byteSize says oversized, the body no longer is) is re-checked on the fresh body and not written", async () => {
  const v = leanVault([thread("big", "!big:hs", "Big", 60)]);
  const rows = await v.vault.listNotes({ tags: ["message-thread"], includeContent: false, includeMetadata: THREAD_LIST_KEYS });
  v.notes.set("big", thread("big", "!big:hs", "Big", 2)); // trimmed by someone else since
  const r = await sweepOversizedThreads(v.vault, new Map([["!big:hs", rows[0]!]]));
  assert.deepEqual(r, { rolled: 0, archives: 0 });
  assert.equal(v.writes.length, 0);
});

test("crash between archive and trim, seen through a lean listing: the next pass trims without a second archive and loses nothing", async () => {
  const quiet = console.log;
  const quietErr = console.error;
  const quietWarn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    const v = leanVault([thread("big", "!big:hs", "Big", 60)]);
    const before = parseThread(v.notes.get("big")!.content).entries;
    v.failures.push({ op: "update", error: new VaultStatusError(500, "PATCH: 500") });
    await ingestMatrix({ sync: async () => ({ nextBatch: "s", invites: [], rooms: [] }) }, v.vault); // archive(s) written, trim fails
    const archives = [...v.notes.values()].filter((n) => n.tags?.includes(ARCHIVE_TAG)).length;
    assert.ok(archives >= 1);
    assert.equal(parseThread(v.notes.get("big")!.content).entries.length, 60, "live note untrimmed");
    // The next pass also brings a new message for that room.
    await ingestMatrix({ sync: async () => ({ nextBatch: "s2", invites: [], rooms: [batch("!big:hs", "Big", [m(900)])] }) }, v.vault);
    assert.equal([...v.notes.values()].filter((n) => n.tags?.includes(ARCHIVE_TAG)).length, archives, "no archive written twice");
    assert.deepEqual(allEntries(v.notes, "big"), [...before, line(900)]);
    assert.ok(Buffer.byteLength(v.notes.get("big")!.content) <= LIMITS.maxBytes);
  } finally {
    console.log = quiet;
    console.error = quietErr;
    console.warn = quietWarn;
  }
});

test("a vault whose lean rows carry NO byteSize: sizes are learned by a bounded number of body reads per pass, once per version — and the oversized thread is still rolled", async () => {
  const quiet = console.log;
  console.log = () => {};
  try {
    const n = SIZE_PROBES_PER_PASS * 2 + 5;
    const seed = Array.from({ length: n }, (_, i) => thread(`t${i}`, `!r${i}:hs`, `Room${i}`, 2));
    seed[n - 1] = thread(`t${n - 1}`, `!r${n - 1}:hs`, `Room${n - 1}`, 60); // the last one listed is oversized
    const v = leanVault(seed, { byteSize: false });
    const idle = { sync: async (): Promise<SyncResult> => ({ nextBatch: "s", invites: [], rooms: [] }) };
    await ingestMatrix(idle, v.vault);
    assert.equal(v.gets.length, SIZE_PROBES_PER_PASS, "bounded");
    await ingestMatrix(idle, v.vault);
    assert.equal(v.gets.length, SIZE_PROBES_PER_PASS * 2);
    assert.equal(new Set(v.gets).size, v.gets.length, "no thread sized twice");
    await ingestMatrix(idle, v.vault);
    assert.equal(new Set(v.gets).size, n, "every thread sized within ceil(n / budget) passes");
    assert.ok(Buffer.byteLength(v.notes.get(`t${n - 1}`)!.content) <= LIMITS.maxBytes, "the oversized one was rolled over");
    const reads = v.gets.length;
    await ingestMatrix(idle, v.vault);
    await ingestMatrix(idle, v.vault);
    // Only the thread the rollover rewrote has a new version to size; nothing else is read again.
    assert.ok(v.gets.length - reads <= 1, `settled: ${v.gets.length - reads} further read(s)`);
  } finally {
    console.log = quiet;
  }
});

test("an append that crosses the limit rolls over in that same write even when the listing gave no size at all", async () => {
  const quiet = console.log;
  console.log = () => {};
  try {
    const v = leanVault([thread("b", "!b:hs", "Busy", 18)], { byteSize: false });
    const before = parseThread(v.notes.get("b")!.content).entries;
    const news = Array.from({ length: 14 }, (_, i) => m(100 + i));
    await ingestMatrix({ sync: async () => ({ nextBatch: "s", invites: [], rooms: [batch("!b:hs", "Busy", news)] }) }, v.vault, {});
    assert.ok(Buffer.byteLength(v.notes.get("b")!.content) <= LIMITS.maxBytes);
    assert.deepEqual(allEntries(v.notes, "b"), [...before, ...news.map((x, i) => line(100 + i))]);
    assert.equal(v.notes.get("b")!.metadata!.messageCount, 32);
  } finally {
    console.log = quiet;
  }
});

test("a thread that vanished between the listing and its write fails that room only — nothing is created in its place", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const v = leanVault([thread("a", "!a:hs", "Alpha", 3), thread("b", "!b:hs", "Beta", 3)]);
    const realList = v.vault.listNotes.bind(v.vault);
    v.vault.listNotes = async (o) => {
      const rows = await realList(o);
      v.notes.delete("a");
      return rows;
    };
    const res = await ingestMatrix({ sync: async () => ({ nextBatch: "s9", invites: [], rooms: [batch("!a:hs", "Alpha", [m(10)]), batch("!b:hs", "Beta", [m(11)])] }) }, v.vault);
    assert.equal(res.nextBatch, "s9");
    assert.equal(v.writes.filter((w) => w.op === "create").length, 0);
    assert.deepEqual(parseThread(v.notes.get("b")!.content).entries.at(-1), line(11));
  } finally {
    console.warn = quiet;
  }
});

// ── scale ───────────────────────────────────────────────────────────────────

test("1,500 threads, idle pass + full reconcile sweep: zero body reads, zero writes, event loop never held 200 ms", async () => {
  process.env.MATRIX_THREAD_MAX_BYTES = "1000000";
  process.env.MATRIX_THREAD_KEEP_BYTES = "200000";
  const N = 1500;
  const body = Array.from({ length: 40 }, (_, i) => line(i)).join("\n"); // ~2.5 KB each
  const seed: Note[] = Array.from({ length: N }, (_, i) => ({
    id: `t${i}`,
    path: `vault/messages/telegram/room-${i}`,
    tags: ["message-thread"],
    metadata: { type: "message-thread", platform: "telegram", matrixRoomId: `!r${i}:hs`, lastMessageAt: T0 + 39 * 60_000, messageCount: 40, participants: ["One", "Two", "Three"] },
    content: `# Room ${i} — telegram\n\n${body}`,
    createdAt: "t",
    updatedAt: `u${i}`,
  }));
  const v = leanVault(seed);
  const client = {
    sync: async (): Promise<SyncResult> => ({ nextBatch: "s2", invites: [], rooms: [] }),
    joinedRooms: async () => seed.map((n) => n.metadata!.matrixRoomId as string),
    messagesBefore: async () => ({ messages: [m(39)], capped: false }),
    joinedMembers: async () => ({}),
    roomName: async () => null,
  };
  // The loop's worst stall in CPU time of this thread (./probe) — not a wall-clock histogram, which also counts
  // every moment the scheduler kept this process off a core.
  const run = await probed(async () => ({ res: await ingestMatrix(client, v.vault, { since: "s1" }), rec: await reconcileMatrix(client, v.vault, { upTo: "s2" }) }));
  if (run.error !== undefined) throw run.error;
  const { res, rec } = run.value!;
  assert.equal(res.messages, 0);
  assert.deepEqual({ scanned: rec.scanned, behind: rec.behind, repaired: rec.repaired }, { scanned: N, behind: 0, repaired: 0 });
  assert.equal(v.gets.length, 0, "no body fetched");
  assert.equal(v.writes.length, 0);
  assert.equal(v.lists.length, 2);
  for (const l of v.lists) assert.equal(l.includeContent, false);
  const maxLagMs = run.maxLagMs;
  assert.ok(maxLagMs < 200, `max event-loop delay ${maxLagMs.toFixed(1)} ms`);
});

// ── the reconcile probe asks the homeserver for ONE event ───────────────────

function fakeHomeserver(pages: Array<{ chunk: unknown[]; end?: string }>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    urls.push(String(input));
    const page = pages[Math.min(urls.length - 1, pages.length - 1)]!;
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const limits = () => urls.map((u) => Number(new URL(u).searchParams.get("limit")));
  return { client: new MatrixClient({ homeserver: "http://hs.test", accessToken: "t" } as never, fetchImpl), urls, limits };
}
const ev = (id: string, ts: number, body: string | null = id) => ({ type: "m.room.message", sender: "@a:hs", event_id: id, origin_server_ts: ts, content: body === null ? {} : { body } });

test("messagesBefore: cap 1 (the reconcile probe) requests limit=1 and stops after one page", async () => {
  const hs = fakeHomeserver([{ chunk: [ev("$new", 9)], end: "t1" }]);
  const r = await hs.client.messagesBefore("!r:hs", { from: "cursor", cap: 1 });
  assert.deepEqual(r.messages.map((x) => x.eventId), ["$new"]);
  assert.deepEqual(hs.limits(), [1]);
  assert.match(hs.urls[0]!, /dir=b/);
  assert.match(hs.urls[0]!, /from=cursor/);
});

test("messagesBefore: a first small page with no usable message (body-less newest event, or an empty page with more to come) continues with full pages — the newest real message is still found", async () => {
  const redacted = fakeHomeserver([{ chunk: [ev("$gone", 9, null)], end: "t1" }, { chunk: [ev("$real", 8)], end: "t2" }]);
  assert.deepEqual((await redacted.client.messagesBefore("!r:hs", { from: "c", cap: 1 })).messages.map((x) => x.eventId), ["$real"]);
  assert.deepEqual(redacted.limits(), [1, 100]);
  const lateFilter = fakeHomeserver([{ chunk: [], end: "t1" }, { chunk: [ev("$real", 8)], end: "t2" }]);
  assert.deepEqual((await lateFilter.client.messagesBefore("!r:hs", { from: "c", cap: 1 })).messages.map((x) => x.eventId), ["$real"]);
  assert.deepEqual(lateFilter.limits(), [1, 100]);
  // A room with nothing at all: one request, no loop.
  const empty = fakeHomeserver([{ chunk: [] }]);
  assert.deepEqual(await empty.client.messagesBefore("!r:hs", { from: "c", cap: 1 }), { messages: [], capped: false });
  assert.deepEqual(empty.limits(), [1]);
  // …and an empty page whose token does not move ends it too.
  const stuck = fakeHomeserver([{ chunk: [], end: "c" }]);
  await stuck.client.messagesBefore("!r:hs", { from: "c", cap: 1 });
  assert.deepEqual(stuck.limits(), [1]);
});

test("messagesBefore: gap-fill paging is unchanged — full pages of 100 until the boundary", async () => {
  const hs = fakeHomeserver([{ chunk: [ev("$3", 30), ev("$2", 20)], end: "t1" }, { chunk: [ev("$1", 10), ev("$0", 5)], end: "t2" }, { chunk: [] }]);
  const r = await hs.client.messagesBefore("!r:hs", { from: "c", sinceTs: 10 });
  assert.deepEqual(r.messages.map((x) => x.eventId), ["$1", "$2", "$3"], "oldest first, boundary-equal kept");
  assert.deepEqual(hs.limits(), [100, 100]);
  const toEnd = fakeHomeserver([{ chunk: [ev("$3", 30)], end: "t1" }, { chunk: [] , end: "t2" }]);
  await toEnd.client.messagesBefore("!r:hs", { from: "c", to: "prev" });
  assert.deepEqual(toEnd.limits(), [100, 100]);
  assert.match(toEnd.urls[0]!, /to=prev/);
});
