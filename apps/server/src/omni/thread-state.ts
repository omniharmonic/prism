/**
 * What a thread's PERSISTED state means once nothing is running or pending on it.
 *
 * `needs-you` is written at turn end (turns.ts) for two different reasons:
 *   1. the turn ended while a draft it proposed was still pending — the owner must decide;
 *   2. the turn itself failed (`errorCode`) — the owner should look at what went wrong.
 * Nothing rewrites the row when the draft is later decided, so reason 1 outlived its cause
 * and the thread sat under "Needs you" after the owner had already approved it.
 *
 * Called by `threadView` only when no turn is running and no approval is pending — those
 * two cases are already `working` / `needs-you` before this runs.
 */
import type { Approval } from "./approvals";
import type { ThreadState, TurnRow } from "./store";

/**
 * @param persisted the state stored on the thread row
 * @param last      the thread's most recent turn (null: the gateway never ran one here)
 * @param approvals every approval on this thread, newest first (none is `pending` here)
 */
export function settledState(persisted: ThreadState, last: TurnRow | null, approvals: Approval[]): ThreadState {
  if (persisted !== "needs-you") return persisted;
  // Reason 2: the turn itself went wrong. That still needs the owner, whatever happened to its drafts.
  if (last && (last.errorCode || last.status === "error" || last.status === "interrupted")) return persisted;
  // A send that was approved but did not go through (Bridge down, API error) must not vanish
  // from the list: the owner believes it went. Only the newest decision counts, so a retry clears it.
  const newest = approvals.find(a => a.decidedAt != null);
  if (newest && (newest.status === "failed" || newest.status === "unknown")) return persisted;
  // Reason 1 has been answered. Settle to what turns.ts would have written had nothing been pending.
  return last?.status === "cancelled" ? "waiting" : "done";
}
