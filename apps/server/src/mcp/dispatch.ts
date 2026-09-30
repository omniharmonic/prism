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
 *
 * Hardening (WP6.1 security review):
 *  - PATH: only `/api/…` routes, and no `.`/`..` segment — raw or
 *    percent-encoded — survives to normalization, so a tool can never be steered
 *    (by an agent-supplied id) onto /acl, /auth, /mcp or another route family.
 *  - READ-ONLY: a read-only principal may dispatch only GET/HEAD (plus the
 *    explicit READ_ONLY_POST_ROUTES allowlist) — the read ceiling is enforced
 *    here too, not just by tool labels.
 *  - ORIGIN: the request is marked in-process via the private env channel
 *    (INPROCESS_CLIENT_KEY → rate limiters key on `mcp:<credentialId>`, never a
 *    shared "unknown" bucket) and carries a forwarding header, so the loopback
 *    heuristic (`isLocalRequest`) can never treat it as the local owner.
 */
import type { Hono } from "hono";
import { INPROCESS_ACTOR, INPROCESS_CLIENT_KEY } from "../auth/actor";
import type { McpPrincipal } from "./auth";
import { ToolError } from "./errors";

export type Dispatch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * POST routes that only READ and so may be dispatched by a read-only principal.
 * Exact path patterns (no query). Empty today — semantic search is a GET. Add a
 * route here only if it provably never mutates state.
 */
export const READ_ONLY_POST_ROUTES: readonly RegExp[] = [];

const READ_METHODS = new Set(["GET", "HEAD"]);

/** Non-routable marker for the forwarding header (never a real client IP). */
const INPROCESS_FORWARD = "mcp-inprocess";

/**
 * Validate + normalize a dispatch target. Throws ToolError("invalid_request")
 * for anything outside `/api/`, any `.`/`..` segment (raw or percent-encoded),
 * encoded slashes/backslashes, or a path that normalization would change.
 */
export function safeApiPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) throw new ToolError("invalid_request", "bad path");
  const q = path.indexOf("?");
  const rawPath = q === -1 ? path : path.slice(0, q);
  for (const seg of rawPath.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw new ToolError("invalid_request", "bad path");
    }
    if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded) || seg.includes("\\")) {
      throw new ToolError("invalid_request", "bad path");
    }
  }
  const u = new URL(path, "http://x");
  if (u.pathname !== rawPath || !u.pathname.startsWith("/api/")) throw new ToolError("invalid_request", "bad path");
  return u.pathname + u.search;
}

/** Run an `/api/…` route against `app` as the principal's actor, pinned to its vault. */
export async function dispatchAsActor(
  app: Hono,
  principal: Pick<McpPrincipal, "actor" | "readOnly" | "credentialId" | "via">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = safeApiPath(path);
  const method = (init.method ?? "GET").toUpperCase();
  if (principal.readOnly && !READ_METHODS.has(method)) {
    const pathOnly = target.split("?")[0]!;
    const allowed = method === "POST" && READ_ONLY_POST_ROUTES.some((r) => r.test(pathOnly));
    if (!allowed) throw new ToolError("forbidden", "this credential is read-only");
  }
  const headers = new Headers(init.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set("x-prism-vault", principal.actor.vaultId);
  headers.set("x-forwarded-for", INPROCESS_FORWARD);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(
    target,
    { ...init, method, headers },
    { [INPROCESS_ACTOR]: principal.actor, [INPROCESS_CLIENT_KEY]: `mcp:${principal.via}:${principal.credentialId}` },
  );
}

/**
 * The ONLY `/acl` routes an MCP tool may reach (WP6.4): the scoped-share surface.
 * `dispatchAsActor` stays `/api`-only; sharing is the one family that lives under
 * `/acl`, so it gets its own entry point with an EXACT method+path allowlist — the
 * note/tag PEOPLE grant routes plus the per-note access read. Everything else on
 * `/acl` (members, publish, links, peers, vaults, workspaces, mirrors, tokens…)
 * is unreachable here by construction, whatever the caller's role.
 *
 * The acl router's own gate (admin, or `share` on the addressed resource) and its
 * `denyEscalation` (subset rule + existing-accounts-only for non-admins) still run
 * unchanged — this is the same handler, not a reimplementation. Ids are a single
 * plain path segment (no dots, no slashes, bounded length).
 */
const SHARE_ALLOWLIST: ReadonlyArray<{ method: string; re: RegExp }> = [
  { method: "GET", re: /^\/acl\/notes\/[^/]+$/ },
  { method: "PUT", re: /^\/acl\/notes\/[^/]+\/people$/ },
  { method: "DELETE", re: /^\/acl\/notes\/[^/]+\/people\/[^/]+$/ },
  { method: "PUT", re: /^\/acl\/tags\/[^/]+\/people$/ },
  { method: "DELETE", re: /^\/acl\/tags\/[^/]+\/people\/[^/]+$/ },
];

export function safeSharePath(path: string, method: string): string {
  if (typeof path !== "string" || !path.startsWith("/acl/") || /[?#\\]/.test(path)) {
    throw new ToolError("invalid_request", "bad path");
  }
  for (const seg of path.split("/").slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw new ToolError("invalid_request", "bad path");
    }
    if (!decoded || decoded === "." || decoded === ".." || /[/\\]/.test(decoded) || decoded.length > 300) {
      throw new ToolError("invalid_request", "bad path");
    }
  }
  if (!SHARE_ALLOWLIST.some((r) => r.method === method && r.re.test(path))) {
    throw new ToolError("forbidden", "that route is not available through MCP");
  }
  return path;
}

/** Run one of the scoped-share `/acl` routes as the principal's actor. Read-only credentials: GET only. */
export async function dispatchShareAsActor(
  app: Hono,
  principal: Pick<McpPrincipal, "actor" | "readOnly" | "credentialId" | "via">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const target = safeSharePath(path, method);
  if (principal.readOnly && !READ_METHODS.has(method)) throw new ToolError("forbidden", "this credential is read-only");
  const headers = new Headers(init.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set("x-prism-vault", principal.actor.vaultId);
  headers.set("x-forwarded-for", INPROCESS_FORWARD);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(
    target,
    { ...init, method, headers },
    { [INPROCESS_ACTOR]: principal.actor, [INPROCESS_CLIENT_KEY]: `mcp:${principal.via}:${principal.credentialId}` },
  );
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
