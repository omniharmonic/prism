/**
 * The fixed-window rate limiter guards the abuse-prone auth surface (magic-link
 * spam, token guessing). The production mount allows 5 magic-link requests per
 * window, so the 6th must 429 — that exact behavior is pinned here, along with
 * the Retry-After header, per-client bucket isolation, and window reset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { rateLimit } from "../src/middleware/ratelimit";

/** Build an app whose single route is rate-limited, and a helper to hit it as a
 *  given client IP (via the trusted CF-Connecting-IP header). */
function appWith(opts: { max: number; windowMs: number; name: string }) {
  const app = new Hono();
  app.use("*", rateLimit(opts));
  app.get("/", (c) => c.text("ok"));
  return (ip: string) => app.request("/", { headers: { "cf-connecting-ip": ip } });
}

test("magic-link mount: the 6th request in a window is rate-limited (max=5)", async () => {
  const hit = appWith({ max: 5, windowMs: 600_000, name: "rl-magic" });
  for (let i = 1; i <= 5; i++) {
    const r = await hit("1.1.1.1");
    assert.equal(r.status, 200, `request ${i} should pass`);
  }
  const sixth = await hit("1.1.1.1");
  assert.equal(sixth.status, 429);
  const bodyJson = (await sixth.json()) as { error: string; retryAfter: number };
  assert.equal(bodyJson.error, "rate_limited");
  assert.ok(bodyJson.retryAfter > 0);
  assert.ok(sixth.headers.get("retry-after"));
});

test("buckets are per-client: a different IP is unaffected by another's limit", async () => {
  const hit = appWith({ max: 2, windowMs: 600_000, name: "rl-perclient" });
  await hit("2.2.2.2");
  await hit("2.2.2.2");
  assert.equal((await hit("2.2.2.2")).status, 429); // 3rd from A blocked
  assert.equal((await hit("3.3.3.3")).status, 200); // B still fresh
});

test("the window resets: after it elapses, the client is allowed again", async () => {
  const hit = appWith({ max: 1, windowMs: 60, name: "rl-reset" });
  assert.equal((await hit("4.4.4.4")).status, 200);
  assert.equal((await hit("4.4.4.4")).status, 429);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal((await hit("4.4.4.4")).status, 200, "should be allowed after the window resets");
});

test("a misconfigured proxy (no IP headers) fails closed to a shared bucket", async () => {
  const app = new Hono();
  app.use("*", rateLimit({ max: 1, windowMs: 600_000, name: "rl-noip" }));
  app.get("/", (c) => c.text("ok"));
  assert.equal((await app.request("/")).status, 200);
  // Second anonymous request shares the "unknown" bucket and is blocked,
  // rather than every header-less client getting an unlimited fresh bucket.
  assert.equal((await app.request("/")).status, 429);
});
