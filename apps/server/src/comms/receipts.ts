// Inbound read receipts (sprint Task 8): whether the OTHER side read the owner's messages.
// Display only — nothing here sends a receipt (D10 governs what the owner sends; Comms sends none).
//
// Source: the m.receipt EDUs of the Matrix /sync (worker/matrix.ts asks for them only with
// COMMS_RECEIPTS_ENABLED). A mautrix bridgev2 bridge turns a remote read into an `m.read` receipt
// from the reader's ghost on the newest bridged message they read (portal.go
// handleRemoteReadReceipt → intent.MarkRead). A read receipt on event E means "read up to E".
//
// Stored: the NEWEST receipt per (room, reader) — comms_receipts, a few rows per room — with the
// receipted event's timestamp when it is known (from the same /sync timeline or the window cache).
// Monotonic: an older receipt arriving late (out of order) never moves a reader back.
//
// Projection (at read time, one SQLite query per page / stream frame, no Matrix call): an owner
// message M is read by R when R's receipt is on M itself, or on an event at or after M
// (event_ts ≥ M.sentAt; when the event's time is unknown, the receipt's own time ≥ M.sentAt).
// Ignored readers: the owner (every self id), Omni / agent accounts, bridge bots (mautrix
// `delivery_receipts: true` makes the BOT send m.read when a message was bridged — that is
// "sent", not "read").
import { config } from "../config";
import { db } from "../db";
import { displayNameFor } from "./naming";
import type { Message } from "./types";

export interface ReceiptEntry { eventId: string; userId: string; ts: number | null }
export interface ReaderRow { userId: string; eventId: string; eventTs: number | null; readAt: number; name: string | null }

const asRec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const MAX_ID = 512;

/** The `m.read` entries of one m.receipt EDU's content ({eventId: {"m.read": {userId: {ts}}}}). */
export function readEntriesOf(content: unknown): ReceiptEntry[] {
  const out: ReceiptEntry[] = [];
  for (const [eventId, byType] of Object.entries(asRec(content) ?? {})) {
    if (!eventId.startsWith("$") || eventId.length > MAX_ID) continue;
    // Only public `m.read`: `m.read.private` is never visible for anyone but its sender.
    for (const [userId, info] of Object.entries(asRec(asRec(byType)?.["m.read"]) ?? {})) {
      if (!userId.startsWith("@") || userId.length > MAX_ID) continue;
      const ts = asRec(info)?.ts;
      out.push({ eventId, userId, ts: typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : null });
    }
  }
  return out;
}

export interface RecordCtx {
  /** The owner's ids, agents, bridge bots: their receipts are not "the other side read it". */
  ignore(userId: string): boolean;
  /** origin_server_ts of a receipted event when known (batch timeline / window cache). */
  eventTs(eventId: string): number | null;
  /** Display name for a reader (room member profile); falls back to the id's readable form. */
  nameOf(userId: string): string | null;
  now?: number;
}

/** Newer = a later receipted event; equal / unknown events compare by the receipt's time. */
function newer(a: { eventTs: number | null; readAt: number }, b: { eventTs: number | null; readAt: number }): boolean {
  const ka = a.eventTs ?? a.readAt;
  const kb = b.eventTs ?? b.readAt;
  return ka > kb || (ka === kb && a.readAt > b.readAt);
}

/**
 * Store the receipts of one room's batch. Returns whether any reader moved forward. A user with
 * several receipts in the batch keeps the newest; a receipt older than the stored one is ignored.
 */
export function recordReceipts(roomId: string, entries: ReceiptEntry[], ctx: RecordCtx): boolean {
  const now = ctx.now ?? Date.now();
  const best = new Map<string, ReaderRow>();
  for (const e of entries) {
    if (ctx.ignore(e.userId)) continue;
    const row: ReaderRow = { userId: e.userId, eventId: e.eventId, eventTs: ctx.eventTs(e.eventId), readAt: e.ts ?? now, name: null };
    const cur = best.get(e.userId);
    if (!cur || newer(row, cur)) best.set(e.userId, row);
  }
  if (!best.size) return false;
  const get = db.prepare(`SELECT event_id, event_ts, read_at FROM comms_receipts WHERE room_id = ? AND user_id = ?`);
  const put = db.prepare(`INSERT INTO comms_receipts (room_id, user_id, event_id, event_ts, read_at, name) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, user_id) DO UPDATE SET event_id = excluded.event_id, event_ts = excluded.event_ts,
      read_at = excluded.read_at, name = COALESCE(excluded.name, comms_receipts.name)`);
  let moved = false;
  db.transaction(() => {
    for (const r of best.values()) {
      const have = get.get(roomId, r.userId) as { event_id: string; event_ts: number | null; read_at: number } | undefined;
      if (have && (have.event_id === r.eventId || !newer(r, { eventTs: have.event_ts, readAt: have.read_at }))) continue;
      put.run(roomId, r.userId, r.eventId, r.eventTs, r.readAt, ctx.nameOf(r.userId));
      moved = true;
    }
  })();
  return moved;
}

export function roomReaders(roomId: string): ReaderRow[] {
  return (db.prepare(`SELECT user_id, event_id, event_ts, read_at, name FROM comms_receipts WHERE room_id = ? LIMIT 500`).all(roomId) as
    { user_id: string; event_id: string; event_ts: number | null; read_at: number; name: string | null }[])
    .map((r) => ({ userId: r.user_id, eventId: r.event_id, eventTs: r.event_ts, readAt: r.read_at, name: r.name }));
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Who of `readers` has read `m` (an owner message), oldest read first. */
function readersOf(m: Message, readers: ReaderRow[]): ReaderRow[] {
  const sent = Date.parse(m.sentAt);
  if (!Number.isFinite(sent)) return [];
  return readers
    .filter((r) => r.eventId === m.id || (r.eventTs !== null ? r.eventTs >= sent : r.readAt >= sent))
    .sort((a, b) => a.readAt - b.readAt || (a.userId < b.userId ? -1 : 1));
}

/** Can a receipt change this message's state? Only the owner's real, sent, unfailed messages. */
const readable = (m: Message) =>
  m.sender.isSelf && !m.redacted && !m.system && (m.delivery === "sent" || m.delivery === "delivered" || m.delivery === "read");

/**
 * The read state of the owner's messages in `messages` (a Matrix room's), from the stored
 * receipts: delivery "read", `readAt` (newest reader's time) and `readBy`. Messages nobody read
 * are returned unchanged. Off (COMMS_RECEIPTS_ENABLED unset) → unchanged.
 */
export function withReadState(messages: Message[], roomId: string | null, readers?: ReaderRow[]): Message[] {
  if (!config.commsReceiptsEnabled || !roomId || !messages.some(readable)) return messages;
  let rows = readers ?? roomReaders(roomId);
  if (!rows.length) return messages;
  // A receipt stored before its event was known: the event may be in this page now (review M1)
  // — use its time instead of the receipt's own (which can over-report a later message).
  if (rows.some((r) => r.eventTs === null)) {
    const at = new Map(messages.map((m) => [m.id, Date.parse(m.sentAt)]));
    rows = rows.map((r) => (r.eventTs === null && Number.isFinite(at.get(r.eventId)) ? { ...r, eventTs: at.get(r.eventId)! } : r));
  }
  return messages.map((m) => {
    if (!readable(m)) return m;
    const by = readersOf(m, rows);
    if (!by.length) return m;
    const sent = Date.parse(m.sentAt);
    const readBy = by.map((r) => ({ id: r.userId, name: r.name ?? displayNameFor(null, r.userId), readAt: iso(Math.max(r.readAt, sent)) }));
    return { ...m, delivery: "read" as const, readAt: readBy[readBy.length - 1]!.readAt, readBy };
  });
}

/** What a receipt changes on a message (for "did this batch change it?"). */
export const readKey = (m: Message): string => JSON.stringify([m.delivery, m.readAt ?? null, m.readBy ?? null]);
