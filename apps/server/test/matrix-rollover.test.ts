/**
 * Message-thread rollover (vault ≥0.7.9 refuses updates to >2 MB notes while
 * history is on). A stateful fake vault models path_prefix listing,
 * if_updated_at conflicts and injected failures, so the crash-between-steps and
 * retry paths are exercised without a live vault.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseThread, rolloverThread, ARCHIVE_TAG, type RolloverVault } from "../src/worker/matrix-rollover";
import { ingestMatrix, sweepOversizedThreads, type SyncResult } from "../src/worker/matrix";
import type { Note } from "../src/parachute";

const LIMITS = { maxBytes: 400, keepBytes: 120 };

afterEach(() => {
  delete process.env.MATRIX_THREAD_MAX_BYTES;
  delete process.env.MATRIX_THREAD_KEEP_BYTES;
});

class VaultStatusError extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
  }
}

function statefulVault(seed: Note[]) {
  const notes = new Map(seed.map((n) => [n.id, { ...n }]));
  let clock = 1;
  let seq = 0;
  const failures: Array<{ op: "update" | "create"; error: Error }> = [];
  const log: string[] = [];
  const vault: RolloverVault & { removeTags?: (id: string, t: string[]) => Promise<void> } = {
    async listNotes(o) {
      return [...notes.values()].filter(
        (n) =>
          (!o.pathPrefix || (n.path ?? "").startsWith(o.pathPrefix)) &&
          (!o.tags?.length || o.tags.every((t) => n.tags?.includes(t))),
      ).map((n) => (o.includeContent === false ? { ...n, content: "" } : { ...n }));
    },
    async getNote(id) {
      return { ...notes.get(id)! };
    },
    async createNote(p) {
      const f = failures.findIndex((x) => x.op === "create");
      if (f !== -1) throw failures.splice(f, 1)[0]!.error;
      const n: Note = { id: `c${++seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "t", updatedAt: `u${clock++}` };
      notes.set(n.id, n);
      log.push(`create ${p.path}`);
      return n;
    },
    async updateNote(id, p) {
      const f = failures.findIndex((x) => x.op === "update");
      if (f !== -1) throw failures.splice(f, 1)[0]!.error;
      const cur = notes.get(id)!;
      if (p.ifUpdatedAt !== undefined && p.ifUpdatedAt !== cur.updatedAt) throw new VaultStatusError(409, "PATCH: 409");
      const next = { ...cur, ...(p.content !== undefined ? { content: p.content } : {}), ...(p.metadata ? { metadata: p.metadata } : {}), updatedAt: `u${clock++}` };
      notes.set(id, next);
      log.push(`update ${id}`);
      return next;
    },
    async removeTags() {},
  };
  return { vault, notes, failures, log };
}

const entry = (i: number, extra = "") => `[2026-01-${String((i % 28) + 1).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}] Person ${i}: message number ${i}${extra}`;
const threadNote = (n: number, multiline = false): Note => ({
  id: "t1",
  path: "vault/messages/telegram/busy",
  tags: ["message-thread"],
  metadata: { type: "message-thread", matrixRoomId: "!busy:hs", platform: "telegram", messageCount: n },
  content: `# Busy — telegram\n\n${Array.from({ length: n }, (_, i) => entry(i, multiline && i % 3 === 0 ? `\n> quoted line ${i}\n\n> more ${i}` : "")).join("\n")}`,
  createdAt: "t",
  updatedAt: "u0",
});

/** Every message entry across the live note + its archives, oldest first. */
function allEntries(notes: Map<string, Note>): string[] {
  const archives = [...notes.values()].filter((n) => n.tags?.includes(ARCHIVE_TAG)).sort((a, b) => (a.path! < b.path! ? -1 : 1));
  const live = notes.get("t1")!;
  return [...archives.flatMap((a) => parseThread(a.content).entries), ...parseThread(live.content).entries];
}

test("parseThread keeps multi-line bodies whole and drops an old pointer line from the header", () => {
  const p = parseThread("# T — x\n\n> Earlier messages: [[a/archive/001]] (1 archive note)\n\n[2026-01-01 00:00] A: hi\n> quote\n\n[unknown] B: yo");
  assert.equal(p.header, "# T — x");
  assert.deepEqual(p.entries, ["[2026-01-01 00:00] A: hi\n> quote\n", "[unknown] B: yo"]);
});

test("rollover moves the OLDEST entries at entry boundaries, keeps header + newest, loses nothing", async () => {
  const original = parseThread(threadNote(30, true).content).entries;
  const { vault, notes } = statefulVault([threadNote(30, true)]);
  const out = await rolloverThread(vault, notes.get("t1")!, { limits: LIMITS });
  assert.ok(out && out.created >= 1);
  const live = notes.get("t1")!;
  assert.match(live.content, /^# Busy — telegram\n\n> Earlier messages: \[\[vault\/messages\/telegram\/busy\/archive\/\d{3}\]\]/);
  assert.ok(Buffer.byteLength(live.content) <= LIMITS.maxBytes);
  assert.deepEqual(allEntries(notes), original); // exact, ordered, no dupes, no loss
  // newest kept live
  assert.equal(parseThread(live.content).entries.at(-1), original.at(-1));
  assert.equal(live.metadata?.matrixRoomId, "!busy:hs");
  assert.equal(live.metadata?.archiveCount, out!.created);
});

test("archives are message-archive (never message-thread), carry no matrixRoomId, and stay under maxBytes", async () => {
  const { vault, notes } = statefulVault([threadNote(60)]);
  await rolloverThread(vault, notes.get("t1")!, { limits: LIMITS });
  const archives = [...notes.values()].filter((n) => n.id !== "t1");
  assert.ok(archives.length >= 2, "chunked into several archives");
  for (const a of archives) {
    assert.deepEqual(a.tags, [ARCHIVE_TAG]);
    assert.equal(a.metadata?.matrixRoomId, undefined);
    assert.equal(a.metadata?.archiveOf, "t1");
    assert.equal(a.metadata?.archivedRoomId, "!busy:hs");
    assert.ok(Buffer.byteLength(parseThread(a.content).entries.join("\n")) <= LIMITS.maxBytes);
    assert.equal(a.metadata?.lineCount, parseThread(a.content).entries.length);
    assert.equal(typeof a.metadata?.fromTs, "number");
  }
  assert.deepEqual(archives.map((a) => a.path), archives.map((_, i) => `vault/messages/telegram/busy/archive/${String(i + 1).padStart(3, "0")}`));
  assert.match(archives[1]!.content, /Previous archive: \[\[vault\/messages\/telegram\/busy\/archive\/001\]\]/);
});

test("a crash AFTER the archive is created but BEFORE the trim neither duplicates nor drops on the next run", async () => {
  const original = parseThread(threadNote(40).content).entries;
  const { vault, notes, failures } = statefulVault([threadNote(40)]);
  failures.push({ op: "update", error: new Error("PATCH: 500 boom") });
  await assert.rejects(rolloverThread(vault, notes.get("t1")!, { limits: LIMITS }));
  const afterCrash = [...notes.values()].filter((n) => n.id !== "t1").length;
  assert.ok(afterCrash >= 1, "archives were written first");
  assert.equal(parseThread(notes.get("t1")!.content).entries.length, 40, "live note untouched");

  const out = await rolloverThread(vault, notes.get("t1")!, { limits: LIMITS });
  assert.ok(out && out.recovered > 0, "recognised the orphaned archive block");
  assert.deepEqual(allEntries(notes), original);
});

test("a crash midway through a multi-archive rollover recovers the partial set", async () => {
  const original = parseThread(threadNote(60).content).entries;
  const { vault, notes, failures } = statefulVault([threadNote(60)]);
  // first archive lands, second create fails
  const realCreate = vault.createNote.bind(vault);
  let n = 0;
  vault.createNote = async (p) => {
    if (++n === 2) throw new Error("POST: 503");
    return realCreate(p);
  };
  await assert.rejects(rolloverThread(vault, notes.get("t1")!, { limits: LIMITS }));
  vault.createNote = realCreate;
  void failures;
  await rolloverThread(vault, notes.get("t1")!, { limits: LIMITS });
  assert.deepEqual(allEntries(notes), original);
});

test("a 409 on the trim re-reads the note and retries without a second archive", async () => {
  const { vault, notes } = statefulVault([threadNote(40)]);
  const stale = { ...notes.get("t1")! };
  // someone appends in between our read and our trim
  const cur = notes.get("t1")!;
  notes.set("t1", { ...cur, content: `${cur.content}\n${entry(99)}`, updatedAt: "u-other" });
  const expected = parseThread(notes.get("t1")!.content).entries;
  const out = await rolloverThread(vault, stale, { limits: LIMITS });
  assert.ok(out);
  assert.deepEqual(allEntries(notes), expected);
});

test("rollover appends new lines in the SAME live write", async () => {
  const { vault, notes, log } = statefulVault([threadNote(30)]);
  const before = parseThread(notes.get("t1")!.content).entries;
  await rolloverThread(vault, notes.get("t1")!, { limits: LIMITS, appendEntries: [entry(500)], metadata: { lastMessageAt: 5 } });
  assert.equal(log.filter((l) => l.startsWith("update")).length, 1);
  assert.deepEqual(allEntries(notes), [...before, entry(500)]);
  assert.equal(notes.get("t1")!.metadata?.lastMessageAt, 5);
});

test("sweepOversizedThreads rolls only threads over the limit, and a re-run is a no-op", async () => {
  process.env.MATRIX_THREAD_MAX_BYTES = String(LIMITS.maxBytes);
  process.env.MATRIX_THREAD_KEEP_BYTES = String(LIMITS.keepBytes);
  const small: Note = { ...threadNote(2), id: "s1", path: "vault/messages/telegram/small", metadata: { matrixRoomId: "!small:hs" } };
  const { vault, notes } = statefulVault([threadNote(40), small]);
  const byRoom = new Map([["!busy:hs", notes.get("t1")!], ["!small:hs", notes.get("s1")!]]);
  const r1 = await sweepOversizedThreads(vault as never, byRoom);
  assert.equal(r1.rolled, 1);
  assert.equal(notes.get("s1")!.updatedAt, "u0", "small thread untouched");
  const archivesAfter1 = notes.size;
  const r2 = await sweepOversizedThreads(vault as never, byRoom);
  assert.deepEqual(r2, { rolled: 0, archives: 0 });
  assert.equal(notes.size, archivesAfter1);
});

test("ingestMatrix never adopts an archive as a room's thread, and rolls over on append past the limit", async () => {
  process.env.MATRIX_THREAD_MAX_BYTES = String(LIMITS.maxBytes);
  process.env.MATRIX_THREAD_KEEP_BYTES = String(LIMITS.keepBytes);
  // A hostile/legacy archive that even carries the room id and the thread tag.
  const rogue: Note = { id: "arch", path: "vault/messages/telegram/busy/archive/001", tags: ["message-thread", ARCHIVE_TAG], metadata: { matrixRoomId: "!busy:hs", archiveOf: "t1" }, content: "# x", createdAt: "t", updatedAt: "u0" };
  const live = threadNote(8); // under the limit before the append
  const { vault, notes } = statefulVault([rogue, live]);
  const many = Array.from({ length: 12 }, (_, i) => ({ sender: "@telegram_1:hs", body: `new message ${i} with some padding text`, ts: Date.UTC(2026, 1, 1, 0, i), eventId: `$n${i}` }));
  const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", invites: [], rooms: [{ roomId: "!busy:hs", name: "Busy", memberIds: ["@telegram_1:hs"], displayNames: { "@telegram_1:hs": "One" }, messages: many }] });
  const res = await ingestMatrix({ sync }, vault as never);
  assert.equal(res.updated, 1);
  assert.equal(notes.get("arch")!.content, "# x", "archive never written to");
  const t = notes.get("t1")!;
  assert.ok(Buffer.byteLength(t.content) <= LIMITS.maxBytes);
  assert.match(t.content, /new message 11/);
  assert.equal(t.metadata?.messageCount, 8 + 12);
});

test("a 413 on a plain append triggers a loud error and an immediate rollover", async () => {
  process.env.MATRIX_THREAD_MAX_BYTES = "100000"; // content is under this, so the normal path runs first
  process.env.MATRIX_THREAD_KEEP_BYTES = "150";
  const { vault, notes, failures } = statefulVault([threadNote(30)]);
  failures.push({ op: "update", error: new VaultStatusError(413, "PATCH /notes/t1: 413 history_overflow") });
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => errors.push(m);
  try {
    const sync = async (): Promise<SyncResult> => ({ nextBatch: "s", invites: [], rooms: [{ roomId: "!busy:hs", name: null, memberIds: [], displayNames: {}, messages: [{ sender: "@a:hs", body: "late", ts: Date.UTC(2026, 2, 1), eventId: "$l" }] }] });
    const res = await ingestMatrix({ sync }, vault as never);
    assert.equal(res.updated, 1);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /413/.test(e) && /rollover/.test(e)));
  assert.ok([...notes.values()].some((n) => n.tags?.includes(ARCHIVE_TAG)));
  assert.match(notes.get("t1")!.content, /a: late$/);
});
