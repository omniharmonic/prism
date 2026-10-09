/**
 * Running a turn: the gateway posts the person's message to Hermes' streamed chat
 * route, normalises the stream (stream.ts), persists every non-delta event with a
 * per-thread seq (replay with `?after=`), derives record cards from the agent's
 * successful writes (records.ts), and ends the turn with exactly one `result` + a
 * `status` event. One active turn per thread (a second POST → 409 + the running turn).
 *
 * What a tool really did is read from the row Hermes stores for it (its stream has no
 * failure flag): right after a write tool completes, so the card appears while the turn
 * runs, and again from `run.completed`. A write is carded only once its row says it worked.
 *
 * The turn outlives the HTTP request that started it: the app may close, reopen and
 * re-attach with `?after=<seq>`. A server restart ends running turns as `interrupted`
 * (sweepRunningTurns at boot); Hermes keeps whatever it already wrote to the session.
 */
import { hermes, HermesError } from "./hermes-client";
import { HermesNormalizer, toolRowsOf, type OmniEvent, type WriteSignal } from "./stream";
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
/** Stop requests still being retried, by turn (they outlive the turn's own entry). */
const stopping = new Map<string, Promise<void>>();
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
  await stopping.get(turnId);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Keep asking Hermes to stop the run until it accepts. One request is not enough: in the
 * first seconds of a run (its agent is still being built) Hermes answers `run_not_found`
 * and — because hanging up at that moment does not interrupt it either — the run would go
 * on to call the model and its tools with nobody watching. It also answers `run_not_found`
 * for a run that already ended, so this gives up after `OMNI_HERMES_STOP_RETRY_MS`.
 */
function stopUntilAccepted(turnId: string, entry: Live): void {
  if (stopping.has(turnId)) return;
  const p = keepStopping(entry).finally(() => stopping.delete(turnId));
  stopping.set(turnId, p);
}
async function keepStopping(entry: Live): Promise<void> {
  const deadline = Date.now() + omniConfig.stopRetryMs();
  let wait = 250;
  for (;;) {
    if (entry.runId) {
      try {
        if (await hermes.stopRun(entry.runId)) return;
      } catch {
        /* unreachable or refused: try again until the deadline */
      }
    }
    if (Date.now() + wait > deadline) return;
    await sleep(wait);
    wait = Math.min(1000, wait * 2);
  }
}

/** Cancel a running turn: hang up, and ask Hermes to stop the run by id until it does.
 *  Returns false when it is not running here. */
export function cancelTurn(turnId: string): boolean {
  const e = live.get(turnId);
  if (!e) return false;
  if (e.cancelled) return true;
  e.cancelled = true;
  // Hermes names the run in its first frame. A cancel that lands before that waits for it
  // (briefly) — hanging up without a run id would leave nothing to stop the run with.
  if (e.runId) e.ac.abort();
  else setTimeout(() => e.ac.abort(), RUN_ID_WAIT_MS).unref?.();
  stopUntilAccepted(turnId, e);
  return true;
}

/** Runs a restart left behind (their turns are swept as `interrupted`): ask Hermes to stop
 *  each, once, best effort — the stream that would have told it is gone. */
export function stopOrphanedRuns(runIds: string[]): void {
  for (const id of runIds) void hermes.stopRun(id).catch(() => false);
}

/** A cancel with no run id yet waits this long for Hermes' first frame before hanging up. */
const RUN_ID_WAIT_MS = 5_000;
/** How long a write's tool row may take to read before the card waits for the run's end. */
const VERIFY_TIMEOUT_MS = 3_000;
/** After the terminal frame Hermes sends `done` and closes; wait this long for that. */
const DRAIN_MS = 2_000;

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
  let drain: NodeJS.Timeout | undefined;
  const handle = (ev: OmniEvent) => {
    if (ev.t === "init" && norm.runId && !entry.runId) {
      entry.runId = norm.runId;
      setTurnRun(turnId, norm.runId);
      if (entry.cancelled) entry.ac.abort(); // the cancel was waiting for this id
    }
    if (ev.t === "result" && !ev.ok) errorCode = ev.errorCode ?? "agent_failed";
    emit(threadId, turnId, ev);
  };
  /** Read the tool rows this turn wrote so far and settle the calls they answer. */
  const verifyFromTranscript = async () => {
    const rows = await hermes.getMessages(threadId, { limit: 60, timeoutMs: VERIFY_TIMEOUT_MS }).catch(() => null);
    if (!rows) return;
    // Only this turn's rows — the ones after the newest user message (Hermes stores it when
    // the turn starts): an earlier turn's result for the same tool is not this call's.
    let from = 0;
    rows.forEach((r, i) => {
      if (r.role === "user") from = i + 1;
    });
    for (const ev of norm.reconcile(toolRowsOf(rows.slice(from)), false)) emit(threadId, turnId, ev);
  };
  const flushWrites = async () => {
    while (seenWrites < norm.writes.length) await handleWrite(norm.writes[seenWrites++]!);
  };
  try {
    for await (const frame of hermes.chatStream(threadId, message, entry.ac.signal)) {
      if (norm.ended) continue; // draining to Hermes' own end of stream
      for (const ev of norm.push(frame)) handle(ev);
      if (!norm.ended && norm.needsVerification) await verifyFromTranscript();
      await flushWrites();
      // The terminal frame is read. Let Hermes finish the response itself (`done`, close)
      // rather than hanging up on it; if it does not, stop waiting.
      if (norm.ended) (drain = setTimeout(() => entry.ac.abort(), DRAIN_MS)).unref?.();
    }
    if (!norm.ended) {
      if (entry.cancelled) emit(threadId, turnId, { t: "result", ok: false, durationMs: 0, errorCode: (errorCode = "cancelled") });
      else {
        timedOut = entry.ac.signal.aborted;
        errorCode = timedOut ? "timeout" : "stream_ended";
        emit(threadId, turnId, { t: "result", ok: false, durationMs: 0, errorCode });
        // The gateway gave up on a run that may still be going: it must not go on alone.
        if (timedOut) stopUntilAccepted(turnId, entry);
      }
    }
  } catch (e) {
    // A stream that breaks AFTER its terminal frame changes nothing: the turn is decided.
    if (!norm.ended) {
      errorCode = entry.cancelled ? "cancelled" : e instanceof HermesError ? e.code : "internal_error";
      if (!e || !(e instanceof HermesError)) console.error(`[omni] turn ${turnId} failed: ${(e as Error)?.message}`);
      emit(threadId, turnId, { t: "result", ok: false, durationMs: 0, errorCode });
      // Silence past the idle limit: the run is still Hermes' — stop it. (A broken stream or
      // a refused request leaves nothing to stop.)
      if (!entry.cancelled && errorCode === "hermes_timeout") stopUntilAccepted(turnId, entry);
    }
  } finally {
    clearTimeout(cap);
    clearTimeout(drain);
  }
  // The run did not end with its transcript (cancelled, cut off, timed out): a write it had
  // already made is still a write — read its row once more before the turn is closed.
  if (!norm.ended && norm.needsVerification) {
    await verifyFromTranscript().catch(() => {});
    await flushWrites().catch(() => {});
  }
  (watcher as Awaited<ReturnType<typeof watchPendingCreates>> | null)?.close();
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
