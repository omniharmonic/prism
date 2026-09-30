/**
 * Message-thread rollover. A Matrix room is ONE note appended in place forever,
 * but vault ≥0.7.9 (note history on) refuses any update to a note whose prior
 * body is over 2,000,000 bytes (413 history_overflow). So a thread past
 * MATRIX_THREAD_MAX_BYTES has its OLDEST messages moved into immutable archive
 * notes at `<threadPath>/archive/<NNN>`, keeping the header + the newest
 * ~MATRIX_THREAD_KEEP_BYTES in the live note.
 *
 * Safety: archives are created FIRST, the live note is trimmed SECOND (with
 * if_updated_at). A crash in between leaves the moved block in BOTH places;
 * each archive records hashes of its first/last entry + its entry count, and the
 * next rollover recognises a live note that still starts with an archive's block
 * and just trims it — never archiving it twice, never dropping a line.
 *
 * Archives are tagged `message-archive` (never `message-thread`) and carry no
 * `matrixRoomId`, so the room→note map can never adopt one.
 */
import { createHash } from "node:crypto";
import type { Note } from "../parachute";

export const ARCHIVE_TAG = "message-archive";
const POINTER_PREFIX = "> Earlier messages: ";
const ENTRY_START = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}|unknown)\] /;

export interface RolloverLimits {
  /** Roll a thread over once its content exceeds this many UTF-8 bytes. */
  maxBytes: number;
  /** Bytes of newest messages kept in the live note after a rollover. */
  keepBytes: number;
}

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function rolloverLimits(): RolloverLimits {
  const maxBytes = envInt("MATRIX_THREAD_MAX_BYTES", 1_000_000);
  const keepBytes = Math.min(envInt("MATRIX_THREAD_KEEP_BYTES", 200_000), Math.floor(maxBytes / 2));
  return { maxBytes, keepBytes };
}

export const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");
const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** The vault surface rollover needs (a subset of IngestVault, plus getNote). */
export interface RolloverVault {
  listNotes(opts: { tags?: string[]; pathPrefix?: string; includeContent?: boolean }): Promise<Note[]>;
  createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note>;
  getNote?(id: string): Promise<Note>;
}

export interface ParsedThread {
  /** Lines before the first message entry, minus any old pointer line. */
  header: string;
  /** One string per message — a stamped line plus its continuation lines. */
  entries: string[];
}

/** Split a thread body into header + message entries (multi-line bodies stay whole). */
export function parseThread(content: string): ParsedThread {
  const lines = content.split("\n");
  const first = lines.findIndex((l) => ENTRY_START.test(l));
  if (first === -1) return { header: content, entries: [] };
  const header = lines
    .slice(0, first)
    .filter((l) => !l.startsWith(POINTER_PREFIX))
    .join("\n")
    .trimEnd();
  const entries: string[] = [];
  for (const l of lines.slice(first)) {
    if (ENTRY_START.test(l) || !entries.length) entries.push(l);
    else entries[entries.length - 1] += `\n${l}`;
  }
  return { header, entries };
}

/** `[YYYY-MM-DD HH:MM]` stamp → epoch ms (null for `[unknown]`). */
function entryTs(entry: string): number | null {
  const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]/.exec(entry);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : null;
}

const archiveNumber = (path: string | null, prefix: string): number => {
  if (!path?.startsWith(prefix)) return NaN;
  const n = Number(path.slice(prefix.length));
  return Number.isInteger(n) ? n : NaN;
};

function archivePrefix(thread: Note): string {
  return `${thread.path ?? `vault/messages/archive/${thread.id}`}/archive/`;
}

export interface RolloverOutcome {
  /** Archive notes created by this call. */
  created: number;
  /** Entries dropped from the live note because an earlier (interrupted) run had already archived them. */
  recovered: number;
  /** The live note as written (content/metadata/updatedAt), for the caller's map. */
  note: Note;
}

/**
 * Roll `thread` over, appending `appendEntries` (already-formatted new message
 * lines, possibly empty) in the SAME live-note write. `extraMeta` is merged into
 * the live note's metadata (the ingester's lastMessageAt/messageCount/…). No-op
 * write is avoided: returns null when the result would fit without a rollover.
 */
export async function rolloverThread(
  vault: RolloverVault,
  thread: Note,
  opts: { appendEntries?: string[]; metadata?: Record<string, unknown>; limits?: RolloverLimits; force?: boolean } = {},
): Promise<RolloverOutcome | null> {
  const limits = opts.limits ?? rolloverLimits();
  let note = thread;
  for (let attempt = 0; ; attempt++) {
    try {
      return await rolloverOnce(vault, note, { ...opts, limits });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const conflict = status === 409 || /\b409\b/.test(String(e));
      if (!conflict || attempt >= 2 || !vault.getNote) throw e;
      // Someone else wrote the thread between our read and our trim. Re-read and
      // redo — archives already created are recognised, not duplicated.
      note = await vault.getNote(thread.id);
    }
  }
}

async function rolloverOnce(
  vault: RolloverVault,
  thread: Note,
  opts: { appendEntries?: string[]; metadata?: Record<string, unknown>; limits: RolloverLimits; force?: boolean },
): Promise<RolloverOutcome | null> {
  const { maxBytes, keepBytes } = opts.limits;
  const parsed = parseThread(thread.content ?? "");
  let entries = [...parsed.entries, ...(opts.appendEntries ?? [])];
  const body = (es: string[]) => es.join("\n");
  if (!opts.force && byteLen(`${parsed.header}\n\n${body(entries)}`) <= maxBytes) return null;
  if (entries.length < 2) return null; // nothing splittable (one giant message) — leave it

  // Existing archives for this thread, oldest first.
  const prefix = archivePrefix(thread);
  const archives = (await vault.listNotes({ pathPrefix: prefix, includeContent: false }))
    .filter((n) => n.metadata?.archiveOf === thread.id && Number.isInteger(archiveNumber(n.path, prefix)))
    .sort((a, b) => archiveNumber(a.path, prefix) - archiveNumber(b.path, prefix));

  // Recovery: a previous run may have created archive(s) and died before the
  // trim. Such blocks are still at the head of the live entries, in order.
  let recovered = 0;
  const startIx = archives.findIndex((a) => blockMatches(a, entries, 0));
  if (startIx !== -1) {
    for (const a of archives.slice(startIx)) {
      if (!blockMatches(a, entries, recovered)) break;
      recovered += Number(a.metadata!.entryCount);
    }
    entries = entries.slice(recovered);
  }

  // Keep the newest entries up to keepBytes (always at least one).
  let keepFrom = entries.length - 1;
  let kept = byteLen(entries[keepFrom]!);
  while (keepFrom > 0 && kept + byteLen(entries[keepFrom - 1]!) + 1 <= keepBytes) {
    keepFrom--;
    kept += byteLen(entries[keepFrom]!) + 1;
  }
  const toMove = entries.slice(0, keepFrom);
  const keep = entries.slice(keepFrom);

  // Chunk the moved entries so no archive exceeds maxBytes.
  const chunks: string[][] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const e of toMove) {
    const b = byteLen(e) + 1;
    if (cur.length && curBytes + b > maxBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(e);
    curBytes += b;
  }
  if (cur.length) chunks.push(cur);

  const title = (parsed.header.split("\n")[0] ?? "").replace(/^#\s*/, "") || thread.path || thread.id;
  let next = archives.length ? archiveNumber(archives[archives.length - 1]!.path, prefix) + 1 : 1;
  let prevPath = archives.length ? archives[archives.length - 1]!.path : null;
  let created = 0;
  for (const chunk of chunks) {
    const path = `${prefix}${String(next).padStart(3, "0")}`;
    const fromTs = entryTs(chunk[0]!);
    const toTs = entryTs(chunk[chunk.length - 1]!);
    const header = [
      `# ${title} — archive ${String(next).padStart(3, "0")}`,
      "",
      `Archived from [[${thread.path ?? thread.id}]] — ${chunk.length} messages.`,
      ...(prevPath ? [`Previous archive: [[${prevPath}]]`] : []),
    ].join("\n");
    await vault.createNote({
      path,
      tags: [ARCHIVE_TAG],
      content: `${header}\n\n${body(chunk)}`,
      metadata: {
        type: "message-archive",
        archiveOf: thread.id,
        archivedRoomId: thread.metadata?.matrixRoomId ?? null,
        platform: thread.metadata?.platform ?? null,
        fromTs,
        toTs,
        lineCount: chunk.length,
        entryCount: chunk.length,
        firstEntryHash: hash(chunk[0]!),
        lastEntryHash: hash(chunk[chunk.length - 1]!),
      },
    });
    created++;
    prevPath = path;
    next++;
  }

  const archiveCount = archives.length + created;
  const newest = prevPath;
  const content = [
    parsed.header,
    ...(newest ? ["", `${POINTER_PREFIX}[[${newest}]] (${archiveCount} archive note${archiveCount === 1 ? "" : "s"})`] : []),
    "",
    body(keep),
  ].join("\n");
  const metadata = {
    ...(thread.metadata ?? {}),
    ...(opts.metadata ?? {}),
    archiveCount,
    ...(newest ? { lastArchivePath: newest } : {}),
  };
  const written = await vault.updateNote(thread.id, {
    content,
    metadata,
    ...(thread.updatedAt ? { ifUpdatedAt: thread.updatedAt } : {}),
  });
  return {
    created,
    recovered,
    note: { ...thread, content, metadata, updatedAt: written?.updatedAt ?? thread.updatedAt },
  };
}

/** Does archive `a`'s recorded block sit at `entries[at..]`? */
function blockMatches(a: Note, entries: string[], at: number): boolean {
  const m = a.metadata ?? {};
  const count = Number(m.entryCount);
  if (!Number.isInteger(count) || count < 1 || at + count > entries.length) return false;
  return hash(entries[at]!) === m.firstEntryHash && hash(entries[at + count - 1]!) === m.lastEntryHash;
}

/** True for notes the room→thread map must never adopt. */
export function isArchiveNote(n: Note): boolean {
  return Boolean(n.tags?.includes(ARCHIVE_TAG) || n.metadata?.archiveOf);
}

/** HTTP 413 from the vault (history_overflow / payload_too_large). */
export function isTooLarge(e: unknown): boolean {
  return (e as { status?: number }).status === 413 || /\b413\b/.test(String(e));
}
