/**
 * `POST /api/bluebubbles/webhook?secret=<s>` — BlueBubbles Server's webhook (new-message,
 * updated-message; every other event type is acknowledged and ignored).
 *
 * Who may call it — ALL of these, else 404 (no oracle for what failed):
 *  - the connector is on (BLUEBUBBLES_ENABLED + a loopback BLUEBUBBLES_URL + a stored credential);
 *  - a DIRECT loopback connection to this server (`loopbackRefusal`: the TCP peer is 127.x/::1
 *    from the socket, no proxy/forwarding header, a loopback Host on this server's port). The
 *    tunnel / reverse proxy can therefore never reach it, even with the secret;
 *  - the shared secret, compared in constant time (SHA-256 of both sides, timingSafeEqual).
 *    BlueBubbles 1.9.12 webhooks cannot carry custom headers (webhookService: axios.post with
 *    Content-Type only), so the secret rides the query (`?secret=`); `X-Prism-Webhook-Secret`
 *    is accepted too. The URL is never logged by this server.
 * Body: JSON `{type, data}`, ≤ 1 MB (read only after the gate). 200 `{ok:true}` once queued (processing is async and
 * serial — BlueBubbles' webhook timeout is 15 s).
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import crypto from "node:crypto";
import { loopbackRefusal } from "../auth/local-signin";
import { consumeRateLimit } from "../middleware/ratelimit";
import { blueBubblesActive, blueBubblesCreds } from "../bluebubbles/config";
import { enqueueWebhook } from "../bluebubbles/service";

export const blueBubblesApi = new Hono();

const MAX_BODY = 1024 * 1024;
const notFound = { error: "not_found" } as const;

/** Constant-time equality of two secrets of any length. */
export function secretEquals(given: string, want: string): boolean {
  const a = crypto.createHash("sha256").update(given, "utf8").digest();
  const b = crypto.createHash("sha256").update(want, "utf8").digest();
  return crypto.timingSafeEqual(a, b) && given.length === want.length;
}

let refusedLoggedAt = 0;
function logRefusal(why: string): void {
  const now = Date.now();
  if (now - refusedLoggedAt < 60_000) return;
  refusedLoggedAt = now;
  console.warn(`[bluebubbles] webhook refused: ${why}`);
}

/** The gate, BEFORE a byte of the body is read (review M1: an oversized tunnelled body must
 *  get the same 404 as any other refused request). Rate limit only after the secret (M2: a
 *  local process without it cannot exhaust BlueBubbles' bucket). */
blueBubblesApi.use("/webhook", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "POST" || !blueBubblesActive()) return c.json(notFound, 404);
  const refusal = loopbackRefusal(c);
  if (refusal) {
    logRefusal(refusal);
    return c.json(notFound, 404);
  }
  const creds = blueBubblesCreds();
  const given = c.req.header("x-prism-webhook-secret") ?? c.req.query("secret") ?? "";
  if (!creds || !given || !secretEquals(given, creds.webhookSecret)) {
    logRefusal(creds ? "bad secret" : "no credential");
    return c.json(notFound, 404);
  }
  if (consumeRateLimit("bluebubbles-webhook", 6000, 60_000)) return c.json({ error: "rate_limited" }, 429);
  await next();
});

blueBubblesApi.post(
  "/webhook",
  bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "too_large" }, 413) }),
  async (c) => {
    let body: { type?: unknown; data?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!body || typeof body !== "object" || typeof body.type !== "string" || body.type.length > 64) return c.json({ error: "bad_request" }, 400);
    const r = enqueueWebhook(body.type, body.data);
    if (!r.accepted) return c.json({ error: "bad_request" }, 400);
    return c.json({ ok: true });
  },
);
