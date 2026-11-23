// Comms full search (PRD §5.6, D12): an SQLite FTS5 index over every message Comms knows of —
// projected messages as they arrive (live) and the vault's message-thread transcripts (history,
// comms/search-vault.ts) — plus a Photos / Links index of projected messages (~90 days).
//
// Tables (db.ts): comms_search_rows (one message; rowid = its FTS row), comms_search_fts,
// comms_search_media. Everything here is rebuildable; nothing reaches a log.
//
// One message seen twice (live AND as a transcript line) is ONE row: dedupe_key = the thread note
// (or the thread, when it has no note) + the UTC minute + the folded body. A live row wins over a
// transcript row (it knows the message id and who sent it).
//
// Queries never reach FTS5 syntax: the text is reduced to letter/digit words, each quoted
// (`"word"`, the last one a prefix `"word"*`), ANDed, at most MAX_TERMS.
import { createHash } from "node:crypto";
import { db } from "../db";
import { config } from "../config";
import { foldSearch } from "./search-text";
import type { Attachment, LinkPreview, Message } from "./types";
import type { Span } from "./richtext";

export const MEDIA_DAYS = 90;
const DAY_MS = 86_400_000;
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 64;
const MAX_BODY_CHARS = 8_000;
/** The furthest a search pages (offset): enough for a person, bounded for the database. */
export const MAX_SEARCH_OFFSET = 2_000;
/** Private-use markers around a hit in FTS5 snippets (stripped from indexed text). */
const HL_OPEN = "";
const HL_CLOSE = "";
const MARKERS = /[]/g;

export const searchIndexingEnabled = (): boolean => config.commsEnabled && config.commsSearchEnabled;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);
const minuteOf = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

/** The dedupe key of a message: same thread note / minute / text = the same message. */
export function dedupeKey(scope: string, sentAt: number, body: string): string {
  return `${scope}|${minuteOf(sentAt)}|${sha(foldSearch(body))}`;
}

/**
 * The ONE normalisation of message text, applied identically to what is indexed and to the
 * query (review I1): NFKC (ligatures, full-width forms and compatibility characters become
 * their ordinary letters; Hangul and kana stay composed), the highlight markers removed. Case
 * and Latin diacritics are folded by the FTS5 tokenizer itself, on both sides.
 */
export const normalizeText = (s: string): string => s.normalize("NFKC").replace(MARKERS, "");
/** Text to index: normalised, bounded. */
const cleanBody = (s: string): string => normalizeText(s).slice(0, MAX_BODY_CHARS);

// ── query parsing (injection-safe) ───────────────────────────────────────────

const WORDISH = /[\p{L}\p{N}]/u;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * The FTS5 MATCH expression for what was typed, or null when it has no letter or digit.
 * Each whitespace-separated chunk becomes ONE quoted FTS5 string (`"` doubled): inside a string
 * FTS5 interprets no syntax and splits the text with the table's own tokenizer, so the query is
 * tokenised exactly like the index, in every script (review I1). At most MAX_TERMS chunks.
 * The chunk being typed matches as a prefix only once its last word has 2+ characters (a
 * one-letter prefix matches most of the index — review I4).
 */
export function ftsQuery(raw: string): string | null {
  const text = normalizeText(raw.slice(0, 400)).replace(CONTROL, " ");
  const chunks = text.split(/\s+/u).filter((c) => WORDISH.test(c)).map((c) => c.slice(0, MAX_TERM_CHARS * 2));
  if (!chunks.length) return null;
  const kept = chunks.slice(0, MAX_TERMS);
  const last = kept[kept.length - 1]!;
  const trailing = /[\p{L}\p{N}\p{M}]+$/u.exec(last)?.[0] ?? "";
  const typing = /[\p{L}\p{N}\p{M}]$/u.test(text) && chunks.length <= MAX_TERMS && [...trailing].length >= 2;
  return kept.map((c, i) => `"${c.replace(/"/g, '""')}"${typing && i === kept.length - 1 ? "*" : ""}`).join(" ");
}

// ── writing ──────────────────────────────────────────────────────────────────

const insertRow = db.prepare(`INSERT INTO comms_search_rows (dedupe_key, origin, thread_id, thread_note_id, source_note_id, message_id, sender_name, from_self, sent_at)
  VALUES (@key, @origin, @threadId, @threadNoteId, @sourceNoteId, @messageId, @sender, @fromSelf, @sentAt)
  ON CONFLICT(dedupe_key) DO NOTHING`);
const upgradeRow = db.prepare(`UPDATE comms_search_rows SET origin = 'live', thread_id = @threadId, source_note_id = NULL, message_id = @messageId,
  sender_name = @sender, from_self = @fromSelf, sent_at = @sentAt WHERE dedupe_key = @key`);
const rowIdByKey = db.prepare(`SELECT id FROM comms_search_rows WHERE dedupe_key = ?`);
const existingByKey = db.prepare(`SELECT origin, message_id FROM comms_search_rows WHERE dedupe_key = ?`);
const insertFts = db.prepare(`INSERT INTO comms_search_fts (rowid, body) VALUES (?, ?)`);
const deleteFtsRow = db.prepare(`DELETE FROM comms_search_fts WHERE rowid = ?`);
const deleteRowById = db.prepare(`DELETE FROM comms_search_rows WHERE id = ?`);
const rowsOfMessage = db.prepare(`SELECT id FROM comms_search_rows WHERE thread_id = ? AND message_id = ?`);
const rowsOfSource = db.prepare(`SELECT id FROM comms_search_rows WHERE source_note_id = ?`);
const rowsOfSourceKeyed = db.prepare(`SELECT id, dedupe_key FROM comms_search_rows WHERE source_note_id = ?`);
const noteOfThread = db.prepare(`SELECT c.vault_note_id AS note FROM comms_thread_members m JOIN comms_conversations c ON c.id = m.conversation_id
  WHERE m.thread_id = ? AND c.vault_note_id IS NOT NULL LIMIT 1`);
const noteOfConversation = db.prepare(`SELECT vault_note_id AS note FROM comms_conversations WHERE id = ?`);

function dropRows(ids: { id: number }[]): number {
  for (const r of ids) {
    deleteFtsRow.run(r.id);
    deleteRowById.run(r.id);
  }
  return ids.length;
}

/** The plain text of a projected message (body + attachment names), "" when there is none. */
export function messageText(m: Pick<Message, "body" | "attachments" | "system">): string {
  if (m.system) return "";
  const parts: string[] = [];
  if (m.body?.plain) parts.push(m.body.plain);
  for (const a of m.attachments ?? []) if (a.name) parts.push(a.name);
  return cleanBody(parts.join("\n").trim());
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Links of a message: link spans, previews and bare URLs in the text (deduplicated, ≤ 10). */
export function messageLinks(m: Pick<Message, "body" | "linkPreviews">): { url: string; title?: string; siteName?: string; imageMxc?: string }[] {
  const out = new Map<string, { url: string; title?: string; siteName?: string; imageMxc?: string }>();
  const add = (u: string, extra: Partial<LinkPreview> = {}) => {
    const url = u.replace(/[).,;:!?\]]+$/, "");
    if (!/^https?:\/\/[^\s/]+/i.test(url) || url.length > 2_000) return;
    const cur = out.get(url) ?? { url };
    if (extra.title && !cur.title) cur.title = extra.title.slice(0, 300);
    if (extra.siteName && !cur.siteName) cur.siteName = extra.siteName.slice(0, 100);
    if (extra.imageMxc && !cur.imageMxc) cur.imageMxc = extra.imageMxc;
    out.set(url, cur);
  };
  for (const p of m.linkPreviews ?? []) if (typeof p?.url === "string") add(p.url, p);
  const walk = (spans: Span[] | undefined, depth: number) => {
    if (!Array.isArray(spans) || depth > 8) return;
    for (const s of spans) {
      if (!s || typeof s !== "object") continue;
      if (s.t === "link" && typeof s.href === "string") add(s.href);
      if ("c" in s) walk(s.c, depth + 1);
    }
  };
  walk(m.body?.spans as Span[] | undefined, 0);
  for (const u of (m.body?.plain ?? "").match(URL_RE) ?? []) add(u);
  return [...out.values()].slice(0, 10);
}

const putMedia = db.prepare(`INSERT INTO comms_search_media (key, thread_id, message_id, kind, sent_at, sender_name, from_self, folded, json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at, sender_name = excluded.sender_name,
  from_self = excluded.from_self, folded = excluded.folded, json = excluded.json`);
const dropMediaOfMessage = db.prepare(`DELETE FROM comms_search_media WHERE thread_id = ? AND message_id = ?`);

function indexMedia(threadId: string, m: Message, sentAt: number, now: number): void {
  dropMediaOfMessage.run(threadId, m.source.eventId);
  if (m.redacted || sentAt < now - MEDIA_DAYS * DAY_MS) return;
  const sender = (m.sender?.name ?? "").slice(0, 200);
  const self = m.sender?.isSelf ? 1 : 0;
  (m.attachments ?? []).forEach((a: Attachment, i) => {
    if ((a.kind !== "image" && a.kind !== "video") || !a.mxc) return;
    putMedia.run(`p|${threadId}|${m.source.eventId}|${i}`, threadId, m.source.eventId, "photo", sentAt, sender, self, foldSearch(a.name ?? ""), JSON.stringify(a));
  });
  for (const l of messageLinks(m)) {
    putMedia.run(`l|${threadId}|${m.source.eventId}|${sha(l.url)}`, threadId, m.source.eventId, "link", sentAt, sender, self,
      foldSearch(`${l.url} ${l.title ?? ""} ${l.siteName ?? ""}`).slice(0, 2_500), JSON.stringify(l));
  }
}

/**
 * Index projected messages of one thread (new, edited or redacted). Idempotent: an edit replaces
 * the message's row, a redaction removes it. No-op while search is off.
 */
export function indexLiveMessages(threadId: string, messages: readonly Message[], now = Date.now()): number {
  if (!searchIndexingEnabled() || !messages.length) return 0;
  const threadNote = (noteOfThread.get(threadId) as { note: string } | undefined)?.note ?? null;
  let n = 0;
  db.transaction(() => {
    for (const m of messages) {
      if (!m?.source?.eventId) continue;
      // A forum message (comms/forums.ts) dedupes against ITS topic's note (the vault transcript).
      const note = m.topic?.id ? (noteOfConversation.get(m.topic.id) as { note: string | null } | undefined)?.note ?? null : threadNote;
      const scope = note ? `n:${note}` : `t:${threadId}`;
      dropRows(rowsOfMessage.all(threadId, m.source.eventId) as { id: number }[]);
      const sentAt = Date.parse(m.sentAt);
      if (!Number.isFinite(sentAt)) continue;
      indexMedia(threadId, m, sentAt, now);
      if (m.redacted) continue;
      const body = messageText(m);
      if (!body) continue;
      const params = {
        key: dedupeKey(scope, sentAt, body), origin: "live", threadId, threadNoteId: note, sourceNoteId: null,
        messageId: m.source.eventId, sender: (m.sender?.name ?? "").slice(0, 200), fromSelf: m.sender?.isSelf ? 1 : 0, sentAt,
      };
      const taken = existingByKey.get(params.key) as { origin: string; message_id: string | null } | undefined;
      // Two different live messages with the same text in the same minute ("ok", "ok") stay two.
      if (taken?.origin === "live" && taken.message_id !== m.source.eventId) params.key = `${params.key}|${sha(m.source.eventId)}`;
      if (insertRow.run(params).changes) {
        insertFts.run((rowIdByKey.get(params.key) as { id: number }).id, body);
      } else {
        upgradeRow.run(params); // the same message from the transcript: now known live
      }
      n++;
    }
  })();
  return n;
}

/** A message was deleted / redacted at the source. */
export function unindexMessage(threadId: string, messageId: string): void {
  if (!searchIndexingEnabled()) return;
  db.transaction(() => {
    dropRows(rowsOfMessage.all(threadId, messageId) as { id: number }[]);
    dropMediaOfMessage.run(threadId, messageId);
  })();
}

export interface TranscriptEntry { sentAt: number; sender: string; body: string; fromSelf: boolean }

/**
 * Bring the rows read from one vault note (thread or archive) in line with `entries` by DIFF
 * (review I2): only lines that are new are inserted, only lines that are gone are deleted — an
 * appended message costs one insert, not a rewrite of the whole thread. A line repeated within
 * the same minute ("ok", "ok") keeps one row per occurrence (`#2`, `#3` …).
 */
export function replaceNoteRows(sourceNoteId: string, threadNoteId: string, entries: readonly TranscriptEntry[]): { added: number; removed: number } {
  const want = new Map<string, { e: TranscriptEntry; body: string }>();
  const seen = new Map<string, number>();
  for (const e of entries) {
    const body = cleanBody(e.body.trim());
    if (!body || !Number.isFinite(e.sentAt)) continue;
    const base = dedupeKey(`n:${threadNoteId}`, e.sentAt, body);
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    want.set(k === 1 ? base : `${base}#${k}`, { e, body });
  }
  let added = 0, removed = 0;
  db.transaction(() => {
    const have = rowsOfSourceKeyed.all(sourceNoteId) as { id: number; dedupe_key: string }[];
    const gone = have.filter((r) => !want.has(r.dedupe_key));
    removed = dropRows(gone);
    for (const r of have) want.delete(r.dedupe_key);
    for (const [key, { e, body }] of want) {
      const r = insertRow.run({ key, origin: "vault", threadId: null, threadNoteId, sourceNoteId, messageId: null, sender: e.sender.slice(0, 200), fromSelf: e.fromSelf ? 1 : 0, sentAt: e.sentAt });
      if (r.changes) {
        insertFts.run(Number(r.lastInsertRowid), body);
        added++;
      }
    }
  })();
  return { added, removed };
}

/** Forget every row read from a vault note (it was deleted). */
export function dropNoteRows(sourceNoteId: string): number {
  return db.transaction(() => dropRows(rowsOfSource.all(sourceNoteId) as { id: number }[]))();
}

let lastMediaPrune = 0;
/** Photos / Links older than ~90 days go (at most hourly). */
export function pruneMedia(now = Date.now(), force = false): number {
  if (!force && now - lastMediaPrune < 3_600_000) return 0;
  lastMediaPrune = now;
  return db.prepare(`DELETE FROM comms_search_media WHERE sent_at < ?`).run(now - MEDIA_DAYS * DAY_MS).changes;
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface Highlight { start: number; length: number }

/** Snippet with markers → text + highlight ranges (UTF-16 offsets, what JS and NSString count). */
export function parseMarked(marked: string): { text: string; highlights: Highlight[] } {
  let text = "";
  const highlights: Highlight[] = [];
  let open = -1;
  for (const ch of marked) {
    if (ch === HL_OPEN) { open = text.length; continue; }
    if (ch === HL_CLOSE) {
      if (open >= 0 && text.length > open) highlights.push({ start: open, length: text.length - open });
      open = -1;
      continue;
    }
    text += ch;
  }
  return { text, highlights };
}

/** The thread a row belongs to (live rows carry it; transcript rows through the thread note). */
const THREAD_OF_ROW = `COALESCE(r.thread_id, (SELECT m2.thread_id FROM comms_conversations c2 JOIN comms_thread_members m2 ON m2.conversation_id = c2.id
  WHERE c2.vault_note_id = r.thread_note_id LIMIT 1))`;

export interface SearchFilter { threadId?: string; personId?: string; networks?: string[]; fromSelf?: boolean }
export interface SearchHit {
  id: string; threadId: string; messageId: string | null; sentAt: string;
  sender: { name: string; isSelf: boolean }; text: string; highlights: Highlight[]; origin: "live" | "history";
}

/** Per-request bounds (review I4). */
export const searchLimits = {
  /** FTS rows read per step (newest first); the event loop gets a turn between steps. */
  chunk: 2_000,
  /** The most matches one search ranks (newest by index order). */
  maxCandidates: 20_000,
  /** Wall-clock budget for one search's ranking steps; past it the best found so far answer (`partial`). */
  budgetMs: 150,
};
/** Tests: replace the clock the time budget reads. */
let searchClock: () => number = () => Date.now();
export function setSearchClockForTests(f: (() => number) | null): void { searchClock = f ?? (() => Date.now()); }

const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Messages matching `q`, best first: FTS5 bm25 relevance blended with recency (a message from
 * today outranks an equally good one from years ago; a much better match still wins). Only rows
 * that resolve to a projected thread are returned (a result must open somewhere).
 *
 * Bounded (review I4): matches are read newest-first (FTS rowid order, no sort) in chunks of
 * `chunk`, at most `maxCandidates`, yielding the event loop between chunks and stopping at
 * `budgetMs`; `partial` says the ranking saw only part of the matches.
 */
export async function searchMessages(q: string, f: SearchFilter, offset: number, limit: number, now: number): Promise<{ hits: SearchHit[]; more: boolean; partial: boolean } | null> {
  const match = ftsQuery(q);
  if (!match) return null;
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.threadId) { where.push(`t.id = ?`); params.push(f.threadId); }
  if (f.personId) {
    where.push(`(t.person_id = ? OR EXISTS (SELECT 1 FROM comms_conversation_members cm WHERE cm.conversation_id = c.id AND cm.person_id = ?))`);
    params.push(f.personId, f.personId);
  }
  if (f.networks?.length) { where.push(`c.network IN (${f.networks.map(() => "?").join(",")})`); params.push(...f.networks); }
  if (f.fromSelf !== undefined) { where.push(`r.from_self = ?`); params.push(f.fromSelf ? 1 : 0); }
  const step = db.prepare(`
    WITH x AS MATERIALIZED (
      SELECT rowid AS id, bm25(comms_search_fts) AS rel FROM comms_search_fts
      WHERE comms_search_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?
    )
    SELECT x.id, x.rel, r.origin, r.message_id, r.sender_name, r.from_self, r.sent_at, t.id AS tid
    FROM x JOIN comms_search_rows r ON r.id = x.id
      JOIN comms_threads t ON t.id = ${THREAD_OF_ROW}
      JOIN comms_thread_members m ON m.thread_id = t.id
      JOIN comms_conversations c ON c.id = m.conversation_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY x.id`);
  const lowest = db.prepare(`SELECT MIN(rowid) AS lo FROM (SELECT rowid FROM comms_search_fts WHERE comms_search_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?)`);
  type Row = { id: number; rel: number; origin: string; message_id: string | null; sender_name: string; from_self: number; sent_at: number; tid: string };
  const found: Row[] = [];
  const started = searchClock();
  let cursor = Number.MAX_SAFE_INTEGER;
  let read = 0;
  let partial = false;
  for (;;) {
    const n = Math.min(searchLimits.chunk, searchLimits.maxCandidates - read);
    if (n <= 0) { partial = true; break; }
    found.push(...(step.all(match, cursor, n, ...params) as Row[]));
    const lo = (lowest.get(match, cursor, n) as { lo: number | null }).lo;
    if (lo === null) break;
    read += n;
    cursor = lo;
    if (searchClock() - started > searchLimits.budgetMs) { partial = true; break; }
    await yieldTurn();
  }
  const score = (r: Row) => r.rel - 4.0 / (1.0 + ((now - r.sent_at) / DAY_MS) / 30.0);
  found.sort((a, b) => score(a) - score(b) || b.sent_at - a.sent_at || b.id - a.id);
  const page = found.slice(offset, offset + limit);
  const snippetOf = db.prepare(`SELECT snippet(comms_search_fts, 0, '${HL_OPEN}', '${HL_CLOSE}', '…', 32) AS snip
    FROM comms_search_fts WHERE comms_search_fts MATCH ? AND rowid = ?`);
  const hits = page.map((r) => {
    const snip = (snippetOf.get(match, r.id) as { snip: string } | undefined)?.snip ?? "";
    const { text, highlights } = parseMarked(snip);
    return {
      id: `sr_${r.id}`, threadId: r.tid, messageId: r.message_id, sentAt: new Date(r.sent_at).toISOString(),
      sender: { name: r.sender_name, isSelf: r.from_self === 1 }, text, highlights, origin: r.origin === "live" ? "live" as const : "history" as const,
    };
  });
  return { hits, more: found.length > offset + limit, partial };
}

export interface MediaItem {
  id: string; threadId: string; messageId: string; sentAt: string; sender: { name: string; isSelf: boolean };
  kind: "photo" | "link"; attachment?: Attachment; link?: { url: string; title?: string; siteName?: string; imageMxc?: string };
}

/** Photos or links of the last ~90 days, newest first; keyset paging on (sent_at, key). */
export function listMedia(kind: "photo" | "link", o: { q?: string; threadId?: string; after?: { at: number; key: string } | null; limit: number; now: number }): { items: MediaItem[]; next: { at: number; key: string } | null } {
  const where = [`s.kind = ?`, `s.sent_at >= ?`];
  const params: unknown[] = [kind, o.now - MEDIA_DAYS * DAY_MS];
  if (o.threadId) { where.push(`s.thread_id = ?`); params.push(o.threadId); }
  const folded = o.q ? foldSearch(o.q) : "";
  if (folded) { where.push(`s.folded LIKE ? ESCAPE '\\'`); params.push(`%${folded.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
  if (o.after) { where.push(`(s.sent_at < ? OR (s.sent_at = ? AND s.key < ?))`); params.push(o.after.at, o.after.at, o.after.key); }
  // Only threads that still list (a left room's media is not offered).
  const rows = db.prepare(`SELECT s.* FROM comms_search_media s WHERE ${where.join(" AND ")}
    AND EXISTS (SELECT 1 FROM comms_thread_members m WHERE m.thread_id = s.thread_id)
    ORDER BY s.sent_at DESC, s.key DESC LIMIT ?`).all(...params, o.limit + 1) as {
      key: string; thread_id: string; message_id: string; kind: string; sent_at: number; sender_name: string; from_self: number; json: string;
    }[];
  const page = rows.slice(0, o.limit);
  const items: MediaItem[] = [];
  for (const r of page) {
    let v: unknown;
    try { v = JSON.parse(r.json); } catch { continue; }
    items.push({
      id: `m_${sha(r.key)}`, threadId: r.thread_id, messageId: r.message_id, sentAt: new Date(r.sent_at).toISOString(),
      sender: { name: r.sender_name, isSelf: r.from_self === 1 }, kind: kind,
      ...(kind === "photo" ? { attachment: v as Attachment } : { link: v as MediaItem["link"] }),
    });
  }
  const last = page[page.length - 1];
  return { items, next: rows.length > o.limit && last ? { at: last.sent_at, key: last.key } : null };
}

/** How far the history index has come (sources = vault notes seen). */
export function historyStatus(): { sources: number; pending: number; failed: number; messages: number } {
  const s = db.prepare(`SELECT COUNT(*) AS n, SUM(state = 'pending') AS p, SUM(state = 'failed') AS f FROM comms_search_sources`).get() as { n: number; p: number | null; f: number | null };
  const m = db.prepare(`SELECT COUNT(*) AS n FROM comms_search_rows`).get() as { n: number };
  return { sources: s.n, pending: s.p ?? 0, failed: s.f ?? 0, messages: m.n };
}

/** Indexed messages per conversation scope (the maintained `comms_search_counts`; no scan). */
export function messageCountsFor(scopes: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < scopes.length; i += 500) {
    const part = scopes.slice(i, i + 500);
    for (const r of db.prepare(`SELECT scope, n FROM comms_search_counts WHERE scope IN (${part.map(() => "?").join(",")})`).all(...part) as { scope: string; n: number }[])
      out.set(r.scope, r.n);
  }
  return out;
}

/**
 * Search turned off: the indexed message text does not stay at rest (review M12). Runs at
 * startup when COMMS_SEARCH_ENABLED is off; a no-op when the index is already empty.
 */
export function purgeSearchIndexIfDisabled(): number {
  if (searchIndexingEnabled()) return 0;
  if (!db.prepare(`SELECT 1 FROM comms_search_rows LIMIT 1`).get() && !db.prepare(`SELECT 1 FROM comms_search_media LIMIT 1`).get()) return 0;
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM comms_search_rows`).get() as { n: number }).n;
  db.transaction(() => {
    db.exec(`DELETE FROM comms_search_fts; DELETE FROM comms_search_rows; DELETE FROM comms_search_counts; DELETE FROM comms_search_sources; DELETE FROM comms_search_media;`);
  })();
  console.log(`[comms] search is off: the search index was cleared (${n} messages)`);
  return n;
}
