/**
 * Why an agent run failed — PURE (no I/O, no imports), so it is unit-tested with
 * recorded streams (test/fixtures/agent-stream-*.jsonl) and shared by one-shot
 * dispatches and session turns.
 *
 * The 2026-10 incident: the `claude` CLI answered "Failed to authenticate: OAuth
 * token revoked…" as an ASSISTANT text block, ended with `result {is_error: true,
 * subtype: "success"}` and exit code 1. The turn then read "claude exited 1 —
 * success" and the client showed a bare status word. Every failure now carries a
 * stable `errorCode` and a truthful sentence; the CLI's own error line is never
 * stored as the assistant's reply.
 */

export const AGENT_ERROR_CODES = [
  "auth", // the CLI could not sign in (revoked/expired OAuth token, bad API key, 401)
  "usage_limit", // usage/rate limit, quota, overloaded (429/529), no credit
  "budget", // the per-run spending cap (--max-budget-usd)
  "memory", // memory admission refused the run (it waits; a waiting client may time out)
  "timeout", // the 30-minute wall clock
  "cancelled",
  "locked", // a locked page (refused before spawning)
  "tool_denied", // the run failed after a tool call was refused
  "cli_missing", // the claude binary is not there (ENOENT)
  "unknown",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];
export const isAgentErrorCode = (v: unknown): v is AgentErrorCode => typeof v === "string" && (AGENT_ERROR_CODES as readonly string[]).includes(v);

// Each pattern is a set of fixed alternatives — no unbounded quantifier over input.
const AUTH_RE = /failed to authenticate|oauth token|please log in|\/login\b|invalid api key|not logged in|authentication[_ ](?:failed|error)|api error: 401|\b401 unauthori[sz]ed|unauthori[sz]ed \(401\)/i;
const USAGE_RE = /usage limit|rate[_ ]limit|\bquota\b|overloaded|api error: (?:429|529)|\b429 too many|limit reached|credit balance|billing[_ ]error/i;
const BUDGET_RE = /max[_ ]budget|budget/i;
const TIMEOUT_RE = /timed out/i;
const MISSING_RE = /\bENOENT\b|command not found/;
const MEMORY_RE = /memory|\bswap\b/i;

/** Text the CLI (or an API error it relays) printed → a code, or null when it says nothing we know. */
export function failureCodeOfText(text: string | null | undefined): "auth" | "usage_limit" | null {
  if (!text) return null;
  const t = text.length > 4000 ? text.slice(-4000) : text;
  if (AUTH_RE.test(t)) return "auth";
  if (USAGE_RE.test(t)) return "usage_limit";
  return null;
}

/** The `error` field the CLI puts on a synthetic assistant message (SDK vocabulary). */
export function sdkErrorCode(v: unknown): AgentErrorCode | null {
  switch (v) {
    case "authentication_failed":
      return "auth";
    case "billing_error":
    case "rate_limit":
    case "server_error":
    case "overloaded":
      return "usage_limit";
    case "invalid_request":
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

const ERROR_LINE_MAX = 400;
/** An assistant text block that is really the CLI reporting an API failure: only a
 *  SHORT block that names a failure we know. (A long reply that merely mentions
 *  "401" is the assistant's own text.) */
export function cliErrorLineCode(text: string): "auth" | "usage_limit" | null {
  const t = text.trim();
  if (!t || t.length > ERROR_LINE_MAX) return null;
  return failureCodeOfText(t);
}

export interface RunFailureInput {
  cancelled?: boolean;
  exitCode?: number | null;
  /** The runner's own error: spawn failure, process error, "timed out after 30m", "claude exited N". */
  runnerError?: string | null;
  /** The code of an error line seen in the stream (StreamNormalizer.failure). */
  streamCode?: AgentErrorCode | null;
  /** The result event's error text (subtype / errors / result text). */
  resultError?: string | null;
  /** Other text to read: stderr tail, a text-mode run's output tail. */
  texts?: Array<string | null | undefined>;
  /** A tool call was refused during the run. */
  deniedTool?: boolean;
}

export function classifyRunFailure(i: RunFailureInput): AgentErrorCode {
  if (i.cancelled) return "cancelled";
  const runner = i.runnerError ?? "";
  if (TIMEOUT_RE.test(runner)) return "timeout";
  if (MISSING_RE.test(runner)) return "cli_missing";
  if (i.streamCode && i.streamCode !== "unknown") return i.streamCode;
  if (i.resultError && BUDGET_RE.test(i.resultError)) return "budget";
  for (const t of [i.resultError, ...(i.texts ?? [])]) {
    const c = failureCodeOfText(t);
    if (c) return c;
  }
  if (i.deniedTool) return "tool_denied";
  return "unknown";
}

/** One truthful sentence for the turn/dispatch record (the client has its own copy by code). */
export function describeRunFailure(code: AgentErrorCode, i: Pick<RunFailureInput, "exitCode" | "runnerError"> = {}): string {
  const exited = typeof i.exitCode === "number" && i.exitCode !== 0;
  const exit = exited ? ` (claude exited ${i.exitCode})` : "";
  // The runner's own words (spawn failure, process error) when it is not just the exit code.
  const runner = i.runnerError && !/^claude exited -?\d+$/.test(i.runnerError) ? i.runnerError.replace(/[.\s]+$/, "") : "";
  switch (code) {
    case "auth":
      return `Claude sign-in failed on the server${exit}.`;
    case "usage_limit":
      return `Claude's usage limit was reached${exit}.`;
    case "budget":
      return "The run reached its spending cap.";
    case "memory":
      return "The server was short on memory.";
    case "timeout":
      return "The run timed out after 30 minutes.";
    case "cancelled":
      return "The run was cancelled.";
    case "locked":
      return "The page is locked.";
    case "tool_denied":
      return `The agent was refused a tool it asked for and the run failed${exit}.`;
    case "cli_missing":
      return `The claude CLI was not found on the server${runner ? ` (${runner})` : ""}.`;
    default:
      return runner ? `The agent run failed: ${runner}.` : `The agent run failed${exit}.`;
  }
}

/** Why a run is WAITING: "memory" for an admission refusal, else null (a busy slot). */
export function queuedReasonCode(reason: string | null | undefined): "memory" | null {
  return reason && MEMORY_RE.test(reason) && !/agent slot|other agent turn/i.test(reason) ? "memory" : null;
}

export const AUTH_RETRY_WINDOW_MS = 10_000;
export const AUTH_RETRY_DELAY_MS = 3_000;

/**
 * The ONE automatic retry. Only a sign-in failure that provably did nothing:
 * first attempt, non-zero exit, fast, no cost, no tool call. A refresh-token
 * collision between two `claude` processes sharing the host's login is transient;
 * nothing else is retried, ever.
 */
export function authRetryAllowed(a: {
  code: AgentErrorCode;
  attempt: number;
  exitCode: number | null;
  elapsedMs: number;
  costUsd: number | null | undefined;
  sawTool: boolean;
  cancelled?: boolean;
}): boolean {
  return (
    a.code === "auth" &&
    a.attempt === 1 &&
    !a.cancelled &&
    typeof a.exitCode === "number" &&
    a.exitCode !== 0 &&
    a.elapsedMs >= 0 &&
    a.elapsedMs <= AUTH_RETRY_WINDOW_MS &&
    !(typeof a.costUsd === "number" && a.costUsd > 0) &&
    !a.sawTool
  );
}

// ── runner health (last outcomes; codes + times only — never text) ───────────

const SIGN_IN_PROBLEM_AFTER = 2;
const recent: Array<{ code: AgentErrorCode | null; at: number }> = [];
let lastFailure: { code: AgentErrorCode; at: number } | null = null;

/** Record how a run ENDED (after any retry): null = it succeeded. Cancelled runs are not outcomes. */
export function noteRunOutcome(code: AgentErrorCode | null, at: number = Date.now()): void {
  if (code === "cancelled") return;
  recent.push({ code, at });
  if (recent.length > 10) recent.shift();
  if (code) lastFailure = { code, at };
}

export function runHealth(): { lastFailure: { code: AgentErrorCode; at: number } | null; signInProblem: boolean } {
  const tail = recent.slice(-SIGN_IN_PROBLEM_AFTER);
  return { lastFailure, signInProblem: tail.length === SIGN_IN_PROBLEM_AFTER && tail.every((r) => r.code === "auth") };
}

export function _resetRunHealth(): void {
  recent.length = 0;
  lastFailure = null;
}
