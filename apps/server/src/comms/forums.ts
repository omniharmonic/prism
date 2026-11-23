// Telegram forums in Comms (owner-testing round 5: "my archiving of chats might not be sticking").
//
// mautrix-telegram bridges each forum TOPIC as its own room (room-meta.ts `forumOf`). Comms shows a
// forum as ONE display thread, as Telegram does:
//
//   - The forum's AGGREGATE conversation (id = conversationIdForKey("forum:<key>"), source_ref
//     "forum:<key>", network telegram, kind group) stands for the thread in every listing: title and
//     avatar are the forum's own (bridge `network` field), preview "Topic · Sender: text" of the
//     newest topic, unread = the sum, lastActivity = the newest, status = the most pressing topic's
//     (store.ts refreshForumAggregate).
//   - Each topic room stays a conversation (forum_id = the aggregate's id, forum_topic = Telegram's
//     topic id) AND a member of the forum thread, so "which thread is this room?" (live batches,
//     status sync, removals, notifications) answers the forum thread. store.ts `LEAD` keeps topic
//     rows out of the listings.
//   - EVERY piece of thread-level owner state is the forum thread's: archive, mute, pins, folders and
//     their notification rules, status, read marker, notifications, search hits, Omni drafts.
//   - Messages are cached PER TOPIC: the window cache, cursors and comms_messages use the topic's
//     cache id `th_<topic conversation>` (the per-topic thread id the forum replaced), while every
//     message carries `threadId` = the forum thread and `topic` = {id, title}. Message events are
//     appended under the forum thread with `cache_id` = the topic, so window freshness stays per topic.
//   - Sending needs a concrete topic (never "All"): routes refuse 422 topic_required without one.
//
// MIGRATION (`mergeForumThreads`, after every rebuild and live projection): a topic conversation that
// is still a member of its own old per-topic thread has that thread's owner state merged into the
// forum thread — archived / muted only if EVERY topic was, pinned if ANY was (the lowest pin
// position), folders united, the newest read marker — and the old id REDIRECTS to the forum thread
// (comms_thread_redirects; routes resolve it), so open clients and deep links keep working.
import { db } from "../db";
import { appendEvent, forumTopicUnreadSql, refreshForumAggregate, upsertConversation } from "./store";
import { conversationIdFor, conversationIdForKey } from "./project";
import { resolveAvatar } from "./naming";
import { threadSource } from "./timeline";
import { withSendFlag } from "./send-policy";
import { withReadState } from "./receipts";
import type { ForumRef } from "./room-meta";
import type { Capabilities, Message, MessagePreview, Network, TopicRef } from "./types";

export const forumConversationId = (key: string): string => conversationIdForKey(`forum:${key}`);
export const forumThreadId = (key: string): string => `th_${forumConversationId(key)}`;
/** Where a topic's messages are cached (its old per-topic thread id). */
export const topicCacheId = (conversationId: string): string => `th_${conversationId}`;

export interface ForumTopic {
  /** Opaque topic id on the wire: the topic room's conversation id. */
  id: string;
  /** Telegram's own topic id (`channel:<chat>:<topic>`). */
  topicId: string | null;
  title: string;
  roomId: string;
  network: Network;
  lastActivityAt: string;
  lastMessage: MessagePreview | null;
  capabilities: Capabilities | null;
  unreadGuess: number;
  noteId: string | null;
  cacheId: string;
}

interface TopicSqlRow {
  id: string; forum_topic: string | null; title: string; source_ref: string; network: Network; last_event_at: string;
  last_preview_json: string | null; capabilities_json: string | null; unread_count: number; vault_note_id: string | null;
}
const parse = <T>(s: string | null): T | null => {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};
const toTopic = (r: TopicSqlRow): ForumTopic => ({
  id: r.id, topicId: r.forum_topic, title: r.title, roomId: r.source_ref, network: r.network, lastActivityAt: r.last_event_at,
  lastMessage: parse<MessagePreview>(r.last_preview_json), capabilities: parse<Capabilities>(r.capabilities_json),
  unreadGuess: r.unread_count, noteId: r.vault_note_id, cacheId: topicCacheId(r.id),
});
export const topicRef = (t: Pick<ForumTopic, "id" | "title">): TopicRef => ({ id: t.id, title: t.title });

const TOPIC_COLS = `c.id, c.forum_topic, c.title, c.source_ref, c.network, c.last_event_at, c.last_preview_json, c.capabilities_json, c.unread_count, c.vault_note_id`;

/** The forum's aggregate conversation id when `threadId` is a forum thread, else null. */
export function forumOfThread(threadId: string): string | null {
  const r = db.prepare(`SELECT c.id AS id FROM comms_thread_members m JOIN comms_conversations c ON c.id = m.conversation_id
    WHERE m.thread_id = ? AND c.source_ref LIKE 'forum:%' LIMIT 1`).get(threadId) as { id: string } | undefined;
  return r?.id ?? null;
}
export const isForumThread = (threadId: string): boolean => forumOfThread(threadId) !== null;

/** A forum thread's topics, newest activity first ([] for any other thread). */
export function forumTopics(threadId: string): ForumTopic[] {
  const f = forumOfThread(threadId);
  if (!f) return [];
  return (db.prepare(`SELECT ${TOPIC_COLS} FROM comms_conversations c WHERE c.forum_id = ? AND c.source_ref LIKE '!%'
    ORDER BY c.last_event_at DESC, c.id DESC LIMIT 500`).all(f) as TopicSqlRow[]).map(toTopic);
}

/** One topic of a forum thread, by its wire id (conversation id) or Telegram topic id. */
export function forumTopic(threadId: string, topic: string): ForumTopic | null {
  const f = forumOfThread(threadId);
  if (!f || !topic || topic.length > 100) return null;
  const r = db.prepare(`SELECT ${TOPIC_COLS} FROM comms_conversations c WHERE c.forum_id = ? AND c.source_ref LIKE '!%'
    AND (c.id = ? OR c.forum_topic = ?) ORDER BY c.id = ? DESC LIMIT 1`).get(f, topic, topic, topic) as TopicSqlRow | undefined;
  return r ? toTopic(r) : null;
}

/** The topic a Matrix room is, with its forum thread; null for a room that is no forum topic. */
export function topicOfRoom(roomId: string): { threadId: string; topic: ForumTopic } | null {
  const r = db.prepare(`SELECT ${TOPIC_COLS}, c.forum_id AS forum_id FROM comms_conversations c WHERE c.id = ? AND c.forum_id IS NOT NULL`)
    .get(conversationIdFor(roomId)) as (TopicSqlRow & { forum_id: string }) | undefined;
  return r ? { threadId: `th_${r.forum_id}`, topic: toTopic(r) } : null;
}

/** The forum topic whose cached window holds message `eventId` (reactions, replies), or null. */
export function topicOfMessage(threadId: string, eventId: string): ForumTopic | null {
  const topics = forumTopics(threadId);
  if (!topics.length || !eventId) return null;
  const r = db.prepare(`SELECT thread_id FROM comms_messages WHERE source_event_id = ? AND thread_id IN (${topics.map(() => "?").join(",")}) LIMIT 1`)
    .get(eventId, ...topics.map((t) => t.cacheId)) as { thread_id: string } | undefined;
  return r ? topics.find((t) => t.cacheId === r.thread_id) ?? null : null;
}

/** The topic of the newest activity (the default send target when the owner picked none). */
export const newestTopic = (threadId: string): ForumTopic | null => forumTopics(threadId)[0] ?? null;

/** The window cache id for a room: a forum topic's own, else its display thread's. */
export function windowKeyOfRoom(roomId: string): string | null {
  const t = topicOfRoom(roomId);
  if (t) return t.topic.cacheId;
  return (db.prepare(`SELECT thread_id FROM comms_thread_members WHERE conversation_id = ? LIMIT 1`).get(conversationIdFor(roomId)) as { thread_id: string } | undefined)?.thread_id ?? null;
}

/** A forum message as the wire names it: the forum thread and its topic. */
export const inTopic = (m: Message, threadId: string, t: Pick<ForumTopic, "id" | "title">): Message => ({ ...m, threadId, topic: topicRef(t) });

// ── projection ────────────────────────────────────────────────────────────────

const insertThread = db.prepare(`INSERT OR IGNORE INTO comms_threads (id) VALUES (?)`);
const insertMember = db.prepare(`INSERT OR IGNORE INTO comms_thread_members (thread_id, conversation_id) VALUES (?, ?)`);

/**
 * Make topic conversation `conversationId` (just upserted by the projection) a topic of `forum`:
 * the forum's aggregate conversation and display thread exist, the topic is a member, the aggregate
 * is recomputed. Returns the forum thread id and whether the aggregate row changed. The topic's old
 * per-topic thread is merged later (mergeForumThreads), once the pass has attached every topic.
 */
export function attachTopic(conversationId: string, forum: ForumRef, topicTitle: string): { threadId: string; changed: boolean } {
  const fid = forumConversationId(forum.key);
  const threadId = `th_${fid}`;
  let changed = false;
  db.transaction(() => {
    const cur = db.prepare(`SELECT title, avatar_json, last_event_at FROM comms_conversations WHERE id = ?`).get(fid) as
      { title: string; avatar_json: string | null; last_event_at: string } | undefined;
    const title = forum.name?.trim() || cur?.title || topicTitle || "Telegram forum";
    const avatar = resolveAvatar({ roomAvatar: forum.avatar, title });
    if (!cur) {
      upsertConversation({
        id: fid, network: "telegram", sourceRef: `forum:${forum.key}`, kind: "group", title, titleSource: "room", avatar,
        lastEventAt: new Date(0).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
        pinned: false, muted: false, archived: false, triage: null, status: "unclassified", accountLabel: null, capabilities: null, vaultNoteId: null,
      });
      changed = true;
    } else if (cur.title !== title || cur.avatar_json !== JSON.stringify(avatar)) {
      db.prepare(`UPDATE comms_conversations SET title = ?, title_source = 'room', avatar_json = ? WHERE id = ?`).run(title, JSON.stringify(avatar), fid);
      changed = true;
    }
    db.prepare(`UPDATE comms_conversations SET forum_id = ?, forum_topic = ? WHERE id = ? AND (forum_id IS NOT ? OR forum_topic IS NOT ?)`)
      .run(fid, forum.topicId, conversationId, fid, forum.topicId);
    insertThread.run(threadId);
    insertMember.run(threadId, fid);
    insertMember.run(threadId, conversationId);
    db.prepare(`INSERT OR IGNORE INTO comms_forum_threads (thread_id, forum_key, created_at) VALUES (?, ?, ?)`).run(threadId, forum.key, Date.now());
    if (refreshForumAggregate(fid)) changed = true;
  })();
  return { threadId, changed };
}

/** A room that was a forum topic and is not any more: back to a thread of its own. */
export function detachTopic(conversationId: string): string | null {
  const r = db.prepare(`SELECT forum_id FROM comms_conversations WHERE id = ? AND forum_id IS NOT NULL`).get(conversationId) as { forum_id: string } | undefined;
  if (!r) return null;
  db.transaction(() => {
    db.prepare(`UPDATE comms_conversations SET forum_id = NULL, forum_topic = NULL WHERE id = ?`).run(conversationId);
    db.prepare(`DELETE FROM comms_thread_members WHERE thread_id = ? AND conversation_id = ?`).run(`th_${r.forum_id}`, conversationId);
    db.prepare(`DELETE FROM comms_thread_redirects WHERE from_id = ?`).run(topicCacheId(conversationId));
    refreshForumAggregate(r.forum_id);
  })();
  appendEvent("thread.updated", `th_${r.forum_id}`, { threadId: `th_${r.forum_id}` });
  return `th_${r.forum_id}`;
}

// ── migration: per-topic threads → the forum thread ──────────────────────────

interface OldThread {
  id: string; o_pinned: number | null; o_muted: number | null; o_archived: number | null; o_folder: string | null;
  o_pin_order: number | null; o_archived_at: string | null;
}

/** Follow a thread id's redirect (a per-topic thread that became its forum's); the id itself otherwise. */
export function resolveThreadRedirect(id: string): string {
  let cur = id;
  for (let i = 0; i < 4; i++) {
    const r = db.prepare(`SELECT to_id FROM comms_thread_redirects WHERE from_id = ?`).get(cur) as { to_id: string } | undefined;
    if (!r || r.to_id === cur) break;
    cur = r.to_id;
  }
  return cur;
}

/**
 * Merge every not-yet-merged per-topic thread into its forum thread (see the header). Idempotent;
 * returns how many old threads were merged. Each forum is one transaction; events follow it.
 */
export function mergeForumThreads(): number {
  const rows = db.prepare(`SELECT c.id AS conv, c.forum_id AS forum, c.title AS title, m.thread_id AS old FROM comms_conversations c
    JOIN comms_thread_members m ON m.conversation_id = c.id
    WHERE c.forum_id IS NOT NULL AND m.thread_id != 'th_' || c.forum_id`).all() as { conv: string; forum: string; title: string; old: string }[];
  if (!rows.length) return 0;
  const byForum = new Map<string, typeof rows>();
  for (const r of rows) byForum.set(r.forum, [...(byForum.get(r.forum) ?? []), r]);
  let merged = 0;
  const announce: string[] = [];
  for (const [forum, olds] of byForum) {
    const ft = `th_${forum}`;
    db.transaction(() => {
      const state = (id: string) => db.prepare(`SELECT id, o_pinned, o_muted, o_archived, o_folder, o_pin_order, o_archived_at FROM comms_threads WHERE id = ?`).get(id) as OldThread | undefined;
      const oldStates = olds.map((o) => state(o.old) ?? { id: o.old, o_pinned: null, o_muted: null, o_archived: null, o_folder: null, o_pin_order: null, o_archived_at: null });
      const topicCount = (db.prepare(`SELECT COUNT(*) AS n FROM comms_conversations WHERE forum_id = ?`).get(forum) as { n: number }).n;
      const cur = state(ft)!;
      // The first merge decides from the topics alone — unless the owner already set state on the
      // forum row itself (a restart between attach and merge, review m3): then it is kept.
      const untouched = cur.o_archived === null && cur.o_muted === null && cur.o_pinned === null && cur.o_folder === null;
      const wasMerged = !!(db.prepare(`SELECT merged FROM comms_forum_threads WHERE thread_id = ?`).get(ft) as { merged: number } | undefined)?.merged;
      const firstMerge = untouched && !wasMerged;
      const ownerSet = !untouched && !wasMerged;
      const allOf = (k: "o_archived" | "o_muted") => oldStates.every((s) => s[k] === 1);
      const archivedAt = oldStates.map((s) => s.o_archived_at).filter((x): x is string => !!x).sort().pop() ?? null;
      const pinned = oldStates.some((s) => s.o_pinned === 1);
      const order = Math.min(...oldStates.filter((s) => s.o_pinned === 1 && typeof s.o_pin_order === "number").map((s) => s.o_pin_order!), Infinity);
      let archived: number | null, muted: number | null, pin: number | null, pinOrder: number | null, folder: string | null;
      if (firstMerge) {
        // Every topic counts: one that had no thread of its own (a new topic) was neither archived nor muted.
        const everyTopic = oldStates.length >= topicCount;
        archived = everyTopic && allOf("o_archived") ? 1 : null;
        muted = everyTopic && allOf("o_muted") ? 1 : null;
        pin = pinned ? 1 : null;
        pinOrder = pinned && Number.isFinite(order) ? order : null;
        const folders = new Set(oldStates.map((s) => s.o_folder));
        folder = folders.size === 1 && everyTopic ? [...folders][0]! : null;
      } else if (ownerSet) {
        // The owner chose on the forum row itself before any merge: his choice stands (pins add up).
        archived = cur.o_archived;
        muted = cur.o_muted;
        pin = cur.o_pinned === 1 || pinned ? 1 : cur.o_pinned;
        pinOrder = cur.o_pinned === 1 ? cur.o_pin_order : pinned && Number.isFinite(order) ? order : cur.o_pin_order;
        folder = cur.o_folder;
      } else {
        // The forum thread has the owner's state already: a topic that was not archived / muted
        // un-does "every topic"; a pinned one pins.
        archived = cur.o_archived === 1 && !allOf("o_archived") ? null : cur.o_archived;
        muted = cur.o_muted === 1 && !allOf("o_muted") ? null : cur.o_muted;
        pin = cur.o_pinned === 1 || pinned ? 1 : cur.o_pinned;
        pinOrder = cur.o_pinned === 1 ? cur.o_pin_order : pinned && Number.isFinite(order) ? order : cur.o_pin_order;
        folder = cur.o_folder;
      }
      // An archived thread holds no Comms pin (thread-actions setArchived, final review M5).
      if (archived === 1) { pin = null; pinOrder = null; }
      db.prepare(`UPDATE comms_threads SET o_archived = ?, o_archived_at = ?, o_muted = ?, o_pinned = ?, o_pin_order = ?, o_folder = ? WHERE id = ?`)
        .run(archived, archived === 1 ? (firstMerge ? archivedAt : cur.o_archived_at) ?? new Date().toISOString() : null, muted, pin, pin === 1 ? pinOrder : null, folder, ft);
      for (const o of olds) {
        const old = o.old;
        // Recoverable: what this topic's own thread held (review I-3).
        const os = oldStates.find((x) => x.id === old)!;
        const folders = (db.prepare(`SELECT folder_id FROM comms_folder_members WHERE thread_id = ?`).all(old) as { folder_id: string }[]).map((r) => r.folder_id);
        const marker = db.prepare(`SELECT read_at, manual_unread FROM comms_read_markers WHERE thread_id = ?`).get(old) ?? null;
        db.prepare(`INSERT OR IGNORE INTO comms_forum_merge_log (old_thread_id, forum_thread_id, conversation_id, state_json, at) VALUES (?, ?, ?, ?, ?)`)
          .run(old, ft, o.conv, JSON.stringify({ archived: os.o_archived, archivedAt: os.o_archived_at, muted: os.o_muted, pinned: os.o_pinned, pinOrder: os.o_pin_order, folder: os.o_folder, folderIds: folders, readMarker: marker }), Date.now());
        // Owner folders: the union.
        db.prepare(`INSERT OR IGNORE INTO comms_folder_members (folder_id, thread_id, added_at) SELECT folder_id, ?, added_at FROM comms_folder_members WHERE thread_id = ?`).run(ft, old);
        // Read state is kept PER TOPIC (fix round 1, m5): the old marker becomes the topic's own read
        // point; the forum's marker is the OLDEST of them (a topic that had none reads from there),
        // and a manual unread anywhere stays unread.
        const mk = db.prepare(`SELECT read_at, manual_unread FROM comms_read_markers WHERE thread_id = ?`).get(old) as { read_at: string; manual_unread: number } | undefined;
        if (mk) {
          if (mk.read_at) {
            db.prepare(`INSERT INTO comms_topic_read_markers (cache_id, thread_id, read_at, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(cache_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at), thread_id = excluded.thread_id, updated_at = excluded.updated_at`)
              .run(topicCacheId(o.conv), ft, mk.read_at, Date.now());
          }
          db.prepare(`INSERT INTO comms_read_markers (thread_id, read_at, manual_unread, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET read_at = MIN(read_at, excluded.read_at), manual_unread = MAX(manual_unread, excluded.manual_unread), updated_at = excluded.updated_at`)
            .run(ft, mk.read_at, mk.manual_unread, Date.now());
        }
        // Notifications already sent, Omni notes closed, search hits: now the forum's.
        db.prepare(`INSERT OR IGNORE INTO comms_notify_log (thread_id, message_id, at) SELECT ?, message_id, at FROM comms_notify_log WHERE thread_id = ?`).run(ft, old);
        db.prepare(`INSERT OR IGNORE INTO comms_omni_dismissed (thread_id, turn_id, at) SELECT ?, turn_id, at FROM comms_omni_dismissed WHERE thread_id = ?`).run(ft, old);
        db.prepare(`UPDATE comms_search_rows SET thread_id = ? WHERE thread_id = ?`).run(ft, old);
        db.prepare(`UPDATE comms_search_media SET thread_id = ? WHERE thread_id = ?`).run(ft, old);
        // The topic's cached window stays (it IS the topic's cache); its messages now name the forum + topic.
        db.prepare(`UPDATE comms_messages SET json = json_set(json, '$.threadId', ?, '$.topic', json(?)) WHERE thread_id = ?`)
          .run(ft, JSON.stringify({ id: o.conv, title: o.title }), topicCacheId(o.conv));
        for (const t of ["comms_notify_log", "comms_omni_dismissed", "comms_folder_members", "comms_read_markers", "comms_thread_verdicts", "comms_status_undo"])
          db.prepare(`DELETE FROM ${t} WHERE thread_id = ?`).run(old);
        db.prepare(`DELETE FROM comms_thread_members WHERE thread_id = ?`).run(old);
        db.prepare(`DELETE FROM comms_threads WHERE id = ?`).run(old);
        db.prepare(`INSERT INTO comms_thread_redirects (from_id, to_id, at) VALUES (?, ?, ?) ON CONFLICT(from_id) DO UPDATE SET to_id = excluded.to_id`).run(old, ft, Date.now());
        db.prepare(`UPDATE comms_thread_redirects SET to_id = ? WHERE to_id = ?`).run(ft, old);
        announce.push(old);
        merged++;
      }
      db.prepare(`UPDATE comms_forum_threads SET merged = 1 WHERE thread_id = ?`).run(ft);
    })();
    announce.push(ft);
  }
  // Open clients drop the old rows (they now redirect) and refetch the list once.
  for (const id of announce) appendEvent("thread.updated", id, { threadId: id, reason: "forum" });
  appendEvent("thread.updated", null, { threadId: null, reason: "forums" });
  return merged;
}

/** Read-only counts for the dry run (scripts/comms-forums-dryrun.ts): no ids, no names. */
export interface ForumDryRun { forums: number; topics: number; perTopicThreads: number; archivedTopics: number; mutedTopics: number; pinnedTopics: number }

/** The source room a projected message came from: its forum topic's room, else its thread's. */
export function roomOfMessage(m: Pick<Message, "threadId" | "topic">): string | null {
  if (m.topic?.id) {
    const r = db.prepare(`SELECT source_ref FROM comms_conversations WHERE id = ? AND forum_id IS NOT NULL`).get(m.topic.id) as { source_ref: string } | undefined;
    if (r) return r.source_ref;
  }
  return threadSource(m.threadId)?.roomId ?? null;
}

// ── wire ──────────────────────────────────────────────────────────────────────

export interface TopicOut {
  id: string;
  title: string;
  lastActivityAt: string;
  lastMessage?: MessagePreview;
  /** Unread in this topic: cached messages from others after the forum's read marker (and after
   *  the owner's own latest message there); before any marker, the source's own guess. */
  unread: number;
  capabilities?: Capabilities;
}

/** GET /threads/:id `topics` for a forum thread, newest activity first. */
export function forumTopicsOut(threadId: string, topics: ForumTopic[] = forumTopics(threadId)): TopicOut[] {
  const mk = db.prepare(`SELECT read_at, manual_unread FROM comms_read_markers WHERE thread_id = ?`).get(threadId) as { read_at: string; manual_unread: number } | undefined;
  // The same per-topic rule as the forum's own unread (store.ts forumTopicUnreadSql).
  const counts = mk
    ? new Map((db.prepare(`SELECT x.id AS id, ${forumTopicUnreadSql("x", "@readAt")} AS n FROM comms_conversations x WHERE x.forum_id = @forum`)
        .all({ readAt: mk.read_at, forum: forumOfThread(threadId) }) as { id: string; n: number }[]).map((r) => [r.id, r.n]))
    : null;
  return topics.map((t) => {
    const unread = counts ? counts.get(t.id) ?? 0 : t.unreadGuess > 0 ? t.unreadGuess : 0;
    return {
      id: t.id, title: t.title, lastActivityAt: t.lastActivityAt, ...(t.lastMessage ? { lastMessage: t.lastMessage } : {}), unread,
      ...(t.capabilities ? { capabilities: withSendFlag(t.network, t.capabilities) } : {}),
    };
  });
}

/** Read receipts (Task 8) for a page of forum messages: each against its own topic room. */
export function withForumReadState(messages: Message[]): Message[] {
  const groups = new Map<string, Message[]>();
  for (const m of messages) groups.set(m.topic?.id ?? "", [...(groups.get(m.topic?.id ?? "") ?? []), m]);
  const out = new Map<string, Message>();
  for (const g of groups.values()) for (const m of withReadState(g, roomOfMessage(g[0]!))) out.set(m.id, m);
  return messages.map((m) => out.get(m.id) ?? m);
}

// ── route helpers (fix round 1) ──────────────────────────────────────────────

/**
 * The thread a route names and, when it names a per-topic thread that became its forum's, that
 * topic (review I-5): an older client (0.3.5), a deep link or a notification holding the old id
 * means exactly that topic — never "All", never a guess.
 */
export function threadAndImpliedTopic(raw: string): { threadId: string; impliedTopic: string | null } {
  const threadId = resolveThreadRedirect(raw);
  if (threadId === raw || !raw.startsWith("th_")) return { threadId, impliedTopic: null };
  const r = db.prepare(`SELECT forum_id FROM comms_conversations WHERE id = ?`).get(raw.slice(3)) as { forum_id: string | null } | undefined;
  return { threadId, impliedTopic: r?.forum_id && `th_${r.forum_id}` === threadId ? raw.slice(3) : null };
}

/** The send's topic: the one the client declared, else the one its (old) thread id implies. A
 *  declared topic that is not the implied one is refused (null + mismatch): no re-resolution. */
export function chooseTopic(threadId: string, declared: string | null, implied: string | null): { topic: string | null; mismatch: boolean } {
  if (!implied) return { topic: declared, mismatch: false };
  if (!declared) return { topic: implied, mismatch: false };
  return forumTopic(threadId, declared)?.id === implied ? { topic: implied, mismatch: false } : { topic: null, mismatch: true };
}
