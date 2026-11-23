// Pinned conversations (sprint Task 8, "favourites at the top, ala Apple Messages").
//
// A pin is an owner override on comms_threads (o_pinned = 1 + o_pin_order), like mute/archive:
// it survives re-projection and every device reads the same order from the server. At most
// MAX_PINS (9, as Messages) are pinned. Order is dense 0…n-1 after every change.
//
// Every change appends `thread.updated` for the thread(s) it touched; a reorder appends one
// list-wide `thread.updated` (threadId null), so other devices refetch the list.
import { db } from "../db";
import { appendEvent, getThread, pinnedThreads } from "./store";
import type { Thread } from "./types";

export const MAX_PINS = 9;

export class PinError extends Error {
  constructor(readonly status: 404 | 409, readonly code: "thread_unavailable" | "pin_limit" | "pins_changed") {
    super(code);
    this.name = "PinError";
  }
}

/** The pinned threads' ids in order (what PUT /pins must name, in any order). */
export function pinnedIds(): string[] {
  return pinnedThreads().map((t) => t.id);
}

/** Make the stored order dense (0…n-1) following `ids`. Inside a transaction. Returns
 *  whether a pin other than `except` moved (then other devices must refetch the whole grid). */
function writeOrder(ids: string[], except?: string): boolean {
  const cur = db.prepare(`SELECT o_pin_order AS o FROM comms_threads WHERE id = ?`);
  const upd = db.prepare(`UPDATE comms_threads SET o_pinned = 1, o_pin_order = ? WHERE id = ?`);
  let moved = false;
  ids.forEach((id, i) => {
    if (id !== except && (cur.get(id) as { o: number | null } | undefined)?.o !== i) moved = true;
    upd.run(i, id);
  });
  return moved;
}

/**
 * Pin `threadId` at the end of the grid. Already pinned: unchanged (idempotent). A 10th pin is
 * refused (409 pin_limit) — the client asks the owner to unpin one first, as Messages does.
 */
export function pinThread(threadId: string): Thread {
  const r = db.transaction((): { done: boolean; healed: boolean } => {
    if (!getThread(threadId)) throw new PinError(404, "thread_unavailable");
    const ids = pinnedIds();
    // A pin without an order (pinned at the source) is healed into the dense order here.
    if (ids.includes(threadId)) return { done: false, healed: writeOrder(ids) };
    if (ids.length >= MAX_PINS) throw new PinError(409, "pin_limit");
    return { done: true, healed: writeOrder([...ids, threadId], threadId) };
  })();
  if (r.done) appendEvent("thread.updated", threadId, { threadId });
  if (r.healed) appendEvent("thread.updated", null, { threadId: null, reason: "pins" });
  return getThread(threadId)!;
}

/** Unpin `threadId` (idempotent); the pins after it move up one. */
export function unpinThread(threadId: string): Thread {
  const changed = db.transaction((): { changed: boolean; healed: boolean } => {
    if (!getThread(threadId)) throw new PinError(404, "thread_unavailable");
    const ids = pinnedIds();
    // o_pinned = 0 (not NULL): an explicit unpin also overrides a source-side pin.
    db.prepare(`UPDATE comms_threads SET o_pinned = 0, o_pin_order = NULL WHERE id = ?`).run(threadId);
    const healed = writeOrder(ids.filter((id) => id !== threadId));
    return { changed: ids.includes(threadId), healed };
  })();
  if (changed.changed) appendEvent("thread.updated", threadId, { threadId });
  // The pins after it moved up one: other devices refetch the grid.
  if (changed.healed) appendEvent("thread.updated", null, { threadId: null, reason: "pins" });
  return getThread(threadId)!;
}

/**
 * Reorder the grid. `ids` must be exactly the pinned set (any order, no duplicates); anything
 * else is 409 pins_changed (another device pinned/unpinned meanwhile — the client refetches).
 */
export function reorderPins(ids: string[]): Thread[] {
  const changed = db.transaction((): boolean => {
    const now = pinnedIds();
    const same = ids.length === now.length && new Set(ids).size === ids.length && ids.every((id) => now.includes(id));
    if (!same) throw new PinError(409, "pins_changed");
    const stored = (db.prepare(`SELECT id, o_pin_order AS o FROM comms_threads WHERE o_pinned = 1`).all() as { id: string; o: number | null }[]);
    const before = new Map(stored.map((r) => [r.id, r.o]));
    writeOrder(ids);
    return ids.some((id, i) => before.get(id) !== i);
  })();
  if (changed) appendEvent("thread.updated", null, { threadId: null, reason: "pins" });
  return pinnedThreads();
}
