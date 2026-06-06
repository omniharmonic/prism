/**
 * Tiny in-memory fixed-window rate limiter. No deps; per (key, route) buckets.
 * Behind the Cloudflare tunnel the real client IP is in CF-Connecting-IP; we
 * fall back to X-Forwarded-For, then a constant (so a misconfigured proxy fails
 * closed to a shared bucket rather than unlimited). Suitable for a single-process
 * home server; swap for a shared store if it ever scales out.
 */
import type { Context, MiddlewareHandler } from "hono";

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function clientKey(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Limit to `max` requests per `windowMs` per client for the routes it's mounted on. */
export function rateLimit(opts: { max: number; windowMs: number; name: string }): MiddlewareHandler {
  return async (c, next) => {
    sweep();
    const key = `${opts.name}:${clientKey(c)}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    } else {
      b.count++;
      if (b.count > opts.max) {
        const retry = Math.ceil((b.resetAt - now) / 1000);
        c.header("Retry-After", String(retry));
        return c.json({ error: "rate_limited", retryAfter: retry }, 429);
      }
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
