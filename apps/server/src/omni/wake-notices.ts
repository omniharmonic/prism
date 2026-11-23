/**
 * Hermes wakes a session itself when background work finishes (`delegate_task(background)`,
 * a watched process): it re-enters the conversation as a `user` row the model reads. It is
 * not something the owner said, so the app must not draw it as the owner's bubble.
 *
 * Two shapes reach us:
 *  - push platforms persist it with `display_kind: "internal_notification"` (Hermes #82888);
 *  - the api_server — every Omni thread — wakes by self-POSTing `/v1/chat/completions` with a
 *    plain user message, so the row carries NO marker. Only its banner identifies it
 *    (`tools/process_registry.py` `_format_async_delegation` / `format_process_notification`).
 *
 * The banner is matched only at the very start of a user row. An owner who types one gets a
 * quiet notice instead of a bubble: a display choice, never a security decision.
 */

const DELEGATION = /^\[ASYNC DELEGATION (BATCH )?COMPLETE(?: — ([^\]\s]+))?\]/;
const BATCH_SIZE = /fan-out of (\d+) subagent/;
const PROCESS = /^\[IMPORTANT: (?:Background process\b|\d+ background processes completed)/;

export interface WakeNotice {
  /** Short line for the timeline, never the raw banner (it can run to thousands of chars). */
  text: string;
  /** Same key = the same delivery re-injected (Hermes retries a wake it thinks failed). */
  key: string;
}

export function wakeNotice(role: string, text: string, displayKind?: string | null): WakeNotice | null {
  if (role !== "user") return null;
  const head = text.trimStart();
  const d = DELEGATION.exec(head);
  if (d) {
    const id = d[2] ?? "";
    if (d[1]) {
      const n = Number(BATCH_SIZE.exec(head)?.[1] ?? 0);
      return { text: n > 0 ? `Background work finished: ${n} subagent${n === 1 ? "" : "s"} reported back.` : "Background work finished.", key: `deleg:${id || head.split("\n", 1)[0]}` };
    }
    return { text: "A background subagent reported back.", key: `deleg:${id || head.split("\n", 1)[0]}` };
  }
  if (PROCESS.test(head)) return { text: "A background process finished.", key: `proc:${head.slice(0, 200)}` };
  if (displayKind === "internal_notification") return { text: "Background update for the agent.", key: `internal:${head.slice(0, 200)}` };
  return null;
}
