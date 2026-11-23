// Comms projection store (ARCHITECTURE §3.2): conversations, display threads, a recent-message
// window cache and the SSE event log, in Prism's SQLite. Everything except the owner overrides
// (comms_threads.o_*) is rebuildable from the sources. JSON columns are TEXT; never store secrets.
import { db } from "../db";
import { config } from "../config";
import type { AvatarRef, Capabilities, Message, MessagePreview, Network, Thread } from "./types";
import { NEEDS_ATTENTION, COMMS_STATUSES, isCommsStatus, type CommsStatus } from "./triage";
import { likePattern, searchTextOf } from "./search-text";
import { indexLiveMessages, unindexMessage } from "./search-index";

export type Folder = "inbox" | "unknown" | "low" | "spam" | "archived";
export type CommsEventKind = "thread.updated" | "message.created" | "message.updated" | "message.deleted" | "reaction.changed";
export type Urgency = NonNullable<Thread["urgency"]>;

/** One source conversation (room / chat GUID / email thread), as the sources project it. */
export interface ConversationRow {
  id: string;
  network: Network;
  sourceRef: string;
  kind: "dm" | "group";
  title: string;
  titleSource: Thread["titleSource"];
  avatar: AvatarRef | null;
  lastEventAt: string; // ISO UTC
  lastPreview: MessagePreview | null;
  unreadCount: number;
  unreadTrusted: boolean;
  folder: Folder;
  pinned: boolean;
  muted: boolean;
  archived: boolean;
  triage: Urgency | null;
  /** Triage status from the thread note's tags (comms/triage.ts); absent = "unclassified". */
  status?: CommsStatus;
  accountLabel: string | null;
  capabilities: Capabilities | null;
  vaultNoteId: string | null;
}

/** Thrown for a malformed/foreign cursor; the route maps it to 400 invalid_cursor. */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid_cursor");
    this.name = "InvalidCursorError";
  }
}

export const WINDOW_SIZE = 200;
export const EVENT_RETENTION_MS = 7 * 86_400_000;

const json = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
/** A stored JSON column; a corrupt one reads as null (one bad row must not break every listing). */
const parse = <T>(s: string | null): T | null => {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    console.warn("[comms] corrupt stored JSON row ignored");
    return null;
  }
};

const upsertConvStmt = db.prepare(`
  INSERT INTO comms_conversations (id, network, source_ref, kind, title, title_source, avatar_json, last_event_at,
    last_preview_json, unread_count, unread_trusted, folder, pinned, muted, archived, triage, status, account_label,
    capabilities_json, vault_note_id, search_text)
  VALUES (@id, @network, @sourceRef, @kind, @title, @titleSource, @avatar, @lastEventAt, @lastPreview, @unreadCount,
    @unreadTrusted, @folder, @pinned, @muted, @archived, @triage, @status, @accountLabel, @capabilities, @vaultNoteId, @searchText)
  ON CONFLICT(id) DO UPDATE SET network=excluded.network, source_ref=excluded.source_ref, kind=excluded.kind,
    title=excluded.title, title_source=excluded.title_source, avatar_json=excluded.avatar_json,
    last_event_at=excluded.last_event_at, last_preview_json=excluded.last_preview_json,
    unread_count=excluded.unread_count, unread_trusted=excluded.unread_trusted, folder=excluded.folder,
    pinned=excluded.pinned, muted=excluded.muted, archived=excluded.archived, triage=excluded.triage, status=excluded.status,
    account_label=excluded.account_label, capabilities_json=excluded.capabilities_json,
    vault_note_id=excluded.vault_note_id, search_text=excluded.search_text
`);

/** Insert or refresh a source conversation. Owner overrides live on comms_threads and are untouched. */
export function upsertConversation(row: ConversationRow): void {
  upsertConvStmt.run({
    ...row,
    status: row.status ?? "unclassified",
    avatar: json(row.avatar),
    lastPreview: json(row.lastPreview),
    unreadTrusted: row.unreadTrusted ? 1 : 0,
    pinned: row.pinned ? 1 : 0,
    muted: row.muted ? 1 : 0,
    archived: row.archived ? 1 : 0,
    capabilities: json(row.capabilities),
    searchText: searchTextOf(row.title, row.lastPreview?.text),
  });
}

const insertThreadStmt = db.prepare(`INSERT OR IGNORE INTO comms_threads (id) VALUES (?)`);
const insertMemberStmt = db.prepare(`INSERT OR IGNORE INTO comms_thread_members (thread_id, conversation_id) VALUES (?, ?)`);

/** Phase 1: one display thread per source conversation. Idempotent; returns the thread id. */
export function ensureSingleThread(conversationId: string): string {
  const id = `th_${conversationId}`;
  db.transaction(() => {
    insertThreadStmt.run(id);
    insertMemberStmt.run(id, conversationId);
  })();
  return id;
}

// Effective (override-aware) values. An explicit folder override wins; otherwise an archived flag
// (override first) forces "archived".
/**
 * Drop a source conversation the owner is no longer in (left / removed room). The display
 * thread's owner overrides (comms_threads) are kept — rejoining brings them back — but it no
 * longer lists. Announced as thread.updated so clients refetch (and get 404 thread_unavailable).
 */
export function removeConversation(conversationId: string): boolean {
  const threads = db.prepare(`SELECT thread_id FROM comms_thread_members WHERE conversation_id = ?`).all(conversationId) as { thread_id: string }[];
  const forum = (db.prepare(`SELECT forum_id AS f FROM comms_conversations WHERE id = ?`).get(conversationId) as { f: string | null } | undefined)?.f ?? null;
  const gone = db.transaction(() => {
    db.prepare(`DELETE FROM comms_thread_members WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM comms_projection_evidence WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM comms_conversation_members WHERE conversation_id = ?`).run(conversationId);
    const removed = db.prepare(`DELETE FROM comms_conversations WHERE id = ?`).run(conversationId).changes > 0;
    // A forum topic: the forum follows its remaining topics; a forum with none left is gone too.
    if (forum) {
      const left = (db.prepare(`SELECT COUNT(*) AS n FROM comms_conversations WHERE forum_id = ?`).get(forum) as { n: number }).n;
      if (left) refreshForumAggregate(forum);
      else {
        db.prepare(`DELETE FROM comms_thread_members WHERE conversation_id = ?`).run(forum);
        db.prepare(`DELETE FROM comms_conversations WHERE id = ?`).run(forum);
      }
    }
    return removed;
  })();
  if (gone) for (const t of threads) appendEvent("thread.updated", t.thread_id, { threadId: t.thread_id });
  return gone;
}

/**
 * Conversations of a feature whose flag is off are not served (final review I3): with
 * COMMS_EMAIL_ENABLED off, the vault-projected email conversations leave every list, the pins, search,
 * people pages and counts, and getThread answers null (so every read route 404s). The rows stay;
 * turning the flag back on brings them back. Evaluated per query (tests toggle the flag).
 */
// Only Task 3's projected email (source_ref `email:<account>:<thread>`); a Matrix-bridged room whose
// bridge protocol is "email" predates the flag and is not governed by it.
export const visibleSql = (): string => (config.commsEmailEnabled ? "1 = 1" : "NOT (c.network = 'email' AND c.source_ref LIKE 'email:%')");

/** The conversation that stands for its display thread in every listing: all of them, except a
 *  Telegram forum's TOPIC conversations — a forum thread is stood for by its aggregate row
 *  (comms/forums.ts), the topics are members only for "which thread is this room?". */
export const LEAD = `c.forum_id IS NULL`;
/** A thread with this member conversation's person (DMs on every network, the groups they are in, a forum's topics). */
const WITH_PERSON = `EXISTS (SELECT 1 FROM comms_thread_members mp JOIN comms_conversation_members cm ON cm.conversation_id = mp.conversation_id
      WHERE mp.thread_id = t.id AND cm.person_id = ?)`;
const E_PINNED = `COALESCE(t.o_pinned, c.pinned)`;
const E_MUTED = `COALESCE(t.o_muted, c.muted)`;
const E_FOLDER = `COALESCE(t.o_folder, CASE WHEN COALESCE(t.o_archived, c.archived) = 1 THEN 'archived' ELSE c.folder END)`;

// Unread (Sprint Task 1). The owner's read marker (comms_read_markers r) decides once it exists:
// nothing after the marker, or the latest message is the owner's own → 0; otherwise the cached
// non-self messages after max(marker, the owner's latest message), at least 1. A manual "mark as
// unread" reads ≥ 1 until the next read. No marker → the source's own guess (Phase-1 placeholder),
// untrusted. Trusted = a marker exists and the window cache holds messages to count.
// Telegram forums (comms/forums.ts): a forum thread's messages are cached per TOPIC (cache id
// `th_<topic conversation>`), so its counts sum over the topics' windows, each after the owner's own
// latest message in THAT topic. For every other thread the cache id is the thread id.
export const CACHE_IDS = `(mm.thread_id = t.id OR mm.thread_id IN (SELECT 'th_' || fx.id FROM comms_conversations fx WHERE fx.forum_id = c.id))`;
const SELF_AT = `(SELECT MAX(ms.sent_at) FROM comms_messages ms WHERE ms.thread_id = mm.thread_id AND json_extract(ms.json, '$.sender.isSelf') = 1)`;
const COUNT_AFTER = `(SELECT COUNT(*) FROM comms_messages mm WHERE ${CACHE_IDS} AND mm.sent_at > r.read_at
    AND mm.sent_at > COALESCE(${SELF_AT}, '') AND json_extract(mm.json, '$.sender.isSelf') = 0
    AND json_extract(mm.json, '$.redacted') = 0 AND json_extract(mm.json, '$.system') IS NULL)`;
const E_UNREAD_PLAIN = `(CASE WHEN COALESCE(json_extract(c.last_preview_json, '$.isSelf'), 0) = 1 OR c.last_event_at <= r.read_at THEN 0
    ELSE MAX(1, ${COUNT_AFTER}) END)`;
// A forum (fix round 1, I-4 / m1): per TOPIC, the Messages rule above against the later of the
// forum's read marker and the topic's own read point (comms_topic_read_markers): the owner's own
// last word in a topic zeroes that topic only; a topic with news but no cached messages counts 1.
export const forumTopicUnreadSql = (topicAlias: string, readAt: string): string => {
  const point = `MAX(${readAt}, COALESCE((SELECT tr.read_at FROM comms_topic_read_markers tr WHERE tr.cache_id = 'th_' || ${topicAlias}.id), ''))`;
  return `(CASE WHEN COALESCE(json_extract(${topicAlias}.last_preview_json, '$.isSelf'), 0) = 1 OR ${topicAlias}.last_event_at <= ${point} THEN 0
    ELSE MAX(1, (SELECT COUNT(*) FROM comms_messages mm WHERE mm.thread_id = 'th_' || ${topicAlias}.id AND mm.sent_at > ${point}
      AND mm.sent_at > COALESCE(${SELF_AT}, '') AND json_extract(mm.json, '$.sender.isSelf') = 0
      AND json_extract(mm.json, '$.redacted') = 0 AND json_extract(mm.json, '$.system') IS NULL)) END)`;
};
const E_UNREAD_FORUM = `(SELECT COALESCE(SUM(${forumTopicUnreadSql("fx", "r.read_at")}), 0) FROM comms_conversations fx WHERE fx.forum_id = c.id)`;
const E_UNREAD_MARKED = `(CASE WHEN c.source_ref LIKE 'forum:%' THEN ${E_UNREAD_FORUM} ELSE ${E_UNREAD_PLAIN} END)`;
export const E_UNREAD = `(CASE WHEN r.thread_id IS NULL THEN c.unread_count
    WHEN r.manual_unread = 1 THEN MAX(1, ${E_UNREAD_MARKED}) ELSE ${E_UNREAD_MARKED} END)`;
const E_UNREAD_TRUSTED = `(CASE WHEN r.thread_id IS NULL THEN c.unread_trusted
    WHEN EXISTS (SELECT 1 FROM comms_messages mm WHERE ${CACHE_IDS}) THEN 1 ELSE 0 END)`;
const READ_JOIN = `LEFT JOIN comms_read_markers r ON r.thread_id = t.id`;

const SELECT_THREAD = `
  SELECT t.id AS id, t.person_id AS person_id, c.network, c.kind, c.title, c.title_source, c.avatar_json,
    c.last_event_at, c.last_preview_json, ${E_UNREAD} AS unread_count, ${E_UNREAD_TRUSTED} AS unread_trusted, c.triage, c.status, c.account_label,
    c.capabilities_json, ${E_PINNED} AS pinned, ${E_MUTED} AS muted, ${E_FOLDER} AS folder,
    COALESCE(c.vault_note_id, (SELECT fn.vault_note_id FROM comms_conversations fn WHERE fn.forum_id = c.id AND fn.vault_note_id IS NOT NULL
      ORDER BY fn.last_event_at DESC, fn.id DESC LIMIT 1)) AS note_id,
    CASE WHEN c.source_ref LIKE 'forum:%' THEN (SELECT COUNT(*) FROM comms_conversations ft WHERE ft.forum_id = c.id) END AS topic_count,
    t.o_pin_order AS pin_order,
    (SELECT group_concat(fm.folder_id, ',') FROM comms_folder_members fm WHERE fm.thread_id = t.id) AS folder_ids,
    CASE WHEN c.kind = 'dm' AND t.person_id IS NULL AND ${E_FOLDER} != 'spam' AND EXISTS (SELECT 1 FROM comms_conversation_members cm
      WHERE cm.conversation_id = c.id AND cm.person_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM comms_tidy_ignored i WHERE i.member_id = cm.member_id)) THEN 1 ELSE 0 END AS needs_tidy
  FROM comms_threads t
  JOIN comms_thread_members m ON m.thread_id = t.id
  JOIN comms_conversations c ON c.id = m.conversation_id AND ${LEAD}
  ${READ_JOIN}`;

interface ThreadSqlRow {
  id: string; person_id: string | null; network: Network; kind: "dm" | "group"; title: string;
  title_source: Thread["titleSource"]; avatar_json: string | null; last_event_at: string;
  last_preview_json: string | null; unread_count: number; unread_trusted: number; triage: Urgency | null; status: string | null;
  account_label: string | null; capabilities_json: string | null; pinned: number; muted: number; folder: Folder; needs_tidy?: number;
  note_id: string | null;
  pin_order: number | null;
  folder_ids?: string | null;
  topic_count?: number | null;
}

function toThread(r: ThreadSqlRow): Thread {
  const capabilities = parse<Capabilities>(r.capabilities_json);
  const t: Thread = {
    id: r.id,
    title: r.title,
    titleSource: r.title_source,
    avatar: parse<AvatarRef>(r.avatar_json),
    kind: r.kind,
    networks: [r.network],
    lastActivityAt: r.last_event_at,
    unread: { count: r.unread_count, trusted: r.unread_trusted === 1 },
    folder: r.folder,
    urgency: r.triage,
    status: r.status && isCommsStatus(r.status) ? r.status : "unclassified",
    pinned: r.pinned === 1,
    muted: r.muted === 1,
    channels: [{ network: r.network, accountLabel: r.account_label, ...(capabilities ? { capabilities } : {}) }],
  };
  if (r.person_id) t.personId = r.person_id;
  if (r.note_id) t.noteId = r.note_id;
  // A Telegram forum (comms/forums.ts): its topics are sub-conversations; the row shows how many.
  if (typeof r.topic_count === "number") t.forum = { topicCount: r.topic_count };
  if (r.pinned === 1 && typeof r.pin_order === "number") t.pinOrder = r.pin_order;
  // Owner folders (COMMS_FOLDERS_ENABLED, sprint Task 9): which of them hold this thread.
  if (r.folder_ids && config.commsFoldersEnabled) t.folderIds = r.folder_ids.split(",").filter(Boolean).sort();
  // Contact tidy-up (COMMS_TIDY_ENABLED): a DM whose counterpart is no person yet ("Who is this?").
  if (r.needs_tidy === 1 && config.commsTidyEnabled) t.needsTidy = true;
  const lastMessage = parse<MessagePreview>(r.last_preview_json);
  if (lastMessage) t.lastMessage = lastMessage;
  return t;
}

function encodeCursor(r: ThreadSqlRow): string {
  return Buffer.from(JSON.stringify([r.pinned, r.last_event_at, r.id])).toString("base64url");
}

function decodeCursor(c: string): { pinned: number; at: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(c)) throw new Error("charset");
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 3) throw new Error("shape");
    const [pinned, at, id] = v;
    if ((pinned !== 0 && pinned !== 1) || typeof at !== "string" || typeof id !== "string" || !at || !id) throw new Error("types");
    return { pinned, at, id };
  } catch {
    throw new InvalidCursorError();
  }
}

/**
 * Ordered pinned first, then lastActivityAt desc, then id desc (pins are NOT in the owner's
 * grid order here — the keyset cursor has no room for it; `pinOrder` rides on each pinned row and
 * GET /api/comms/pins is the ordered grid, which clients use). Keyset paging on
 * (pinned, lastActivityAt, id): rows inserted ahead of the cursor never repeat or skip a row.
 * No `folder` means no folder filter (every folder).
 */
export function listThreads(q: {
  folder?: Folder; unread?: boolean; networks?: Network[]; q?: string; cursor?: string; limit: number;
  /** Any of these triage statuses (OR). */
  statuses?: CommsStatus[];
  /** Conversations with this person: their DMs on every network and the groups they are in. */
  personId?: string;
  /** The conversation projected from this vault `message-thread` note (Prism web opens a note). */
  noteId?: string;
  /** Threads in this owner folder (sprint Task 9). With no `folder`, archived and spam are left out. */
  inFolder?: string;
}): { threads: Thread[]; next: string | null } {
  const where: string[] = [visibleSql()];
  const params: unknown[] = [];
  if (q.folder) { where.push(`${E_FOLDER} = ?`); params.push(q.folder); }
  if (q.unread) where.push(`${E_UNREAD} > 0`);
  if (q.networks?.length) { where.push(`c.network IN (${q.networks.map(() => "?").join(",")})`); params.push(...q.networks); }
  if (q.statuses?.length) { where.push(`c.status IN (${q.statuses.map(() => "?").join(",")})`); params.push(...q.statuses); }
  if (q.personId) {
    where.push(`(t.person_id = ? OR ${WITH_PERSON})`);
    params.push(q.personId, q.personId);
  }
  // Any member conversation's note (a forum thread answers for each of its topics' notes).
  if (q.noteId) {
    where.push(`EXISTS (SELECT 1 FROM comms_thread_members mn JOIN comms_conversations cn ON cn.id = mn.conversation_id WHERE mn.thread_id = t.id AND cn.vault_note_id = ?)`);
    params.push(q.noteId);
  }
  if (q.inFolder) {
    where.push(`EXISTS (SELECT 1 FROM comms_folder_members fm WHERE fm.thread_id = t.id AND fm.folder_id = ?)`);
    params.push(q.inFolder);
    if (!q.folder) where.push(`${E_FOLDER} NOT IN ('archived', 'spam')`);
  }
  // Title OR last-message preview, case/diacritic-folded (comms/search-text.ts): one narrow column.
  const like = q.q ? likePattern(q.q) : null;
  if (like) {
    where.push(`c.search_text LIKE ? ESCAPE '\\'`);
    params.push(like);
  }
  if (q.cursor) {
    const k = decodeCursor(q.cursor);
    where.push(`(${E_PINNED} < ? OR (${E_PINNED} = ? AND (c.last_event_at < ? OR (c.last_event_at = ? AND t.id < ?))))`);
    params.push(k.pinned, k.pinned, k.at, k.at, k.id);
  }
  const limit = Math.max(1, Math.floor(q.limit));
  const rows = db
    .prepare(`${SELECT_THREAD} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${E_PINNED} DESC, c.last_event_at DESC, t.id DESC LIMIT ?`)
    .all(...params, limit + 1) as ThreadSqlRow[];
  const page = rows.slice(0, limit);
  return { threads: page.map(toThread), next: rows.length > limit && page.length ? encodeCursor(page[page.length - 1]!) : null };
}

/** Every pinned thread (any folder), in the owner's pin order (sprint Task 8: at most 9 are
 *  ever pinned by Comms). Threads pinned without an order (a source-side pin) come last, newest first. */
export function pinnedThreads(): Thread[] {
  const rows = db.prepare(`${SELECT_THREAD} WHERE ${E_PINNED} = 1 AND ${visibleSql()}
    ORDER BY t.o_pin_order IS NULL, t.o_pin_order ASC, c.last_event_at DESC, t.id DESC LIMIT 50`).all() as ThreadSqlRow[];
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).map(toThread);
}

export function getThread(id: string): Thread | null {
  const r = db.prepare(`${SELECT_THREAD} WHERE t.id = ? AND ${visibleSql()}`).get(id) as ThreadSqlRow | undefined;
  return r ? toThread(r) : null;
}

const putMsgStmt = db.prepare(`
  INSERT INTO comms_messages (thread_id, source_event_id, sent_at, json) VALUES (?, ?, ?, ?)
  ON CONFLICT(thread_id, source_event_id) DO UPDATE SET sent_at=excluded.sent_at, json=excluded.json`);
const pruneWindowStmt = db.prepare(`
  DELETE FROM comms_messages WHERE thread_id = ? AND (thread_id, source_event_id) NOT IN (
    SELECT thread_id, source_event_id FROM comms_messages WHERE thread_id = ?
    ORDER BY sent_at DESC, source_event_id DESC LIMIT ${WINDOW_SIZE})`);

/** Upsert messages into the thread's window cache, then keep only the newest 200. */
export function putWindow(threadId: string, messages: Message[], displayId: string = threadId): void {
  db.transaction(() => {
    for (const m of messages) putMsgStmt.run(threadId, m.source.eventId, m.sentAt, JSON.stringify(m));
    pruneWindowStmt.run(threadId, threadId);
  })();
  // Full search (COMMS_SEARCH_ENABLED): every message that enters the window is indexed for good —
  // under the DISPLAY thread (a forum topic's window is cached under its own id).
  indexSafely(() => indexLiveMessages(displayId, messages));
}

/** Search indexing never breaks the projection: a failure is logged (no content) and dropped. */
function indexSafely(f: () => unknown): void {
  try { f(); } catch (e) { console.warn(`[comms] search index write failed: ${e instanceof Error ? e.name : "error"}`); }
}

/**
 * Up to `limit` cached messages, oldest first (newest last). `before` is a message id
 * (source event id) or an ISO sentAt; only strictly older messages are returned.
 */
export function readWindow(threadId: string, before?: string, limit = 50): Message[] {
  const n = Math.max(1, Math.floor(limit));
  let rows: { json: string }[];
  if (before) {
    const ref = db.prepare(`SELECT sent_at, source_event_id FROM comms_messages WHERE thread_id = ? AND (source_event_id = ? OR json_extract(json, '$.id') = ?)`)
      .get(threadId, before, before) as { sent_at: string; source_event_id: string } | undefined;
    const at = ref?.sent_at ?? before;
    const eid = ref?.source_event_id ?? "￿";
    rows = db.prepare(`SELECT json FROM comms_messages WHERE thread_id = ? AND (sent_at < ? OR (sent_at = ? AND source_event_id < ?))
      ORDER BY sent_at DESC, source_event_id DESC LIMIT ?`).all(threadId, at, at, eid, n) as { json: string }[];
  } else {
    rows = db.prepare(`SELECT json FROM comms_messages WHERE thread_id = ? ORDER BY sent_at DESC, source_event_id DESC LIMIT ?`)
      .all(threadId, n) as { json: string }[];
  }
  return rows.reverse().map((r) => parse<Message>(r.json)).filter((m): m is Message => !!m && typeof m === "object");
}

const insertEventStmt = db.prepare(`INSERT INTO comms_events (at, kind, thread_id, payload_json, cache_id) VALUES (?, ?, ?, ?, ?)`);

/** Append to the SSE event log; returns the monotonic event id (AUTOINCREMENT: never reused).
 *  `cacheId`: the forum TOPIC window a message event belongs to (comms/forums.ts); null otherwise. */
export function appendEvent(kind: CommsEventKind, threadId: string | null, payload: unknown, cacheId: string | null = null): number {
  const id = Number(insertEventStmt.run(Date.now(), kind, threadId, JSON.stringify(payload ?? null), cacheId).lastInsertRowid);
  const message = threadId && kind.startsWith("message.") ? (payload as { message?: Message } | null)?.message : undefined;
  if (kind === "message.created" && message && typeof message === "object") unarchiveOnArrival(threadId!, message);
  if (message && typeof message === "object") {
    indexSafely(() => kind === "message.deleted" ? unindexMessage(threadId!, message.source?.eventId ?? "") : indexLiveMessages(threadId!, [message]));
  }
  wakeEventListeners();
  return id;
}

// Live wake-up for the SSE stream (Task 11): listeners are told "new rows may exist" once per
// microtask and read them with eventsAfter — after any enclosing transaction has committed.
const eventListeners = new Set<() => void>();
let wakeQueued = false;
function wakeEventListeners(): void {
  if (wakeQueued || !eventListeners.size) return;
  wakeQueued = true;
  queueMicrotask(() => {
    wakeQueued = false;
    for (const fn of [...eventListeners]) {
      try { fn(); } catch { /* a listener never breaks an append */ }
    }
  });
}
export function onCommsEvent(fn: () => void): () => void {
  eventListeners.add(fn);
  return () => { eventListeners.delete(fn); };
}
export const commsEventListenerCount = (): number => eventListeners.size;

/** Highest id ever issued (AUTOINCREMENT: survives pruning) and the lowest retained id. */
export function eventBounds(): { seq: number; min: number | null } {
  const seq = (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'comms_events'`).get() as { seq: number } | undefined)?.seq ?? 0;
  const min = (db.prepare(`SELECT MIN(id) AS m FROM comms_events`).get() as { m: number | null }).m;
  return { seq, min };
}

export function eventsAfter(id: number, limit: number): Array<{ id: number; kind: CommsEventKind; payload: unknown }> {
  const rows = db.prepare(`SELECT id, kind, payload_json FROM comms_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .all(id, Math.max(1, Math.floor(limit))) as { id: number; kind: CommsEventKind; payload_json: string }[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, payload: parse<unknown>(r.payload_json) }));
}

let lastPruneAt = 0;
/** pruneEvents at most once a minute (GET /stream calls it on connect). */
export function pruneEventsThrottled(now: number = Date.now()): void {
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  pruneEvents(now);
}

/** Drop events older than 7 days relative to `now` (epoch ms). */
export function pruneEvents(now: number = Date.now()): number {
  return db.prepare(`DELETE FROM comms_events WHERE at < ?`).run(now - EVENT_RETENTION_MS).changes;
}

/**
 * Messages: a conversation the owner archived comes back to the inbox when someone writes in it.
 * Only the owner's own Comms archive (o_archived = 1) and only for a message sent after it was
 * archived (a backfill of older messages never un-archives); it returns to the source's state
 * (o_archived NULL). The owner's own messages and system lines do not count.
 */
function unarchiveOnArrival(threadId: string, m: Message): void {
  // Omni posting into a room is not "someone wrote" (final review M4).
  if (m.sender?.isSelf || m.sender?.isOmni || m.system || m.redacted || typeof m.sentAt !== "string") return;
  const sent = Date.parse(m.sentAt);
  if (!Number.isFinite(sent)) return;
  const row = db.prepare(`SELECT o_archived_at AS at FROM comms_threads WHERE id = ? AND o_archived = 1`).get(threadId) as { at: string | null } | undefined;
  if (!row) return;
  // A Telegram forum (comms/forums.ts) stays archived (controller ruling, 2026-11-23): its many
  // topics would bring it back all day. Only the owner's Unarchive does; it never pushes meanwhile
  // (notify.ts blocks archived threads). Ordinary DMs and groups keep the Messages rule.
  if (db.prepare(`SELECT 1 FROM comms_thread_members m JOIN comms_conversations c ON c.id = m.conversation_id
    WHERE m.thread_id = ? AND c.source_ref LIKE 'forum:%' LIMIT 1`).get(threadId)) return;
  // Compared as instants, not strings (ISO precision may differ).
  if (row.at !== null && !(sent > Date.parse(row.at))) return;
  const r = db.prepare(`UPDATE comms_threads SET o_archived = NULL, o_archived_at = NULL WHERE id = ? AND o_archived = 1`).run(threadId);
  if (r.changes > 0) {
    // Messages: the chat comes back QUIETLY. The notifier reads the thread after this (a microtask
    // later) and would see an inbox thread, so the message that brought it back is logged as
    // handled in the notifier's dedupe log here, before notify can evaluate it (polish r2: a
    // thread archived at 03:46:38Z pushed at 03:46:54Z).
    if (typeof m.id === "string") markNotifyHandled.run(threadId, m.id, Date.now());
    appendEvent("thread.updated", threadId, { threadId, reason: "unarchived" });
  }
}
const markNotifyHandled = db.prepare(`INSERT OR IGNORE INTO comms_notify_log (thread_id, message_id, at) VALUES (?, ?, ?)`);

/** Owner overrides; they survive re-upserts of the source conversation. Unspecified keys are left as-is. */
export function setOverride(
  threadId: string,
  o: Partial<{ pinned: boolean; muted: boolean; archived: boolean; folder: Folder }>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of [["pinned", "o_pinned"], ["muted", "o_muted"], ["archived", "o_archived"]] as const) {
    if (o[k] !== undefined) { sets.push(`${col} = ?`); params.push(o[k] ? 1 : 0); }
  }
  // When the owner archived (a later arrival un-archives: unarchiveOnArrival).
  if (o.archived !== undefined) { sets.push(`o_archived_at = ?`); params.push(o.archived ? new Date().toISOString() : null); }
  if (o.folder !== undefined) { sets.push(`o_folder = ?`); params.push(o.folder); }
  if (!sets.length) return;
  db.prepare(`UPDATE comms_threads SET ${sets.join(", ")} WHERE id = ?`).run(...params, threadId);
}

/** Thread count per triage status (statuses with no thread are omitted), for one folder (default inbox). */
export function statusCounts(folder: Folder = "inbox"): Record<string, number> {
  const rows = db.prepare(`SELECT c.status AS status, COUNT(*) AS n FROM comms_threads t
    JOIN comms_thread_members m ON m.thread_id = t.id JOIN comms_conversations c ON c.id = m.conversation_id AND ${LEAD}
    WHERE ${E_FOLDER} = ? AND ${visibleSql()} GROUP BY c.status`).all(folder) as { status: string; n: number }[];
  const out: Record<string, number> = {};
  for (const s of COMMS_STATUSES) {
    const n = rows.find((r) => r.status === s)?.n;
    if (n) out[s] = n;
  }
  return out;
}

/**
 * Unread threads in a folder (default inbox): all of them, and those that Need attention
 * (urgent + action-required) — the app badge (Sprint Task 1). Muted threads are not counted.
 */
export function unreadSummary(folder: Folder = "inbox"): { threads: number; attention: number } {
  // A thread whose tags ingest just stripped (status unclassified / triage-failed) still counts by
  // its last verdict (comms_thread_verdicts, kept by comms/notify.ts) — review M1.
  const na = NEEDS_ATTENTION.map(() => "?").join(",");
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN c.status IN (${na})
      OR (c.status IN ('unclassified', 'triage-failed') AND v.status IN (${na})) THEN 1 ELSE 0 END) AS a
    FROM comms_threads t JOIN comms_thread_members m ON m.thread_id = t.id JOIN comms_conversations c ON c.id = m.conversation_id AND ${LEAD} ${READ_JOIN}
    LEFT JOIN comms_thread_verdicts v ON v.thread_id = t.id
    WHERE ${E_FOLDER} = ? AND ${E_MUTED} = 0 AND ${E_UNREAD} > 0 AND ${visibleSql()}`).get(...NEEDS_ATTENTION, ...NEEDS_ATTENTION, folder) as { n: number; a: number | null };
  return { threads: r.n, attention: r.a ?? 0 };
}

/** The statuses `attention=true` stands for. */
export const ATTENTION_STATUSES: readonly CommsStatus[] = NEEDS_ATTENTION;

/**
 * Set the status of the conversation(s) projected from vault note `noteId` (a tag change on the
 * note). Announces thread.updated for each one that changed; returns how many changed.
 */
export function setStatusForNote(noteId: string, status: CommsStatus): number {
  const rows = db.prepare(`SELECT c.id AS id FROM comms_conversations c WHERE c.vault_note_id = ? AND c.status != ?`).all(noteId, status) as { id: string }[];
  let n = 0;
  for (const r of rows) {
    db.prepare(`UPDATE comms_conversations SET status = ? WHERE id = ?`).run(status, r.id);
    // A forum topic: the forum's own status follows its topics.
    const forum = (db.prepare(`SELECT forum_id AS f FROM comms_conversations WHERE id = ?`).get(r.id) as { f: string | null } | undefined)?.f;
    if (forum) refreshForumAggregate(forum);
    for (const t of db.prepare(`SELECT thread_id FROM comms_thread_members WHERE conversation_id = ?`).all(r.id) as { thread_id: string }[])
      appendEvent("thread.updated", t.thread_id, { threadId: t.thread_id });
    n++;
  }
  return n;
}

// ── people: who is in a conversation ─────────────────────────────────────────

export interface ConversationMember { memberId: string; personId: string | null }

/** Replace a conversation's member rows (a no-op when they are unchanged). */
export function replaceConversationMembers(conversationId: string, members: ConversationMember[]): void {
  const have = db.prepare(`SELECT member_id, person_id FROM comms_conversation_members WHERE conversation_id = ?`).all(conversationId) as { member_id: string; person_id: string | null }[];
  const want = new Map(members.map((m) => [m.memberId.toLowerCase(), m.personId]));
  if (have.length === want.size && have.every((h) => want.has(h.member_id) && want.get(h.member_id) === h.person_id)) return;
  db.transaction(() => {
    db.prepare(`DELETE FROM comms_conversation_members WHERE conversation_id = ?`).run(conversationId);
    const ins = db.prepare(`INSERT INTO comms_conversation_members (conversation_id, member_id, person_id) VALUES (?, ?, ?)`);
    for (const [id, p] of want) ins.run(conversationId, id, p);
  })();
}

/** The member rows of a display thread's conversation(s). */
export function threadMembers(threadId: string): ConversationMember[] {
  return (db.prepare(`SELECT cm.member_id AS member_id, cm.person_id AS person_id FROM comms_thread_members m
    JOIN comms_conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.thread_id = ?`).all(threadId) as { member_id: string; person_id: string | null }[])
    .map((r) => ({ memberId: r.member_id, personId: r.person_id }));
}

/** Ghost / member ids of the DMs a person is in (their bridge ids, for contact data). */
export function personMemberIds(personId: string): string[] {
  return (db.prepare(`SELECT DISTINCT cm.member_id AS id FROM comms_conversation_members cm
    JOIN comms_conversations c ON c.id = cm.conversation_id WHERE cm.person_id = ? AND c.kind = 'dm' LIMIT 200`).all(personId) as { id: string }[]).map((r) => r.id);
}

/** Set the person a (single-conversation) display thread is with; null clears it. */
export function setThreadPerson(threadId: string, personId: string | null): void {
  db.prepare(`UPDATE comms_threads SET person_id = ? WHERE id = ? AND person_id IS NOT ?`).run(personId, threadId, personId);
}

/** Every conversation with this person (all folders), newest activity first, pinned NOT first. Bounded. */
export function threadsOfPerson(personId: string, limit = 200): Thread[] {
  const rows = db.prepare(`${SELECT_THREAD}
    WHERE (t.person_id = ? OR ${WITH_PERSON})
      AND ${visibleSql()}
    ORDER BY c.last_event_at DESC, t.id DESC LIMIT ?`).all(personId, personId, Math.max(1, Math.floor(limit))) as ThreadSqlRow[];
  return rows.map(toThread);
}

// ── Telegram forums: the aggregate row (comms/forums.ts) ───────────────────────

/** Forum status: the most pressing of its topics' (display order: urgent, action-required,
 *  unclassified …, handled last) — "Handled" only when every topic is. */
export function forumStatusOf(statuses: readonly string[]): CommsStatus {
  let best: CommsStatus | null = null;
  for (const s of statuses) {
    if (!isCommsStatus(s)) continue;
    if (best === null || COMMS_STATUSES.indexOf(s) < COMMS_STATUSES.indexOf(best)) best = s;
  }
  return best ?? "unclassified";
}

/**
 * Recompute a forum's aggregate conversation from its topics: newest activity, the newest topic's
 * preview as "Topic · Sender: text", the sum of the topics' unread guesses, Low only when every
 * topic is, the most pressing status, the newest topic's capabilities. Title and avatar (the
 * forum's own, from the bridge) are written by comms/forums.ts. Returns whether the row changed.
 */
export function refreshForumAggregate(forumConversationId: string): boolean {
  const before = db.prepare(`SELECT * FROM comms_conversations WHERE id = ?`).get(forumConversationId) as Record<string, unknown> | undefined;
  if (!before) return false;
  const topics = db.prepare(`SELECT title, last_event_at, last_preview_json, unread_count, folder, status, capabilities_json
    FROM comms_conversations WHERE forum_id = ? ORDER BY last_event_at DESC, id DESC`).all(forumConversationId) as {
      title: string; last_event_at: string; last_preview_json: string | null; unread_count: number; folder: string; status: string; capabilities_json: string | null;
    }[];
  if (!topics.length) return false;
  const newest = topics[0]!;
  const p = parse<MessagePreview>(newest.last_preview_json);
  const preview: MessagePreview | null = p ? { ...p, text: `${newest.title} · ${p.text}` } : null;
  const folder = topics.every((t) => t.folder === "low") ? "low" : "inbox";
  const unread = topics.reduce((n, t) => n + (t.unread_count > 0 ? t.unread_count : 0), 0);
  db.prepare(`UPDATE comms_conversations SET last_event_at = ?, last_preview_json = ?, unread_count = ?, unread_trusted = 0, folder = ?,
      status = ?, capabilities_json = ?, search_text = ? WHERE id = ?`)
    .run(newest.last_event_at, json(preview), unread, folder, forumStatusOf(topics.map((t) => t.status)), newest.capabilities_json,
      searchTextOf(String(before.title ?? ""), preview?.text), forumConversationId);
  const after = db.prepare(`SELECT * FROM comms_conversations WHERE id = ?`).get(forumConversationId);
  return JSON.stringify(before) !== JSON.stringify(after);
}
