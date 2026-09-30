/**
 * In-process dispatch for MCP tools (WP6.1 plumbing; WP6.2+ tools use it).
 *
 * A tool that reads or writes notes does NOT reimplement the gateway: it calls
 * the existing Hono route in-process, as the MCP caller's actor, so every gate
 * the web app goes through (caps, anti-escalation, ACCESS_KEYS, private notes,
 * `_caps` annotation, the owner passthrough) applies unchanged. The actor rides
 * in `env` under `INPROCESS_ACTOR` (see auth/actor.ts) — never as a token — and
 * any Cookie/Authorization header is stripped so the request can only ever be
 * that actor.
 */
import type { Hono } from "hono";
import { INPROCESS_ACTOR, type Actor } from "../auth/actor";
import { ToolError } from "./errors";

export type Dispatch = (path: string, init?: RequestInit) => Promise<Response>;

/** Run `path` against `app` as `actor`, pinned to the actor's vault. */
export function dispatchAsActor(app: Hono, actor: Actor, path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/")) throw new Error("dispatch path must be absolute");
  const headers = new Headers(init.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set("x-prism-vault", actor.vaultId);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return Promise.resolve(app.request(path, { ...init, headers }, { [INPROCESS_ACTOR]: actor }));
}

/**
 * Turn a dispatched route's response into tool data, or throw the ToolError the
 * status maps to (the same vocabulary as mapToolError / the gateway's vaultErr).
 */
export async function jsonOrToolError<T = unknown>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return body as T;
  const reason = typeof body?.error === "string" ? body.error : undefined;
  switch (res.status) {
    case 400:
    case 413:
    case 422:
      throw new ToolError("invalid_request", reason ?? "the request was rejected");
    case 401:
    case 403:
      throw new ToolError("forbidden", "you do not have access to that");
    case 404:
      throw new ToolError("not_found", "not found");
    case 409:
    case 428:
      throw new ToolError("conflict", "the note changed since you read it — re-read and retry", body?.current);
    case 429:
      throw new ToolError("rate_limited", "too many requests — slow down");
    default:
      throw new ToolError("upstream_error", "the vault could not complete the request");
  }
}
