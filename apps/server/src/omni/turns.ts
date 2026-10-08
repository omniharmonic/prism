/**
 * Running a turn: the gateway posts the person's message to Hermes' streamed chat
 * route, normalises the stream (stream.ts), persists every non-delta event with a
 * per-thread seq (replay with `?after=`), derives record cards from the agent's
 * successful writes (records.ts), and ends the turn with exactly one `result` + a
 * `status` event. One active turn per thread (a second POST → 409 + the running turn).
 *
 * The turn outlives the HTTP request that started it: the app may close, reopen and
 * re-attach with `?after=<seq>`. A server restart ends running turns as `interrupted`
 * (sweepRunningTurns at boot); Hermes keeps whatever it already wrote to the session.
 */
import { hermes, HermesError } from "./hermes-client";
import { HermesNormalizer, type OmniEvent, type WriteSignal } from "./stream";
import { cardForWrite, watchPendingCreates, buildCard, type PendingCreate } from "./records";
import { appendEvent, claimTurn, endTurn, getThread, saveCard, setThreadState, setTurnRun, touchThread, type ThreadState, type TurnRow } from "./store";
import { publishNotice, publishThread, pushOmni, threadWatched } from "./bus";
import { listApprovals } from "./approvals";
import { omniConfig } from "./config";

interface Live {
  ac: AbortController;
  runId: string | null;
  cancelled: boolean;
  done: Promise<void>;
}
const live = new Map<string, Live>();
export const liveTurnCount = (): number => live.size;

/** Emit one event to the thread: persisted (with seq) unless it is a live-only delta. */
export function emit(threadId: string, turnId: string | null, event: OmniEvent): number | undefined {
  if (event.t === "text_delta") {
    publishThread(threadId, { turnId, event });
    return undefined;
  }
  const seq = appendEvent(threadId, turnId, event as unknown as Record<string, unknown>, omniConfig.eventsPerThread());
  publishThread(threadId, { seq, turnId, event });
  return seq;
}

export type StartTurn = { turn: TurnRow } | { active: TurnRow } | { replay: TurnRow };

/** Claim + start a turn in the background. */
export function startTurn(threadId: string, message: string, idemKey: string | null): StartTurn {
  const r = claimTurn(threadId, idemKey);
  if (r.replay) return { replay: r.replay };
  if (r.active) return { active: r.active };
  const turn = r.turn!;
  setThreadState(threadId, "working");
  touchThread(threadId);
  emit(threadId, turn.id, { t: "status", state: "working" });
  publishNotice({ type: "thread", id: threadId, op: "working" });
  const ac = new AbortController();
  const entry: Live = { ac, runId: null, cancelled: false, done: Promise.resolve() };
  live.set(turn.id, entry);
  entry.done = run(threadId, turn.id, message, entry).finally(() => live.delete(turn.id));
  return { turn };
}

/** For tests: wait until a turn's background run settled. */
export async function turnSettled(turnId: string): Promise<void> {
  await live.get(turnId)?.done;
}

/** Cancel a running turn: abort the stream (Hermes interrupts a run whose stream drops)
 *  and ask Hermes to stop the run by id. Returns false when it is not running here. */
export function cancelTurn(turnId: string): boolean {
  const e = live.get(turnId);
  if (!e) return false;
  e.cancelled = true;
  e.ac.abort();
  if (e.runId) void hermes.stopRun(e.runId).catch(() => {});
  return true;
}

async function run(threadId: string, turnId: string, message: string, entry: Live): Promise<void> {
  const norm = new HermesNormalizer(turnId);
  let watcher: Awaited<ReturnType<typeof watchPendingCreates>> | null = null;
  let seenWrites = 0;
  const onCard = (card: ReturnType<typeof buildCard>) => {
    saveCard(threadId, turnId, card);
    emit(threadId, turnId, { t: "card", card });
    publishNotice({ type: "card", id: card.noteId, op: card.op, threadId });
  };
  const handleWrite = async (w: WriteSignal) => {
    const r = await cardForWrite(w, threadId).catch(() => ({}) as { card?: undefined; pending?: PendingCreate });
    if (r.card) onCard(r.card);
    else if (r.pending) {
      if (!watcher) watcher = await watchPendingCreates([], (wr, meta) => onCard(buildCard(wr, meta, threadId)));
      watcher.add(r.pending);
    }
  };
  const cap = setTimeout(() => entry.ac.abort(), omniConfig.turnMaxMs());
  cap.unref?.();
  let errorCode: string | null = null;
  let timedOut = false;
  try {
    for await (const frame of hermes.chatStream(threadId, message, entry.ac.signal)) {
      for (const ev of norm.push(frame)) {
        if (ev.t === "init" && norm.runId && !entry.runId) {
          entry.runId = norm.runId;
          setTurnRun(turnId, norm.runId);
          if (entry.cancelled) void hermes.stopRun(norm.runId).catch(() => {});
        }
        if (ev.t !== "result") emit(threadId, turnId, ev);
        else {
          if (!ev.ok) errorCode = ev.errorCode ?? "agent_failed";
          emit(threadId, turnId, ev);
        }
      }
      while (seenWrites < norm.writes.length) await handleWrite(norm.writes[seenWrites++]!);
      if (norm.ended) break;
    }
    if (!norm.ended) {
      if (entry.cancelled) emit(threadId, turnId, { t: "result", ok: false, durationMs: 0, errorCode: (errorCode = "cancelled") });
      else {
        timedOut = entry.ac.signal.aborted;
        errorCode = timedOut ? "timeout" : "stream_ended";
        emit(threadId, turnId, { t: "result", ok: false, durationMs: 0, errorCode });
      }
    }
  } catch (e) {
    errorCode = entry.cancelled ? "cancelled" : e instanceof HermesError ? e.code : "internal_error";
    if (!e || !(e instanceof HermesError)) console.error(`[omni] turn ${turnId} failed: ${(e as Error)?.message}`);
    emit(threadId, turnId, { t: "result", ok: false, durationMs: 0, errorCode });
  } finally {
    clearTimeout(cap);
    (watcher as Awaited<ReturnType<typeof watchPendingCreates>> | null)?.close();
  }
  const cancelled = errorCode === "cancelled";
  endTurn(turnId, cancelled ? "cancelled" : errorCode ? "error" : "done", errorCode);
  const pendingHere = listApprovals(omniConfig.ownerEmail(), "pending").some((a) => a.threadId === threadId);
  const state: ThreadState = pendingHere ? "needs-you" : cancelled ? "waiting" : errorCode ? "needs-you" : "done";
  setThreadState(threadId, state);
  touchThread(threadId);
  emit(threadId, turnId, { t: "status", state, ...(errorCode ? { reason: errorCode } : {}) });
  publishNotice({ type: "thread", id: threadId, op: state });
  // Nobody is watching the thread live (app backgrounded) → an ids-only push.
  if (!cancelled && !threadWatched(threadId) && getThread(threadId)) pushOmni("OMNI_THREAD", threadId);
}
