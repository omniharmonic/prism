// The ingest event bus (Task 11): the single Matrix ingest owner (worker/matrix.ts ingestMatrix)
// publishes one batch per synced room AFTER that room's vault write succeeded (a room whose
// write failed is announced at the end of the pass, flagged `stale`); the Comms live
// listener (comms/live.ts) subscribes. In-process only. publish() never throws into ingest and
// never waits for a subscriber.
import type { MatrixEvent } from "../worker/matrix";

export interface LiveBatch {
  roomId: string;
  /** The room's RAW /sync timeline events (all types, oldest first), not the vault writer's filtered lines. */
  events: MatrixEvent[];
  /** The room's m.receipt EDUs from /sync (sprint Task 8, COMMS_RECEIPTS_ENABLED only). */
  receipts?: MatrixEvent[];
  /** The homeserver truncated the timeline: `events` is only the tail (a gap precedes it). */
  limited?: boolean;
  /** The room's message-thread note, when the pass knows it (lets the projection skip a listing). */
  noteId?: string;
  /** The pass synced this room but did not get its vault write through (write / gap-fill failed,
   *  or the pass stopped before it). `events` is still the room's raw timeline and is merged like
   *  any batch (with `limited`, a gap → the window goes stale). An EMPTY stale batch (the live
   *  queue dropped what it held) only marks the window stale. */
  stale?: true;
}

type Listener = (b: LiveBatch) => void;
const listeners = new Set<Listener>();

export const commsBus = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  publish(b: LiveBatch): void {
    for (const fn of [...listeners]) {
      try {
        fn(b);
      } catch (e) {
        console.warn(`[comms] bus listener failed: ${String(e).slice(0, 200)}`);
      }
    }
  },
  listenerCount(): number {
    return listeners.size;
  },
};
