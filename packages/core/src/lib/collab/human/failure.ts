import type { HumanCollabErrorCode } from "../commands";

/**
 * A command that did not return a confirmed 200. `outcome`:
 *  - "refused"  — the server answered and changed nothing (or, for resolve/delete
 *                 after an uncertain save, may have: reload threads);
 *  - "unknown"  — the change may or may not have been applied (network loss, 502,
 *                 503 not_confirmed): retry the IDENTICAL request (same requestId);
 *  - "not-sent" — refused locally before any network request.
 */
export class HumanCommandFailure extends Error {
  constructor(
    message: string,
    readonly code: HumanCollabErrorCode | "network_error" | "invalid_response" | "not_ready",
    readonly outcome: "refused" | "unknown" | "not-sent",
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HumanCommandFailure";
  }
  /** Retrying the same request is the right move (and safe: the server dedupes by requestId). */
  get retrySame(): boolean {
    return this.outcome === "unknown" || this.code === "rate_limited" || this.code === "document_request_limit" || this.code === "actor_request_limit";
  }
  /** The document moved under the draft: re-select the passage, keep the text. */
  get needsReanchor(): boolean {
    return this.code === "stale_revision" || this.code === "quote_changed" || this.code === "suggestion_overlap" || this.code === "thread_missing";
  }
}

/** What to tell the person for each refusal. Specific, calm, and always says what happens to the draft. */
export const HUMAN_COMMAND_COPY: Record<string, string> = {
  unauthenticated: "You’re signed out. Sign in again, then send your draft — it’s kept here.",
  unsupported_media_type: "This version of Prism sent the change in a format the server doesn’t accept. Reload to update.",
  csrf_refused: "This change was blocked as a cross-site request. Reload the page and try again.",
  invalid_command: "This change can’t be sent as written. Check the selected passage and your text.",
  unsupported_kind: "Suggested edits and comments work only in text documents. This page is view-only for you.",
  forbidden: "You no longer have permission to suggest changes here.",
  access_changed: "Your access to this page changed. Reopen it before trying again — your draft is kept.",
  vault_mismatch: "This page belongs to another workspace. Reopen it from that workspace.",
  not_author: "Only the person who wrote every comment in a thread can delete it.",
  not_found: "This page isn’t available any more.",
  locked: "This page is locked. Suggestions are paused until it’s unlocked; comments still work.",
  stale_revision: "The page changed while you were writing. Select the passage again to resend — your text is kept.",
  quote_changed: "The passage you selected was edited. Select it again to resend — your text is kept.",
  suggestion_overlap: "That passage already has a pending suggestion. Review it first, or choose different text.",
  thread_missing: "That comment thread no longer exists.",
  request_id_reused: "This exact request was already used for a different change. Send it again as a new change.",
  expired: "This draft is more than a day old. Send it again as a new change.",
  rate_limited: "You’re sending changes too quickly. Wait a moment, then retry.",
  document_request_limit: "This page is receiving too many changes right now. Wait a moment, then retry.",
  actor_request_limit: "You’ve sent many changes to this page recently. Wait a moment, then retry.",
  actor_growth_limit: "You’ve reached today’s limit for adding text to this page. Ask an editor, or try again tomorrow.",
  too_many_pending_suggestions: "You have many suggestions waiting for review on this page. Ask an editor to review them first.",
  too_many_threads: "This page has reached its limit of comment threads. Resolve or delete some first.",
  thread_full: "This thread is full. Start a new comment instead.",
  document_too_large: "This change would make the page too large.",
  not_confirmed: "The change reached the server but isn’t confirmed as saved yet. Retry — it won’t be applied twice.",
  upstream_error: "The server couldn’t confirm the change. Retry — it won’t be applied twice.",
  network_error: "You appear to be offline. Retry when connected — it won’t be applied twice.",
  invalid_response: "The server’s reply didn’t confirm this exact change. Retry to check — it won’t be applied twice.",
  not_ready: "Wait for the page to finish connecting.",
};
