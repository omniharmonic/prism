/**
 * Timing probes for tests that prove "this work is bounded" — measured in CPU TIME OF THIS
 * THREAD, not on the wall clock.
 *
 * What those tests prove is a property of the code: the pre-check is one linear pass, an inline
 * conversion is a few milliseconds of work, nothing holds the event loop for long. Wall-clock
 * time measures the machine as well: on a laptop running other jobs the same code "took" ten
 * times longer and "stalled the loop" for as long as the scheduler kept the process off a core —
 * the tests failed without anything being wrong (and would have passed with something wrong on a
 * fast, idle machine).
 *
 * `process.threadCpuUsage()` counts only the time this thread actually ran: a descheduled thread
 * accrues none, a thread that is blocked computing accrues all of it.
 */
export const threadCpuMs = (): number => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};

/** CPU milliseconds this thread spends inside a synchronous `fn`. */
export function cpuOf<T>(fn: () => T): { value: T; cpuMs: number } {
  const start = threadCpuMs();
  const value = fn();
  return { value, cpuMs: threadCpuMs() - start };
}

export interface Probed<T> {
  value?: T;
  error?: unknown;
  /**
   * The event loop's worst stall: the most CPU this thread burned between two consecutive turns
   * of a 10 ms timer. A loop that keeps turning shows a few milliseconds whatever the machine is
   * doing; a synchronous stretch of N ms shows N.
   */
  maxLagMs: number;
  /** CPU this thread spent from start to finish (waiting for a worker thread costs none). */
  cpuMs: number;
  /** Wall-clock duration — for messages only; never assert on it. */
  wallMs: number;
}

/** Run `fn` while a 10 ms timer records the longest CPU-bound gap between its ticks. */
export async function probed<T>(fn: () => Promise<T> | T): Promise<Probed<T>> {
  let last = threadCpuMs();
  let maxLagMs = 0;
  const tick = () => {
    const now = threadCpuMs();
    maxLagMs = Math.max(maxLagMs, now - last);
    last = now;
  };
  const timer = setInterval(tick, 10);
  const startCpu = last;
  const startWall = performance.now();
  const done = (): Pick<Probed<T>, "maxLagMs" | "cpuMs" | "wallMs"> => {
    tick();
    return { maxLagMs, cpuMs: threadCpuMs() - startCpu, wallMs: performance.now() - startWall };
  };
  try {
    const value = await fn();
    return { value, ...done() };
  } catch (error) {
    return { error, ...done() };
  } finally {
    clearInterval(timer);
  }
}

/**
 * How many turns of the event loop pass before `promise` settles. "Answered at once" means a
 * handful; anything that waited for a timer or a thread is hundreds of turns away on any machine.
 */
export function turnsUntilSettled<T>(promise: Promise<T>): { result: Promise<T>; turns: () => number } {
  let turns = 0;
  let settled = false;
  const spin = () => {
    if (settled) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  const result = promise.finally(() => {
    settled = true;
  });
  return { result, turns: () => turns };
}
