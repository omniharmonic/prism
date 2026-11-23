// The history half of Comms search (D12: "text search reaches all history through the vault"):
// the vault's message-thread notes and their rollover archives (message-archive) are indexed into
// comms_search_rows in small, resumable batches.
//
//   sync   ONE lean listing per tag (no bodies): every note's id / path / updatedAt goes into
//          comms_search_sources; a note whose version changed becomes `pending`; a note that left
//          the listing has its rows dropped. Runs at start, every SYNC_EVERY_MS, and on a resync.
//   batch  up to BATCH_NOTES pending notes (newest first) are read ONE AT A TIME, parsed and their
//          rows replaced; then the next batch after BATCH_PAUSE_MS. The state is in SQLite, so a
//          restart resumes where it stopped. A note that fails is retried (5 tries per version).
//   live   a tree change on a thread/archive note marks it pending (no vault read) and wakes the loop.
//
// A search request never reads the vault.
import { resolveVaultEntry, db } from "../db";
import { config } from "../config";
import { vaultClient, type Note } from "../parachute";
import { subscribeTreeChanges, type TreeChange } from "../tree";
import { parseThread, ARCHIVE_TAG } from "../worker/matrix-rollover";
import { foldSearch } from "./search-text";
import { dropNoteRows, pruneMedia, replaceNoteRows, searchIndexingEnabled, type TranscriptEntry } from "./search-index";

export const THREAD_TAG = "message-thread";
const BATCH_NOTES = 5;
const BATCH_PAUSE_MS = 1_500;
const SYNC_EVERY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;
/** The shortest time between two re-indexes of one note (review I2). */
export const REINDEX_MIN_MS = 10 * 60_000;

const ENTRY = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] ([^\n]{1,200}?): ([\s\S]*)$/;

/** The messages of a transcript body (`[YYYY-MM-DD HH:MM] Name: body` + continuation lines, UTC). */
export function parseTranscript(content: string, selfNames: ReadonlySet<string> = new Set()): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const e of parseThread(content).entries) {
    const m = ENTRY.exec(e);
    if (!m) continue; // "[unknown]" stamps cannot be placed in time
    const sentAt = Date.parse(`${m[1]!.replace(" ", "T")}:00.000Z`);
    if (!Number.isFinite(sentAt)) continue;
    const sender = m[2]!.trim();
    out.push({ sentAt, sender, body: m[3]!, fromSelf: selfNames.has(foldSearch(sender)) });
  }
  return out;
}

/** The thread note an archive belongs to: `<threadPath>/archive/<NNN>`. */
export const archiveParentPath = (path: string | null): string | null => {
  const i = path?.lastIndexOf("/archive/") ?? -1;
  return path && i > 0 ? path.slice(0, i) : null;
};

export interface HistorySource {
  list(tag: string): Promise<Pick<Note, "id" | "path" | "updatedAt" | "tags">[]>;
  read(id: string): Promise<Pick<Note, "id" | "content" | "updatedAt" | "path">>;
}

/** Record the vault's current thread + archive notes; returns how many became pending. */
export async function syncSources(src: HistorySource): Promise<{ notes: number; pending: number; dropped: number }> {
  const threads = await src.list(THREAD_TAG);
  const archives = await src.list(ARCHIVE_TAG);
  const byPath = new Map<string, string>();
  for (const t of threads) if (t.path) byPath.set(t.path.toLowerCase(), t.id);
  const want = new Map<string, { path: string | null; threadNote: string; updatedAt: string | null }>();
  for (const t of threads) want.set(t.id, { path: t.path, threadNote: t.id, updatedAt: t.updatedAt });
  for (const a of archives) {
    const parent = archiveParentPath(a.path);
    const threadNote = parent ? byPath.get(parent.toLowerCase()) : undefined;
    if (threadNote) want.set(a.id, { path: a.path, threadNote, updatedAt: a.updatedAt });
  }
  const have = new Map((db.prepare(`SELECT note_id, updated_at, indexed_at, state FROM comms_search_sources`).all() as {
    note_id: string; updated_at: string | null; indexed_at: string | null; state: string;
  }[]).map((r) => [r.note_id, r]));
  let pending = 0, dropped = 0;
  const up = db.prepare(`INSERT INTO comms_search_sources (note_id, path, thread_note_id, updated_at, state, attempts) VALUES (?, ?, ?, ?, 'pending', 0)
    ON CONFLICT(note_id) DO UPDATE SET path = excluded.path, thread_note_id = excluded.thread_note_id, updated_at = excluded.updated_at,
      state = CASE WHEN comms_search_sources.indexed_at IS excluded.updated_at AND comms_search_sources.state = 'done' THEN 'done' ELSE 'pending' END,
      attempts = CASE WHEN comms_search_sources.updated_at IS excluded.updated_at THEN comms_search_sources.attempts ELSE 0 END`);
  db.transaction(() => {
    for (const [id, w] of want) {
      const h = have.get(id);
      if (h && h.state === "done" && h.indexed_at === w.updatedAt) continue;
      if (h && h.state === "failed" && h.updated_at === w.updatedAt) continue; // same broken version: wait for a change
      up.run(id, w.path, w.threadNote, w.updatedAt);
      pending++;
    }
    for (const id of have.keys()) {
      if (want.has(id)) continue;
      dropNoteRows(id);
      db.prepare(`DELETE FROM comms_search_sources WHERE note_id = ?`).run(id);
      dropped++;
    }
  })();
  return { notes: want.size, pending, dropped };
}

/** Index up to `n` pending notes (newest first). Returns how many were processed. */
export async function indexBatch(src: HistorySource, n = BATCH_NOTES, selfNames: ReadonlySet<string> = new Set(), now = Date.now()): Promise<number> {
  // A note indexed in the last REINDEX_MIN_MS waits (review I2): a busy thread note changes with
  // every message, and those messages are already indexed live — its transcript is diffed again
  // at most once per interval.
  const rows = db.prepare(`SELECT note_id, thread_note_id, updated_at FROM comms_search_sources WHERE state = 'pending'
    AND (indexed_ms IS NULL OR indexed_ms <= ?) ORDER BY updated_at DESC, note_id LIMIT ?`).all(now - REINDEX_MIN_MS, n) as { note_id: string; thread_note_id: string; updated_at: string | null }[];
  for (const r of rows) {
    try {
      const note = await src.read(r.note_id);
      const entries = parseTranscript(note.content ?? "", selfNames);
      replaceNoteRows(r.note_id, r.thread_note_id, entries);
      // Indexed AS OF the version read; a newer write since then makes it pending again (sync / tree).
      db.prepare(`UPDATE comms_search_sources SET state = CASE WHEN updated_at IS ? OR ? IS NULL THEN 'done' ELSE 'pending' END,
        indexed_at = ?, entries = ?, attempts = 0, indexed_ms = ? WHERE note_id = ?`).run(note.updatedAt, r.updated_at, note.updatedAt ?? r.updated_at, entries.length, now, r.note_id);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 404) {
        dropNoteRows(r.note_id);
        db.prepare(`DELETE FROM comms_search_sources WHERE note_id = ?`).run(r.note_id);
        continue;
      }
      db.prepare(`UPDATE comms_search_sources SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE note_id = ?`)
        .run(MAX_ATTEMPTS, r.note_id);
      console.warn(`[comms] history index read failed: ${e instanceof Error ? e.name : "error"}${status ? ` vault_${status}` : ""}`);
      break; // a failing vault: stop this batch, the loop tries later
    }
  }
  return rows.length;
}

/** A tree change on a thread / archive note: mark it pending (no read). Returns true when it did. */
export function noteChanged(change: TreeChange): boolean {
  if (change.kind === "remove") {
    if (!db.prepare(`SELECT 1 FROM comms_search_sources WHERE note_id = ?`).get(change.id)) return false;
    dropNoteRows(change.id);
    db.prepare(`DELETE FROM comms_search_sources WHERE note_id = ?`).run(change.id);
    return true;
  }
  if (change.kind !== "upsert") return false;
  const row = change.row;
  if (row.trashedAt) return false;
  const isThread = row.tags.includes(THREAD_TAG);
  if (!isThread && !row.tags.includes(ARCHIVE_TAG)) return false;
  let threadNote: string | null = row.id;
  if (!isThread) {
    const parent = archiveParentPath(row.path);
    threadNote = parent
      ? (db.prepare(`SELECT note_id FROM comms_search_sources WHERE lower(path) = lower(?) AND note_id = thread_note_id LIMIT 1`).get(parent) as { note_id: string } | undefined)?.note_id ?? null
      : null;
    if (!threadNote) return false; // the next sync places it
  }
  const cur = db.prepare(`SELECT indexed_at, state FROM comms_search_sources WHERE note_id = ?`).get(row.id) as { indexed_at: string | null; state: string } | undefined;
  if (cur?.state === "done" && cur.indexed_at === row.updatedAt) return false;
  db.prepare(`INSERT INTO comms_search_sources (note_id, path, thread_note_id, updated_at, state, attempts) VALUES (?, ?, ?, ?, 'pending', 0)
    ON CONFLICT(note_id) DO UPDATE SET path = excluded.path, thread_note_id = excluded.thread_note_id, updated_at = excluded.updated_at, state = 'pending', attempts = 0`)
    .run(row.id, row.path, threadNote, row.updatedAt);
  return true;
}

// ── the background loop ──────────────────────────────────────────────────────

let running = false;
let stopped = true;
let wake: (() => void) | null = null;
let unsubscribe: (() => void) | null = null;
let timer: NodeJS.Timeout | null = null;

const sleep = (ms: number) => new Promise<void>((r) => {
  timer = setTimeout(() => { timer = null; wake = null; r(); }, ms);
  timer.unref?.();
  wake = () => { if (timer) clearTimeout(timer); timer = null; wake = null; r(); };
});

/** Production source: the primary vault, lean listings + one body read per note. */
function liveSource(): HistorySource {
  const entry = resolveVaultEntry(undefined);
  const vault = vaultClient(entry.id, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? config.matrixVaultTimeoutMs : 30_000 });
  return {
    list: (tag) => vault.listNotes({ tags: [tag], includeContent: false, includeMetadata: ["platform"] }),
    read: (id) => vault.getNote(id),
  };
}

/** Startup hook (COMMS_ENABLED + COMMS_SEARCH_ENABLED): background, never throws. */
export function startCommsSearchIndexer(given?: HistorySource, selfNames: () => ReadonlySet<string> = () => new Set()): void {
  if (!searchIndexingEnabled() || running) return;
  const src = given ?? liveSource();
  running = true;
  stopped = false;
  let lastSync = 0;
  void subscribeTreeChanges(resolveVaultEntry(undefined), (c) => {
    if (c.kind === "resync") { lastSync = 0; wake?.(); return; }
    try { if (noteChanged(c)) wake?.(); } catch { /* the next sync settles it */ }
  }).then((off) => { if (stopped) off(); else unsubscribe = off; }).catch(() => { /* syncs alone keep it current */ });
  void (async () => {
    await sleep(15_000); // let the server finish starting
    while (!stopped) {
      try {
        if (Date.now() - lastSync > SYNC_EVERY_MS) {
          await syncSources(src);
          lastSync = Date.now();
        }
        pruneMedia();
        const n = await indexBatch(src, BATCH_NOTES, selfNames());
        await sleep(n ? BATCH_PAUSE_MS : 60_000);
      } catch (e) {
        console.warn(`[comms] history index pass failed: ${e instanceof Error ? e.name : "error"}`);
        await sleep(60_000);
      }
    }
    running = false;
  })();
}

export function stopCommsSearchIndexer(): void {
  stopped = true;
  unsubscribe?.();
  unsubscribe = null;
  wake?.();
}
