/**
 * Graceful shutdown (SIGTERM / SIGINT) — the order is the point:
 *
 *  1. stop accepting: the HTTP listener closes, idle keep-alive sockets are dropped, and
 *     any request that still arrives on an open socket is answered 503 + Retry-After;
 *  2. stop background work: the worker tick (ingest, skills, indexes), notifications,
 *     nudges, the collab reconciler / sweep / access checks; running `claude` children are
 *     SIGTERMed and their turns left for the boot sweep (`interrupted`);
 *  3. store every loaded collaborative document (the one step that can lose typing), each
 *     through Hocuspocus's save mutex — bounded by the deadline;
 *  4. close clients cleanly: SSE streams end, collab sockets get close code 1012 (they
 *     reconnect to the restarted server), every remaining HTTP socket is closed;
 *  5. stop the conversion worker threads;
 *  6. checkpoint the SQLite WAL and close the database;
 *  7. exit 0.
 *
 * One deadline covers the whole run (`SHUTDOWN_DEADLINE_MS`, default 8000 — under the host
 * supervisor's 15 s SIGKILL and launchd's 20 s ExitTimeOut). Past it, or on a SECOND signal,
 * the process exits at once: 1 when a document store was still running (each one is named
 * in the log — its latest state is already in SQLite when its vault write was the part that
 * hung), 0 when nothing was abandoned. The database is still checkpointed and closed on that
 * path (both are synchronous and quick).
 *
 * Everything with an effect is injected (`ShutdownDeps`), so tests drive the deadline and the
 * second signal without a clock: `setTimer` is a fake they fire themselves.
 */

export interface StoreTracker {
  /** Settles when every store settled. */
  done: Promise<{ stored: number; failed: string[] }>;
  /** Documents whose store has not settled yet. */
  pending(): string[];
  total: number;
}

export interface ShutdownDeps {
  /** Close the listener (no new connections) and drop idle keep-alive sockets. Synchronous. */
  stopAccepting(): void;
  /** Stop timers, schedulers, ingest loops, agent children. Synchronous (it runs inside the signal handler). */
  stopBackground(): void;
  /** Begin storing every loaded collaborative document (synchronously starts each store). */
  storeDocuments(): StoreTracker;
  /** End SSE streams, close collab sockets and every remaining HTTP connection. */
  closeClients(): void;
  /** Stop the conversion worker threads. */
  stopConversion(): Promise<void>;
  /** Checkpoint the WAL and close SQLite. Synchronous; must not throw (log instead). */
  closeDb(): void;
  exit(code: number): void;
  log(line: string): void;
  deadlineMs: number;
  /** A one-shot timer; tests pass a fake. */
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

export interface Shutdown {
  /** Wire this to SIGTERM and SIGINT. The first call starts the shutdown, the second forces the exit. */
  onSignal(signal: string): void;
  /** Resolves once the orderly path finished (not on a forced exit). */
  readonly finished: Promise<void>;
  readonly started: boolean;
}

/** `SHUTDOWN_DEADLINE_MS`: a positive integer of milliseconds, else 8000. */
export function shutdownDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SHUTDOWN_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8000;
}

export function createShutdown(deps: ShutdownDeps): Shutdown {
  let started = false;
  let exited = false;
  let tracker: StoreTracker | null = null;
  let dbClosed = false;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((r) => (resolveFinished = r));

  const closeDbOnce = () => {
    if (dbClosed) return;
    dbClosed = true;
    try {
      deps.closeDb();
    } catch (e) {
      deps.log(`[shutdown] closing the database failed: ${(e as Error)?.message ?? e}`);
    }
  };
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };
  /** Deadline or second signal: name what is abandoned, close the db, exit now. */
  const force = (why: string) => {
    if (exited) return;
    const abandoned = tracker?.pending() ?? [];
    if (abandoned.length) deps.log(`[shutdown] ${why}: exiting with ${abandoned.length} document store(s) unfinished: ${abandoned.join(", ")}`);
    else deps.log(`[shutdown] ${why}: exiting now`);
    closeDbOnce();
    exit(abandoned.length ? 1 : 0);
  };

  const fail = (name: string, e: unknown) => deps.log(`[shutdown] ${name} failed: ${(e as Error)?.message ?? e}`);
  const syncStep = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      fail(name, e);
    }
  };
  const step = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      fail(name, e);
    }
  };

  /**
   * Steps 1–3 begin SYNCHRONOUSLY inside the signal handler: by the time anything else can
   * run (another request, a second signal), nothing new is accepted and every store has
   * started — so a second signal always knows which stores it abandons.
   */
  const run = async (signal: string) => {
    deps.log(`[shutdown] ${signal}: stopping (deadline ${deps.deadlineMs} ms; a second signal exits at once)`);
    const deadline = deps.setTimer(() => force(`deadline of ${deps.deadlineMs} ms passed`), deps.deadlineMs);
    syncStep("stop accepting", () => deps.stopAccepting());
    syncStep("stop background work", () => deps.stopBackground());
    try {
      tracker = deps.storeDocuments();
      if (tracker.total) deps.log(`[shutdown] storing ${tracker.total} open document(s)`);
      const r = await tracker.done;
      if (exited) return;
      if (tracker.total) deps.log(`[shutdown] stored ${r.stored} document(s)${r.failed.length ? `; ${r.failed.length} kept in SQLite for a later save: ${r.failed.join(", ")}` : ""}`);
    } catch (e) {
      deps.log(`[shutdown] storing documents failed: ${(e as Error)?.message ?? e}`);
    }
    if (exited) return;
    await step("close clients", () => deps.closeClients());
    await step("stop conversion workers", () => deps.stopConversion());
    if (exited) return;
    closeDbOnce();
    deadline.cancel();
    deps.log("[shutdown] done");
    resolveFinished();
    exit(0);
  };

  return {
    onSignal(signal: string) {
      if (!started) {
        started = true;
        void run(signal);
        return;
      }
      force(`second signal (${signal})`);
    },
    finished,
    get started() {
      return started;
    },
  };
}

let shuttingDown = false;
/** True once a graceful shutdown began (the request wrapper answers 503 from then on). */
export function isShuttingDown(): boolean {
  return shuttingDown;
}
export function markShuttingDown(): void {
  shuttingDown = true;
}
