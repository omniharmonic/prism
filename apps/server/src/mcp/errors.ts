/**
 * Tool error vocabulary for the Prism MCP endpoint — one place, so every tool
 * (and the in-process dispatch helper) reports failures the same way.
 */
import { VaultConflictError, VaultError } from "../parachute";

export type ToolErrorCode =
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "rate_limited"
  | "upstream_error"
  | "internal_error";

/** A tool failure the caller should see. `message` must be safe to show an agent. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    /** Optional structured detail (e.g. the current note on a conflict). */
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export const STALE_MESSAGE = "the note changed since you read it — re-read and retry";

/**
 * Classify a vault/gateway 409 (or 428) body. The vault answers 409 for several
 * DIFFERENT things (its `error_type`): a stale `if_updated_at` (`conflict`), a
 * path already taken (`path_conflict`), an ambiguous path, a state-transition
 * CAS miss, … The gateway wraps the vault's body as `{error:"conflict", current}`
 * for non-owners; the owner passthrough returns it raw — both are handled.
 * Only a stale-token conflict may be reported as "the note changed since you
 * read it"; anything else gets its own, accurate message (and `detail.reason`).
 */
export function conflictError(status: number, body: unknown): ToolError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const inner = (b.current && typeof b.current === "object" ? b.current : b) as Record<string, unknown>;
  const kind = String(inner.error_type ?? inner.error ?? "");
  const path = typeof inner.path === "string" ? inner.path : undefined;
  switch (kind) {
    case "path_conflict":
      return new ToolError("conflict", `a note already exists at ${path ? `"${path}"` : "that path"} — choose a different path`, { reason: "path_conflict", ...(path ? { path } : {}) });
    case "ambiguous_path":
      return new ToolError("invalid_request", "that path matches more than one note — use the note id instead");
    case "transition_conflict":
      return new ToolError("conflict", "the field's current value is not the one you expected — re-read the note and retry", { reason: "transition_conflict" });
    case "target_exists":
    case "tag_in_use_by_tokens":
    case "history_unrecoverable":
    case "content_edit_ambiguous":
      return new ToolError("conflict", `the vault refused the change (${kind})`, { reason: kind });
    default:
      // `conflict` (stale if_updated_at), a 428 precondition, or an unrecognized body.
      return new ToolError("conflict", status === 428 ? "if_updated_at is required — read the note first and pass its updatedAt" : STALE_MESSAGE, b.current ?? body);
  }
}

/** A stale-`if_updated_at` conflict (as opposed to a path conflict, a live-doc refusal, …). */
export const isStaleConflict = (e: unknown): e is ToolError =>
  e instanceof ToolError && e.code === "conflict" && !(e.detail && typeof e.detail === "object" && ("reason" in e.detail || "live" in e.detail));

/** Uniform error mapping — the MCP analogue of the gateway's vaultErr(). */
export function mapToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof VaultConflictError) return conflictError(e.status, e.body);
  if (e instanceof VaultError) {
    if (e.status === 404) return new ToolError("not_found", "not found");
    if (e.status === 400 || e.status === 413 || e.status === 422) return new ToolError("invalid_request", "the vault rejected the request");
    return new ToolError("upstream_error", "the vault could not complete the request");
  }
  return new ToolError("internal_error", "internal error");
}

