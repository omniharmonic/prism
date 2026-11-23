// Read state (Sprint Task 1, PRD §5.10, D10): the owner's read marker per display thread, manual
// "mark as unread", who is looking at a thread right now, and network read receipts.
//
// A marker is an ISO instant: everything sent at or before it is read. Marking read never moves a
// marker backwards. The unread count itself is computed in SQL (store.ts E_UNREAD).
//
// READ RECEIPTS (D10 + controller ruling, review I1): marking read is LOCAL. A receipt leaves the
// server only when
//   1. COMMS_READ_RECEIPTS_ENABLED=true (server flag, default off), AND
//   2. the request came from the owner's own device (requestVia "device", human origin), AND
//   3. EITHER the owner's toggle (settings.readReceipts, or its per-network override) is on, OR the
//      read is an EXPLICIT "Mark as Read" (`explicit: true` — the row action, never opening,
//      viewing, closing or a message arriving while open), AND
//   4. the thread is Matrix-bridged (iMessage / SMS through BlueBubbles cannot send one without the
//      Private API, which D6 keeps off).
// The receipt names the newest incoming message at or before the read point. Typing is never sent.
// Anything else → `receipt: "off" | "unsupported" | "nothing"` and no network call at all.
import { db } from "../db";
import { config } from "../config";
import { appendEvent, getThread } from "./store";
import { threadSource } from "./timeline";
import { forumTopic, forumTopics } from "./forums";
import { getNotifySettings, receiptsWanted } from "./notify-settings";
import { isBlueBubblesNetwork } from "./send-policy";
import type { Network } from "./types";

export interface ReadMarker { readAt: string; manualUnread: boolean }

const getStmt = db.prepare(`SELECT read_at, manual_unread FROM comms_read_markers WHERE thread_id = ?`);
const upsertStmt = db.prepare(`INSERT INTO comms_read_markers (thread_id, read_at, manual_unread, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(thread_id) DO UPDATE SET read_at = excluded.read_at, manual_unread = excluded.manual_unread, updated_at = excluded.updated_at`);

export function readMarker(threadId: string): ReadMarker | null {
  const r = getStmt.get(threadId) as { read_at: string; manual_unread: number } | undefined;
  return r ? { readAt: r.read_at, manualUnread: r.manual_unread === 1 } : null;
}

const iso = (v: string): string | null => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Mark a thread read up to `upTo` (an ISO instant; default: its latest activity). Clears a manual
 * unread. Returns whether anything changed (a change announces thread.updated, so other devices
 * update). Never moves the marker back.
 */
export function markThreadRead(threadId: string, upTo?: string): { changed: boolean; readAt: string; before: string } | null {
  const thread = getThread(threadId);
  if (!thread) return null;
  const latest = iso(thread.lastActivityAt) ?? new Date(0).toISOString();
  // A client may only claim what it was shown: never beyond the thread's latest activity.
  const wanted = upTo ? iso(upTo) : latest;
  const target = wanted && wanted < latest ? wanted : latest;
  const cur = readMarker(threadId);
  const readAt = cur && cur.readAt > target ? cur.readAt : target;
  const before = cur?.readAt ?? "";
  if (cur && cur.readAt === readAt && !cur.manualUnread) return { changed: false, readAt, before };
  upsertStmt.run(threadId, readAt, 0, Date.now());
  appendEvent("thread.updated", threadId, { threadId });
  return { changed: true, readAt, before };
}

/**
 * A Telegram forum topic read (fix round 1, I-4): only THAT topic's read point moves (never past its
 * latest activity, never backwards); the forum's marker and its other topics stay. Clears a manual
 * unread. `before` = the topic's previous read point (receipts name only what this read moved over).
 */
export function markTopicRead(threadId: string, topicId: string, upTo?: string): { changed: boolean; readAt: string; before: string; topic: { cacheId: string; roomId: string } } | null {
  const t = forumTopic(threadId, topicId);
  if (!t) return null;
  const latest = iso(t.lastActivityAt) ?? new Date(0).toISOString();
  const wanted = upTo ? iso(upTo) : latest;
  const target = wanted && wanted < latest ? wanted : latest;
  const forum = readMarker(threadId);
  const cur = (db.prepare(`SELECT read_at FROM comms_topic_read_markers WHERE cache_id = ?`).get(t.cacheId) as { read_at: string } | undefined)?.read_at ?? "";
  const before = cur > (forum?.readAt ?? "") ? cur : forum?.readAt ?? "";
  const readAt = before > target ? before : target;
  const moved = readAt !== cur && readAt > cur;
  if (!moved && !forum?.manualUnread && forum) return { changed: false, readAt, before, topic: t };
  db.transaction(() => {
    if (moved) db.prepare(`INSERT INTO comms_topic_read_markers (cache_id, thread_id, read_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_id) DO UPDATE SET read_at = excluded.read_at, thread_id = excluded.thread_id, updated_at = excluded.updated_at`).run(t.cacheId, threadId, readAt, Date.now());
    // The forum needs a marker row for its unread to be computed from read points at all.
    upsertStmt.run(threadId, forum?.readAt ?? "", 0, Date.now());
  })();
  appendEvent("thread.updated", threadId, { threadId });
  return { changed: true, readAt, before, topic: t };
}

/** Mark as unread: the thread shows unread (≥ 1) until it is read again. */
export function markThreadUnread(threadId: string): boolean | null {
  const thread = getThread(threadId);
  if (!thread) return null;
  const cur = readMarker(threadId);
  if (cur?.manualUnread) return false;
  upsertStmt.run(threadId, cur?.readAt ?? "", 1, Date.now());
  appendEvent("thread.updated", threadId, { threadId });
  return true;
}

// ── presence: "the owner is reading this thread" ──────────────────────────────
// In memory (a restart forgets: at worst one extra notification). A device holds a lease while the
// thread is on screen; it renews it every ~60 s and drops it when the thread closes.
export const VIEWING_LEASE_MS = 90_000;
const viewing = new Map<string, Map<string, number>>();
let clock: () => number = Date.now;
export function setReadStateClockForTests(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

export function setViewing(threadId: string, deviceKey: string, on: boolean): void {
  let m = viewing.get(threadId);
  if (on) {
    if (!m) viewing.set(threadId, (m = new Map()));
    m.set(deviceKey, clock() + VIEWING_LEASE_MS);
    if (viewing.size > 500) for (const [k, v] of viewing) if ([...v.values()].every((u) => u <= clock())) viewing.delete(k);
  } else if (m) {
    m.delete(deviceKey);
    if (!m.size) viewing.delete(threadId);
  }
}

/** Is the owner looking at this thread on any device right now? */
export function isViewing(threadId: string): boolean {
  const m = viewing.get(threadId);
  if (!m) return false;
  const now = clock();
  for (const [k, until] of m) if (until <= now) m.delete(k);
  if (!m.size) viewing.delete(threadId);
  return !!m.size;
}
export function _resetViewingForTests(): void {
  viewing.clear();
}

// ── network read receipts (D10) ────────────────────────────────────────────────
export type ReceiptOutcome = "sent" | "off" | "unsupported" | "nothing" | "failed";

/** Sends one Matrix m.read receipt. Injectable (tests); the default uses the stored credential. */
export type ReceiptSender = (roomId: string, eventId: string) => Promise<void>;
let senderOverride: ReceiptSender | null = null;
export function setReceiptSenderForTests(fn: ReceiptSender | null): void {
  senderOverride = fn;
}

async function defaultSender(vaultId: string): Promise<ReceiptSender | null> {
  const { loadMatrixCreds } = await import("../actions/matrix");
  const { MatrixClient } = await import("../worker/matrix");
  const creds = loadMatrixCreds(vaultId);
  if (!creds) return null;
  const client = new MatrixClient(creds, fetch, 10_000);
  return (roomId, eventId) => client.sendReadReceipt(roomId, eventId);
}

/** The newest cached message from someone else sent at or before `readAt` (and after `after`, when
 *  given: a read names only what it moved over), its Matrix event id. */
function latestIncomingEventId(threadId: string, readAt: string, after = ""): string | null {
  const r = db.prepare(`SELECT source_event_id FROM comms_messages WHERE thread_id = ? AND sent_at <= ? AND sent_at > ?
    AND json_extract(json, '$.sender.isSelf') = 0 AND json_extract(json, '$.redacted') = 0
    ORDER BY sent_at DESC, source_event_id DESC LIMIT 1`).get(threadId, readAt, after) as { source_event_id: string } | undefined;
  return r && r.source_event_id.startsWith("$") ? r.source_event_id : null;
}

/** The last receipt sent per room (forums: never the same receipt twice; in memory). */
const lastReceipt = new Map<string, string>();
export function _resetReceiptMemoryForTests(): void { lastReceipt.clear(); }
/** At most this many forum receipts at once, and per read. */
const FORUM_RECEIPT_CONCURRENCY = 4;
const MAX_FORUM_RECEIPTS = 30;

/**
 * Send the network read receipt for a thread the owner just read — only when every gate above
 * holds. `humanDevice` = the request came from the owner's device credential (not a session, MCP,
 * an agent or a timer); `explicit` = the owner's own "Mark as Read" action; `readAt` = the read
 * point (the receipt never names a later message). Never throws; never logs ids or content.
 */
export async function maybeSendReceipt(
  threadId: string, vaultId: string,
  o: { humanDevice: boolean; explicit: boolean; readAt: string; topic?: { cacheId: string; roomId: string } | null; before?: string },
): Promise<ReceiptOutcome> {
  const thread = getThread(threadId);
  if (!thread) return "nothing";
  const network = (thread.networks[0] ?? "matrix") as Network;
  if (!config.commsReadReceiptsEnabled || !o.humanDevice) return "off";
  if (!o.explicit && !receiptsWanted(getNotifySettings(), network)) return "off";
  if (isBlueBubblesNetwork(network)) return "unsupported";
  // A Telegram forum (comms/forums.ts): one receipt per topic room, each naming that topic's newest
  // incoming message at or before the read point (bounded: the topics with cached messages).
  // A forum (fix round 1, I-4): a topic read names that topic only; a forum-wide read names only
  // the topics whose messages it moved over (after the previous read point), each at most once.
  const topics = o.topic ? [o.topic] : forumTopics(threadId);
  const targets: { roomId: string; eventId: string }[] = [];
  if (o.topic || topics.length) {
    for (const t of topics.slice(0, MAX_FORUM_RECEIPTS)) {
      const eventId = latestIncomingEventId(t.cacheId, o.readAt, o.before ?? "");
      if (eventId && lastReceipt.get(t.roomId) !== eventId) targets.push({ roomId: t.roomId, eventId });
    }
  } else {
    const src = threadSource(threadId);
    if (!src) return "unsupported";
    const eventId = latestIncomingEventId(threadId, o.readAt);
    if (eventId) targets.push({ roomId: src.roomId, eventId });
  }
  if (!targets.length) return "nothing";
  try {
    const send = senderOverride ?? (await defaultSender(vaultId));
    if (!send) return "unsupported";
    // Bounded concurrency; one failing room never stops the others.
    let sent = 0, failed = 0;
    for (let i = 0; i < targets.length; i += FORUM_RECEIPT_CONCURRENCY) {
      const batch = targets.slice(i, i + FORUM_RECEIPT_CONCURRENCY);
      const out = await Promise.allSettled(batch.map((t) => send(t.roomId, t.eventId)));
      out.forEach((r, j) => {
        if (r.status === "fulfilled") { sent++; lastReceipt.set(batch[j]!.roomId, batch[j]!.eventId); } else failed++;
      });
    }
    if (lastReceipt.size > 5000) lastReceipt.clear();
    if (!sent && failed) throw new Error("receipts failed");
    return "sent";
  } catch {
    console.warn("[comms] read receipt failed");
    return "failed";
  }
}
