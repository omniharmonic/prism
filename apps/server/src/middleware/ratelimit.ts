/**
 * Tiny in-memory fixed-window rate limiter. No deps; per (key, route) buckets.
 * Behind the Cloudflare tunnel the real client IP is in CF-Connecting-IP; we
 * fall back to X-Forwarded-For, then a constant (so a misconfigured proxy fails
 * closed to a shared bucket rather than unlimited). Suitable for a single-process
 * home server; swap for a shared store if it ever scales out.
 */
import type { Context, MiddlewareHandler } from "hono";
import { INPROCESS_CLIENT_KEY } from "../auth/actor";

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function clientKey(c: Context): string {
  // An MCP tool's in-process dispatch (mcp/dispatch.ts) is keyed by its
  // credential via the private env channel — never the shared "unknown" bucket.
  const env = c.env as Record<symbol, unknown> | undefined;
  const internal = env && typeof env === "object" ? env[INPROCESS_CLIENT_KEY] : undefined;
  if (typeof internal === "string" && internal) return internal;
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Count one hit against the fixed-window bucket `key`. Returns null when within
 * the limit, else the seconds until the window resets. Shared by the IP-keyed
 * middleware below and callers that key by something else (e.g. the MCP
 * endpoint's per-credential limit, mcp/router.ts).
 */
export function consumeRateLimit(key: string, max: number, windowMs: number): number | null {
  sweep();
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  b.count++;
  return b.count > max ? Math.ceil((b.resetAt - now) / 1000) : null;
}

/** Is `key` currently over `max` WITHOUT counting a hit? (For "only failures count" limits.) */
export function rateLimited(key: string, max: number): number | null {
  const b = buckets.get(key);
  const now = Date.now();
  return b && b.resetAt >= now && b.count >= max ? Math.ceil((b.resetAt - now) / 1000) : null;
}

/** The client key (tunnel IP) the IP-keyed limits bucket on. */
export const rateLimitClientKey = (c: Context): string => clientKey(c);

/** Limit to `max` requests per `windowMs` per client for the routes it's mounted on. */
export function rateLimit(opts: { max: number; windowMs: number; name: string }): MiddlewareHandler {
  return async (c, next) => {
    const retry = consumeRateLimit(`${opts.name}:${clientKey(c)}`, opts.max, opts.windowMs);
    if (retry !== null) {
      c.header("Retry-After", String(retry));
      return c.json({ error: "rate_limited", retryAfter: retry }, 429);
    }
    await next();
  };
}

// Opportunistic cleanup so the map can't grow unbounded.
let lastSweep = 0;
function sweep(): void {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}
