// A Telegram forum's timeline (comms/forums.ts): one topic, or "All topics" merged.
//
// One topic = the ordinary timeline (timeline.ts readTimeline) of that topic's room, cached under the
// topic's cache id, every message tagged with its topic.
//
// All topics = a k-way merge, newest last, over the topics' own timelines. The client holds one
// opaque `tc_…` cursor whose server-side state (comms_forum_cursors, a day's TTL) is
//   b  the oldest message already served (sentAt, id): everything served next is strictly older;
//   t  per topic: `p` where its timeline continues (a topic cursor; absent = its newest page;
//      false = exhausted) and `u` an upper bound of what it still holds (to skip topics that cannot
//      reach this page — a 21-topic forum costs only the topics that actually hold the next messages).
// A topic page that was only partly served keeps its position: the next page reads it again and
// keeps what is older than `b` (cheap: it is the topic's window or the same source page).
import { randomBytes } from "node:crypto";
import { db } from "../db";
import { readTimeline, type CommsReader, type TimelinePage, CursorNotFoundError } from "./timeline";
import { forumTopics, inTopic, type ForumTopic } from "./forums";
import type { Message } from "./types";

const CURSOR_TTL_MS = 24 * 60 * 60_000;
/** Topic pages one request may read for one topic while skipping messages already served. */
const MAX_SKIP_READS = 3;

interface TopicPos { p?: string | false; u?: string }
interface AllState { b: { ts: string; id: string } | null; t: Record<string, TopicPos> }

export interface ForumTimelineRequest {
  threadId: string;
  limit: number;
  before?: string;
  reader: () => CommsReader;
  stillAllowed: () => boolean;
}

const newer = (a: Message, b: Message) => (a.sentAt > b.sentAt || (a.sentAt === b.sentAt && a.id > b.id));
const olderThan = (b: AllState["b"]) => (m: Message) => !b || m.sentAt < b.ts || (m.sentAt === b.ts && m.id < b.id);

/** One topic's page (the ordinary timeline, tagged with the topic). */
export function readTopicTimeline(threadId: string, topic: ForumTopic, q: Omit<ForumTimelineRequest, "threadId">): Promise<TimelinePage> {
  return readTimeline({
    threadId: topic.cacheId, displayThreadId: threadId, decorate: (m) => inTopic(m, threadId, topic),
    source: { roomId: topic.roomId, network: topic.network }, limit: q.limit, ...(q.before ? { before: q.before } : {}),
    reader: q.reader, stillAllowed: q.stillAllowed,
  });
}

function loadState(id: string, threadId: string): AllState | null {
  const r = db.prepare(`SELECT state_json FROM comms_forum_cursors WHERE id = ? AND thread_id = ? AND created_at >= ?`)
    .get(id, threadId, Date.now() - CURSOR_TTL_MS) as { state_json: string } | undefined;
  if (!r) return null;
  try { return JSON.parse(r.state_json) as AllState; } catch { return null; }
}

function mintState(threadId: string, s: AllState): string {
  const id = `tc_${randomBytes(18).toString("base64url")}`;
  const now = Date.now();
  db.prepare(`DELETE FROM comms_forum_cursors WHERE created_at < ?`).run(now - CURSOR_TTL_MS);
  db.prepare(`INSERT INTO comms_forum_cursors (id, thread_id, state_json, created_at) VALUES (?, ?, ?, ?)`).run(id, threadId, JSON.stringify(s), now);
  return id;
}

/** Is `before` an "All topics" cursor of this forum thread? */
export const isAllTopicsCursor = (id: string, threadId: string): boolean => !!loadState(id, threadId);

/** "All topics": the newest `limit` messages across every topic older than the cursor, newest last. */
export async function readAllTopics(q: ForumTimelineRequest): Promise<TimelinePage> {
  const topics = forumTopics(q.threadId);
  let state: AllState = { b: null, t: {} };
  if (q.before) {
    const s = loadState(q.before, q.threadId);
    if (!s) throw new CursorNotFoundError();
    state = s;
  }
  const keep = olderThan(state.b);
  // Order by what each topic can still hold (a topic never read: its newest activity).
  const bound = (t: ForumTopic): string => state.t[t.id]?.u ?? t.lastActivityAt;
  const live = topics.filter((t) => state.t[t.id]?.p !== false).sort((a, b) => (bound(a) < bound(b) ? 1 : bound(a) > bound(b) ? -1 : 0));
  const pool: Message[] = [];
  const read = new Map<string, { from: string | undefined; next: string | null; got: Message[] }>();
  for (const t of live) {
    if (pool.length >= q.limit) {
      pool.sort((a, b) => (newer(a, b) ? -1 : 1));
      const cut = pool[q.limit - 1]!;
      // Everything this topic (and every later one) holds is older than the page's oldest message.
      if (bound(t) < cut.sentAt) break;
    }
    let from: string | undefined = state.t[t.id]?.p || undefined;
    let got: Message[] = [];
    let next: string | null = null;
    for (let i = 0; i < MAX_SKIP_READS; i++) {
      const page = await readTopicTimeline(q.threadId, t, { limit: q.limit, ...(from ? { before: from } : {}), reader: q.reader, stillAllowed: q.stillAllowed });
      got = page.messages.filter(keep);
      next = page.before;
      if (got.length || !next) break;
      from = next; // this page holds only what was served already
    }
    read.set(t.id, { from, next, got });
    pool.push(...got);
  }
  pool.sort((a, b) => (newer(a, b) ? -1 : 1));
  const served = pool.slice(0, q.limit);
  const servedIds = new Set(served.map((m) => m.id));
  const oldest = served[served.length - 1];
  const nextState: AllState = { b: oldest ? { ts: oldest.sentAt, id: oldest.id } : state.b, t: { ...state.t } };
  for (const [id, r] of read) {
    const left = r.got.filter((m) => !servedIds.has(m.id));
    if (!left.length) {
      const last = r.got.reduce<Message | null>((a, m) => (!a || newer(a, m) ? m : a), null);
      nextState.t[id] = r.next ? { p: r.next, ...(last ? { u: last.sentAt } : nextState.t[id]?.u ? { u: nextState.t[id]!.u } : {}) } : { p: false };
    } else {
      const top = left.reduce((a, m) => (newer(m, a) ? m : a));
      nextState.t[id] = { ...(r.from ? { p: r.from } : {}), u: top.sentAt };
    }
  }
  const more = topics.some((t) => nextState.t[t.id]?.p !== false);
  const messages = served.reverse();
  return { messages, before: more ? mintState(q.threadId, nextState) : null, hasMore: more };
}
