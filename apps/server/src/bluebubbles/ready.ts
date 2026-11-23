// Is BlueBubbles answering right now? The send capability for iMessage/SMS (comms/send-policy.ts)
// is offered only while it is: a pass whose ping + identity check succeeded, or a successful
// send, within WORKER_STALE_BLUEBUBBLES_MS. Tiny on purpose (no imports beyond config), so the
// read path can ask without pulling in the connector.
import { config } from "../config";

let lastOkAt = 0;
let clock: () => number = () => Date.now();

/** BlueBubbles answered as BlueBubbles (worker ping, a send). */
export function noteBlueBubblesReachable(): void {
  lastOkAt = clock();
}

/** BlueBubbles failed to answer (a pass that could not ping it). */
export function noteBlueBubblesUnreachable(): void {
  lastOkAt = 0;
}

export function blueBubblesReachable(): boolean {
  const stale = config.workerStaleMs.bluebubbles > 0 ? config.workerStaleMs.bluebubbles : 15 * 60_000;
  return lastOkAt > 0 && clock() - lastOkAt <= stale;
}

/** Tests: a clock (null restores Date.now) and a forgotten state. */
export function resetBlueBubblesReadyForTests(now: (() => number) | null = null): void {
  clock = now ?? (() => Date.now());
  lastOkAt = 0;
}
