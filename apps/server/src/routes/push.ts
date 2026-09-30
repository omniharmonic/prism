/**
 * Web Push routes (Arch v2 WP3.3) — /api/push/*. SERVER OWNER only, like
 * /api/agent: the subscription is a capability to ping the owner's browser.
 */
import { Hono } from "hono";
import { resolveActor } from "../auth/actor";
import { pushEnabled, vapidPublicKey, saveSubscription, removeSubscription, sendPush } from "../push";

export const pushApi = new Hono();

pushApi.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner") return c.json({ error: "forbidden" }, 403);
  await next();
});

pushApi.get("/vapid-public-key", (c) =>
  pushEnabled() ? c.json({ publicKey: vapidPublicKey() }) : c.json({ error: "push_disabled" }, 503),
);

const isHttps = (s: unknown): s is string => typeof s === "string" && /^https:\/\//.test(s) && s.length < 2048;
const isKey = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length < 512;

pushApi.post("/subscribe", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const b = await c.req.json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>().catch(() => ({}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } });
  const p256dh = b.keys?.p256dh;
  const auth = b.keys?.auth;
  if (!isHttps(b.endpoint) || !isKey(p256dh) || !isKey(auth)) {
    return c.json({ error: "bad_request", detail: "endpoint (https) + keys.p256dh + keys.auth required" }, 400);
  }
  saveSubscription({ email: actor.email, endpoint: b.endpoint, p256dh, auth, userAgent: c.req.header("user-agent") });
  return c.json({ ok: true });
});

pushApi.delete("/subscribe", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const b = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as { endpoint?: unknown });
  if (!isHttps(b.endpoint)) return c.json({ error: "bad_request", detail: "endpoint required" }, 400);
  return c.json({ ok: removeSubscription(actor.email, b.endpoint) });
});

/** Send a content-free test ping to every subscription of the owner. */
pushApi.post("/test", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  if (!pushEnabled()) return c.json({ error: "push_disabled" }, 503);
  return c.json(await sendPush(actor.email, { type: "test" }));
});
