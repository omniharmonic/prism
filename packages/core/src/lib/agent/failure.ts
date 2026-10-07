/**
 * ONE place that turns an agent failure into a sentence + whether trying again can
 * help. Pure and import-free (the verify scripts and the host-services module both
 * load it), so every entry point — thread summary / reply draft, page AI actions,
 * ⌘J, "Turn into…", agent chat, Agent activity — says the same honest thing and
 * none shows a bare status word.
 *
 * The server sends a stable `errorCode` (apps/server/src/agent-failure.ts) on a
 * failed turn / dispatch; `failureCodeOfText` is the fallback for an older server
 * and for failures stored before the code existed.
 */

export const AGENT_ERROR_CODES = [
  "auth",
  "usage_limit",
  "budget",
  "memory",
  "timeout",
  "cancelled",
  "locked",
  "tool_denied",
  "cli_missing",
  "offline",
  "busy",
  "interrupted",
  "unknown",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];
export const isAgentErrorCode = (v: unknown): v is AgentErrorCode => typeof v === "string" && (AGENT_ERROR_CODES as readonly string[]).includes(v);

export interface AgentFailure {
  code: AgentErrorCode;
  /** The whole message: what happened and what to do. */
  text: string;
  /** Offer "Try again" (retrying can help). */
  retry: boolean;
  tone: "error" | "muted";
}

const COPY: Record<AgentErrorCode, { text: string; retry: boolean; tone?: "muted" }> = {
  auth: {
    text: "The agent couldn’t sign in on the server. Try again; if it keeps happening, sign in to Claude on the server (run `claude` there and log in).",
    retry: true,
  },
  usage_limit: { text: "Claude’s usage limit was reached. Try again later.", retry: true },
  budget: { text: "The agent stopped because this run hit its spending cap. A smaller request may fit.", retry: false },
  memory: { text: "The server is short on memory right now — it will run when there is room.", retry: true },
  timeout: { text: "The agent took too long and was stopped. Try again, or ask for less at once.", retry: true },
  cancelled: { text: "Cancelled.", retry: false, tone: "muted" },
  locked: { text: "This page is locked — unlock it or use a read-only session.", retry: false },
  tool_denied: { text: "The agent was refused a tool it asked for, so the run stopped. Trying again will not change that.", retry: false },
  cli_missing: { text: "The agent isn’t installed on the server (the `claude` command was not found there).", retry: false },
  offline: { text: "Can’t reach the Prism server. Check your connection, then try again.", retry: true },
  busy: { text: "The agent queue is full right now. Try again in a minute.", retry: true },
  interrupted: { text: "Interrupted — the server restarted mid-turn. Try again to continue.", retry: true, tone: "muted" },
  unknown: { text: "The agent hit an error on the server. Try again.", retry: true },
};

/** The copy for a code. `detail` (the server's own sentence) is shown only for `unknown`. */
export function agentFailure(code: AgentErrorCode, detail?: string | null): AgentFailure {
  const c = COPY[code] ?? COPY.unknown;
  const d = (detail ?? "").trim();
  const said = d.replace(/[.\s]+$/, "");
  const text =
    code === "unknown" && said
      ? /^The agent\b/.test(said)
        ? `${said}. Try again.`
        : `The agent hit an error: ${said}. Try again.`
      : code === "locked" && d
        ? d
        : c.text;
  return { code, text, retry: c.retry, tone: c.tone ?? "error" };
}

/** Read a failure class out of error TEXT (older servers, stored dispatch notes). Fixed
 *  alternatives only — no unbounded quantifier over the input. */
export function failureCodeOfText(text: string | null | undefined): AgentErrorCode | null {
  if (!text) return null;
  const t = text.length > 2000 ? text.slice(0, 2000) : text;
  if (/sign-in failed|failed to authenticate|oauth token|please log in|\/login\b|invalid api key|not logged in|api error: 401/i.test(t)) return "auth";
  if (/budget|spending cap/i.test(t)) return "budget";
  if (/usage limit|rate[_ ]limit|\bquota\b|overloaded|api error: (?:429|529)|credit balance/i.test(t)) return "usage_limit";
  if (/timed out/i.test(t)) return "timeout";
  if (/\bENOENT\b|cli was not found|command not found/i.test(t)) return "cli_missing";
  if (/memory pressure|short on memory|swap nearly/i.test(t)) return "memory";
  if (/refused a tool/i.test(t)) return "tool_denied";
  return null;
}

/** A finished turn (or stored dispatch) → its failure, or null when it did not fail. */
export function failureOfRun(run: { status: string; errorCode?: string | null; error?: string | null; reason?: string | null }): AgentFailure | null {
  const detail = run.error ?? run.reason ?? null;
  switch (run.status) {
    case "error":
    case "failed":
      return agentFailure(isAgentErrorCode(run.errorCode) ? run.errorCode : (failureCodeOfText(detail) ?? "unknown"), detail);
    case "cancelled":
      return agentFailure("cancelled");
    case "interrupted":
      return agentFailure("interrupted");
    default:
      return null;
  }
}

/** A run that is WAITING: the sentence to show instead of a bare "Queued". */
export function queuedText(run: { errorCode?: string | null; reason?: string | null }): string {
  if (run.errorCode === "memory" || failureCodeOfText(run.reason) === "memory") return COPY.memory.text;
  return run.reason ? `Queued — ${run.reason}` : "Queued…";
}

/**
 * A thrown error from the agent API / host services → a failure. Structural (no
 * `instanceof`): `AgentApiError` and `HostServiceError` both carry `status`,
 * `code`, `detail`; a host-service failure of a run also carries `errorCode`.
 */
export function failureOfError(e: unknown): AgentFailure {
  if (e instanceof TypeError) return agentFailure("offline");
  const o = (e ?? {}) as { status?: unknown; code?: unknown; detail?: unknown; errorCode?: unknown; message?: unknown };
  const detail = typeof o.detail === "string" ? o.detail : null;
  if (isAgentErrorCode(o.errorCode)) return agentFailure(o.errorCode, detail);
  switch (o.code) {
    case "locked":
      return agentFailure("locked", detail);
    case "busy":
      return agentFailure("busy");
    case "agent_cancelled":
    case "aborted":
      return agentFailure("cancelled");
    case "agent_timeout":
      return agentFailure("timeout");
    case "agent_failed":
      return agentFailure(failureCodeOfText(detail) ?? "unknown", detail);
    case "budget_exceeded":
    case "daily_budget_exceeded":
      return agentFailure("budget");
    default: {
      const message = detail ?? (typeof o.message === "string" ? o.message : e == null ? "" : String(e));
      return agentFailure(failureCodeOfText(message) ?? "unknown", message);
    }
  }
}
