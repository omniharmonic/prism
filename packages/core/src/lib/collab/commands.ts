/**
 * Human collaboration commands — the ONLY way a suggest-level person or
 * capability-link guest changes a shared prose document.
 *
 * The collab socket of a suggest actor is read-only (the server refuses its raw
 * Yjs updates), so instead of typing into the shared Y.Doc the client sends one
 * of these bounded, structured commands to
 *
 *     POST /api/collab/:noteId/commands
 *
 * and the SERVER authors the change: it derives who you are from the request's
 * credential (never from the body), checks the document has not moved since you
 * looked at it, and writes the suggestion marks / comment thread itself. A
 * command carries plain text and positions only — never marks, never a
 * ProseMirror step, never a Yjs update.
 *
 * This module is isomorphic (no DOM, no node: imports) and dependency-free. The
 * server imports the SAME `canonicalCollabState`, so the revision a browser
 * computes is byte-for-byte the one the server compares against.
 */

/** Fields every command carries. */
export interface HumanCollabCommandBase {
  /** A fresh UUID per user action. Retrying after a lost response MUST reuse it
   *  (with the identical body): the server then answers with the original
   *  result instead of applying the change again. */
  requestId: string;
  /** `Date.now()` when the command was prepared. Older than 24 h → refused. */
  createdAt: number;
  /** `humanCollabRevision(...)` of the document state the user was looking at. */
  revision: string;
}

/** An exact ProseMirror range in the document the revision was computed from. */
export interface HumanCollabRange {
  /** ProseMirror position (same coordinates as `editor.state.selection`). */
  from: number;
  to: number;
  /** `doc.textBetween(from, to, "\n", "￼")` — must still match exactly. */
  quote: string;
}

/**
 * A suggested edit. The shape decides the operation:
 *  - `from === to`, non-empty `text` → suggest INSERTING `text` at that position;
 *  - `from < to`, empty `text`      → suggest DELETING the range;
 *  - `from < to`, non-empty `text`  → suggest REPLACING the range with `text`.
 * `text` is plain text; "\n" becomes a line break inside the same block.
 */
export interface HumanSuggestCommand extends HumanCollabCommandBase, HumanCollabRange {
  kind: "suggest";
  text: string;
}
/** Open a comment thread anchored on a non-empty range. */
export interface HumanCommentCommand extends HumanCollabCommandBase, HumanCollabRange {
  kind: "comment";
  text: string;
}
/** Reply in an existing thread. */
export interface HumanReplyCommand extends HumanCollabCommandBase {
  kind: "reply";
  threadId: string;
  text: string;
}
/** Resolve (`true`) or reopen (`false`) a thread. */
export interface HumanResolveCommand extends HumanCollabCommandBase {
  kind: "resolve";
  threadId: string;
  resolved: boolean;
}
/** Delete a thread and its anchor. Suggest actors: only a thread whose every
 *  comment they wrote through this endpoint (see BACKEND-STATUS.md). */
export interface HumanDeleteCommentCommand extends HumanCollabCommandBase {
  kind: "delete-comment";
  threadId: string;
}

export type HumanCollabCommand =
  | HumanSuggestCommand
  | HumanCommentCommand
  | HumanReplyCommand
  | HumanResolveCommand
  | HumanDeleteCommentCommand;

export type HumanCollabCommandKind = HumanCollabCommand["kind"];

/** The 200 body. A replay of the same request returns this same object again
 *  (and the response carries `Idempotent-Replayed: true`). */
export interface HumanCollabResult {
  requestId: string;
  kind: HumanCollabCommandKind;
  /** `suggest`: the id stamped on the insertion/deletion marks (`data-suggestion-id`). */
  suggestionId?: string;
  /** Every comment command: the thread it created / touched. */
  threadId?: string;
  /** `comment` / `reply`: the id of the comment item that was written. */
  commentId?: string;
  /** `resolve`: the state that was set. */
  resolved?: boolean;
}

/** Machine-readable `error` values of a non-200 response. */
export type HumanCollabErrorCode =
  | "unauthenticated" // 401
  | "unsupported_media_type" // 415
  | "csrf_refused" // 403
  | "invalid_command" // 400 — body failed the strict schema / bad range
  | "unsupported_kind" // 400 — the note is code / a sheet / a canvas
  | "forbidden" // 403 — below suggest on this note
  | "access_changed" // 403 — access changed while the request was in flight
  | "vault_mismatch" // 403 — the request's workspace is not the document's
  | "not_author" // 403 — delete-comment on someone else's thread
  | "not_found" // 404
  | "stale_revision" // 409 — document or comments changed; draft must be re-anchored
  | "quote_changed" // 409 — the selected passage changed
  | "suggestion_overlap" // 409 — the passage already carries a suggestion
  | "thread_missing" // 409 — the thread no longer exists
  | "request_id_reused" // 409 — same requestId, different body
  | "expired" // 409 — createdAt outside the accepted window
  | "rate_limited" // 429
  | "document_request_limit" // 429 — per-document receipt cap
  | "not_confirmed" // 503 — applied but not yet durable: retry the SAME request
  | "upstream_error"; // 502 — outcome unknown: retry the SAME request

export interface HumanCollabErrorBody {
  error: HumanCollabErrorCode;
  /** Human-readable, safe to show. */
  message: string;
  /** True when retrying the SAME request (same requestId + body) is the right move. */
  retry?: boolean;
  /** `unsupported_kind`: what the note actually is. */
  noteKind?: "code" | "spreadsheet" | "canvas";
}

export type HumanCollabSend = (command: HumanCollabCommand) => Promise<HumanCollabResult>;

/** Bounds the server enforces (a larger value is a 400, not a truncation). */
export const HUMAN_COLLAB_LIMITS = {
  /** Max characters of `text` (suggested text, comment, reply). */
  text: 10_000,
  /** Max characters of `quote`. */
  quote: 10_000,
  /** Max request body, bytes. */
  body: 80_000,
  /** A command older than this (by `createdAt`) is refused as `expired`. */
  maxAgeMs: 24 * 60 * 60 * 1000,
} as const;

/** The endpoint path for a note (append to the API origin / `/api` base). */
export const humanCollabCommandPath = (noteId: string): string => `/api/collab/${encodeURIComponent(noteId)}/commands`;

/**
 * Canonical JSON: object keys sorted (by UTF-16 code unit, like `Array#sort`),
 * no whitespace, arrays in order; `undefined`, functions and symbols serialize
 * as `null` wherever they appear. Insertion-order independent, so a browser and
 * the server produce identical bytes for equal values.
 */
export function canonicalCollabState(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCollabState).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalCollabState(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The exact string whose SHA-256 is the revision. */
export function humanCollabRevisionInput(doc: unknown, comments: unknown): string {
  return canonicalCollabState({ comments, doc });
}

/**
 * The document revision a command is pinned to: lowercase hex SHA-256 of the
 * UTF-8 bytes of `humanCollabRevisionInput(doc, comments)`, where
 *
 *   doc      = editor.state.doc.toJSON()          (ProseMirror JSON of the body)
 *   comments = ydoc.getMap("comments").toJSON()   (the comment threads)
 *
 * Compute it from the SAME editor state the range/quote were read from, only
 * while the provider is connected and synced. Uses Web Crypto (browsers, and
 * Node ≥ 20's global `crypto`).
 */
export async function humanCollabRevision(doc: unknown, comments: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(humanCollabRevisionInput(doc, comments));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
