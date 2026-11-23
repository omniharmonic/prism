// The Comms live listener (Task 11): ingest bus batch → projection, normalized events in
// comms_events, the window cache kept warm, and (through store.onCommsEvent) the SSE stream.
//
// Per batch, in order (one batch at a time, process-wide):
//   1. projectRoom with the room's note (one lean vault read) → the thread row; appends
//      thread.updated only when the row changed.
//   2. normalizeEvents over the RAW timeline events, ctx.known = the window's messages when
//      the window is current — relations to cached messages come back as `updated`.
//   3. applyLiveBatch (timeline.ts): message.created / message.updated / message.deleted /
//      reaction.changed appended, the window merged and its mark advanced, in one transaction.
// Any failure, an over-full queue, or no Matrix credential marks the thread's window stale, so
// the next GET /messages refetches — a missed batch can never leave a "current" window behind.
import type { Note } from "../parachute";
import { config } from "../config";
import { db } from "../db";
import { agentSenderIds, isBridgeBot } from "../worker/matrix";
import { readEntriesOf, readKey, recordReceipts, withReadState } from "./receipts";
import { commsBus, type LiveBatch } from "./bus";
import { commsSelfIds, storedOwnerSenders } from "./owner";
import { MAX_PENDING, normalizeEvents } from "./normalize";
import { conversationIdFor, projectRoom, recordEditPreview, type ProjectDeps } from "./project";
import { fromMatrixContent } from "./richtext";
import { pruneEvents, readWindow, type CommsEventKind } from "./store";
import { applyLiveBatch, invalidateWindow, threadSource, type LiveBuild, type ThreadSource } from "./timeline";
import { inTopic, topicOfRoom, windowKeyOfRoom } from "./forums";
import type { Message } from "./types";

export interface LiveDeps {
  project: ProjectDeps;
  /** The thread note by id, lean (metadata, no body); null when it cannot be read. */
  getNote(id: string): Promise<Note | null>;
}

const MAX_QUEUE = 1000;
/** A room's coalesced batch holding more events than this is not merged: the window goes stale. */
const MAX_MERGED_EVENTS = 2000;
const DEPS_TTL_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const ROOM_CACHE_TTL_MS = 45_000;
const ROOM_CACHE_MAX = 2000;

// ── per-room reader cache ────────────────────────────────────────────────────
// projectRoom and the normalizer both need memberProfiles (and projectRoom roomState); a busy
// room batches every pass. One fetch per room per 45 s, shared by both; a batch carrying a
// state event (member / name / avatar / topic …) drops the room's entry first.
type Reader = ProjectDeps["reader"];
interface RoomEntry { at: number; profiles?: ReturnType<Reader["memberProfiles"]>; state?: ReturnType<Reader["roomState"]> }
const roomCaches = new WeakMap<Reader, { rooms: Map<string, RoomEntry>; reader: Reader }>();
function cachedReader(base: Reader): { rooms: Map<string, RoomEntry>; reader: Reader } {
  const hit = roomCaches.get(base);
  if (hit) return hit;
  const rooms = new Map<string, RoomEntry>();
  const entry = (r: string): RoomEntry => {
    let e = rooms.get(r);
    if (!e || Date.now() - e.at > ROOM_CACHE_TTL_MS) {
      e = { at: Date.now() };
      rooms.delete(r);
      rooms.set(r, e);
      while (rooms.size > ROOM_CACHE_MAX) rooms.delete(rooms.keys().next().value!);
    }
    return e;
  };
  const keep = <T>(r: string, p: Promise<T>): Promise<T> => p.catch((err) => { rooms.delete(r); throw err; });
  const reader: Reader = {
    whoami: () => base.whoami(),
    memberProfiles: (r) => { const e = entry(r); return (e.profiles ??= keep(r, base.memberProfiles(r))); },
    roomState: (r) => { const e = entry(r); return (e.state ??= keep(r, base.roomState(r))); },
    ...(base.timelinePage ? { timelinePage: base.timelinePage.bind(base) } : {}),
  };
  const out = { rooms, reader };
  roomCaches.set(base, out);
  return out;
}
const changesRoom = (b: LiveBatch) => b.events.some((e) => typeof e.state_key === "string" || /^m\.room\.(member|name|avatar|topic|create|power_levels)$/.test(e.type ?? ""));

let depsOverride: (() => Promise<LiveDeps | null>) | null = null;
export function setLiveDepsForTests(f: typeof depsOverride): void {
  depsOverride = f;
  cachedDeps = null;
}

let cachedDeps: { at: number; deps: Promise<LiveDeps | null> } | null = null;
async function buildLiveDeps(): Promise<LiveDeps | null> {
  const { buildProjectDeps } = await import("./project-deps");
  const { resolveVaultEntry } = await import("../db");
  const { vaultClient } = await import("../parachute");
  const built = await buildProjectDeps();
  if (!built) return null;
  // whoami is asked per batch (projection + normalizer): one homeserver call per deps lifetime.
  let me: Promise<string> | null = null;
  const reader = built.reader;
  const project: ProjectDeps = {
    ...built,
    reader: {
      roomState: (r) => reader.roomState(r),
      memberProfiles: (r) => reader.memberProfiles(r),
      whoami: () => (me ??= reader.whoami().catch((e) => { me = null; throw e; })),
      ...(reader.timelinePage ? { timelinePage: reader.timelinePage.bind(reader) } : {}),
    },
  };
  const vault = vaultClient(resolveVaultEntry(undefined).id, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? config.matrixVaultTimeoutMs : 30_000 });
  return { project, getNote: (id) => vault.getNote(id, { includeContent: false }).catch(() => null) };
}
function liveDeps(): Promise<LiveDeps | null> {
  if (depsOverride) return depsOverride();
  const now = Date.now();
  if (!cachedDeps || now - cachedDeps.at > DEPS_TTL_MS) {
    const deps = buildLiveDeps().catch((e) => {
      console.warn(`[comms] live deps unavailable: ${String(e).slice(0, 200)}`);
      cachedDeps = null;
      return null;
    });
    cachedDeps = { at: now, deps };
  }
  return cachedDeps.deps;
}

const threadOfRoom = (roomId: string): string | null =>
  (db.prepare(`SELECT thread_id FROM comms_thread_members WHERE conversation_id = ? LIMIT 1`).get(conversationIdFor(roomId)) as { thread_id: string } | undefined)?.thread_id ?? null;
/** The window a room's batch merges into: a forum topic's own (comms/forums.ts), else its thread's. */
const windowOfRoom = (roomId: string): string | null => windowKeyOfRoom(roomId);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** How an update to a cached message is announced. */
function updateKind(prev: Message, next: Message): CommsEventKind {
  if (next.redacted && !prev.redacted) return "message.deleted";
  if (same({ ...next, reactions: prev.reactions }, prev)) return "reaction.changed";
  return "message.updated";
}

/** An edit's preview text is its m.new_content (normalized), never the "* …" fallback body the
 *  vault stores as the latest line (e2e B2). Recorded before the projection reads the note. */
function recordEditPreviews(b: LiveBatch): void {
  for (const e of b.events) {
    const c = e.content && typeof e.content === "object" ? (e.content as Record<string, unknown>) : null;
    const rel = c?.["m.relates_to"] as Record<string, unknown> | undefined;
    const nc = c?.["m.new_content"];
    if (e.type !== "m.room.message" || rel?.rel_type !== "m.replace" || !nc || typeof nc !== "object" || Array.isArray(nc) || typeof e.event_id !== "string") continue;
    const plain = fromMatrixContent(nc as Record<string, unknown>).plain.trim();
    if (plain) recordEditPreview(b.roomId, e.event_id, plain);
  }
}

/** One batch, end to end. Exported for tests; production goes through the queue. */
export async function handleLiveBatch(deps: LiveDeps | null, b: LiveBatch): Promise<void> {
  let threadId = threadOfRoom(b.roomId);
  // No deps, or a batch the pass could not get through (stale): the window must refetch.
  if (!deps || (b.stale && !b.events.length && !b.receipts?.length)) {
    const w = windowOfRoom(b.roomId);
    if (w) invalidateWindow(w);
    return;
  }
  const cache = cachedReader(deps.project.reader);
  if (changesRoom(b)) cache.rooms.delete(b.roomId);
  const project: ProjectDeps = { ...deps.project, reader: cache.reader };
  try {
    recordEditPreviews(b);
    const note = b.noteId ? await deps.getNote(b.noteId) : null;
    if (note) {
      try {
        threadId = await projectRoom(project, b.roomId, note, b.events);
      } catch (e) {
        console.warn(`[comms] live projection of ${b.roomId} failed: ${String(e).slice(0, 200)}`);
      }
    }
    if (!threadId) return await storeReceiptsOnly(project, b, null); // not projected yet: nothing cached, nothing to announce
    // A Telegram forum topic: its own window (cache id), events under the forum thread, every
    // message tagged with the topic (comms/forums.ts).
    const forumTopic = topicOfRoom(b.roomId);
    const src: ThreadSource | null = forumTopic && forumTopic.threadId === threadId ? { roomId: b.roomId, network: forumTopic.topic.network } : threadSource(threadId);
    if (!src || src.roomId !== b.roomId) return await storeReceiptsOnly(project, b, null);
    const cacheId = forumTopic ? forumTopic.topic.cacheId : threadId;
    const tag = forumTopic ? (m: Message): Message => inTopic(m, forumTopic.threadId, forumTopic.topic) : (m: Message): Message => m;
    const [me, profiles] = await Promise.all([
      project.reader.whoami(),
      project.reader.memberProfiles(b.roomId).catch(() => ({}) as Awaited<ReturnType<ProjectDeps["reader"]["memberProfiles"]>>),
    ]);
    const agents = agentSenderIds();
    const names: Record<string, string> = {};
    const avatars: Record<string, string | null> = {};
    for (const [id, p] of Object.entries(profiles)) {
      if (p?.name) names[id] = p.name;
      avatars[id] = p?.avatar ?? null;
    }
    const tid = threadId;
    // `stale` with events = the vault write lagged, the timeline is complete: merged normally.
    applyLiveBatch(cacheId, b.roomId, !!b.limited, (known): LiveBuild => {
      // A base event the window already holds (a refill raced this batch) is not re-normalized:
      // its relations then fold onto the cached copy (re-applying is idempotent).
      const events = b.events.filter((e) => !e.event_id || !known.has(e.event_id));
      const r = normalizeEvents(events, { threadId: tid, network: src.network, selfIds: commsSelfIds(me), agentIds: agents, ownerIds: [me, ...storedOwnerSenders()], names, avatars, known });
      r.messages = r.messages.map(tag);
      r.updated = r.updated.map(tag);
      const out: LiveBuild = { events: [], cache: [], pending: r.pendingRelations.slice(-MAX_PENDING) };
      for (const m of r.messages) {
        out.events.push({ kind: "message.created", message: m });
        out.cache.push(m);
      }
      for (const u of r.updated) {
        const prev = known.get(u.id);
        if (prev && same(prev, u)) continue;
        out.events.push({ kind: prev ? updateKind(prev, u) : "message.updated", message: u });
        out.cache.push(u);
      }
      // Read receipts (Task 8, COMMS_RECEIPTS_ENABLED): stored, then every cached owner message
      // whose read state moved is announced (message.updated; the stream projects the state).
      if (config.commsReceiptsEnabled && b.receipts?.length) {
        const entries = b.receipts.flatMap((e) => readEntriesOf(e.content));
        if (entries.length) {
          const selves = new Set(commsSelfIds(me));
          const ts = new Map<string, number>();
          for (const e of b.events) if (e.event_id && typeof e.origin_server_ts === "number") ts.set(e.event_id, e.origin_server_ts);
          for (const m of [...known.values(), ...r.messages]) if (!ts.has(m.id)) ts.set(m.id, Date.parse(m.sentAt));
          const pool = [...known.values()].map((m) => out.cache.find((c) => c.id === m.id) ?? m);
          const before = new Map(withReadState(pool, b.roomId).map((m) => [m.id, readKey(m)]));
          const moved = recordReceipts(b.roomId, entries, {
            ignore: (u) => selves.has(u.toLowerCase()) || agents.includes(u.toLowerCase()) || isBridgeBot(u),
            eventTs: (id) => { const v = ts.get(id); return typeof v === "number" && Number.isFinite(v) ? v : null; },
            nameOf: (u) => names[u] ?? null,
          });
          if (moved) {
            const announced = new Set(out.events.map((e) => e.message.id));
            for (const m of withReadState(pool, b.roomId)) {
              if (announced.has(m.id) || before.get(m.id) === readKey(m)) continue;
              out.events.push({ kind: "message.updated", message: pool.find((p) => p.id === m.id)! });
            }
          }
        }
      }
      return out;
    }, { displayId: tid });
  } catch (e) {
    console.warn(`[comms] live batch for ${b.roomId} failed (window refetched on next read): ${String(e).slice(0, 200)}`);
    const w = windowOfRoom(b.roomId) ?? threadId;
    if (w) invalidateWindow(w);
  }
}

/** Store a batch's receipts when it is not merged into a window (room not projected yet, or not
 *  the thread's current source): nothing is announced, the next page read projects them. */
async function storeReceiptsOnly(project: ProjectDeps, b: LiveBatch, threadId: string | null): Promise<void> {
  if (!config.commsReceiptsEnabled || !b.receipts?.length) return;
  const entries = b.receipts.flatMap((e) => readEntriesOf(e.content));
  if (!entries.length) return;
  try {
    const [me, profiles] = await Promise.all([
      project.reader.whoami(),
      project.reader.memberProfiles(b.roomId).catch(() => ({}) as Awaited<ReturnType<ProjectDeps["reader"]["memberProfiles"]>>),
    ]);
    const selves = new Set(commsSelfIds(me));
    const agents = agentSenderIds();
    const ts = new Map<string, number>();
    for (const e of b.events) if (e.event_id && typeof e.origin_server_ts === "number") ts.set(e.event_id, e.origin_server_ts);
    if (threadId) for (const m of readWindow(threadId, undefined, 200)) if (!ts.has(m.id)) ts.set(m.id, Date.parse(m.sentAt));
    recordReceipts(b.roomId, entries, {
      ignore: (u) => selves.has(u.toLowerCase()) || agents.includes(u.toLowerCase()) || isBridgeBot(u),
      eventTs: (id) => { const v = ts.get(id); return typeof v === "number" && Number.isFinite(v) ? v : null; },
      nameOf: (u) => (profiles as Record<string, { name?: string | null } | undefined>)[u]?.name ?? null,
    });
  } catch (e) {
    console.warn(`[comms] receipts for ${b.roomId} not stored: ${String(e).slice(0, 200)}`);
  }
}

// ── the queue ────────────────────────────────────────────────────────────────
// One entry per room (insertion order = first arrival). A batch for a room that is still waiting
// is merged into its entry (events appended in order), so a busy room costs one projection and
// one profile read per turn, not one per pass. A room that arrives again while it is being
// handled gets a new entry behind the others: per-room order is kept.

const waiting = new Map<string, LiveBatch>();
let running = false;
let settleWaiters: Array<() => void> = [];

function merge(a: LiveBatch, b: LiveBatch): LiveBatch {
  const events = [...a.events, ...b.events];
  const over = events.length > MAX_MERGED_EVENTS;
  const noteId = b.noteId ?? a.noteId;
  // Receipts are kept even when the events are not (a dropped receipt is never replayed:
  // only the newest one per reader is stored). Bounded: the newest MAX_MERGED_EVENTS.
  const receipts = [...(a.receipts ?? []), ...(b.receipts ?? [])].slice(-MAX_MERGED_EVENTS);
  return {
    roomId: a.roomId,
    events: over ? [] : events,
    ...(receipts.length ? { receipts } : {}),
    ...(a.limited || b.limited ? { limited: true } : {}),
    ...(a.stale || b.stale || over ? { stale: true as const } : {}),
    ...(noteId ? { noteId } : {}),
  };
}

function enqueue(b: LiveBatch): void {
  const cur = waiting.get(b.roomId);
  if (cur) {
    waiting.set(b.roomId, merge(cur, b));
    return;
  }
  if (waiting.size >= MAX_QUEUE) {
    const t = windowOfRoom(b.roomId);
    if (t) invalidateWindow(t);
    return;
  }
  waiting.set(b.roomId, b);
  if (!running) {
    running = true;
    queueMicrotask(() => void drain()); // batches published in the same turn merge first
  }
}

async function drain(): Promise<void> {
  try {
    while (waiting.size) {
      const [roomId, b] = waiting.entries().next().value!;
      waiting.delete(roomId);
      try {
        await handleLiveBatch(await liveDeps(), b);
      } catch (e) {
        console.warn(`[comms] live batch failed: ${String(e).slice(0, 200)}`);
      }
    }
  } finally {
    running = false;
    const w = settleWaiters;
    settleWaiters = [];
    for (const r of w) r();
  }
}

/** Resolves when every batch queued so far is handled (tests). */
export const liveSettled = (): Promise<void> =>
  !running && !waiting.size ? Promise.resolve() : new Promise((r) => settleWaiters.push(r));

let unsubscribe: (() => void) | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
const pruneNow = () => {
  try {
    pruneEvents();
  } catch (e) {
    console.warn(`[comms] event prune failed: ${String(e).slice(0, 200)}`);
  }
};
/** Startup hook (with COMMS_ENABLED): subscribe the listener to the ingest bus and prune the
 *  event log now and hourly (independent of traffic). Idempotent. */
export function startCommsLive(): () => void {
  if (!unsubscribe) unsubscribe = commsBus.subscribe(enqueue);
  if (!pruneTimer) {
    pruneNow();
    pruneTimer = setInterval(pruneNow, PRUNE_EVERY_MS);
    pruneTimer.unref?.();
  }
  return stopCommsLive;
}
export function stopCommsLive(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}
