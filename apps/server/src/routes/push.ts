/**
 * Web Push routes (Arch v2 WP3.3) — /api/push/*. SERVER OWNER only, like
 * /api/agent: the subscription is a capability to ping the owner's browser.
 */
import { Hono } from "hono";
import { config } from "../config";
import { resolveActor, requestVia } from "../auth/actor";
import { pushEnabled, vapidPublicKey, saveSubscription, removeSubscription, sendPush, isPushEndpoint } from "../push";
import { csrfRefusal } from "./actions";
import { consumeRateLimit } from "../middleware/ratelimit";
import {
  apnsEnabled,
  apnsApplicationForDevice,
  apnsTokenForDevice,
  isApnsEnvironment,
  isApnsToken,
  removeApnsTokenForDevice,
  saveApnsToken,
  sendApns,
  testNotification,
} from "../apns";

export const pushApi = new Hono();

// Any signed-in USER may register their own browser / device (wave 2A: mentions,
// replies, reminders and access requests notify members too). Every row is keyed
// to the caller's email and every payload is ids-only; agent-turn pushes still
// only ever go to the session owner (notifyTurnEnd). Links/anon → 403.
pushApi.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  await next();
});

pushApi.get("/vapid-public-key", (c) =>
  pushEnabled() ? c.json({ publicKey: vapidPublicKey() }) : c.json({ error: "push_disabled" }, 503),
);

const isKey = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length < 512;

pushApi.post("/subscribe", async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const b = await c.req.json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>().catch(() => ({}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } });
  const p256dh = b.keys?.p256dh;
  const auth = b.keys?.auth;
  if (!isPushEndpoint(b.endpoint) || !isKey(p256dh) || !isKey(auth)) {
    return c.json({ error: "bad_request", detail: "a browser push-service endpoint + keys.p256dh + keys.auth required" }, 400);
  }
  if (!saveSubscription({ email: actor.email, endpoint: b.endpoint, p256dh, auth, userAgent: c.req.header("user-agent") })) {
    return c.json({ error: "conflict" }, 409);
  }
  return c.json({ ok: true });
});

pushApi.delete("/subscribe", async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const b = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as { endpoint?: unknown });
  if (typeof b.endpoint !== "string" || b.endpoint.length >= 2048) return c.json({ error: "bad_request", detail: "endpoint required" }, 400);
  return c.json({ ok: removeSubscription(actor.email, b.endpoint) });
});

/** Send a content-free test ping to every subscription of the caller. CSRF-guarded
 *  and rate-limited; only the server owner sees per-endpoint counts (no outcome
 *  oracle for anyone else). */
pushApi.post("/test", async (c) => {
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  if (!pushEnabled()) return c.json({ error: "push_disabled" }, 503);
  const retry = consumeRateLimit(`push-test:${actor.email}`, 5, 60_000);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited", retryAfter: retry }, 429);
  }
  const r = await sendPush(actor.email, { type: "test" });
  return c.json(actor.role === "owner" && actor.email === config.ownerEmail ? r : { ok: true });
});

// ── APNs (iOS) ───────────────────────────────────────────────────────────────
// An APNs token addresses ONE installed app, so it is registered by — and bound
// to — the native device credential (`Authorization: Bearer pd_…`): the row dies
// with the device (revokeDevice / the app's own sign-out). A browser session
// cookie is refused (403 device_token_required) even for the owner: a cookie
// identifies a browser, not the device the token belongs to, and nothing would
// revoke the row. No CSRF surface: the credential is a bearer header, never
// ambient. The router-wide owner gate above still applies first.
type DeviceActor = { kind: "user"; email: string; vaultId: string; deviceId: string };
function deviceActor(c: Parameters<typeof resolveActor>[0]): DeviceActor | null {
  // requestVia: the device path itself, never an in-process (MCP) dispatch.
  if (requestVia(c) !== "device") return null;
  const a = resolveActor(c);
  return a.kind === "user" && a.deviceId && apnsApplicationForDevice(a.deviceId) === "prism" ? { kind: "user", email: a.email, vaultId: a.vaultId, deviceId: a.deviceId } : null;
}
const needDevice = { error: "device_token_required", detail: "register APNs with the app's device token (Bearer pd_…)" };

/** Register / replace this device's APNs token. → {ok, apnsEnabled} */
pushApi.post("/apns", async (c) => {
  const a = deviceActor(c);
  if (!a) return c.json(needDevice, 403);
  const b = await c.req.json<{ token?: unknown; environment?: unknown }>().catch(() => ({}) as { token?: unknown; environment?: unknown });
  if (!isApnsToken(b.token) || !isApnsEnvironment(b.environment)) {
    return c.json({ error: "bad_request", detail: "token (hex, 64–200 chars) + environment (sandbox|production) required" }, 400);
  }
  saveApnsToken({ deviceId: a.deviceId, token: b.token, environment: b.environment, email: a.email, vaultId: a.vaultId });
  return c.json({ ok: true, apnsEnabled: apnsEnabled() });
});

/** Unregister this device's APNs token. → {ok: <a row was removed>} */
pushApi.delete("/apns", (c) => {
  const a = deviceActor(c);
  if (!a) return c.json(needDevice, 403);
  return c.json({ ok: removeApnsTokenForDevice(a.deviceId) });
});

/** Content-free test notification to THIS device only. → {result: sent|pruned|failed} */
pushApi.post("/apns/test", async (c) => {
  const a = deviceActor(c);
  if (!a) return c.json(needDevice, 403);
  if (!apnsEnabled()) return c.json({ error: "apns_disabled" }, 503);
  const row = apnsTokenForDevice(a.deviceId);
  if (!row) return c.json({ error: "not_registered" }, 404);
  return c.json({ result: await sendApns(row, testNotification()) });
});
