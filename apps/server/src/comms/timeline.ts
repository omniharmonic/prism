// Comms read path (Task 9): thread → source room, the paged normalized timeline with its
// window cache and server-side cursors, and the mxc → media-token rewrite every response
// goes through. Routes live in routes/comms.ts.
//
// Cursors: the client only ever holds `tc_<24 base64url>`, an id into comms_timeline_cursors.
// The row keeps the Matrix pagination token and the relations of newer pages whose target
// was not loaded yet (normalizeEvents → pendingRelations); they are folded into the older
// page when it is fetched. A cursor is bound to its thread and expires after a day.
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";
import { agentSenderIds, isBridgeBot, MatrixClient, type MatrixCreds, type MatrixEvent } from "../worker/matrix";
import { commsSelfIds, storedOwnerSenders } from "./owner";
import { displayNameFor } from "./naming";
import { MAX_PENDING, normalizeEvents } from "./normalize";
import { mintMediaToken } from "./media";
import { appendEvent, putWindow, readWindow, WINDOW_SIZE, type CommsEventKind } from "./store";
import type { Attachment, AvatarRef, LinkPreview, Message, Network, Thread } from "./types";
import { wellFormedDeep } from "./wire";
import { withSendFlag } from "./send-policy";
import { clientIdForEvent, clientIdForTxn } from "./send-ledger";

export type CommsReader = Pick<MatrixClient, "whoami" | "memberProfiles" | "timelinePage">;
let readerFactory: ((creds: MatrixCreds) => CommsReader) | null = null;
export function setCommsReaderForTests(value: typeof readerFactory): void {
  readerFactory = value;
}
export const commsReaderFor = (creds: MatrixCreds): CommsReader =>
  readerFactory ? readerFactory(creds) : new MatrixClient(creds, fetch, 15_000);

/** Thrown when the source cannot answer; the route maps it to 503 source_unavailable. */
export class SourceUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("source_unavailable", { cause });
    this.name = "SourceUnavailableError";
  }
}

// ── thread → source ───────────────────────────────────────────────────────────

export interface ThreadSource { roomId: string; network: Network }

/** Phase 1: one Matrix conversation per thread. Null when the thread has none — and for a Telegram
 *  forum thread, whose topics are its sources (comms/forums.ts: callers name a topic). */
export function threadSource(threadId: string): ThreadSource | null {
  const r = db.prepare(`SELECT c.source_ref AS roomId, c.network AS network FROM comms_thread_members m
    JOIN comms_conversations c ON c.id = m.conversation_id WHERE m.thread_id = ? AND c.forum_id IS NULL ORDER BY c.last_event_at DESC LIMIT 1`)
    .get(threadId) as ThreadSource | undefined;
  return r && typeof r.roomId === "string" && r.roomId.startsWith("!") ? r : null;
}

// ── mxc → media tokens ────────────────────────────────────────────────────────

export type MediaActor = { email: string; deviceId?: string };
const AVATAR_THUMB = { w: 128, h: 128 };
const MEDIA_THUMB = { w: 512, h: 512 };

const mint = (mxc: string, actor: MediaActor, thumb?: { w: number; h: number }): string | null => {
  try {
    return mintMediaToken(mxc, actor, thumb ? { thumb } : {});
  } catch {
    return null; // not a usable mxc: drop it rather than leak it
  }
};

export function avatarOut(a: AvatarRef | null | undefined, actor: MediaActor, depth = 0): AvatarRef | null {
  if (!a || typeof a !== "object") return null;
  if ("mxc" in a) {
    const token = typeof a.mxc === "string" ? mint(a.mxc, actor, AVATAR_THUMB) : null;
    return token ? { token } : null;
  }
  if ("token" in a) return { token: a.token };
  if ("monogram" in a) {
    const members = depth < 2 && Array.isArray(a.members)
      ? a.members.map((m) => avatarOut(m, actor, depth + 1)).filter((m): m is AvatarRef => !!m)
      : undefined;
    return { monogram: a.monogram, ...(members?.length ? { members } : {}) };
  }
  return null;
}

export function threadOut(t: Thread, actor: MediaActor): Thread {
  // `send` per channel depends on the server's flags now (comms/send-policy.ts), never stored.
  const channels = Array.isArray(t.channels)
    ? t.channels.map((ch) => (ch?.capabilities ? { ...ch, capabilities: withSendFlag(ch.network, ch.capabilities) } : ch))
    : t.channels;
  return wellFormedDeep({ ...t, avatar: avatarOut(t.avatar, actor), channels });
}

/** A wire attachment: mxc → mediaToken (+ thumbToken for images and videos). */
export function attachmentOut({ mxc, ...rest }: Attachment, actor: MediaActor): Omit<Attachment, "mxc"> & { mediaToken?: string; thumbToken?: string } {
  if (!mxc) return rest;
  const mediaToken = mint(mxc, actor);
  const thumbToken = rest.kind === "image" || rest.kind === "video" ? mint(mxc, actor, MEDIA_THUMB) : null;
  return { ...rest, ...(mediaToken ? { mediaToken } : {}), ...(thumbToken ? { thumbToken } : {}) };
}

/** A wire link preview: imageMxc → imageToken. */
export function linkPreviewOut({ imageMxc, ...rest }: LinkPreview, actor: MediaActor): Omit<LinkPreview, "imageMxc"> {
  const imageToken = imageMxc ? mint(imageMxc, actor, MEDIA_THUMB) : null;
  return { ...rest, ...(imageToken ? { imageToken } : {}) };
}

/** A wire message: Attachment.mxc → mediaToken (+ thumbToken), imageMxc → imageToken, avatars → tokens. */
export function messageOut(m: Message, actor: MediaActor): Message {
  const attachments = m.attachments.map((a) => attachmentOut(a, actor));
  const linkPreviews = m.linkPreviews.map((p) => linkPreviewOut(p, actor));
  // A message Comms sent (send ledger): the echo carries its clientId, and it is the OWNER's
  // message even when the Matrix account that posted it is the agent's (isOmni false).
  // An echo that came before the send's answer: BlueBubbles' tempGuid (recorded by the webhook) or
  // the Matrix transaction id (sendTxn, server-only — stripped here).
  const { sendTxn, ...rest } = m;
  const clientId = m.sender.isSelf ? clientIdForEvent(m.source.eventId) ?? clientIdForTxn(sendTxn) : null;
  const sender = { ...m.sender, avatar: avatarOut(m.sender.avatar, actor), ...(clientId ? { isOmni: false } : {}) };
  return wellFormedDeep({ ...rest, ...(m.replyTo ? { replyTo: replyOut(m.replyTo) } : {}), sender, attachments, linkPreviews, ...(clientId ? { clientId } : {}) });
}

/** The quoted sender as the owner reads it: "You" for his own messages (his ghosts, and what
 *  Comms sent through the stored account — never that account's display name, e.g.
 *  "omni-agent"), "Omni" for the agent's, else the sender's name. */
export function replyOut(r: NonNullable<Message["replyTo"]>): NonNullable<Message["replyTo"]> {
  const { senderSelf, senderOmni, ...rest } = r;
  if (senderSelf && (!senderOmni || clientIdForEvent(r.messageId))) return { ...rest, senderName: "You" };
  if (senderOmni) return { ...rest, senderName: "Omni" };
  return rest;
}

// ── cursors ───────────────────────────────────────────────────────────────────
//
// Two kinds of cursor, one table:
//   window cursor  (before_msg set): "older than this message". While the message is still in
//                  the window it reads the window below it and then continues at the CURRENT
//                  window's source token — never a token remembered from an earlier fill.
//                  If a refill pushed the message out, it reads the source from the current
//                  window's bottom and drops what is not strictly older than (before_ts, before_msg).
//   source cursor  (mode "source"): a Matrix token below everything the client already has; it
//                  carries the (before_ts, before_msg) filter when it continues such a skip.
// Pending relations are stored once per distinct set (comms_timeline_pending, keyed by hash)
// and cursors reference them; an identical cursor is reused instead of minted again.

export const CURSOR_RE = /^tc_[A-Za-z0-9_-]{24}$/;
const CURSOR_TTL_MS = 24 * 60 * 60_000;
const MAX_PENDING_BYTES = 512 * 1024;
/** The newest page is always fetched with at least this many events, whatever the limit. */
export const WINDOW_FILL_EVENTS = 50;
/** Source pages one request may read (empty filtered chunks, pages skipped by a window cursor). */
const MAX_FETCHES = 5;
/** Consecutive empty chunks (with a token) tolerated before the room counts as exhausted. */
const MAX_EMPTY_CHUNKS = 2;

const limits = { perThread: 1000, total: 20_000 };
export function setTimelineLimitsForTests(v: Partial<typeof limits> | null): void {
  Object.assign(limits, v ?? { perThread: 1000, total: 20_000 });
}

/** Length / control characters / shape; anything else is 400 invalid_cursor. */
export function cursorShapeOk(raw: string): boolean {
  return raw.length > 0 && raw.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(raw) && CURSOR_RE.test(raw);
}

interface CursorRow {
  thread_id: string; room_id: string; mode: "window" | "source"; source_from: string | null; before_msg: string | null;
  before_ts: string | null; pending_hash: string;
}

/** Bounded copy of the pending relations: at most MAX_PENDING, the newest kept, ≤ 512 KB. */
function packPending(pending: MatrixEvent[]): string {
  let list = pending.slice(-MAX_PENDING);
  let s = JSON.stringify(list);
  while (s.length > MAX_PENDING_BYTES && list.length) {
    list = list.slice(Math.ceil(list.length / 4));
    s = JSON.stringify(list);
  }
  return s;
}

/** Store a pending set once; returns its hash. Call inside the transaction that references it. */
function putPending(pending: MatrixEvent[]): string {
  const json = packPending(pending);
  const hash = createHash("sha256").update(json).digest("base64url");
  db.prepare(`INSERT OR IGNORE INTO comms_timeline_pending (hash, json) VALUES (?, ?)`).run(hash, json);
  return hash;
}

function getPending(hash: string): MatrixEvent[] {
  const r = db.prepare(`SELECT json FROM comms_timeline_pending WHERE hash = ?`).get(hash) as { json: string } | undefined;
  try {
    const v = r ? JSON.parse(r.json) : [];
    return Array.isArray(v) ? v.filter((e) => e && typeof e === "object") : [];
  } catch {
    return [];
  }
}

const gcPending = () =>
  db.prepare(`DELETE FROM comms_timeline_pending WHERE hash NOT IN (SELECT pending_hash FROM comms_timeline_cursors)
    AND hash NOT IN (SELECT pending_hash FROM comms_timeline_windows)`).run();

interface CursorSpec { threadId: string; roomId: string; mode: "window" | "source"; sourceFrom: string | null; beforeMsg: string | null; beforeTs: string | null; pendingHash: string }

function mintCursor(c: CursorSpec): string {
  const now = Date.now();
  return db.transaction(() => {
    db.prepare(`DELETE FROM comms_timeline_cursors WHERE created_at < ?`).run(now - CURSOR_TTL_MS);
    const same = db.prepare(`SELECT id FROM comms_timeline_cursors WHERE thread_id = ? AND room_id = ? AND mode = ? AND source_from IS ?
      AND before_msg IS ? AND before_ts IS ? AND pending_hash = ?`)
      .get(c.threadId, c.roomId, c.mode, c.sourceFrom, c.beforeMsg, c.beforeTs, c.pendingHash) as { id: string } | undefined;
    if (same) {
      db.prepare(`UPDATE comms_timeline_cursors SET created_at = ? WHERE id = ?`).run(now, same.id);
      return same.id;
    }
    const id = `tc_${randomBytes(18).toString("base64url")}`;
    db.prepare(`INSERT INTO comms_timeline_cursors (id, thread_id, room_id, mode, source_from, before_msg, before_ts, pending_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, c.threadId, c.roomId, c.mode, c.sourceFrom, c.beforeMsg, c.beforeTs, c.pendingHash, now);
    db.prepare(`DELETE FROM comms_timeline_cursors WHERE thread_id = ? AND id NOT IN (
      SELECT id FROM comms_timeline_cursors WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(c.threadId, c.threadId, limits.perThread);
    db.prepare(`DELETE FROM comms_timeline_cursors WHERE id NOT IN (
      SELECT id FROM comms_timeline_cursors ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(limits.total);
    gcPending();
    return id;
  })();
}

/** A live cursor of this thread AND this room (a re-pointed conversation invalidates it). */
function loadCursor(id: string, threadId: string, roomId: string): CursorRow | null {
  const r = db.prepare(`SELECT thread_id, room_id, mode, source_from, before_msg, before_ts, pending_hash FROM comms_timeline_cursors
    WHERE id = ? AND created_at >= ?`).get(id, Date.now() - CURSOR_TTL_MS) as CursorRow | undefined;
  return r && r.thread_id === threadId && r.room_id === roomId ? r : null;
}

/** A plain source cursor for a non-Matrix source (BlueBubbles: `sourceFrom` = "before" epoch ms
 *  as a string). Same table, same TTL, same thread + source binding as the Matrix cursors. */
export function mintSourceCursor(threadId: string, sourceRef: string, sourceFrom: string): string {
  return db.transaction(() => mintCursor({ threadId, roomId: sourceRef, mode: "source", sourceFrom, beforeMsg: null, beforeTs: null, pendingHash: putPending([]) }))();
}

/** The source position a cursor minted by mintSourceCursor holds; null = unknown / expired / foreign. */
export function sourceCursorPosition(id: string, threadId: string, sourceRef: string): string | null {
  const r = loadCursor(id, threadId, sourceRef);
  return r && r.mode === "source" ? r.source_from : null;
}

// ── the window cache ─────────────────────────────────────────────────────────

interface WindowRow { room_id: string; event_mark: number; source_from: string | null; pending_hash: string; filled_at: number }

/** A window not filled or confirmed by a live merge for this long is refetched (final review M1):
 *  "current" only means no comms event arrived after its mark, which misses what never produced
 *  one (edits/reactions/deletes while COMMS was off, a lost queue, a stopped ingest). */
export const WINDOW_MAX_AGE_MS = 15 * 60_000;
let clock: () => number = Date.now;
/** Tests: the clock the window age is judged by (null = Date.now). */
export function setTimelineClockForTests(f: (() => number) | null): void {
  clock = f ?? Date.now;
}
const young = (w: WindowRow): boolean => clock() - w.filled_at <= WINDOW_MAX_AGE_MS;

/** Startup: every cached window is stale (anything may have happened while we were down). */
export function markAllWindowsStale(): number {
  return db.prepare(`UPDATE comms_timeline_windows SET event_mark = -1 WHERE event_mark >= 0`).run().changes;
}

// A forum TOPIC window (comms/forums.ts) is cached under its own id while its events are appended
// under the forum thread with cache_id = that id: its mark counts only its own events.
const topicWindow = (cacheId: string, displayId: string | undefined): boolean => !!displayId && displayId !== cacheId;
const eventMark = (threadId: string, displayId?: string): number =>
  topicWindow(threadId, displayId)
    ? (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM comms_events WHERE cache_id = ?`).get(threadId) as { n: number }).n
    : (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM comms_events WHERE thread_id = ?`).get(threadId) as { n: number }).n;

function windowOf(threadId: string, roomId: string): WindowRow | null {
  const w = db.prepare(`SELECT room_id, event_mark, source_from, pending_hash, filled_at FROM comms_timeline_windows WHERE thread_id = ?`)
    .get(threadId) as WindowRow | undefined;
  return w && w.room_id === roomId ? w : null;
}

/** The cached newest page, if no comms event for the thread arrived after it was filled and it
 *  is younger than WINDOW_MAX_AGE_MS (filled, or kept current by a live merge). */
function freshWindow(threadId: string, roomId: string, displayId?: string): WindowRow | null {
  const w = windowOf(threadId, roomId);
  return w && young(w) && eventMark(threadId, displayId) <= w.event_mark ? w : null;
}

/** Replace the window with the newest page (the cache only ever holds that page). */
function fillWindow(threadId: string, roomId: string, messages: Message[], mark: number, sourceFrom: string | null, pending: MatrixEvent[], displayId = threadId): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM comms_messages WHERE thread_id = ?`).run(threadId);
    putWindow(threadId, messages, displayId);
    const hash = putPending(pending);
    db.prepare(`INSERT INTO comms_timeline_windows (thread_id, room_id, event_mark, source_from, pending_hash, filled_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET room_id=excluded.room_id, event_mark=excluded.event_mark, source_from=excluded.source_from,
        pending_hash=excluded.pending_hash, filled_at=excluded.filled_at`).run(threadId, roomId, mark, sourceFrom, hash, clock());
    gcPending();
  })();
}

const inWindow = (threadId: string, id: string): boolean =>
  !!db.prepare(`SELECT 1 FROM comms_messages WHERE thread_id = ? AND source_event_id = ?`).get(threadId, id);

/** The cursor below a page served from the window: more of the window first, then the current window's source. */
function nextFromWindow(threadId: string, w: WindowRow, oldest: Message | null): string | null {
  if (oldest && readWindow(threadId, oldest.id, 1).length)
    return mintCursor({ threadId, roomId: w.room_id, mode: "window", sourceFrom: w.source_from, beforeMsg: oldest.id, beforeTs: oldest.sentAt, pendingHash: w.pending_hash });
  return w.source_from
    ? mintCursor({ threadId, roomId: w.room_id, mode: "source", sourceFrom: w.source_from, beforeMsg: null, beforeTs: null, pendingHash: w.pending_hash })
    : null;
}

// ── live merge (Task 11) ──────────────────────────────────────────────────────
//
// A live batch (comms/live.ts) keeps a CURRENT window warm instead of invalidating it: its
// events are appended and its messages merged in one transaction, and the window's mark moves
// to the new last event. "Current" = no message event for the thread after the window's mark
// (a thread.updated never changes the messages). Anything else — no window, a stale one, a
// truncated (limited) sync timeline — leaves / makes the window stale: the next read refetches.

export interface LiveBuild {
  /** Events to append, in order; each payload is {threadId, message}. */
  events: Array<{ kind: CommsEventKind; message: Message }>;
  /** Messages to upsert into the window (only used when it is current). */
  cache: Message[];
  /** Relations whose target is below the window (kept with the window for the older page). */
  pending: MatrixEvent[];
}

/** Mark the thread's window stale (a failed or dropped live batch must never leave it "current"). */
export function invalidateWindow(threadId: string): void {
  db.prepare(`UPDATE comms_timeline_windows SET event_mark = -1 WHERE thread_id = ?`).run(threadId);
}

/**
 * Apply one live batch. `build` gets the window's messages when the window is current (else an
 * empty map) and returns what to append / merge. Synchronous and transactional, so no timeline
 * read can interleave. Returns whether the window stayed warm.
 */
export function applyLiveBatch(
  threadId: string, roomId: string, limited: boolean, build: (known: Map<string, Message>) => LiveBuild,
  /** A forum topic window: `threadId` is the topic's cache id, events go to `displayId` (the forum thread). */
  opts: { displayId?: string } = {},
): { warm: boolean } {
  const displayId = opts.displayId ?? threadId;
  const topic = topicWindow(threadId, displayId);
  return db.transaction(() => {
    const w = windowOf(threadId, roomId);
    const current = !!w && !limited && w.event_mark >= 0 && young(w) &&
      !(topic
        ? db.prepare(`SELECT 1 FROM comms_events WHERE cache_id = ? AND id > ? LIMIT 1`).get(threadId, w.event_mark)
        : db.prepare(`SELECT 1 FROM comms_events WHERE thread_id = ? AND id > ? AND kind != 'thread.updated' LIMIT 1`).get(threadId, w.event_mark));
    const known = new Map<string, Message>();
    if (current) for (const m of readWindow(threadId, undefined, WINDOW_SIZE)) known.set(m.id, m);
    const out = build(known);
    for (const e of out.events) appendEvent(e.kind, displayId, { threadId: displayId, message: e.message }, topic ? threadId : null);
    // putWindow keeps the newest WINDOW_SIZE: growing past it would drop the oldest messages
    // while source_from still continues BELOW them (a hole in paging) — so refetch instead.
    const fits = known.size + out.cache.filter((m) => !known.has(m.id)).length <= WINDOW_SIZE;
    if (current && w && fits) {
      if (out.cache.length) putWindow(threadId, out.cache, displayId);
      const hash = out.pending.length ? putPending([...getPending(w.pending_hash), ...out.pending]) : w.pending_hash;
      // A live merge confirms the window: its age restarts.
      db.prepare(`UPDATE comms_timeline_windows SET event_mark = ?, pending_hash = ?, filled_at = ? WHERE thread_id = ?`).run(eventMark(threadId, displayId), hash, clock(), threadId);
      if (hash !== w.pending_hash) gcPending();
      return { warm: true };
    }
    if (w) invalidateWindow(threadId);
    return { warm: false };
  })();
}

// ── the timeline ──────────────────────────────────────────────────────────────

export interface TimelinePage { messages: Message[]; before: string | null; hasMore: boolean }

export interface TimelineRequest {
  threadId: string;
  source: ThreadSource;
  limit: number;
  /** A validated cursor id (cursorShapeOk), or undefined for the newest page. */
  before?: string;
  /** Opens the source; throws SourceUnavailableError when it cannot (no credentials). */
  reader: () => CommsReader;
  /** Called after every source read and before anything is cached; false = access changed. */
  stillAllowed: () => boolean;
  /** A forum topic (comms/forums.ts): `threadId` is the topic's cache id, this the forum thread the
   *  messages belong to, and `decorate` tags each one with its topic before it is cached. */
  displayThreadId?: string;
  decorate?: (m: Message) => Message;
}

export class CursorNotFoundError extends Error {}
export class AccessChangedError extends Error {}

/** Strictly older than (ts, id), in the window's order (sent_at, then event id). */
const olderThan = (ts: string, id: string) => (m: Message) => m.sentAt < ts || (m.sentAt === ts && m.id < id);

/**
 * Newest-last page. No cursor: the window cache when it is current, else the source (and the
 * window is refilled with at least WINDOW_FILL_EVENTS events). A cursor: see the cursor notes.
 */
export async function readTimeline(q: TimelineRequest): Promise<TimelinePage> {
  const { threadId } = q;
  const roomId = q.source.roomId;
  let from: string | null = null;
  let pending: MatrixEvent[] = [];
  let keep: ((m: Message) => boolean) | null = null;
  if (q.before) {
    const cur = loadCursor(q.before, threadId, roomId);
    if (!cur) throw new CursorNotFoundError();
    if (cur.mode === "window" && cur.before_msg) {
      const w = windowOf(threadId, roomId);
      if (w && inWindow(threadId, cur.before_msg)) {
        const messages = readWindow(threadId, cur.before_msg, q.limit);
        const before = nextFromWindow(threadId, w, messages[0] ?? null);
        return { messages, before, hasMore: !!before };
      }
      // Refilled past it: everything strictly older lies below the current window's bottom
      // (or, with no window, below the bottom the cursor was minted against).
      from = w ? w.source_from : cur.source_from;
      pending = getPending(w ? w.pending_hash : cur.pending_hash);
      if (cur.before_ts) keep = olderThan(cur.before_ts, cur.before_msg);
    } else {
      from = cur.source_from;
      pending = getPending(cur.pending_hash);
      if (cur.before_ts && cur.before_msg) keep = olderThan(cur.before_ts, cur.before_msg);
    }
    if (!from) return { messages: [], before: null, hasMore: false };
  } else {
    const w = freshWindow(threadId, roomId, q.displayThreadId);
    if (w) {
      const messages = readWindow(threadId, undefined, q.limit);
      const before = nextFromWindow(threadId, w, messages[0] ?? null);
      return { messages, before, hasMore: !!before };
    }
  }

  const first = !q.before;
  const mark = eventMark(threadId, q.displayThreadId);
  const reader = q.reader();
  const fetchLimit = first ? Math.max(q.limit, WINDOW_FILL_EVENTS) : q.limit;
  let me: string;
  let profiles: Awaited<ReturnType<CommsReader["memberProfiles"]>>;
  let page: Awaited<ReturnType<CommsReader["timelinePage"]>>;
  try {
    [me, profiles, page] = await Promise.all([
      reader.whoami(),
      reader.memberProfiles(roomId).catch(() => ({})),
      reader.timelinePage(roomId, from ?? undefined, fetchLimit),
    ]);
  } catch (e) {
    throw new SourceUnavailableError(e);
  }
  const agents = agentSenderIds();
  const names: Record<string, string> = {};
  const avatars: Record<string, string | null> = {};
  for (const [id, p] of Object.entries(profiles)) {
    if (p?.name) names[id] = p.name;
    avatars[id] = p?.avatar ?? null;
  }
  // Self = whoami + the agent + the owner's own bridge ghosts / person-note ids (comms/owner.ts).
  const ctx = { threadId: q.displayThreadId ?? threadId, network: q.source.network, selfIds: commsSelfIds(me), agentIds: agents, ownerIds: [me, ...storedOwnerSenders()], names, avatars };

  let messages: Message[] = [];
  let at = from;
  let end: string | null = null;
  let empty = 0;
  for (let fetches = 1; ; fetches++) {
    if (!q.stillAllowed()) throw new AccessChangedError();
    const r = normalizeEvents([...page.chunk, ...pending], ctx);
    if (q.decorate) r.messages = r.messages.map(q.decorate);
    pending = r.pendingRelations;
    end = page.end && page.end !== at && page.end !== page.start ? page.end : null;
    if (!page.chunk.length) {
      empty++;
      if (!end || empty > MAX_EMPTY_CHUNKS) { end = null; break; }
    } else {
      empty = 0;
      messages = keep ? r.messages.filter(keep) : r.messages;
      if (messages.length || !end || !keep) break;
    }
    if (fetches >= MAX_FETCHES) break;
    at = end;
    try {
      page = await reader.timelinePage(roomId, at, fetchLimit);
    } catch (e) {
      throw new SourceUnavailableError(e);
    }
  }
  if (!q.stillAllowed()) throw new AccessChangedError();

  if (first) {
    fillWindow(threadId, roomId, messages, mark, end, pending, q.displayThreadId ?? threadId);
    const w = windowOf(threadId, roomId)!;
    const served = messages.slice(-q.limit);
    const before = nextFromWindow(threadId, w, served[0] ?? null);
    return { messages: served, before, hasMore: !!before };
  }
  // A skip that ran out of fetches before reaching older messages keeps its filter.
  const filter = keep && !messages.length && q.before ? loadCursor(q.before, threadId, roomId) : null;
  const before = end
    ? db.transaction(() => mintCursor({
        threadId, roomId, mode: "source", sourceFrom: end,
        beforeMsg: filter?.before_msg ?? null, beforeTs: filter?.before_ts ?? null, pendingHash: putPending(pending),
      }))()
    : null;
  return { messages, before, hasMore: !!before };
}

/** Joined members for the thread detail (bridge bots left out); [] when the source is down. */
export async function readMembers(reader: CommsReader, roomId: string, actor: MediaActor): Promise<{ id: string; name: string; avatar: AvatarRef | null }[]> {
  try {
    const profiles = await reader.memberProfiles(roomId);
    return wellFormedDeep(Object.entries(profiles)
      .filter(([id]) => !isBridgeBot(id))
      .slice(0, 500)
      .map(([id, p]) => ({ id, name: displayNameFor(p?.name, id), avatar: p?.avatar ? avatarOut({ mxc: p.avatar }, actor) : null })));
  } catch {
    return [];
  }
}
