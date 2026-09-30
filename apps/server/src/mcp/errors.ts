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

/** Uniform error mapping — the MCP analogue of the gateway's vaultErr(). */
export function mapToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof VaultConflictError) return new ToolError("conflict", "the note changed since you read it — re-read and retry", e.body);
  if (e instanceof VaultError) {
    if (e.status === 404) return new ToolError("not_found", "not found");
    if (e.status === 400 || e.status === 413 || e.status === 422) return new ToolError("invalid_request", "the vault rejected the request");
    return new ToolError("upstream_error", "the vault could not complete the request");
  }
  return new ToolError("internal_error", "internal error");
}

